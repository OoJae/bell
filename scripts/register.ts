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
  ixRegisterSymbol,
  loadKeypair,
  readSymbolState,
  readTokenRisk,
  riskPda,
  send,
} from '../src/chain/client.ts'
import { multiplierOf } from '../src/chain/codec.ts'
import { ALLOWLIST } from '../src/config.ts'

/** Matches the on-chain `HoursMode` discriminants. */
const HoursMode = { TwentyFourFive: 0, MarketHours: 1, Regular: 2 } as const

const ATTESTOR_PATH = process.env.BELL_ATTESTOR_KEYPAIR ?? '.attestor.json'
const PAYER_PATH =
  process.env.BELL_PAYER_KEYPAIR ?? `${process.env.HOME}/.config/solana/id.json`

/**
 * The attestor's only power is `push_session`. Keeping it separate from the
 * deploy authority means a leaked attestor can close symbols — the fail-closed
 * direction — but can never touch the program.
 */
function attestorKeypair(): Keypair {
  if (existsSync(ATTESTOR_PATH)) return loadKeypair(ATTESTOR_PATH)
  const kp = Keypair.generate()
  writeFileSync(ATTESTOR_PATH, JSON.stringify([...kp.secretKey]))
  console.log(`  generated attestor -> ${ATTESTOR_PATH}`)
  return kp
}

async function main() {
  const conn = connect()
  const payer = loadKeypair(PAYER_PATH)
  const attestor = attestorKeypair()

  console.log(`payer    ${payer.publicKey.toBase58()}`)
  console.log(`attestor ${attestor.publicKey.toBase58()}\n`)

  const balance = await conn.getBalance(payer.publicKey)
  if (balance === 0) throw new Error('payer has no SOL')

  // The attestor pays its own transaction fees, so it needs a working balance.
  // Deliberately small: its only power is push_session, and a thin balance
  // bounds what a leaked key can spend. At ~5,000 lamports per batched push
  // every 45s, 0.05 SOL runs for roughly five days.
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
      // Backed publishes hours mode per asset; Backpack's securities all trade
      // the extended sessions, so they are 24/5.
      const hoursMode =
        l.issuer === 'backpack' ? HoursMode.TwentyFourFive : HoursMode.TwentyFourFive
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
      await send(conn, [ixInitTokenRisk(payer.publicKey, mint)], [payer])
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
