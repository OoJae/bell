/**
 * Run the keeper.
 *
 *   node scripts/keeper.ts            # dry run: decide, print, write nothing
 *   BELL_ARM=1 node scripts/keeper.ts # actually push
 *
 * Dry run is the default, following the same invariant as Ripcord: a process
 * that writes to a chain should never do so because someone forgot a flag.
 */
import { connect, loadKeypair, readSymbolState } from '../src/chain/client.ts'
import { tick } from '../src/chain/keeper.ts'
import { HaltState } from '../src/policy/reconcile.ts'
import { Recorder } from '../src/record.ts'

const INTERVAL_MS = Number(process.env.BELL_INTERVAL_MS ?? 45_000)
const ATTESTOR_PATH = process.env.BELL_ATTESTOR_KEYPAIR ?? '.attestor.json'
const ONCE = process.argv.includes('--once')
const dryRun = process.env.BELL_ARM !== '1'

const recorder = new Recorder()

const haltName = (h: number) =>
  Object.entries(HaltState).find(([, v]) => v === h)?.[0] ?? String(h)

async function once() {
  const conn = connect()
  const attestor = loadKeypair(ATTESTOR_PATH)
  const result = await tick({ conn, attestor, dryRun })

  const stamp = result.at.toISOString().slice(11, 19)
  console.log(`\n[${stamp}] ${dryRun ? 'DRY RUN' : 'ARMED'}`)
  for (const d of result.decisions) {
    const state = await readSymbolState(conn, d.listing.symbol)
    // observedAt is 0 until the first push; that is "never", not an age.
    const age =
      state && state.observedAt > 0n ? Math.floor(Date.now() / 1000) - Number(state.observedAt) : null
    console.log(
      `  ${d.listing.symbol.padEnd(7)} open=${String(d.verdict.openNow).padEnd(5)} ` +
        `halt=${haltName(d.verdict.halt).padEnd(11)} ${d.verdict.confidence.padEnd(10)} ` +
        `age=${age === null ? 'never' : age + 's'}  ${d.verdict.detail}`,
    )
  }
  const pushedSet = new Set(result.pushed)
  const transitions = recorder.record(
    result.decisions.map((d) => ({
      at: Math.floor(result.at.getTime() / 1000),
      symbol: d.listing.symbol,
      mint: d.listing.mint,
      issuer: d.listing.issuer,
      openNow: d.verdict.openNow,
      halt: d.verdict.halt,
      confidence: d.verdict.confidence,
      detail: d.verdict.detail,
      ...d.sources,
      pushed: pushedSet.has(d.listing.symbol),
      signature: result.signature,
    })),
  )

  if (result.pushed.length === 0) console.log('  (no change)')
  else console.log(`  pushed: ${result.pushed.join(', ')}${result.signature ? ` sig=${result.signature.slice(0, 16)}…` : ''}`)

  for (const t of transitions) {
    console.log(
      `  ** ${t.symbol} ${t.fromOpen ? 'open' : 'closed'} -> ${t.toOpen ? 'open' : 'closed'}` +
        `${t.fromHalt !== t.toHalt ? `, halt ${haltName(t.fromHalt)} -> ${haltName(t.toHalt)}` : ''}` +
        `  (${t.detail})`,
    )
  }
}

if (ONCE) {
  try {
    await once()
  } catch (e) {
    // A failed tick pushes nothing, and an un-refreshed attestation closes its
    // symbol within 120s. Reporting the failure is enough; exiting non-zero
    // would be wrong, because the safe outcome already happened.
    console.error('tick failed:', (e as Error).message)
  }
} else {
  console.log(`keeper every ${INTERVAL_MS / 1000}s — ctrl-c to stop`)
  for (;;) {
    try {
      await once()
    } catch (e) {
      // Never exit the loop on a transient sensor failure: an attestation that
      // stops being refreshed closes its symbol on its own, which is correct.
      console.error('  tick failed:', (e as Error).message)
    }
    await new Promise((r) => setTimeout(r, INTERVAL_MS))
  }
}
