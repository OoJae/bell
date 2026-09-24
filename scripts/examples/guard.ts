/**
 * Ask BELL's gate about a symbol the way an integrator would, sending nothing.
 *
 *   BELL_CLUSTER=devnet BELL_RPC_URL=https://api.devnet.solana.com \
 *     node scripts/examples/guard.ts SPYx              # Strict: the regular session only
 *   ... node scripts/examples/guard.ts SPYx --guarded  # skip the market-open gate, keep the rest
 *   ... node scripts/examples/guard.ts SPYx --refresh  # re-read the mint in the same transaction
 *
 * It wraps a stand-in swap with `guardInstructions` — an SPL Memo instruction,
 * because no router's pools exist on devnet — and prints the gate's verdict
 * and the program's reason. Then it simulates the whole guarded transaction, to
 * show what composing by prepending means: when the gate refuses, the stand-in
 * never runs, and when it allows, the stand-in runs exactly as given.
 *
 * Read-only. It holds no key and signs nothing. The fee payer of the simulated
 * transaction stands in for the user's wallet and is the symbol's attestor,
 * because a simulation needs a funded payer and is never charged. The guide
 * this goes with is `docs/INTEGRATE.md`.
 */
import { PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction } from '@solana/web3.js'
import { connect, readSymbolState } from '../../src/chain/client.ts'
import { Mode } from '../../src/chain/codec.ts'
import { guardInstructions, readVerdict } from '../../src/chain/guard.ts'
import { ALLOWLIST, CLUSTER } from '../../src/config.ts'
import { HaltState } from '../../src/policy/reconcile.ts'

const USAGE = 'usage: node scripts/examples/guard.ts SYMBOL [--guarded] [--refresh]'
const MEMO = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr')

/**
 * The attestor BELL's devnet deployment names on all nine symbols. Pinned
 * rather than read, because `register_symbol` is first-come: whoever registers
 * a ticker names its attestor, so a record is only worth the key it names.
 * Elsewhere — a local validator you registered yourself — nothing is pinned.
 */
const PINNED_ATTESTOR =
  CLUSTER === 'devnet' ? new PublicKey('EsZp7XusAj9fJ1ntQYCTMEw7h6L9mfZUtAvaXDxi4TcG') : undefined

const args = process.argv.slice(2)
const unknownFlag = args.find((a) => a.startsWith('-') && a !== '--guarded' && a !== '--refresh')
const symbolArg = args.filter((a) => !a.startsWith('-'))
if (unknownFlag || symbolArg.length !== 1) {
  console.error(`${unknownFlag ? `unknown flag ${unknownFlag}\n` : ''}${USAGE}`)
  process.exit(2)
}
// The allowlist is the pin from ticker to mint. A ticker is a label; the mint
// is the identity, and a swap moves a mint.
const listing = ALLOWLIST.find((l) => l.symbol.toLowerCase() === symbolArg[0]!.toLowerCase())
if (!listing) {
  console.error(`unknown symbol ${symbolArg[0]}; the allowlist is ${ALLOWLIST.map((l) => l.symbol).join(' ')}`)
  process.exit(2)
}
const mode = args.includes('--guarded') ? Mode.Guarded : Mode.Strict
const refreshRisk = args.includes('--refresh')
const mint = new PublicKey(listing.mint)

const conn = connect()
const state = await readSymbolState(conn, listing.symbol)
if (!state) {
  console.error(`${listing.symbol} is not registered on this cluster (${CLUSTER}); is BELL_RPC_URL pointing where BELL is deployed?`)
  process.exit(1)
}
const payer = PINNED_ATTESTOR ?? state.attestor

// Whatever a router would hand back. The guard neither reads nor changes it.
const swap = [
  new TransactionInstruction({
    programId: MEMO,
    keys: [],
    data: Buffer.from(`stand-in for a swap of ${listing.symbol}`),
  }),
]

const g = await guardInstructions(conn, {
  symbol: listing.symbol,
  mint,
  instructions: swap,
  payer,
  mode,
  refreshRisk,
  attestor: PINNED_ATTESTOR,
})
const v = g.verdict

const et = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  weekday: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
})
const span = (s: number) => `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`
const now = Math.floor(Date.now() / 1000)

console.log(`${listing.symbol} on ${CLUSTER}, ${mode === Mode.Strict ? 'Strict' : 'Guarded'}${refreshRisk ? ', mint re-read first' : ''}`)
console.log(`  verdict   ${v.tradeable ? 'TRADEABLE' : 'REFUSED'}${v.reason ? `  ${v.reason}` : ''}`)
if (v.message) console.log(`  reason    ${v.message}`)
// Named, not described: `Unspecified` covers an issuer withdrawing its own
// token as well as a halt nobody gave a reason for, and "halted" would claim
// an exchange halt that may never have happened.
const haltName = (Object.keys(HaltState) as (keyof typeof HaltState)[]).find((k) => HaltState[k] === v.session.halt)
const session =
  v.session.halt !== HaltState.None
    ? `stopped (HaltState.${haltName ?? v.session.halt})`
    : v.session.openNow
      ? 'open'
      : 'closed'
const next =
  v.session.nextChangeAt > now
    ? `; ${v.session.openNow ? 'closes' : 'next change'} ${et.format(new Date(v.session.nextChangeAt * 1000))} ET, in ${span(v.session.nextChangeAt - now)}`
    : ''
console.log(`  session   ${session}, attested ${now - v.session.observedAt}s ago${next}`)
if (!v.tradeable) {
  console.log(
    v.waitsForOpen
      ? '  offer     a bell order: nothing is wrong but the hour, so the order can wait for the open'
      : '  offer     nothing: waiting for the open would not clear this refusal',
  )
}
if (v.unitsConsumed !== null) console.log(`  cost      ${v.unitsConsumed} compute units for BELL's instructions`)

// The whole guarded transaction, gate and stand-in together, as a wallet's own
// preflight would run it. The node substitutes its own blockhash, so a
// load-balanced RPC cannot fail this for a reason unrelated to the gate.
const full = await conn.simulateTransaction(g.transaction, {
  sigVerify: false,
  replaceRecentBlockhash: true,
  commitment: 'confirmed',
})
const whole = readVerdict(full.value.err, g.gateIndex)
const ran = (full.value.logs ?? []).some((l) => l.startsWith(`Program ${MEMO.toBase58()} invoke`))
console.log(
  `\nwhole transaction (${g.instructions.length} instructions, gate at ${g.gateIndex}), simulated: ` +
    (full.value.err ? `failed ${JSON.stringify(full.value.err)}` : 'succeeded'),
)
console.log(`  the gate   ${whole.tradeable ? 'passed' : `refused${whole.reason ? ` with ${whole.reason}` : ''}`}`)
console.log(`  the swap   ${ran ? 'ran' : 'never ran'}`)
if (whole.tradeable !== v.tradeable) {
  // Two simulations a moment apart can straddle an attestation or a bell, and
  // the first may not have been able to run at all.
  console.log('  (the two simulations disagree: the chain changed between them, or the first could not run)')
}

// What the gate costs in bytes, against the same stand-in unguarded.
const bare = new VersionedTransaction(
  new TransactionMessage({ payerKey: payer, recentBlockhash: g.blockhash, instructions: swap }).compileToV0Message(),
)
const size = g.transaction.serialize().length
// An unsigned VersionedTransaction serializes with a zeroed slot for each
// required signature, so this is already the size it will have once signed.
console.log(`  size       ${size} bytes as signed, ${size - bare.serialize().length} of them BELL's (limit 1232)`)
console.log('\nnothing was sent.')
