/**
 * The filler.
 *
 *   node scripts/crank.ts            # report what it would do
 *   BELL_ARM=1 node scripts/crank.ts # settle due orders
 *
 * Deliberately not privileged: it re-runs the identical on-chain gate that
 * refused the trade in the first place, and it is paid by the spread rather
 * than by a tip. Anyone can run this, which is the point — the venue does not
 * depend on our server being up.
 *
 * On localnet it settles from seeded inventory. On mainnet the same loop swaps
 * through Jupiter in its own transaction first, which is why the program never
 * needs to CPI a router.
 */
import { PublicKey, Transaction, sendAndConfirmTransaction } from '@solana/web3.js'
import {
  connect,
  errorName,
  ixFillOrder,
  loadKeypair,
  readMark,
  readOrders,
  TOKEN_PROGRAM,
  TOKEN_2022,
} from '../src/chain/client.ts'
import { fairOut } from '../src/chain/codec.ts'
import { byMint } from '../src/config.ts'

const FILLER_PATH = process.env.BELL_FILLER_KEYPAIR ?? '.filler.json'
const arm = process.env.BELL_ARM === '1'

const conn = connect()
const filler = loadKeypair(FILLER_PATH)

/** Where this filler keeps inventory for a given mint. Seeded on localnet. */
function inventoryFor(mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('inv'), filler.publicKey.toBytes(), mint.toBytes()],
    new PublicKey('11111111111111111111111111111112'),
  )[0]
}

const orders = await readOrders(conn)
console.log(`crank — ${arm ? 'SETTLING' : 'dry run'} — ${orders.length} order(s)\n`)

for (const o of orders) {
  const listing = byMint.get(o.mint.toBase58())
  const mark = await readMark(conn, o.symbol)
  const remaining = o.amountIn - o.filledIn

  if (!mark || mark.observedAt === 0n) {
    console.log(`  ${o.symbol.padEnd(7)} no mark — cannot price, so cannot fill`)
    continue
  }

  // Deliver exactly the band edge. Every fill lands here, which is why
  // max_slip_bps is the user's maximum cost rather than a tolerance.
  const fair = fairOut(remaining, mark.rateQ64)
  const minOut = (fair * BigInt(10_000 - o.maxSlipBps)) / 10_000n
  const deliver = minOut

  const ix = ixFillOrder({
    filler: filler.publicKey,
    order: o,
    fillerIn: new PublicKey(process.env.BELL_FILLER_QUOTE!),
    fillerOut: inventoryFor(o.mint),
    amountInLeg: remaining,
    amountOut: deliver,
    quoteTokenProgram: TOKEN_PROGRAM,
    stockTokenProgram: TOKEN_2022,
  })

  const tx = new Transaction().add(ix)
  tx.feePayer = filler.publicKey
  tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash

  const sim = await conn.simulateTransaction(tx)
  if (sim.value.err) {
    const e = sim.value.err as { InstructionError?: [number, { Custom?: number }] }
    const code = e.InstructionError?.[1]?.Custom
    console.log(
      `  ${o.symbol.padEnd(7)} REFUSED  ${code !== undefined ? errorName(code) : JSON.stringify(sim.value.err)}`,
    )
    continue
  }

  if (!arm) {
    console.log(
      `  ${o.symbol.padEnd(7)} would fill ${Number(remaining) / 1e6} quote -> ${deliver} raw ` +
        `(${o.maxSlipBps}bps spread, mark $${(Number(mark.pxNum) / 1e6).toFixed(2)})`,
    )
    continue
  }

  const sig = await sendAndConfirmTransaction(conn, tx, [filler], { commitment: 'confirmed' })
  console.log(
    `  ${o.symbol.padEnd(7)} FILLED ${Number(remaining) / 1e6} quote -> ${deliver} raw  sig=${sig.slice(0, 16)}…`,
  )
  void listing
}
