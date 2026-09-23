/**
 * The atomicity proof: the same trade, guarded, against each symbol named
 * (SPYx and IWMx by default).
 *
 *   node scripts/guarded-swap.ts                     # simulate SPYx and IWMx
 *   node scripts/guarded-swap.ts NVDAx TSLAx         # simulate the symbols named
 *   BELL_ARM=1 node scripts/guarded-swap.ts          # actually send
 *   BELL_ARM=1 node scripts/guarded-swap.ts --land   # send, and land any refusal on chain
 *
 * The second instruction here is a lamport transfer standing in for a swap,
 * because Jupiter's program and pools are not on devnet or the local validator.
 * It makes the point the demo needs and makes it checkable: the transfer
 * settles when the gate allows and does not exist when the gate refuses. On
 * mainnet the same composition takes a real Jupiter swap instruction in that
 * slot, unchanged.
 *
 * `--land` exists because a refusal never reaches the chain by itself. Every
 * client simulates a transaction before sending it (preflight), sees the gate
 * refuse, and stops there — which is the gate working, and also leaves nothing
 * in an explorer to point at. With `--land`, a leg the gate refuses in
 * simulation is sent with `skipPreflight: true`, so a validator executes it,
 * the gate aborts it, and the ledger records it as a failed transaction: fee
 * paid, transfer absent, the gate's error in its status. A leg the gate allows
 * is sent the ordinary way. Without BELL_ARM=1 nothing is sent, with or without
 * `--land`.
 */
import { Keypair, PublicKey, SystemProgram, sendAndConfirmTransaction, type Transaction } from '@solana/web3.js'
import { connect, rpcUrl } from '../src/chain/client.ts'
import { errorName } from '../src/chain/codec.ts'
import { loadKeypair } from '../src/chain/keys.ts'
import { guarded, interpret, type Outcome } from '../src/chain/guard.ts'
import { ALLOWLIST, type Listing } from '../src/config.ts'

const PAYER_PATH = process.env.BELL_PAYER_KEYPAIR ?? `${process.env.HOME}/.config/solana/id.json`
const arm = process.env.BELL_ARM === '1'
const AMOUNT = 1_000_000 // lamports moved only if the gate allows
const DEFAULT_SYMBOLS = ['SPYx', 'IWMx']

const USAGE = 'usage: node scripts/guarded-swap.ts [--land] [SYMBOL ...]'

const args = process.argv.slice(2)
const flags = args.filter((a) => a.startsWith('-'))
const unknownFlag = flags.find((f) => f !== '--land')
if (unknownFlag) {
  console.error(`unknown flag ${unknownFlag}\n${USAGE}`)
  process.exit(2)
}
const land = flags.includes('--land')

// Matched without regard to case, because `spyx` is an easy thing to type and
// there is no second listing it could mean. Unknown symbols are refused up
// front rather than skipped: a run that quietly tests one symbol instead of two
// proves nothing about atomicity.
const requested = args.filter((a) => !a.startsWith('-'))
const listings: Listing[] = []
for (const s of requested.length > 0 ? requested : DEFAULT_SYMBOLS) {
  const l = ALLOWLIST.find((x) => x.symbol.toLowerCase() === s.toLowerCase())
  if (!l) {
    console.error(`unknown symbol ${s}; the allowlist is ${ALLOWLIST.map((x) => x.symbol).join(' ')}\n${USAGE}`)
    process.exit(2)
  }
  listings.push(l)
}

const conn = connect()
const payer = loadKeypair(PAYER_PATH)
// A fresh account per run, so its balance is unambiguous evidence.
const sink = Keypair.generate().publicKey

/** An explorer link for the cluster the RPC URL points at. */
function explorerTx(signature: string): string {
  const rpc = rpcUrl()
  const base = `https://explorer.solana.com/tx/${signature}`
  if (rpc.includes('devnet')) return `${base}?cluster=devnet`
  if (rpc.includes('testnet')) return `${base}?cluster=testnet`
  if (/127\.0\.0\.1|localhost/.test(rpc)) return `${base}?cluster=custom&customUrl=${encodeURIComponent(rpc)}`
  return base
}

/** The custom error an instruction at `index` failed with, or null if it did not. */
function customCode(err: unknown, index: number): number | null {
  const e = err as { InstructionError?: [number, { Custom?: number } | string] } | null
  const [at, detail] = e?.InstructionError ?? []
  return at === index && typeof detail === 'object' && detail?.Custom !== undefined ? detail.Custom : null
}

/**
 * Send a transaction the gate is expected to refuse, past preflight, and wait
 * until the ledger has it.
 *
 * A fresh blockhash with its expiry height, so confirmation waits on the block
 * height at which the transaction can no longer land rather than on a timer.
 * `getTransaction` afterwards, not just the confirmation status: the point is a
 * transaction anyone can look up, so this does not report success until one
 * can be.
 */
async function landRefusal(tx: Transaction): Promise<{ signature: string; err: unknown; fee: number | null }> {
  const latest = await conn.getLatestBlockhash('confirmed')
  tx.recentBlockhash = latest.blockhash
  tx.lastValidBlockHeight = latest.lastValidBlockHeight
  tx.sign(payer)
  const signature = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true })
  // Once sent, every failure below names the signature: the transaction may
  // still be on the ledger, and it is the one thing needed to go and look.
  try {
    await conn.confirmTransaction({ signature, ...latest }, 'confirmed')
  } catch (e) {
    throw new Error(`${signature} sent but not confirmed (${(e as Error).message}) — check ${explorerTx(signature)}`)
  }
  for (let i = 0; i < 10; i++) {
    const got = await conn.getTransaction(signature, {
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0,
    })
    // A transaction without status metadata says nothing about how it ended,
    // and reading a missing error as "no error" would report a trade that
    // never happened.
    if (got && !got.meta) throw new Error(`${signature} has no status metadata — check ${explorerTx(signature)}`)
    if (got?.meta) return { signature, err: got.meta.err ?? null, fee: got.meta.fee }
    await new Promise((r) => setTimeout(r, 1_000))
  }
  throw new Error(`${signature} confirmed but not yet retrievable — check ${explorerTx(signature)}`)
}

console.log(
  `guarded trade — ${arm ? 'SENDING' : 'SIMULATING'}` +
    (land ? (arm ? ', landing refusals on chain' : ' (--land sends nothing without BELL_ARM=1)') : ''),
)
console.log(`sink ${sink.toBase58()}\n`)

const results: Array<{ symbol: string; outcome: Outcome }> = []

for (const listing of listings) {
  const { symbol } = listing
  const plan = await guarded({
    conn,
    payer: payer.publicKey,
    symbol,
    mint: new PublicKey(listing.mint),
    instructions: [
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: sink,
        lamports: AMOUNT,
      }),
    ],
  })

  // Simulated first in every mode: `--land` has to know the gate refuses
  // before it sends anything past preflight, and an unarmed run needs nothing
  // more than this.
  const sim = await conn.simulateTransaction(plan.transaction)
  let outcome = interpret(sim.value.err, plan.gateIndex)
  let signature: string | null = null
  let landed: Awaited<ReturnType<typeof landRefusal>> | null = null

  if (arm && land && outcome.refusedByGate) {
    landed = await landRefusal(plan.transaction)
    signature = landed.signature
    outcome = interpret(landed.err, plan.gateIndex)
  } else if (arm) {
    try {
      signature = await sendAndConfirmTransaction(conn, plan.transaction, [payer], {
        commitment: 'confirmed',
      })
      outcome = interpret(null, plan.gateIndex)
    } catch (e) {
      const logs = (e as { transactionLogs?: string[] }).transactionLogs ?? []
      const code = /custom program error: 0x([0-9a-f]+)/.exec(logs.join('\n') + String(e))
      outcome = interpret(
        code ? { InstructionError: [plan.gateIndex, { Custom: parseInt(code[1], 16) }] } : e,
        plan.gateIndex,
      )
    }
  }
  results.push({ symbol, outcome })

  // Simulation decides nothing, so it does not get to say TRADED.
  const verdict = arm ? (outcome.executed ? 'TRADED ' : 'ABORTED') : outcome.executed ? 'ALLOWED' : 'REFUSED'
  const balance = await conn.getBalance(sink)
  console.log(
    `${symbol.padEnd(7)} ${verdict} ` +
      `${(outcome.refusedBecause ?? '').padEnd(18)} sink=${balance} lamports` +
      (signature && !landed ? `  sig=${signature.slice(0, 16)}…` : ''),
  )
  if (!outcome.executed && !outcome.refusedByGate) {
    console.log('        (failure came from the trade, not the gate)')
  }
  if (land && !arm && outcome.refusedByGate) {
    console.log('        --land would send this leg past preflight so the refusal lands; set BELL_ARM=1')
  }

  if (landed) {
    console.log(`        landed ${landed.signature}`)
    console.log(`        ${explorerTx(landed.signature)}`)
    const expected = customCode(sim.value.err, plan.gateIndex)
    const got = customCode(landed.err, plan.gateIndex)
    if (got !== null && got === expected) {
      console.log(
        `        on chain: failed at the gate with ${errorName(got)} (custom ${got})` +
          (landed.fee !== null ? `, fee ${landed.fee} lamports, transfer absent` : ''),
      )
    } else {
      // The chain moved between simulation and landing: a session push or a
      // refresh can change the gate's answer in between. Said plainly, and the
      // exit code says it too, rather than passing this off as the refusal
      // `--land` was asked to record.
      console.log(
        `        on chain: ${landed.err ? JSON.stringify(landed.err) : 'no error — the trade executed'}, ` +
          `not the ${expected !== null ? errorName(expected) : 'refusal'} seen in simulation`,
      )
      process.exitCode = 1
    }
  }
}

const allowed = results.filter((r) => r.outcome.executed).map((r) => r.symbol)
const refused = results.filter((r) => r.outcome.refusedByGate).map((r) => r.symbol)
const list = (xs: string[]) => (xs.length > 0 ? xs.join(', ') : 'none')
// Computed from what happened rather than written in advance: which symbols
// trade depends on the hour, so a fixed "one traded, one did not" line would be
// false for most of the week.
console.log(
  arm
    ? `\nsink balance: ${await conn.getBalance(sink)} lamports — traded: ${list(allowed)}; ` +
        `refused by the gate: ${list(refused)}. Every gate verdict came from the program, not this script.`
    : `\nnothing was sent. The gate would allow: ${list(allowed)}; refuse: ${list(refused)}. ` +
        `Set BELL_ARM=1 to send.`,
)
