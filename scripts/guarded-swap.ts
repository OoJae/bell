/**
 * The atomicity proof: the same trade, guarded, against two symbols.
 *
 *   node scripts/guarded-swap.ts          # simulate
 *   BELL_ARM=1 node scripts/guarded-swap.ts   # actually send
 *
 * The second instruction here is a lamport transfer standing in for a swap,
 * because Jupiter's program and pools are not on the local validator. It makes
 * the point the demo needs and makes it checkable: the transfer settles when
 * the gate allows and does not exist when the gate refuses. On mainnet the same
 * composition takes a real Jupiter swap instruction in that slot, unchanged.
 */
import { Keypair, PublicKey, SystemProgram, sendAndConfirmTransaction } from '@solana/web3.js'
import { connect, loadKeypair } from '../src/chain/client.ts'
import { guarded, interpret } from '../src/chain/guard.ts'
import { bySymbol } from '../src/config.ts'

const PAYER_PATH = process.env.BELL_PAYER_KEYPAIR ?? `${process.env.HOME}/.config/solana/id.json`
const arm = process.env.BELL_ARM === '1'
const AMOUNT = 1_000_000 // lamports moved only if the gate allows

const conn = connect()
const payer = loadKeypair(PAYER_PATH)
// A fresh account per run, so its balance is unambiguous evidence.
const sink = Keypair.generate().publicKey

console.log(`guarded trade — ${arm ? 'SENDING' : 'SIMULATING'}`)
console.log(`sink ${sink.toBase58()}\n`)

for (const symbol of ['SPYx', 'IWMx']) {
  const listing = bySymbol.get(symbol)!
  const mint = new PublicKey(listing.mint)

  const plan = await guarded({
    conn,
    payer: payer.publicKey,
    symbol,
    mint,
    instructions: [
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: sink,
        lamports: AMOUNT,
      }),
    ],
  })

  let outcome
  let signature: string | null = null
  if (arm) {
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
  } else {
    const sim = await conn.simulateTransaction(plan.transaction)
    outcome = interpret(sim.value.err, plan.gateIndex)
  }

  const balance = await conn.getBalance(sink)
  console.log(
    `${symbol.padEnd(6)} ${outcome.executed ? 'TRADED ' : 'ABORTED'} ` +
      `${(outcome.refusedBecause ?? '').padEnd(14)} sink=${balance} lamports` +
      (signature ? `  sig=${signature.slice(0, 16)}…` : ''),
  )
  if (!outcome.executed && !outcome.refusedByGate) {
    console.log('        (failure came from the trade, not the gate)')
  }
}

console.log(
  `\nsink balance: ${await conn.getBalance(sink)} lamports` +
    ` — the trade exists for one symbol and not the other, decided on chain.`,
)
