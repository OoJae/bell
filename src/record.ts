/**
 * The evidence log.
 *
 * BELL's central claim is that refusing a trade is worth something, and that
 * claim is only as good as the record behind it. Every tick is written here
 * with each source's raw reading, so a verdict can be reconstructed after the
 * fact and a disagreement between sources can be explained rather than
 * asserted.
 *
 * It also holds the honest counterfactual: when the gate refuses, what would
 * the trade have cost. If that number turns out small, EVIDENCE.md should say
 * so. Every mark the keeper lands is kept for that reason; `nightVsOpen`
 * below turns them into the figure the report prints.
 */
import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export interface TickRow {
  at: number
  symbol: string
  mint: string
  issuer: string
  openNow: boolean
  halt: number
  confidence: string
  detail: string
  /** Raw source readings, so a verdict is always reconstructable. */
  pythOpen: boolean | null
  issuerOpen: boolean | null
  issuerHalted: boolean | null
  exchangeHalt: number | null
  pushed: boolean
  signature: string | null
}

/** One mark as it landed on chain. */
export interface MarkRow {
  /** The tick it was pushed in; joins `ticks.at`. */
  at: number
  /** The `observed_at` it attested, on the cluster's clock. */
  observedAt: number
  symbol: string
  /** Quote units (USDC) per share as `pxNum × 10^pxExpo`, multiplier applied. */
  pxNum: bigint
  pxExpo: number
  confBps: number
  /** The `MarkSource` by name, e.g. `Jupiter`. */
  source: string
  rateQ64: bigint
  /** The transaction that carried it. */
  signature: string | null
}

export interface TransitionRow {
  at: number
  symbol: string
  fromOpen: boolean
  toOpen: boolean
  fromHalt: number
  toHalt: number
  detail: string
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS ticks (
  id INTEGER PRIMARY KEY,
  at INTEGER NOT NULL,
  symbol TEXT NOT NULL,
  mint TEXT NOT NULL,
  issuer TEXT NOT NULL,
  open_now INTEGER NOT NULL,
  halt INTEGER NOT NULL,
  confidence TEXT NOT NULL,
  detail TEXT NOT NULL,
  pyth_open INTEGER,
  issuer_open INTEGER,
  issuer_halted INTEGER,
  exchange_halt INTEGER,
  pushed INTEGER NOT NULL,
  signature TEXT
);
CREATE INDEX IF NOT EXISTS ticks_at ON ticks (at);
CREATE INDEX IF NOT EXISTS ticks_symbol ON ticks (symbol, at);

CREATE TABLE IF NOT EXISTS transitions (
  id INTEGER PRIMARY KEY,
  at INTEGER NOT NULL,
  symbol TEXT NOT NULL,
  from_open INTEGER NOT NULL,
  to_open INTEGER NOT NULL,
  from_halt INTEGER NOT NULL,
  to_halt INTEGER NOT NULL,
  detail TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS transitions_at ON transitions (at);

-- Added after the hosted log already held rows, which is why every statement
-- here is IF NOT EXISTS: opening an existing log adds this table and touches
-- nothing else. The two big integers are TEXT because SQLite's INTEGER is a
-- signed 64-bit value: rate_q64 is a u128 and px_num a u64, and a log that
-- could not hold what was attested would be no record of it. price is
-- px_num × 10^px_expo, kept alongside so a reader can compare prices in SQL
-- without redoing that arithmetic.
CREATE TABLE IF NOT EXISTS marks (
  id INTEGER PRIMARY KEY,
  at INTEGER NOT NULL,
  observed_at INTEGER NOT NULL,
  symbol TEXT NOT NULL,
  price REAL NOT NULL,
  px_num TEXT NOT NULL,
  px_expo INTEGER NOT NULL,
  conf_bps INTEGER NOT NULL,
  source TEXT NOT NULL,
  rate_q64 TEXT NOT NULL,
  signature TEXT
);
CREATE INDEX IF NOT EXISTS marks_symbol ON marks (symbol, observed_at);
`

export class Recorder {
  private db: Database.Database
  private insertTick: Database.Statement
  private insertTransition: Database.Statement
  private insertMark: Database.Statement
  private lastState = new Map<string, { openNow: boolean; halt: number }>()

  constructor(path = process.env.BELL_DB ?? 'data/bell.db') {
    mkdirSync(dirname(path), { recursive: true })
    const db = new Database(path)
    try {
      // WAL so a reader (the evidence report) never blocks the keeper.
      db.pragma('journal_mode = WAL')
      db.exec(SCHEMA)
    } catch (e) {
      // The keeper retries a log that will not open on every tick. Without
      // this, each retry that got as far as opening the file would leave its
      // handle behind, one every 45 seconds for as long as the fault lasts.
      db.close()
      throw e
    }
    this.db = db
    this.insertTick = this.db.prepare(`
      INSERT INTO ticks (at, symbol, mint, issuer, open_now, halt, confidence, detail,
                         pyth_open, issuer_open, issuer_halted, exchange_halt, pushed, signature)
      VALUES (@at, @symbol, @mint, @issuer, @openNow, @halt, @confidence, @detail,
              @pythOpen, @issuerOpen, @issuerHalted, @exchangeHalt, @pushed, @signature)
    `)
    this.insertTransition = this.db.prepare(`
      INSERT INTO transitions (at, symbol, from_open, to_open, from_halt, to_halt, detail)
      VALUES (@at, @symbol, @fromOpen, @toOpen, @fromHalt, @toHalt, @detail)
    `)
    this.insertMark = this.db.prepare(`
      INSERT INTO marks (at, observed_at, symbol, price, px_num, px_expo, conf_bps, source, rate_q64, signature)
      VALUES (@at, @observedAt, @symbol, @price, @pxNum, @pxExpo, @confBps, @source, @rateQ64, @signature)
    `)
    for (const row of this.db
      .prepare(
        `SELECT symbol, open_now, halt FROM ticks WHERE id IN
           (SELECT MAX(id) FROM ticks GROUP BY symbol)`,
      )
      .all() as Array<{ symbol: string; open_now: number; halt: number }>) {
      this.lastState.set(row.symbol, { openNow: row.open_now === 1, halt: row.halt })
    }
  }

  private static bit(v: boolean | null | undefined): number | null {
    return v === null || v === undefined ? null : v ? 1 : 0
  }

  /** Write one tick, and a transition row if the state actually moved. */
  record(rows: TickRow[]): TransitionRow[] {
    const transitions: TransitionRow[] = []
    // Staged, and applied only once the transaction commits. Updated in place,
    // a write that failed half way would roll back the rows but keep the new
    // state, and the next tick would miss a transition that really happened.
    const next = new Map(this.lastState)
    const write = this.db.transaction((batch: TickRow[]) => {
      for (const r of batch) {
        this.insertTick.run({
          ...r,
          openNow: Recorder.bit(r.openNow),
          pushed: Recorder.bit(r.pushed),
          pythOpen: Recorder.bit(r.pythOpen),
          issuerOpen: Recorder.bit(r.issuerOpen),
          issuerHalted: Recorder.bit(r.issuerHalted),
        })
        const prev = next.get(r.symbol)
        if (prev && (prev.openNow !== r.openNow || prev.halt !== r.halt)) {
          const t: TransitionRow = {
            at: r.at,
            symbol: r.symbol,
            fromOpen: prev.openNow,
            toOpen: r.openNow,
            fromHalt: prev.halt,
            toHalt: r.halt,
            detail: r.detail,
          }
          this.insertTransition.run({
            ...t,
            fromOpen: Recorder.bit(t.fromOpen),
            toOpen: Recorder.bit(t.toOpen),
          })
          transitions.push(t)
        }
        next.set(r.symbol, { openNow: r.openNow, halt: r.halt })
      }
    })
    write(rows)
    this.lastState = next
    return transitions
  }

  /** Write the marks one tick landed, all or none. */
  recordMarks(rows: MarkRow[]): void {
    const write = this.db.transaction((batch: MarkRow[]) => {
      for (const r of batch) {
        this.insertMark.run({
          ...r,
          price: Number(r.pxNum) * 10 ** r.pxExpo,
          pxNum: r.pxNum.toString(),
          rateQ64: r.rateQ64.toString(),
        })
      }
    })
    write(rows)
  }

  counts() {
    const n = (table: string) => (this.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get() as { n: number }).n
    return { ticks: n('ticks'), transitions: n('transitions'), marks: n('marks') }
  }

  close() {
    this.db.close()
  }
}

// ------------------------------------------------------------ night vs open
//
// Pure from here down: no database, no clock of its own. The report feeds these
// rows it read, and the tests feed them fixtures.

/** One mark, as far as the overnight comparison needs it. */
export interface MarkSample {
  symbol: string
  /** Unix seconds: the `observed_at` the mark attested. */
  observedAt: number
  /** Quote units per share. */
  price: number
}

export interface NightStats {
  symbol: string
  /** Nights this symbol had covered at both ends. */
  nights: number
  samples: number
  /** Night price against the next open's, in bps. Positive: the night buyer would have paid more. */
  medianBps: number
  /** The deviation furthest from zero, signed. */
  worstBps: number
  /** Samples where the night buyer would have paid more per share than at the open. */
  paidMore: number
  /** Samples where they paid less. */
  paidLess: number
}

export interface NightReport {
  /** The ET date of each open that ended a covered night, oldest first. */
  nights: string[]
  bySymbol: NightStats[]
  /** Overnight marks left out because their night was not covered at both ends. */
  unmatched: number
}

const OPEN = 9 * 60 + 30
const CLOSE = 16 * 60
/**
 * The reference is the first mark at or after 09:35, not 09:30. The pools do
 * not reprice the instant the bell rings; five minutes in, they have been
 * arbitraged against a market that is trading again.
 */
const REFERENCE_FROM = 9 * 60 + 35
/**
 * And no later than 10:00. The keeper marks every 45 seconds, so a first mark
 * later than this means it was down at the open, and a comparison against it
 * would measure the morning's drift rather than the open.
 */
const REFERENCE_UNTIL = 10 * 60

const easternFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  weekday: 'short',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
})
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/**
 * An instant's wall clock in New York: date, weekday (0 is Sunday) and minute
 * of the day.
 *
 * From the IANA database rather than an offset, because the offset is -4 for
 * eight months of the year and -5 for the other four, and a fixed one puts
 * every winter mark an hour off — a pre-market mark would read as the open.
 */
export function eastern(unix: number): { date: string; weekday: number; minute: number } {
  const parts = easternFormat.formatToParts(new Date(unix * 1000))
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? ''
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    weekday: WEEKDAYS.indexOf(get('weekday')),
    // Some ICU versions render midnight as "24" even in h23.
    minute: (Number(get('hour')) % 24) * 60 + Number(get('minute')),
  }
}

/**
 * Calendar arithmetic on a `YYYY-MM-DD` date. UTC here is only a frame for
 * counting days, not a timezone: the date is already New York's.
 */
function addDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10)
}

function isTradingDay(date: string, holidays: ReadonlySet<string>): boolean {
  const [y, m, d] = date.split('-').map(Number)
  const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay()
  return weekday >= 1 && weekday <= 5 && !holidays.has(date)
}

function stepTradingDay(date: string, direction: 1 | -1, holidays: ReadonlySet<string>): string {
  let d = addDays(date, direction)
  while (!isTradingDay(d, holidays)) d = addDays(d, direction)
  return d
}

function median(sorted: readonly number[]): number {
  const mid = sorted.length >> 1
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/**
 * What a night buyer would have paid, against what the same dollars bought at the open.
 *
 * Every mark taken while the US regular session was closed — after 16:00 ET
 * until 09:30 ET on the next trading day, so a whole weekend or holiday is one
 * night — is compared with that symbol's first mark from 09:35 to 10:00 ET on
 * the trading morning that ended its night. That morning is the next *trading*
 * day, found by stepping over weekends and `holidays`, not the calendar's next
 * day: Friday's night ends on Monday, and a night before a Monday holiday ends
 * on Tuesday.
 *
 * A night counts for a symbol only when the log covers both ends of it: a mark
 * during the regular session that closed it, and the reference at the next
 * open. A keeper that started at 3am saw only the hours nearest the open,
 * where prices have had the least time to drift from it, and counting those
 * alone would flatter the median.
 *
 * `holidays` holds weekday dates (ET, `YYYY-MM-DD`) on which the session did
 * not open. Early closes are not modelled: the hours between an early close
 * and 16:00 are neither night nor reference, so they are left out rather than
 * counted as something they are not.
 */
export function nightVsOpen(
  marks: readonly MarkSample[],
  holidays: ReadonlySet<string> = new Set(),
): NightReport {
  const bySymbol = new Map<string, MarkSample[]>()
  for (const m of marks) {
    if (!(m.price > 0) || !Number.isFinite(m.price)) continue
    const list = bySymbol.get(m.symbol) ?? []
    list.push(m)
    bySymbol.set(m.symbol, list)
  }

  // All nine marks of a tick attest the same instant, so one conversion serves
  // them all. Intl is most of this function's cost on a month-long log.
  const clock = new Map<number, ReturnType<typeof eastern>>()
  const easternOf = (unix: number) => {
    let c = clock.get(unix)
    if (!c) clock.set(unix, (c = eastern(unix)))
    return c
  }

  const nights = new Set<string>()
  const stats: NightStats[] = []
  let unmatched = 0
  for (const [symbol, list] of [...bySymbol].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    list.sort((a, b) => a.observedAt - b.observedAt)
    /** Trading days on which this symbol has a mark during the regular session. */
    const inSession = new Set<string>()
    /** Trading day -> the first reference price that morning. */
    const reference = new Map<string, number>()
    /** The trading day whose open ends the night -> prices marked that night. */
    const byNight = new Map<string, number[]>()

    for (const m of list) {
      const { date, minute } = easternOf(m.observedAt)
      const trading = isTradingDay(date, holidays)
      if (trading && minute >= OPEN && minute < CLOSE) {
        inSession.add(date)
        if (minute >= REFERENCE_FROM && minute < REFERENCE_UNTIL && !reference.has(date)) {
          reference.set(date, m.price)
        }
        continue
      }
      const open = trading && minute < OPEN ? date : stepTradingDay(date, 1, holidays)
      const prices = byNight.get(open) ?? []
      prices.push(m.price)
      byNight.set(open, prices)
    }

    const bps: number[] = []
    let covered = 0
    for (const [open, prices] of byNight) {
      const ref = reference.get(open)
      if (ref === undefined || !inSession.has(stepTradingDay(open, -1, holidays))) {
        unmatched += prices.length
        continue
      }
      covered++
      nights.add(open)
      for (const p of prices) bps.push((p / ref - 1) * 10_000)
    }
    if (bps.length === 0) continue

    const sorted = [...bps].sort((a, b) => a - b)
    stats.push({
      symbol,
      nights: covered,
      samples: bps.length,
      medianBps: median(sorted),
      worstBps: bps.reduce((w, x) => (Math.abs(x) > Math.abs(w) ? x : w), 0),
      paidMore: bps.filter((x) => x > 0).length,
      paidLess: bps.filter((x) => x < 0).length,
    })
  }

  return { nights: [...nights].sort(), bySymbol: stats, unmatched }
}

/** What one tick's sources said about the US regular session, across all symbols. */
export interface SessionSample {
  at: number
  /** At least one source said the session was open. */
  saidOpen: boolean
  /** At least one source said it was closed. */
  saidClosed: boolean
}

/**
 * The part of the session a holiday is judged on: clear of the minutes where a
 * source lags either bell, and starting with the reference window rather than
 * after it. Every mark `nightVsOpen` takes as a reference was pushed by a tick
 * inside this span, so a weekday that supplies a reference has also been
 * checked for being a holiday. Starting at 10:00 left a gap: a keeper that
 * watched a holiday's 09:35 and then went down read the day as trading, and the
 * night before it was compared against a holiday-morning mark, which is itself
 * a night price.
 */
const JUDGED_FROM = REFERENCE_FROM
const JUDGED_UNTIL = 15 * 60 + 30

/**
 * Weekdays on which the regular session did not open, read from the tick log
 * so that the holidays `nightVsOpen` steps over are the ones the keeper saw.
 *
 * Positive evidence only: a weekday is a holiday when, between 09:35 and 15:30
 * ET, some source said closed and none said open. A weekday it did not watch
 * stays a trading day, and since it has no ticks it has no reference either,
 * so the night before it is dropped, where calling the day a holiday would
 * have compared that night against the open a day later.
 */
export function closedWeekdays(samples: readonly SessionSample[]): Set<string> {
  const open = new Set<string>()
  const closed = new Set<string>()
  for (const s of samples) {
    const { date, weekday, minute } = eastern(s.at)
    if (weekday < 1 || weekday > 5 || minute < JUDGED_FROM || minute >= JUDGED_UNTIL) continue
    if (s.saidOpen) open.add(date)
    else if (s.saidClosed) closed.add(date)
  }
  return new Set([...closed].filter((d) => !open.has(d)))
}
