/**
 * One-time setup: bind each allowlisted mint to a symbol, and read its
 * Token-2022 risk state on chain.
 *
 *   node scripts/register.ts
 *
 * Idempotent — a symbol already registered is skipped rather than failing.
 */
import { existsSync, writeFileSync } from 'node:fs'
import { Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram } from '@solana/web3.js'
import {
  connect,
  ixInitTokenRisk,
  ixOpenMark,
  ixRegisterSymbol,
  readMark,
  readSymbolState,
  readTokenRisk,
  riskPda,
  send,
} from '../src/chain/client.ts'
import { loadKeypair } from '../src/chain/keys.ts'
import { multiplierOf } from '../src/chain/codec.ts'
import { ALLOWLIST } from '../src/config.ts'

/** Matches the on-chain `HoursMode` discriminants. */
const HoursMode = { TwentyFourFive: 0, MarketHours: 1, Regular: 2 } as const

const ATTESTOR_PATH = process.env.BELL_ATTESTOR_KEYPAIR ?? '.attestor.json'
const PAYER_PATH =
  process.env.BELL_PAYER_KEYPAIR ?? `${process.env.HOME}/.config/solana/id.json`

/**
 * The attestor is a hot key with three powers: it opens or closes a symbol
 * (`push_session`), sets its price (`push_mark`), and classifies a pending
 * corporate action (`classify_rebase`). It cannot touch the program, transfer
 * anyone else's tokens, or place an order in anyone else's name — that is what
 * keeping it separate from the deploy authority buys.
 *
 * Closing a symbol is the safe direction; opening one and pricing it are not.
 * `fill_order` is permissionless, so the key that sets the price can also be
 * the filler: a leaked attestor can open a symbol, push an inflated price and
 * fill every parked order against it itself, delivering too little stock.
 * What bounds that is the order. The page and `scripts/queue.ts` give each one
 * a loss floor at three quarters of what the mark said it was worth at
 * placement (`src/policy/order.ts`), and it will not fill below that; an order
 * placed before a symbol's first mark, or by a client that sets no floor, has
 * none. The program refuses any order over $1,000. A swap guarded by
 * `assert_tradeable` elsewhere gets neither bound: a wrongly opened symbol lets
 * it through, limited only by its own slippage.
 *
 * A newly generated key is written owner-only (0600). It signs every
 * attestation the venue trusts, so no other account on this machine should be
 * able to read it.
 */
function attestorKeypair(): Keypair {
  if (existsSync(ATTESTOR_PATH)) return loadKeypair(ATTESTOR_PATH)
  const kp = Keypair.generate()
  writeFileSync(ATTESTOR_PATH, JSON.stringify([...kp.secretKey]), { mode: 0o600 })
  console.log(`  generated attestor -> ${ATTESTOR_PATH}`)
  return kp
}

async function main() {
  const conn = connect()
  const quoteMint = process.env.BELL_QUOTE_MINT
    ? new PublicKey(process.env.BELL_QUOTE_MINT)
    : null
  // This script is the point of no return: `register_symbol`, `init_token_risk`
  // and `open_mark` all use `init`, and the program has no close instruction for
  // any of them. So everything it needs is checked *before* the first write,
  // not discovered partway through.
  //
  // `open_mark` in particular binds the quote mint permanently. Reaching the
  // loop with this unset used to register a symbol, init its risk record, and
  // only then throw — leaving permanent accounts behind from a run that never
  // finished. A stale address is worse still: every mark binds to a mint that
  // does not exist, and nothing surfaces until the first `place_order` refuses
  // with `QuoteMintMismatch`, pointing at the order rather than the cause.
  if (!quoteMint) {
    throw new Error(
      'BELL_QUOTE_MINT is unset. Run scripts/demo-setup.sh for this cluster first — ' +
        'marks bind their quote mint permanently, so this script must not start without it.',
    )
  }
  if (!(await conn.getAccountInfo(quoteMint))) {
    throw new Error(
      `BELL_QUOTE_MINT ${quoteMint.toBase58()} does not exist on this cluster. ` +
        `It is probably left over from a previous ledger — re-run scripts/demo-setup.sh.`,
    )
  }

  const payer = loadKeypair(PAYER_PATH)
  const attestor = attestorKeypair()

  console.log(`payer    ${payer.publicKey.toBase58()}`)
  console.log(`attestor ${attestor.publicKey.toBase58()}\n`)

  const balance = await conn.getBalance(payer.publicKey)
  if (balance === 0) throw new Error('payer has no SOL')

  // The attestor pays its own transaction fees, so it needs a working balance.
  // Deliberately small: this balance is the only SOL the key can spend, so a
  // thin one bounds what a leaked key burns. It is a starting balance, not a
  // running one — an armed keeper signs three transactions a tick (sessions,
  // token-risk refresh, marks), about 15,000 lamports every 45 seconds, which
  // spends 0.05 SOL in under two days. `scripts/health.ts` fails below the
  // same 0.05, so a freshly funded attestor reads as low after its first armed
  // tick: top it up past that before arming the keeper.
  const attestorBalance = await conn.getBalance(attestor.publicKey)
  const FLOOR = 0.05 * LAMPORTS_PER_SOL
  if (attestorBalance < FLOOR) {
    await send(
      conn,
      [
        SystemProgram.transfer({
          fromPubkey: payer.publicKey,
          toPubkey: attestor.publicKey,
          lamports: FLOOR - attestorBalance,
        }),
      ],
      [payer],
    )
    console.log(`  funded attestor to ${FLOOR / LAMPORTS_PER_SOL} SOL\n`)
  }

  for (const l of ALLOWLIST) {
    const mint = new PublicKey(l.mint)
    const existing = await readSymbolState(conn, l.symbol)

    if (existing) {
      console.log(`${l.symbol.padEnd(7)} already registered`)
    } else {
      // Every symbol is registered as 24/5, whatever its issuer publishes.
      // `hours_mode` is a label, not a control: the program stores it here and
      // nothing acts on it afterwards — no gate consults it and no instruction
      // can change it. Whether a symbol's market is open right now is
      // `open_now`, which the attestor sets on every `push_session` and gate 7
      // checks for strict callers. A per-asset mode here would change what the
      // account says and nothing about what it allows.
      const hoursMode = HoursMode.TwentyFourFive
      await send(
        conn,
        [
          ixRegisterSymbol({
            payer: payer.publicKey,
            symbol: l.symbol,
            mint,
            exchangeMic: l.exchangeMic,
            hoursMode,
            attestor: attestor.publicKey,
          }),
        ],
        [payer],
      )
      console.log(`${l.symbol.padEnd(7)} registered`)
    }

    if (!(await readTokenRisk(conn, mint))) {
      await send(conn, [ixInitTokenRisk(payer.publicKey, mint, attestor.publicKey)], [payer])
    }

    // The mark is the queue's price input. Opened with a zero timestamp, which
    // every freshness check reads as stale — a symbol is not fillable until the
    // attestor has actually pushed a price.
    if (!(await readMark(conn, l.symbol))) {
      if (!quoteMint) throw new Error('BELL_QUOTE_MINT is unset; cannot open marks')
      await send(conn, [ixOpenMark(payer.publicKey, l.symbol, quoteMint)], [payer])
    }

    const risk = await readTokenRisk(conn, mint)
    if (!risk) throw new Error(`${l.symbol}: token risk missing after init`)
    console.log(
      `        risk ${riskPda(mint).toBase58().slice(0, 8)}..  ` +
        `multiplier=${multiplierOf(risk.multiplierBits)}  ` +
        `paused=${risk.paused}  hook=${risk.hook ? 'ARMED' : 'none'}  ` +
        `delegate=${risk.permanentDelegate ? 'yes' : 'no'}  ` +
        `pending=${risk.pendingMultiplierBits === 0n ? 'none' : 'YES'}`,
    )
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
