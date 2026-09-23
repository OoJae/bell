/**
 * Run the keeper.
 *
 *   node scripts/keeper.ts            # dry run: decide, print, send nothing
 *   BELL_ARM=1 node scripts/keeper.ts # actually push
 *
 * Dry run is the default, following the same invariant as Ripcord: a process
 * that writes to a chain should never do so because someone forgot a flag.
 */
import { connect, readAllSymbols } from '../src/chain/client.ts'
import { MarkSource } from '../src/chain/codec.ts'
import { loadKeypair } from '../src/chain/keys.ts'
import { tick } from '../src/chain/keeper.ts'
import { HaltState } from '../src/policy/reconcile.ts'
import { Recorder, type TransitionRow } from '../src/record.ts'

const INTERVAL_MS = Number(process.env.BELL_INTERVAL_MS ?? 45_000)
/**
 * Exit if no tick has succeeded for this long, so the restart policy brings
 * the keeper back. A `fetch` with no timeout can hang forever, and a hung
 * keeper is the worst kind of failure: Railway shows it running, and every
 * symbol quietly goes stale.
 */
const WATCHDOG_MS = Number(process.env.BELL_WATCHDOG_MS ?? 300_000)
const ATTESTOR_PATH = process.env.BELL_ATTESTOR_KEYPAIR ?? '.attestor.json'
const ONCE = process.argv.includes('--once')
const dryRun = process.env.BELL_ARM !== '1'

/**
 * The evidence log, when it can be opened.
 *
 * The log records the keeper; it is not the keeper. A database that would not
 * open used to crash the process on start, and a keeper that is not running
 * closes every symbol two minutes later: the venue shut because its log was
 * unwritable. So the keeper runs without it, tries again every tick, and says
 * so on every tick until it opens.
 */
let recorder: Recorder | null = null
let recorderError: string | null = null
function openRecorder() {
  try {
    recorder = new Recorder()
    recorderError = null
  } catch (e) {
    recorderError = (e as Error).message
  }
}
openRecorder()
if (recorderError) console.error(`evidence log unavailable, running without it: ${recorderError}`)

const haltName = (h: number) =>
  Object.entries(HaltState).find(([, v]) => v === h)?.[0] ?? String(h)
const sourceName = (s: number) =>
  Object.entries(MarkSource).find(([, v]) => v === s)?.[0] ?? String(s)

async function once() {
  const conn = connect()
  const attestor = loadKeypair(ATTESTOR_PATH)
  const result = await tick({ conn, attestor, dryRun })

  const stamp = result.at.toISOString().slice(11, 19)
  console.log(`\n[${stamp}] ${dryRun ? 'DRY RUN' : 'ARMED'}`)
  // One read for the whole log, not one per symbol: nine more requests a tick
  // at a public endpoint is how the keeper earns itself a 429.
  const after = await readAllSymbols(conn, result.decisions.map((d) => d.listing)).catch(() => null)
  for (const d of result.decisions) {
    const state = after?.get(d.listing.symbol)?.state
    // observedAt is 0 until the first push; that is "never", not an age.
    const age =
      state && state.observedAt > 0n ? Math.floor(Date.now() / 1000) - Number(state.observedAt) : null
    console.log(
      `  ${d.listing.symbol.padEnd(7)} open=${String(d.verdict.openNow).padEnd(5)} ` +
        `halt=${haltName(d.verdict.halt).padEnd(11)} ${d.verdict.confidence.padEnd(10)} ` +
        `age=${age === null ? 'never' : age + 's'}  ${d.verdict.detail}`,
    )
  }

  // Recording is best-effort. The chain writes are done by now, and a log that
  // cannot be written must not turn a good tick into a failed one: the loop
  // would count it against the watchdog and restart a keeper whose only fault
  // was its log. Ticks and marks are written separately, so that one failing
  // does not cost the other.
  //
  // A dry run records its ticks, since what the keeper saw and decided is true
  // either way, but nothing it did not push. `pushed` is false for every row
  // and no mark is written: the marks table is the prices that were on chain,
  // where a fill could settle against them, and the report reads it as what a
  // buyer paid. A price nobody could have paid does not belong in it. The
  // summary below still prints what a dry run would have pushed.
  const at = Math.floor(result.at.getTime() / 1000)
  const unrecorded: string[] = []
  let transitions: TransitionRow[] = []
  if (!recorder) openRecorder()
  if (!recorder) unrecorded.push(`log unavailable: ${recorderError}`)
  else {
    const pushedSet = new Set(result.dryRun ? [] : result.pushed)
    try {
      transitions = recorder.record(
        result.decisions.map((d) => ({
          at,
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
    } catch (e) {
      unrecorded.push(`ticks: ${(e as Error).message}`)
    }
    if (!result.dryRun && result.markSignature && result.marks.length > 0) {
      try {
        recorder.recordMarks(
          result.marks.map((m) => ({
            at,
            observedAt: m.observedAt,
            symbol: m.symbol,
            pxNum: m.pxNum,
            pxExpo: m.pxExpo,
            confBps: m.confBps,
            source: sourceName(m.source),
            rateQ64: m.rateQ64,
            signature: result.markSignature,
          })),
        )
      } catch (e) {
        unrecorded.push(`marks: ${(e as Error).message}`)
      }
    }
  }

  if (result.pushed.length === 0 && result.marked.length === 0) console.log('  (no change)')
  else {
    const parts = []
    if (result.pushed.length) parts.push(`sessions: ${result.pushed.join(', ')}`)
    if (result.marked.length) parts.push(`marks: ${result.marked.length}`)
    // A pricing failure is not a tick failure — the venue stays open, but
    // nothing can fill until a fresh mark lands, so say so out loud.
    if (result.markError) parts.push(`marks UNPRICED (${result.markError})`)
    // The mint re-read is what keeps gates 3-6 honest. When it fails the venue
    // stays open on the last-known issuer state, which is exactly the silent
    // failure this line exists to make loud.
    if (result.refreshed) parts.push(`risk: ${result.refreshed} re-read`)
    if (result.riskError) parts.push(`risk UNREFRESHED (${result.riskError})`)
    console.log(`  ${parts.join('  |  ')}${result.signature ? `  sig=${result.signature.slice(0, 16)}…` : ''}`)
  }
  // Outside the branch above on purpose: either can happen on a tick that
  // pushed nothing, and each is a standing fault an operator has to see.
  if (result.backpackError) console.log(`  backpack UNREAD, its listings closed (${result.backpackError})`)
  if (unrecorded.length) console.log(`  evidence UNRECORDED (${unrecorded.join('; ')})`)

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
  let lastOk = Date.now()
  setInterval(() => {
    if (Date.now() - lastOk > WATCHDOG_MS) {
      console.error(`watchdog: no successful tick for ${Math.round((Date.now() - lastOk) / 1000)}s, exiting to be restarted`)
      process.exit(1)
    }
  }, 15_000).unref()
  for (;;) {
    const started = Date.now()
    try {
      await once()
      lastOk = Date.now()
    } catch (e) {
      // Never exit the loop on a transient sensor failure: an attestation that
      // stops being refreshed closes its symbol on its own, which is correct.
      console.error('  tick failed:', (e as Error).message)
    }
    // The interval is the cadence, not the gap. Sleeping a full interval after
    // a ~12s tick made the real period ~57s, which is what left attestations
    // landing 110s old against a 120s limit.
    await new Promise((r) => setTimeout(r, Math.max(0, INTERVAL_MS - (Date.now() - started))))
  }
}
