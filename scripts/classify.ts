/**
 * Classify a pending multiplier change as a split or a dividend.
 *
 *   BELL_CLUSTER=devnet BELL_RPC_URL=https://api.devnet.solana.com \
 *     node scripts/classify.ts AAPLx dividend            # dry run: show what would happen
 *   BELL_ARM=1 ... node scripts/classify.ts AAPLx dividend   # send it
 *
 * A split and a dividend are both "the multiplier changes at T" in the mint's
 * extension data, and they have opposite consequences for a pool: a split
 * leaves value-per-raw-unit alone, a dividend steps it up and leaves the pool
 * stale-low by exactly the dividend. The mint cannot say which, so it is
 * attested — and until someone does, gate 4b refuses the symbol with
 * `RebaseUnclassified`. Being unable to classify is a reason not to trade.
 *
 * Signed by the key in `TokenRisk.attestor` (the keeper's hot key), never the
 * deploy key: this is the one attested field in an otherwise-proven account.
 */
import { PublicKey, Transaction, sendAndConfirmTransaction } from '@solana/web3.js'
import {
  connect,
  errorName,
  ixClassifyRebase,
  ixRefreshTokenRisk,
  readTokenRisk,
  riskPda,
} from '../src/chain/client.ts'
import { decodeTokenRisk, multiplierOf, RebaseKind, rebaseKindName } from '../src/chain/codec.ts'
import { loadKeypair } from '../src/chain/keys.ts'
import { bySymbol, CLUSTER } from '../src/config.ts'

const KINDS: Record<string, RebaseKind> = {
  split: RebaseKind.Split,
  dividend: RebaseKind.Dividend,
  unknown: RebaseKind.Unknown,
}

const [symbol, kindArg] = process.argv.slice(2)
const kind = KINDS[kindArg?.toLowerCase() ?? '']
if (!symbol || kind === undefined) {
  console.error('usage: node scripts/classify.ts <SYMBOL> split|dividend|unknown')
  console.error("  'none' is not accepted: the next refresh resets a settled change to None by itself.")
  process.exit(2)
}

// Refuse to guess the cluster. The CLI config and the demo env files both
// default to localnet, and classifying the wrong cluster's record is silent.
if (!process.env.BELL_CLUSTER || !process.env.BELL_RPC_URL) {
  console.error('set BELL_CLUSTER and BELL_RPC_URL explicitly — this script will not guess the cluster')
  process.exit(2)
}

const listing = bySymbol.get(symbol)
if (!listing) {
  console.error(`unknown symbol ${symbol}`)
  process.exit(2)
}

const conn = connect()
const attestor = loadKeypair(process.env.BELL_ATTESTOR_KEYPAIR ?? '.attestor.json')
const mint = new PublicKey(listing.mint)
const arm = process.env.BELL_ARM === '1'

const before = await readTokenRisk(conn, mint)
if (!before) {
  console.error(`${symbol} has no TokenRisk on ${CLUSTER}`)
  process.exit(1)
}
if (!before.attestor.equals(attestor.publicKey)) {
  console.error(
    `loaded key ${attestor.publicKey.toBase58()} is not this record's attestor ` +
      `(${before.attestor.toBase58()}); the program would refuse with NotAttestor`,
  )
  process.exit(1)
}

console.log(`${symbol} on ${CLUSTER}  mint ${mint.toBase58()}`)

// Refresh and classify in ONE transaction, so the classification can never land
// ahead of the refresh that observed the pending change — and so what we
// simulate below is exactly the state the classification is applied to.
const tx = new Transaction().add(
  ixRefreshTokenRisk(mint),
  ixClassifyRebase({ attestor: attestor.publicKey, mint, kind }),
)
tx.feePayer = attestor.publicKey
tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash
tx.sign(attestor)

const sim = await conn.simulateTransaction(tx, undefined, [riskPda(mint)])
if (sim.value.err) {
  const e = sim.value.err as { InstructionError?: [number, { Custom?: number }] }
  const code = e.InstructionError?.[1]?.Custom
  console.error(`refused in simulation: ${code !== undefined ? errorName(code) : JSON.stringify(sim.value.err)}`)
  process.exit(1)
}
const post = sim.value.accounts?.[0]
const after = post ? decodeTokenRisk(Buffer.from(post.data[0], 'base64')) : null
if (!after || after.pendingMultiplierBits === 0n) {
  // Nothing pending means nothing to classify, and the next refresh would
  // reset the field to None anyway. Sending it would look like it worked.
  console.error('no pending multiplier change on the mint — nothing to classify')
  process.exit(1)
}

const at = new Date(Number(after.activatesAt) * 1000).toISOString()
console.log(
  `  pending ${multiplierOf(after.multiplierBits)} → ${multiplierOf(after.pendingMultiplierBits)} at ${at}`,
)
console.log(`  classification ${rebaseKindName(before.rebaseKind)} → ${rebaseKindName(after.rebaseKind)}`)

if (!arm) {
  console.log('\ndry run — set BELL_ARM=1 to send')
  process.exit(0)
}

const sig = await sendAndConfirmTransaction(conn, tx, [attestor], { commitment: 'confirmed' })
console.log(`\nclassified  sig ${sig}`)
