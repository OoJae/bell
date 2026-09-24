/**
 * Run the checker, dry.
 *
 *   node scripts/checker.ts          # every BELL_CHECKER_INTERVAL_MS (60s)
 *   node scripts/checker.ts --once   # one pass, then exit
 *
 * The checker is meant to become a second signer: a process that is not the
 * keeper, reads sources the keeper does not (Nasdaq, with Yahoo behind it,
 * and the local NYSE calendar), and pushes its own session verdict and a
 * reference price. The program has no instruction for that yet, so this
 * version only reads. It holds no key and sends no transaction. What it prints
 * is what it would have said, next to what the keeper put on chain.
 *
 * Per listing, each pass prints:
 *
 * - checker: open only when the calendar says open AND Nasdaq says regular
 *   session. Pre-market and after-hours are closed.
 * - keeper: the on-chain SymbolState and its age. Older than
 *   MAX_STATE_AGE_SECONDS reads as `stale`, because the program treats it as
 *   closed.
 * - ref: the underlying's last sale, which source gave it, and its age.
 * - mark: the on-chain SymbolMark price, its age and its confidence.
 * - |mark-ref|: the gap in basis points of the reference.
 *
 * What |mark-ref| measures: the keeper's executable price for a $200 buy,
 * against the last trade the source reported. So it includes the pool's spread
 * and price impact, the seconds between the two timestamps, and USDC against
 * USD. It does not say which of the two is right. The band the on-chain check
 * will enforce is read off this number, from passes taken during the session.
 *
 * Runs in the keeper's image (Dockerfile.keeper copies src/ and scripts/) with
 * start command `node scripts/checker.ts`. It needs BELL_CLUSTER and
 * BELL_RPC_URL, which that image sets, and no key, no volume and no database.
 */
import { connect, readAllSymbols, rpcUrl, type SymbolAccounts } from '../src/chain/client.ts'
import { MAX_MARK_AGE_SECONDS, MAX_STATE_AGE_SECONDS, MarkSource } from '../src/chain/codec.ts'
import { ALLOWLIST, CLUSTER } from '../src/config.ts'
import { isRegularOpen } from '../src/policy/calendar.ts'
import { HaltState } from '../src/policy/reconcile.ts'
import { readReferences, type Reading } from '../src/sensor/nasdaq.ts'

/**
 * Each pass asks Nasdaq ten times, so a cadence typo is not harmless: "60s" is
 * NaN, and NaN or 0 makes the loop below spin as fast as Nasdaq answers, which
 * is how an IP gets blocked. A bad value refuses to start rather than guessing.
 */
const MIN_INTERVAL_MS = 15_000
function msFromEnv(name: string, fallback: number, min: number): number {
  const raw = process.env[name]
  const n = raw === undefined || raw === '' ? fallback : Number(raw)
  if (!Number.isFinite(n) || n < min) {
    console.error(`${name}=${raw} is not a number of milliseconds >= ${min}. Refusing.`)
    process.exit(1)
  }
  return n
}
const INTERVAL_MS = msFromEnv('BELL_CHECKER_INTERVAL_MS', 60_000, MIN_INTERVAL_MS)
/**
 * Exit if no pass has finished for this long, so the restart policy brings the
 * checker back. Every fetch has a timeout, but a hang somewhere else would
 * leave Railway showing a running service that has stopped checking anything.
 * It must outlast a pass, or a healthy checker would restart itself forever.
 */
const WATCHDOG_MS = msFromEnv('BELL_CHECKER_WATCHDOG_MS', Math.max(300_000, INTERVAL_MS + 60_000), INTERVAL_MS + 60_000)
const ONCE = process.argv.includes('--once')

/**
 * A row counts toward the band only when both prices describe the same moment
 * of a live session: the checker says open, the mark could still settle a fill
 * and the reference is recent. Nasdaq prints to the minute, so three minutes
 * is two whole minutes of slack past its resolution.
 */
const MAX_REF_AGE_S = 180

// Refused, not ignored. Someone who sets this expects a signer, and a checker
// that quietly stays dry would let them believe the venue has one.
if (process.env.BELL_CHECKER_ARM === '1') {
  console.error('BELL_CHECKER_ARM=1, but the program has no checker instruction yet; this build only reads. Refusing.')
  process.exit(1)
}

const haltName = (h: number) => Object.entries(HaltState).find(([, v]) => v === h)?.[0] ?? String(h)
const markSourceName = (s: number) => Object.entries(MarkSource).find(([, v]) => v === s)?.[0] ?? String(s)

/** 45 → "45s", 192 → "3m12s", 7500 → "2h05m". */
function ageText(seconds: number): string {
  const s = Math.round(seconds)
  if (s < 0) return `${s}s`
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`
  if (s < 86_400) return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`
  return `${Math.floor(s / 86_400)}d`
}

/**
 * A mark whose price stops moving while the market does. PFE's read $28.6744
 * then $28.6743 for over twenty minutes on 2026-09-24, with its observed_at
 * fresh every tick, so the age test above never catches it. It can be true (a
 * thin pool nobody arbitrages quotes the same fill) or a quote re-pushed; this
 * cannot tell which. Either way its gap is the pool's drift, not a spread, and
 * a band read off it would be read off that. Loop mode only: one pass has
 * nothing to compare with.
 *
 * Counted in keeper pushes (distinct observed_at), not in checker passes: a
 * checker faster than the keeper's 45 s tick sees the same push twice, and
 * that is not a price standing still.
 */
const UNMOVED_BPS = 1
const UNMOVED_PUSHES = 3
const lastMarks = new Map<string, { px: number; at: bigint; ref: number | null; pushes: number }>()

function unmoved(symbol: string, px: number, at: bigint, ref: number | null): string | null {
  const seen = lastMarks.get(symbol)
  if (!seen || (Math.abs(px - seen.px) / seen.px) * 10_000 >= UNMOVED_BPS) {
    lastMarks.set(symbol, { px, at, ref, pushes: 1 })
    return null
  }
  if (at !== seen.at) [seen.at, seen.pushes] = [at, seen.pushes + 1]
  if (seen.pushes < UNMOVED_PUSHES) return null
  const refMoved = ref !== null && seen.ref !== null ? `${((Math.abs(ref - seen.ref) / seen.ref) * 10_000).toFixed(1)}bps` : 'unknown'
  return `mark unmoved (<${UNMOVED_BPS}bps) over ${seen.pushes} keeper pushes; ref moved ${refMoved} meanwhile`
}

interface Row {
  symbol: string
  reading: Reading | undefined
  accounts: SymbolAccounts | undefined
  /** Absolute gap in bps, when both prices exist. */
  gapBps: number | null
  comparable: boolean
  line: string
}

function row(
  symbol: string,
  reading: Reading | undefined,
  accounts: SymbolAccounts | undefined,
  chainRead: boolean,
  nowS: number,
): Row {
  const cols: string[] = [symbol.padEnd(6)]
  const notesEarly: string[] = []

  cols.push((reading ? (reading.openNow ? 'open' : 'closed') : '?').padEnd(7))

  let keeperOpen: boolean | null = null
  let keeperStale = false
  let keeper: string
  const state = accounts?.state
  if (!chainRead) keeper = 'unread'
  else if (!state) keeper = 'none'
  else if (state.observedAt === 0n) keeper = 'never'
  else {
    const age = nowS - Number(state.observedAt)
    // The program refuses a state this old, so it is closed whatever it says.
    keeperStale = age >= MAX_STATE_AGE_SECONDS
    keeperOpen = !keeperStale && state.openNow
    const said = keeperStale ? 'stale' : state.openNow ? 'open' : 'closed'
    keeper = `${said} ${ageText(age)}`
  }
  cols.push(keeper.padEnd(12))

  const q = reading?.quote ?? null
  const refAge = q ? nowS - q.lastAt / 1000 : null
  // A last sale from before the bell, read in the first minutes of the
  // session, is recent but is a pre-market print. Nasdaq's time is the start
  // of the print's minute, so a 09:30 print still counts.
  const refInSession = q ? isRegularOpen(new Date(q.lastAt)) === true : false
  cols.push(q ? `$${q.last.toFixed(4)} ${q.source} ${ageText(refAge!)}`.padEnd(26) : 'no reference'.padEnd(26))

  const mark = accounts?.mark
  let markPx: number | null = null
  let markAge: number | null = null
  let markStale = false
  if (mark && mark.observedAt > 0n && mark.pxNum > 0n) {
    markPx = Number(mark.pxNum) * 10 ** mark.pxExpo
    markAge = nowS - Number(mark.observedAt)
    markStale = markAge > MAX_MARK_AGE_SECONDS
    const still = markStale ? null : unmoved(symbol, markPx, mark.observedAt, q?.last ?? null)
    if (still) notesEarly.push(still)
    cols.push(
      `$${markPx.toFixed(4)} ${ageText(markAge)} ${mark.confBps}bps ${markSourceName(mark.source)}`.padEnd(34),
    )
  } else cols.push((chainRead ? 'no mark' : 'unread').padEnd(34))

  let gapBps: number | null = null
  if (q && markPx !== null) {
    gapBps = (Math.abs(markPx - q.last) / q.last) * 10_000
    cols.push(`${gapBps.toFixed(1)}bps ${markPx >= q.last ? 'over' : 'under'}`)
  } else cols.push('-')

  const comparable =
    gapBps !== null &&
    reading?.openNow === true &&
    markAge !== null &&
    markAge <= MAX_MARK_AGE_SECONDS &&
    refAge !== null &&
    refAge <= MAX_REF_AGE_S &&
    refInSession

  const notes: string[] = [...notesEarly]
  // A keeper that stopped refreshing is not a session disagreement: that is
  // the keeper down, not the two of them reading the market differently.
  if (keeperStale) notes.push('keeper stale: the program reads it as closed')
  // Nor is a halt. The checker judges only whether the market is in its
  // regular session; a symbol the keeper closed for a halt or an issuer's
  // withdrawal is closed for a reason this checker does not read.
  else if (keeperOpen !== null && state!.halt !== HaltState.None) {
    notes.push(`keeper halt=${haltName(state!.halt)}, which the checker does not judge`)
  }
  // The disagreement that matters: when the two session verdicts differ, the
  // on-chain version of this check would close the symbol, or would have.
  else if (reading && keeperOpen !== null && keeperOpen !== reading.openNow) {
    notes.push(`DISAGREE: checker ${reading.openNow ? 'open' : 'closed'} (${reading.why})`)
  }
  if (reading && !reading.openNow && keeperOpen === null) notes.push(reading.why)
  // Said so the gap beside it is not read as a price the keeper would fill at.
  if (markStale) notes.push('mark stale: no fill settles at it, gap left out of the band')
  if (reading?.openNow && q && !refInSession) notes.push('ref printed before the session, left out of the band')
  // Said of when it was read, not of the print: outside the session Nasdaq's
  // last sale can be an extended-hours trade, and Yahoo's is the close.
  if (q && q.session && q.session !== 'regular') notes.push(`ref read outside the regular session (${q.session})`)
  if (reading?.errors.length) notes.push(reading.errors.join('; '))

  return {
    symbol,
    reading,
    accounts,
    gapBps,
    comparable,
    line: `  ${cols.join(' ')}${notes.length ? `  [${notes.join(' | ')}]` : ''}`,
  }
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

async function once() {
  const now = new Date()
  const conn = connect()
  // Two issuers can list the same underlying; ask Nasdaq once for it.
  const underlyings = [...new Set(ALLOWLIST.map((l) => l.underlying))]

  // The chain and the references are independent, so neither waits on the
  // other, and a chain that will not answer still leaves the checker's own
  // verdicts on the page.
  const [pass, board] = await Promise.all([
    readReferences(underlyings, now),
    readAllSymbols(conn, ALLOWLIST).then(
      (m) => ({ ok: true as const, m }),
      (e: Error) => ({ ok: false as const, error: e.message }),
    ),
  ])
  const nowS = Date.now() / 1000

  const market = pass.market ? `${pass.market.session ?? 'unrecognised'} ("${pass.market.label}")` : 'UNREAD'
  const calendar = pass.calendarOpen === null ? 'no opinion' : pass.calendarOpen ? 'open' : 'closed'
  console.log(`\n[${now.toISOString().slice(11, 19)}] checker DRY RUN, holds no key, writes nothing`)
  console.log(`  calendar=${calendar}  nasdaq market-info=${market}`)
  if (pass.marketError) console.log(`  market-info failed: ${pass.marketError}`)
  if (!board.ok) console.log(`  chain UNREAD: ${board.error}`)
  console.log(
    `  ${'symbol'.padEnd(6)} ${'checker'.padEnd(7)} ${'keeper'.padEnd(12)} ${'ref (source, age)'.padEnd(26)} ` +
      `${'mark (age, conf, source)'.padEnd(34)} |mark-ref|`,
  )

  const rows = ALLOWLIST.map((l) =>
    row(l.symbol, pass.readings.get(l.underlying), board.ok ? board.m.get(l.symbol) : undefined, board.ok, nowS),
  )
  for (const r of rows) console.log(r.line)

  const used = rows.filter((r) => r.comparable).map((r) => r.gapBps!)
  const fallbacks = rows.filter((r) => r.reading?.quote?.source === 'yahoo').map((r) => r.symbol)
  // Yahoo can also be where the session came from while the price is still
  // Nasdaq's, and a verdict resting on Yahoo's trading periods should say so.
  const yahooSession = rows.filter((r) => r.reading?.sessionFrom === 'yahoo').map((r) => r.symbol)
  if (used.length) {
    console.log(
      `  band: |mark-ref| over ${used.length} comparable rows: max ${Math.max(...used).toFixed(1)}bps, ` +
        `median ${median(used).toFixed(1)}bps (checker open, mark <=${MAX_MARK_AGE_SECONDS}s, ` +
        `ref <=${MAX_REF_AGE_S}s and printed in the session)`,
    )
  } else console.log('  band: no comparable rows this pass (needs checker open, a fresh mark and a recent reference)')
  if (fallbacks.length) console.log(`  yahoo stood in for: ${fallbacks.join(', ')}`)
  if (yahooSession.length) console.log(`  session from yahoo for: ${yahooSession.join(', ')}`)
}

// The host only, never the full URL: a keyed RPC carries its key in the query.
const rpcHost = (() => {
  try {
    return new URL(rpcUrl()).host
  } catch {
    return 'unparseable BELL_RPC_URL'
  }
})()
console.log(`checker on ${CLUSTER} via ${rpcHost}, ${ALLOWLIST.length} listings`)

if (ONCE) {
  try {
    await once()
  } catch (e) {
    console.error('pass failed:', (e as Error).message)
    process.exitCode = 1
  }
} else {
  console.log(`checker every ${INTERVAL_MS / 1000}s, ctrl-c to stop`)
  let lastOk = Date.now()
  setInterval(() => {
    if (Date.now() - lastOk > WATCHDOG_MS) {
      console.error(`watchdog: no finished pass for ${Math.round((Date.now() - lastOk) / 1000)}s, exiting to be restarted`)
      process.exit(1)
    }
  }, 15_000).unref()
  for (;;) {
    const started = Date.now()
    try {
      await once()
      lastOk = Date.now()
    } catch (e) {
      // A failed pass writes nothing, because nothing ever does yet. Say so
      // and try again; the watchdog is for the pass that never comes back.
      console.error('  pass failed:', (e as Error).message)
    }
    // The interval is the cadence, not the gap, as in the keeper.
    await new Promise((r) => setTimeout(r, Math.max(0, INTERVAL_MS - (Date.now() - started))))
  }
}
