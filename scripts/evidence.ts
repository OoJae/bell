/**
 * Turn the tick log into EVIDENCE.md.
 *
 *   node scripts/evidence.ts
 *
 * Everything here is counted from the database rather than written by hand, so
 * the document cannot drift from what actually happened. Where a number is
 * unflattering it still gets printed — a measured figure that undercuts the
 * pitch is worth more than a claim nobody checked.
 */
import Database from 'better-sqlite3'
import { writeFileSync } from 'node:fs'
import { closedWeekdays, nightVsOpen, type MarkSample, type SessionSample } from '../src/record.ts'

const HALTS = ['None', 'Luld', 'NewsPending', 'MarketWide', 'Suspension', 'Unspecified']

const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`
const iso = (t: number) => new Date(t * 1000).toISOString().replace('T', ' ').slice(0, 19)

// ------------------------------------------------------------------ stoppages
//
// Pure from here to `main`: rows in, record out, no database and no clock. The
// report feeds these what it read, and the tests feed them fixtures.

/** One row of the transitions table, with what the report joins onto it. */
export interface TransitionIn {
  at: number
  symbol: string
  fromOpen: boolean
  toOpen: boolean
  fromHalt: number
  toHalt: number
  detail: string
  /** The symbol's previous tick, which had not seen the change; null for its first. */
  prevAt: number | null
  /** The session attestation that carried the new state on chain, when this tick pushed one. */
  signature: string | null
}

/** Where a symbol's part of the log begins and ends. */
export interface SymbolSpan {
  symbol: string
  firstAt: number
  /** What its first tick attested: the state the record starts from. */
  firstHalt: number
  firstDetail: string
  firstSignature: string | null
  lastAt: number
}

/** One stoppage, in the terms footnote 84 of the order lists. */
export interface Stoppage {
  symbol: string
  /** `HaltState` values attested while it lasted, in order; one unless the kind changed. */
  kinds: number[]
  /** The verdict's reason when it began, then any other reason given at a change while it lasted. */
  reasons: string[]
  /** The first tick that saw it; null only when the log never shows it begin. */
  start: number | null
  /** The tick before that, which did not see it; null when it was in force at the symbol's first tick. */
  startAfter: number | null
  /** The first tick that saw it lifted; null while it is still in force at the end of the log. */
  end: number | null
  endAfter: number | null
  /** The verdict when it lifted: why trading could resume, or that the market had closed meanwhile. */
  endReason: string | null
  /** Whether the symbol was tradeable on the tick that lifted it. */
  resumedOpen: boolean | null
  /** The symbol's last tick, which bounds a stoppage still in force at the end of the log. */
  lastSeen: number
  startSignature: string | null
  endSignature: string | null
}

export interface StoppageRecord {
  stoppages: Stoppage[]
  /** Per symbol, how often it went from open to closed with no halt: the session ending, not a stoppage. */
  ordinaryCloses: Map<string, number>
}

const bySymbolThenTime = (a: Stoppage, b: Stoppage) =>
  (a.start ?? 0) - (b.start ?? 0) || (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0)

/**
 * Every stoppage in the log: each interval in which the keeper attested a halt
 * (`HaltState` other than `None`) for a symbol, from the first tick that saw it
 * to the first tick that saw it lifted.
 *
 * The transitions table alone would miss the longest ones. A symbol already
 * stopped at the keeper's first tick never transitions into the stop — a token
 * its issuer had withdrawn reads halted from its first tick on — so the record
 * starts from each symbol's first tick, not from its first change.
 *
 * An ordinary close is kept apart on purpose. The regular session ending is not
 * a stoppage of trading in the security, and a record that mixed each night's
 * close in with the halts would bury the few that matter under the many that
 * do not.
 */
export function stoppages(
  spans: readonly SymbolSpan[],
  transitions: readonly TransitionIn[],
): StoppageRecord {
  const open = new Map<string, Stoppage>()
  const done: Stoppage[] = []
  const closes = new Map<string, number>()
  const lastSeen = new Map(spans.map((s) => [s.symbol, s.lastAt]))
  const begin = (
    symbol: string,
    kind: number,
    reason: string,
    at: number | null,
    after: number | null,
    signature: string | null,
  ): Stoppage => {
    const s: Stoppage = {
      symbol,
      kinds: [kind],
      reasons: [reason],
      start: at,
      startAfter: after,
      end: null,
      endAfter: null,
      endReason: null,
      resumedOpen: null,
      lastSeen: lastSeen.get(symbol) ?? at ?? 0,
      startSignature: signature,
      endSignature: null,
    }
    open.set(symbol, s)
    return s
  }

  for (const s of spans) {
    closes.set(s.symbol, 0)
    if (s.firstHalt !== 0) begin(s.symbol, s.firstHalt, s.firstDetail, s.firstAt, null, s.firstSignature)
  }
  for (const t of [...transitions].sort((a, b) => a.at - b.at)) {
    // A change out of a halt the record never saw begin can only come from
    // input without the symbol's first tick. Its start is unknown, and it is
    // still a stoppage.
    const cur =
      open.get(t.symbol) ??
      (t.fromHalt !== 0 ? begin(t.symbol, t.fromHalt, 'not recorded', null, null, null) : undefined)
    if (t.toHalt !== 0) {
      if (!cur) {
        begin(t.symbol, t.toHalt, t.detail, t.at, t.prevAt, t.signature)
      } else {
        if (t.toHalt !== cur.kinds.at(-1)) cur.kinds.push(t.toHalt)
        if (!cur.reasons.includes(t.detail)) cur.reasons.push(t.detail)
      }
      continue
    }
    if (cur) {
      cur.end = t.at
      cur.endAfter = t.prevAt
      cur.endReason = t.detail
      cur.resumedOpen = t.toOpen
      cur.endSignature = t.signature
      done.push(cur)
      open.delete(t.symbol)
      continue
    }
    if (t.fromOpen && !t.toOpen) closes.set(t.symbol, (closes.get(t.symbol) ?? 0) + 1)
  }
  return { stoppages: [...done, ...open.values()].sort(bySymbolThenTime), ordinaryCloses: closes }
}

/** `4m 22s`, `2h 05m`, `3d 4h`. */
export function duration(seconds: number): string {
  const d = Math.floor(seconds / 86_400)
  const h = Math.floor((seconds % 86_400) / 3_600)
  const m = Math.floor((seconds % 3_600) / 60)
  const s = Math.floor(seconds % 60)
  if (d) return `${d}d ${h}h`
  if (h) return `${h}h ${String(m).padStart(2, '0')}m`
  if (m) return `${m}m ${String(s).padStart(2, '0')}s`
  return `${s}s`
}

/**
 * How long it lasted, from first sighting to first sighting. A lower bound when
 * it was in force before the log began or is still in force at its end.
 */
function lasted(s: Stoppage): { seconds: number; atLeast: boolean } | null {
  if (s.start === null) return null
  const until = s.end ?? s.lastSeen
  return { seconds: until - s.start, atLeast: s.end === null || s.startAfter === null }
}

/** When a change happened: between the tick that had not seen it and the one that had. */
function between(after: number | null, at: number): string {
  if (after === null) return iso(at)
  return iso(after).slice(0, 10) === iso(at).slice(0, 10)
    ? `${iso(after)} – ${iso(at).slice(11)}`
    : `${iso(after)} – ${iso(at)}`
}

const cell = (s: string) => s.replaceAll('|', '\\|')

function attestation(signature: string | null, cluster: string): string {
  if (!signature) return '—'
  const short = `${signature.slice(0, 8)}…`
  if (cluster === 'localnet') return `\`${short}\``
  const q = cluster === 'mainnet' ? '' : `?cluster=${cluster}`
  return `[${short}](https://explorer.solana.com/tx/${signature}${q})`
}

/** The record as a section of EVIDENCE.md. */
export function renderStoppages(record: StoppageRecord, cluster: string): string[] {
  const lines: string[] = []
  const w = (s = '') => lines.push(s)
  const { stoppages: list, ordinaryCloses } = record

  w('## Stoppages')
  w()
  w('Every interval in which the keeper attested a halt for a symbol, meaning a')
  w('`HaltState` other than `None`, kept in the form footnote 84 of SEC Order')
  w('34-106402 asks of a venue\'s books and records: the security, the reasons,')
  w('when the stoppage started and ended, and why trading resumed. BELL is not a')
  w('Tokenized Securities Venue; this is the record it would keep if it were.')
  w()
  w('A stoppage here is anything that made the keeper attest a halt, and the')
  w('reason column says which: a halt of the underlying on its primary listing')
  w('exchange, from Nasdaq\'s feed (the §II.H case); the issuer withdrawing its own')
  w('token; the issuer not trading while the session is open; or no reading from')
  w('the issuer at all. An ordinary close, the regular session ending with no')
  w('halt, is not a stoppage and is counted separately below.')
  w()
  w('Each time is a tick. A start or end reads "A – B": the tick at A had not seen')
  w('the change and the tick at B had, so it happened between them. Ticks are')
  w('about 45 seconds apart, and a wider gap means no tick completed in between. A')
  w('stoppage in force at a symbol\'s first tick began before the log did, and one')
  w('still in force at its last tick has not ended in it; either way its length is')
  w('a lower bound.')
  w()
  w('Notices: BELL keeps no list of participants, and notified none of them')
  w('individually. Each stoppage was public from the tick that first saw it, as the')
  w('session attestation on chain, linked below where that tick pushed one, and on')
  w('the page, which reads that attestation.')
  w()
  if (list.length === 0) {
    w('No stoppage in this window: no tick attested a halt for any symbol.')
  } else {
    w('| symbol | halt | reason | started (UTC) | ended (UTC) | lasted | how it ended | attested |')
    w('|---|---|---|---|---|---|---|---|')
    for (const s of list) {
      const started =
        s.start === null
          ? 'before the log shows'
          : s.startAfter === null
            ? `in force at its first tick, ${iso(s.start)}`
            : between(s.startAfter, s.start)
      const ended = s.end === null ? `not in the log; still in force at ${iso(s.lastSeen)}` : between(s.endAfter, s.end)
      const l = lasted(s)
      const length = l ? `${l.atLeast ? 'at least ' : ''}${duration(l.seconds)}` : '—'
      const how =
        s.end === null
          ? '—'
          : `${s.resumedOpen ? 'trading resumed' : 'lifted with the market closed'}: ${s.endReason}`
      const kinds = s.kinds.map((k) => HALTS[k] ?? `halt ${k}`).join(' → ')
      const sigs = [attestation(s.startSignature, cluster), ...(s.end === null ? [] : [attestation(s.endSignature, cluster)])]
      w(
        `| ${s.symbol} | ${kinds} | ${cell(s.reasons.join('; then '))} | ${started} | ${ended} | ` +
          `${length} | ${cell(how)} | ${sigs.join(' → ')} |`,
      )
    }
  }
  w()
  w('Per symbol, with the ordinary closes kept apart:')
  w()
  w('| symbol | stoppages | time stopped | ordinary closes, not stoppages |')
  w('|---|---|---|---|')
  const symbols = [...new Set([...ordinaryCloses.keys(), ...list.map((s) => s.symbol)])].sort()
  for (const sym of symbols) {
    const mine = list.filter((s) => s.symbol === sym)
    const spans = mine.map(lasted).filter((l): l is NonNullable<typeof l> => l !== null)
    const total = spans.reduce((n, l) => n + l.seconds, 0)
    const atLeast = spans.some((l) => l.atLeast) || spans.length < mine.length
    const time = mine.length === 0 ? '—' : `${atLeast ? 'at least ' : ''}${duration(total)}`
    w(`| ${sym} | ${mine.length} | ${time} | ${ordinaryCloses.get(sym) ?? 0} |`)
  }
  return lines
}

/**
 * The report itself. Run only when this file is the entry point, so a test can
 * import the pure functions above without opening a database or writing a file.
 */
function main(): void {
  const db = new Database(process.env.BELL_DB ?? 'data/bell.db', { readonly: true })

  const one = <T>(sql: string, ...a: unknown[]) => db.prepare(sql).get(...a) as T
  const many = <T>(sql: string, ...a: unknown[]) => db.prepare(sql).all(...a) as T[]

  // A tick writes one row per symbol, so rows and ticks are different counts:
  // the first version of this report called 567 ticks of nine symbols "5103
  // ticks". Every row of a tick carries the same `at`.
  const span = one<{ lo: number; hi: number; n: number; ticks: number }>(
    'SELECT MIN(at) lo, MAX(at) hi, COUNT(*) n, COUNT(DISTINCT at) ticks FROM ticks',
  )
  if (!span.n) {
    console.error('no ticks recorded yet — run scripts/keeper.ts first')
    process.exit(1)
  }

  const hours = ((span.hi - span.lo) / 3600).toFixed(1)

  const perSymbol = many<{
    symbol: string
    issuer: string
    n: number
    open: number
    pushes: number
  }>(`SELECT symbol, issuer, COUNT(*) n, SUM(open_now) open, SUM(pushed) pushes
      FROM ticks GROUP BY symbol ORDER BY symbol`)

  const byConfidence = many<{ confidence: string; n: number }>(
    'SELECT confidence, COUNT(*) n FROM ticks GROUP BY confidence ORDER BY n DESC',
  )

  const transitions = many<{
    at: number
    symbol: string
    from_open: number
    to_open: number
    from_halt: number
    to_halt: number
    detail: string
  }>('SELECT * FROM transitions ORDER BY at')

  /**
   * Ticks where the two session sources disagreed, split by direction. The two
   * directions are different facts and cannot share one caption: an issuer that
   * will not trade while the market does is what a halt looks like, while an
   * issuer trading while the market is shut is a 24/5 wrapper at night, which
   * Backed's tokens are on every weeknight. Counted together, the first
   * version of this report put every overnight tick of five symbols under a
   * caption about halts.
   */
  const disagreements = many<{ symbol: string; issuer_out: number; issuer_on: number }>(
    `SELECT symbol,
       SUM(CASE WHEN pyth_open = 1 AND issuer_open = 0 THEN 1 ELSE 0 END) issuer_out,
       SUM(CASE WHEN pyth_open = 0 AND issuer_open = 1 THEN 1 ELSE 0 END) issuer_on
     FROM ticks
     WHERE pyth_open IS NOT NULL AND issuer_open IS NOT NULL AND pyth_open != issuer_open
     GROUP BY symbol ORDER BY issuer_out DESC, issuer_on DESC, symbol`,
  )

  const refused = one<{ n: number }>('SELECT COUNT(*) n FROM ticks WHERE open_now = 0')

  const lines: string[] = []
  const w = (s = '') => lines.push(s)

  w('# Evidence')
  w()
  // Say where the log came from. The same generator runs against a local
  // validator's log and the hosted keeper's, and those are different claims — a
  // header that named the wrong one would be the evidence file lying about itself.
  const dbPath = process.env.BELL_DB ?? 'data/bell.db'
  const cluster = process.env.BELL_CLUSTER ?? 'localnet'
  const where = process.env.RAILWAY_SERVICE_NAME
    ? `the hosted keeper's tick log on ${cluster} (Railway service \`${process.env.RAILWAY_SERVICE_NAME}\`, \`${dbPath}\`)`
    : `\`${dbPath}\` (${cluster})`
  w(`Generated from ${where} by \`scripts/evidence.ts\`. Every number below is`)
  w('counted from the tick log, not written by hand.')
  w()
  w(
    `**Observation window:** ${iso(span.lo)} → ${iso(span.hi)} UTC ` +
      `(${hours}h, ${plural(span.ticks, 'tick')}, ${plural(span.n, 'symbol-observation')})`,
  )
  w()

  w('## Per symbol')
  w()
  w('| symbol | issuer | ticks | tradeable | refused | session pushes |')
  w('|---|---|---|---|---|---|')
  for (const r of perSymbol) {
    const pct = ((r.open / r.n) * 100).toFixed(0)
    w(`| ${r.symbol} | ${r.issuer} | ${r.n} | ${r.open} (${pct}%) | ${r.n - r.open} | ${r.pushes} |`)
  }
  w()
  w(`Across the window, **${refused.n} of ${span.n}** symbol-observations were not tradeable.`)
  w()

  w('## Confidence')
  w()
  w('How much corroboration each verdict had. `degraded` means a single source —')
  w('for a non-US listing no `Equity.US.*` Pyth feed exists, so there is nothing to')
  w('confirm against and the log says so rather than implying agreement.')
  w()
  w('| confidence | symbol-observations |')
  w('|---|---|')
  for (const c of byConfidence) w(`| ${c.confidence} | ${c.n} |`)
  w()

  w('## Source disagreement')
  w()
  if (disagreements.length === 0) {
    w('No tick had Pyth and the issuer disagreeing about the session.')
  } else {
    w('Ticks where Pyth and the issuer disagreed about whether the session was open,')
    w('in each direction.')
    w()
    w('- **Market open, issuer not trading.** Not noise to be smoothed over: this is')
    w('  how a halt shows up when nobody publishes a reason code. It is not only that,')
    w('  since anything that stops the issuer\'s token during the session reads the')
    w('  same way; the transitions below give the verdict each time it changed.')
    w('- **Market closed, issuer trading.** An issuer whose token trades around the')
    w('  clock while the primary market is shut. Expected every weeknight for a 24/5')
    w('  wrapper, and not a halt; the gate refuses those ticks because the market is')
    w('  closed.')
    w()
    w('| symbol | market open, issuer not trading | market closed, issuer trading |')
    w('|---|---|---|')
    for (const d of disagreements) w(`| ${d.symbol} | ${d.issuer_out} | ${d.issuer_on} |`)
  }
  w()

  w('## Transitions')
  w()
  if (transitions.length === 0) {
    w('No state change observed in this window.')
  } else {
    w('| when (UTC) | symbol | change | reason |')
    w('|---|---|---|---|')
    for (const t of transitions) {
      const open = `${t.from_open ? 'open' : 'closed'} → ${t.to_open ? 'open' : 'closed'}`
      const halt =
        t.from_halt !== t.to_halt ? `, halt ${HALTS[t.from_halt]} → ${HALTS[t.to_halt]}` : ''
      w(`| ${iso(t.at)} | ${t.symbol} | ${open}${halt} | ${t.detail} |`)
    }
  }
  w()

  // The stoppage record reads the same transitions, with each one's previous
  // tick and the attestation it pushed joined on, and each symbol's first and
  // last tick, so that a stop already in force when the log began is not missed.
  const spans = many<{
    symbol: string
    first_at: number
    first_halt: number
    first_detail: string
    first_signature: string | null
    last_at: number
  }>(
    `SELECT f.symbol, f.at first_at, f.halt first_halt, f.detail first_detail,
       CASE WHEN f.pushed = 1 THEN f.signature END first_signature,
       (SELECT MAX(t.at) FROM ticks t WHERE t.symbol = f.symbol) last_at
     FROM ticks f WHERE f.id IN (SELECT MIN(id) FROM ticks GROUP BY symbol)
     ORDER BY f.symbol`,
  ).map((r): SymbolSpan => ({
    symbol: r.symbol,
    firstAt: r.first_at,
    firstHalt: r.first_halt,
    firstDetail: r.first_detail,
    firstSignature: r.first_signature,
    lastAt: r.last_at,
  }))
  const joined = many<{
    at: number
    symbol: string
    from_open: number
    to_open: number
    from_halt: number
    to_halt: number
    detail: string
    prev_at: number | null
    signature: string | null
  }>(
    `SELECT tr.at, tr.symbol, tr.from_open, tr.to_open, tr.from_halt, tr.to_halt, tr.detail,
       (SELECT MAX(t.at) FROM ticks t WHERE t.symbol = tr.symbol AND t.at < tr.at) prev_at,
       (SELECT t.signature FROM ticks t WHERE t.symbol = tr.symbol AND t.at = tr.at AND t.pushed = 1) signature
     FROM transitions tr ORDER BY tr.at, tr.id`,
  ).map((r): TransitionIn => ({
    at: r.at,
    symbol: r.symbol,
    fromOpen: r.from_open === 1,
    toOpen: r.to_open === 1,
    fromHalt: r.from_halt,
    toHalt: r.to_halt,
    detail: r.detail,
    prevAt: r.prev_at,
    signature: r.signature,
  }))
  const record = stoppages(spans, joined)
  for (const l of renderStoppages(record, cluster)) w(l)
  w()

  w('## What a night buyer would have paid')
  w()
  const signed = (bps: number) => `${bps > 0 ? '+' : ''}${bps.toFixed(1)} bps`
  const hasMarks = one<{ n: number }>(
    "SELECT COUNT(*) n FROM sqlite_master WHERE type = 'table' AND name = 'marks'",
  ).n
  const marks = hasMarks
    ? many<MarkSample>('SELECT symbol, observed_at observedAt, price FROM marks ORDER BY observed_at, id')
    : []
  if (!hasMarks) {
    w('No overnight data yet: this log predates mark recording.')
  } else if (marks.length === 0) {
    w('No overnight data yet: no marks recorded. Only marks that landed on chain')
    w('are recorded, so a dry run adds none.')
  } else {
    // One row per tick, saying whether any source had the regular session open
    // or closed. Backed's own flag is left out: its wrapper trades 24/5, so it
    // says open on a holiday. Backpack's flag is its holiday-aware calendar.
    const sessions = many<{ at: number; said_open: number; said_closed: number }>(
      `SELECT at,
         MAX(CASE WHEN pyth_open = 1 OR (issuer = 'backpack' AND issuer_open = 1) THEN 1 ELSE 0 END) said_open,
         MAX(CASE WHEN pyth_open = 0 OR (issuer = 'backpack' AND issuer_open = 0) THEN 1 ELSE 0 END) said_closed
       FROM ticks GROUP BY at`,
    ).map((r): SessionSample => ({ at: r.at, saidOpen: r.said_open === 1, saidClosed: r.said_closed === 1 }))
    const holidays = closedWeekdays(sessions)
    const night = nightVsOpen(marks, holidays)
    const sources = many<{ source: string }>('SELECT DISTINCT source FROM marks ORDER BY source').map((r) => r.source)

    w('Every mark the keeper saw confirmed on chain while the US regular session was')
    w('closed, from 16:00 ET until 09:30 ET on the next trading day, is compared with')
    w("the same symbol's first mark from 09:35 to 10:00 ET that trading morning, five")
    w('minutes in so that the pool has had time to be arbitraged against a market')
    w('that is trading again. A weekend or a holiday is part of the night it falls')
    w('in. On an early-close day the hours from the early close to 16:00 ET are')
    w('left out, counted as neither night nor open. Positive means the night buyer')
    w('would have paid more per share: +50 bps is 0.5% more, so the same dollars')
    w('would have bought about 0.5% fewer shares. The median and the worst are taken')
    w('over every sample, not per night, so a weekend, being longer, weighs more than')
    w('a weeknight.')
    w()
    w('What this measures is what the same dollars would have bought at night against')
    w('at the open: the gap a buyer who traded the pool overnight saw against one who')
    w('waited, which is what BELL makes them do. It includes genuine overnight news')
    w('as well as pool staleness, and nothing here can tell the two apart, so it is')
    w('not a measure of mispricing alone. A mark is an executable quote at a fixed')
    w('reference size, not a fill, and a larger order moves the pool further at any')
    w(`hour. Marks came from: ${sources.join(', ')}.`)
    w()
    w('A night counts for a symbol only when the log covers both ends of it: a mark')
    w('during the regular session before it, and one from 09:35 to 10:00 ET the next')
    w('trading morning. A weekday counts as a holiday only when some tick between')
    w('09:35 and 15:30 ET that day saw the session closed and none saw it open.')
    w()
    if (night.bySymbol.length === 0) {
      w('No complete overnight window in the log yet, so there is no number to print:')
      w(`the ${marks.length} marks recorded so far do not cover any night at both ends.`)
    } else {
      const first = night.nights[0]
      const last = night.nights[night.nights.length - 1]
      w(
        `${plural(night.nights.length, 'night')}, ending at the opens of ` +
          `${first}${first === last ? '' : ` through ${last}`} (ET).`,
      )
      if (holidays.size) w(`Weekday holidays seen in the log: ${[...holidays].sort().join(', ')}.`)
      w()
      w('| symbol | nights | samples | median | worst | direction |')
      w('|---|---|---|---|---|---|')
      for (const r of night.bySymbol) {
        const direction =
          r.medianBps > 0
            ? `dearer at night (${r.paidMore} of ${r.samples})`
            : r.medianBps < 0
              ? `cheaper at night (${r.paidLess} of ${r.samples})`
              : `even (${r.paidMore} dearer, ${r.paidLess} cheaper)`
        w(`| ${r.symbol} | ${r.nights} | ${r.samples} | ${signed(r.medianBps)} | ${signed(r.worstBps)} | ${direction} |`)
      }
    }
    if (night.unmatched > 0) {
      w()
      w(`${plural(night.unmatched, 'overnight mark')} left out because the log did not cover that night at both ends.`)
    }
  }
  w()

  writeFileSync('EVIDENCE.md', lines.join('\n') + '\n')
  console.log(
    `EVIDENCE.md written — ${plural(span.ticks, 'tick')} (${plural(span.n, 'symbol-observation')}), ` +
      `${plural(transitions.length, 'transition')}, ${plural(record.stoppages.length, 'stoppage')}, ${plural(marks.length, 'mark')}`,
  )
}

if (import.meta.main) main()
