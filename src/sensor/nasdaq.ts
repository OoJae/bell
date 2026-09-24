/**
 * Nasdaq's public quote pages, with Yahoo behind them: the checker's inputs.
 *
 * The checker is a second opinion on the keeper, so it reads sources the
 * keeper does not. The keeper decides the session from Pyth's market hours,
 * Backed's feed, Backpack's calendar and the local NYSE table, and prices from
 * a Jupiter quote. None of those are here. What is here is what the US market
 * itself says: whether the regular session is open, and each underlying's
 * reference price.
 *
 * The reference depends on the session. In the regular session it is the last
 * sale. Outside it, it is the regular session's official close, never an
 * extended-hours print: those come from a thin book and can be far from the
 * market. Nasdaq's last sale for SPY read $714.68 at 16:56 ET on 24 September
 * 2026, 6.8% under the day's close, and a night fill judged against that
 * would have been judged against nothing the market agreed on.
 *
 * Two endpoints on Nasdaq, both public and keyless:
 *
 * - `/api/market-info` says which session the US market is in. One call a pass.
 * - `/api/quote/{T}/info` gives each name's last sale, when it printed, and
 *   the session label again. Outside the session it also gives the official
 *   close, stamped "Closed at Sep 24, 2026 4:00 PM ET".
 *
 * Yahoo's chart endpoint stands in for a name only when Nasdaq gives no
 * reading for it, and every reading says which source it came from and
 * whether it is a last sale or a close.
 *
 * What a reading is not: a settlement price. Neither endpoint documents where
 * its last sale comes from or promises the consolidated tape, so either can be
 * a trade or two away from the primary listing's last print. That is fine for
 * a band measured in basis points, and nothing here is used as more than that.
 *
 * Parsing is strict. A price or a time that is not in the exact form seen in
 * the captured samples (test/fixtures/nasdaq-*, yahoo-*) gives no reading at
 * all. A reading with the wrong time would make a stale price look fresh, and
 * a close is only a close at an instant the local calendar says a regular
 * session ended.
 */
import { isRegularOpen } from '../policy/calendar.ts'

const NASDAQ = 'https://api.nasdaq.com/api'
const YAHOO = 'https://query1.finance.yahoo.com/v8/finance/chart'
/** Nasdaq took 2 to 4.5 seconds to answer when measured on 2026-09-24. */
const TIMEOUT_MS = 15_000

/**
 * Browser-like headers, the set web/lib/reference.ts found Nasdaq needs: that
 * file records the endpoint stalling for eight seconds or more without the
 * language, origin and referer. Restated rather than imported, so the checker
 * shares no code path with the page.
 */
const NASDAQ_HEADERS = {
  'user-agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36',
  accept: 'application/json, text/plain, */*',
  'accept-language': 'en-US,en;q=0.9',
  origin: 'https://www.nasdaq.com',
  referer: 'https://www.nasdaq.com/',
}

/**
 * A bare user agent, on purpose. On 2026-09-24 Yahoo's edge answered the full
 * desktop Chrome string above with 429 "Too Many Requests" all three times it
 * was tried, including the first request of the day, and answered
 * `Mozilla/5.0` and Node's default agent with 200 in between.
 */
const YAHOO_HEADERS = { 'user-agent': 'Mozilla/5.0', accept: 'application/json' }

/**
 * Nasdaq files ETFs and stocks under different asset classes. Asked under the
 * wrong one it answers 200 with `data: null` and "Symbol not exists."
 */
const ETFS = new Set(['SPY', 'QQQ', 'IWM', 'JPST'])
export const assetClassOf = (underlying: string): 'etf' | 'stocks' =>
  ETFS.has(underlying) ? 'etf' : 'stocks'

/** Which part of the US trading day a source says it is. */
export type Session = 'regular' | 'pre' | 'after' | 'closed'
export type Source = 'nasdaq' | 'yahoo'

/**
 * What a price is: the last sale, which is the reference in the regular
 * session, or the regular session's official close, which is the reference
 * outside it.
 */
export type Kind = 'last' | 'close'

/** One underlying's price, as one source reported it. */
export interface Quote {
  underlying: string
  source: Source
  kind: Kind
  /** In dollars: the last sale, or for a close, the closing price. */
  last: number
  /**
   * When that sale printed, or the instant the session closed, in unix
   * milliseconds. Nasdaq prints the time to the minute, so for a Nasdaq last
   * sale this is the start of that minute, and an age read from it can be up
   * to 59 seconds more than the true age. A close is the exact instant.
   */
  lastAt: number
  /** The session this source said it was when asked. Null when it said something unrecognised. */
  session: Session | null
  /** Nasdaq's own `isRealTime`. Null for Yahoo, which does not say. */
  realTime: boolean | null
}

/**
 * What one source's answer for one underlying held: the session it named, its
 * last sale and the official close. Either price is null when the answer did
 * not carry it in a form read here, and at least one of them is present.
 */
export interface Quotes {
  source: Source
  session: Session | null
  last: Quote | null
  close: Quote | null
}

/** Nasdaq's market-wide session status. */
export interface MarketInfo {
  session: Session | null
  /** Nasdaq's own words, for the log. */
  label: string
}

// ------------------------------------------------------------------ parsers

/**
 * A session label → the session. Nasdaq writes "Open" on a quote and
 * "Market Open" in market-info; the pre- and after-hours labels are matched
 * with and without the hyphen. Anything else is null: an unknown label is no
 * opinion, never "open".
 */
export function sessionOf(label: unknown): Session | null {
  if (typeof label !== 'string') return null
  const s = label.trim().toLowerCase().replace(/[\s-]+/g, ' ')
  if (s === 'open' || s === 'market open') return 'regular'
  if (s === 'closed' || s === 'market closed') return 'closed'
  if (s === 'pre market' || s === 'premarket') return 'pre'
  if (s === 'after hours' || s === 'afterhours') return 'after'
  return null
}

/**
 * "$766.7494" or "$1,234.50" → dollars. Null for anything else, including zero
 * and "N/A". The whole string must match: "$12abc" is not $12.
 */
export function parseDollars(s: unknown): number | null {
  if (typeof s !== 'string') return null
  if (!/^\$(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?$/.test(s)) return null
  const n = Number(s.slice(1).replaceAll(',', ''))
  return Number.isFinite(n) && n > 0 ? n : null
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
/**
 * The hour may carry a leading zero. Quotes print "1:01 PM ET" (seen at 13:01
 * on 2026-09-24), but the same API's market-info prints "04:00 AM ET" and
 * "09:30 AM ET". The zero changes nothing about the instant, and refusing it
 * would hand every name to Yahoo from 1 PM to 10 AM if the quote ever took the
 * other form.
 */
const STAMP = /^([A-Z][a-z]{2}) ([1-9]|[12]\d|3[01]), (\d{4}) (1[0-2]|0?[1-9]):([0-5]\d) (AM|PM) ET$/

/**
 * Built once, and inside a try: a runtime without New York's zone data throws
 * here, and that must cost the checker its Nasdaq timestamps, not its life.
 */
const NY = (() => {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
  } catch {
    return null
  }
})()

/**
 * The instant New York's wall clock reads this date and time, in unix ms.
 *
 * Guess as though New York were UTC, read the wall clock at the guess, and move
 * by the difference, so daylight saving is the tz database's business. Null
 * when no instant reads that time, which is the hour skipped in March.
 */
function nyInstant(y: number, mo: number, d: number, h: number, mi: number): number | null {
  if (!NY) return null
  const target = Date.UTC(y, mo - 1, d, h, mi)
  let t = target
  for (let i = 0; i < 3; i++) {
    const parts = NY.formatToParts(new Date(t))
    const get = (k: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === k)?.value)
    const seen = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'))
    if (seen === target) return t
    t += target - seen
  }
  return null
}

/**
 * Nasdaq's "Sep 24, 2026 12:35 PM ET" → unix ms.
 *
 * Only that form, with or without a zero before a one-digit hour. After the close Nasdaq prints the date alone ("Sep 23,
 * 2026"), and that is refused rather than read as 16:00: the close is 13:00 on
 * an early-close day, and a guessed time is exactly what this must not do.
 * A date that does not exist (Sep 31) is refused too, rather than rolled into
 * the next month the way `Date` would.
 */
export function parseNasdaqTimestamp(s: unknown): number | null {
  if (typeof s !== 'string') return null
  const m = STAMP.exec(s)
  if (!m) return null
  const month = MONTHS.indexOf(m[1]) + 1
  if (month === 0) return null
  const [day, year, hour12, minute] = [Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5])]
  const probe = new Date(Date.UTC(year, month - 1, day))
  if (probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return null
  const hour = (hour12 % 12) + (m[6] === 'PM' ? 12 : 0)
  return nyInstant(year, month, day, hour, minute)
}

/**
 * Whether a regular session ends at exactly this instant, by the local
 * calendar: open the second before it and closed at it. True at 16:00 on a
 * trading day and at 13:00 on an early close, and at no other time; false on a
 * weekend or a holiday, and false when the calendar has no opinion.
 */
export function isSessionClose(ms: number): boolean {
  return isRegularOpen(new Date(ms - 1000)) === true && isRegularOpen(new Date(ms)) === false
}

/**
 * The latest instant at or before `ms` that a regular session ended, by the
 * local calendar, or null when the calendar cannot say: a date on the way back
 * that it has no opinion on, or none in ten New York dates, far more than the
 * longest run of closed days in the tables.
 */
export function lastSessionClose(ms: number): number | null {
  if (!NY) return null
  const parts = NY.formatToParts(new Date(ms))
  const get = (k: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === k)?.value)
  const [y, mo, d] = [get('year'), get('month'), get('day')]
  for (let back = 0; back <= 10; back++) {
    // Walked by calendar date, not by 24 hours, so a daylight-saving day is never skipped.
    const day = new Date(Date.UTC(y, mo - 1, d - back))
    // A day the calendar has no opinion on could have held a session it does not know of.
    const noon = nyInstant(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), 12, 0)
    if (noon === null || isRegularOpen(new Date(noon)) === null) return null
    for (const hour of [16, 13]) {
      const t = nyInstant(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), hour, 0)
      if (t !== null && t <= ms && isSessionClose(t)) return t
    }
  }
  return null
}

/**
 * How long before its session's end a print may be and still be taken as that
 * session's close: the program's bound on a session reference
 * (MAX_SESSION_REF_AGE_SECONDS, 300 s; test/nasdaq.test.ts holds the two
 * equal). Nasdaq's close is the closing instant itself. Yahoo's is its last
 * regular sale, stamped 16:00:00 when read after the close on 2026-09-24; one
 * stamped earlier than this is a feed that stopped during the session, and
 * its price is not the close.
 */
export const CLOSE_PRINT_S = 300

/**
 * Whether a close is the latest session's: the session that most recently
 * ended at or before `now` by the local calendar, printed no more than
 * `CLOSE_PRINT_S` before its end. Anything else is a previous day's close
 * still being served, or a print from before the close: never the night
 * reference, whatever its label says.
 */
export function isLatestClose(q: Quote, now: Date): boolean {
  const end = lastSessionClose(now.getTime())
  return end !== null && q.lastAt <= end && end - q.lastAt <= CLOSE_PRINT_S * 1000
}

const CLOSED_AT = 'Closed at '

/**
 * Nasdaq's close stamp, "Closed at Sep 24, 2026 4:00 PM ET" → the instant of
 * that close, in unix ms.
 *
 * The time after the prefix is read by `parseNasdaqTimestamp`, so a date with
 * no time is refused as it is there. And it must be an instant a regular
 * session actually ended (`isSessionClose`): 4:00 PM, or 1:00 PM on the day
 * after Thanksgiving and on Christmas Eve, on a day the market opened. A close
 * stamped at any other time is not believed, because its price would then be
 * whatever printed at that time, and the instant is what the program ages it
 * by.
 */
export function parseNasdaqClose(s: unknown): number | null {
  if (typeof s !== 'string' || !s.startsWith(CLOSED_AT)) return null
  const at = parseNasdaqTimestamp(s.slice(CLOSED_AT.length))
  return at !== null && isSessionClose(at) ? at : null
}

type Json = Record<string, unknown>
const obj = (v: unknown): Json | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null)

/** Nasdaq's envelope carries its own status; anything but 200 inside it is an error body. */
const nasdaqOk = (body: Json | null): boolean => {
  const code = obj(body?.status)?.rCode
  return code === undefined || code === 200
}

/**
 * Nasdaq's quote JSON → its last sale and its close, or null when it gives
 * neither in the known form. A body for a different symbol is null too: it
 * would be a true reading of the wrong thing.
 *
 * The two prices sit in two blocks. `primaryData` is the latest trade: in the
 * session a regular one, after it an extended-hours one ("Sep 24, 2026 5:57 PM
 * ET", marketStatus "After-Hours"). `secondaryData` is null in the session and
 * after it holds the official close, stamped "Closed at Sep 24, 2026 4:00 PM
 * ET" (both seen on 2026-09-24; test/fixtures/nasdaq-quote-*-after-hours).
 * A close is read from `secondaryData`, and from `primaryData` only if that
 * block carries the same "Closed at" stamp. That form has not been seen there;
 * it is read because the stamp says exactly what the price is, and it is
 * held to the same calendar check wherever it appears.
 */
export function parseNasdaqQuote(underlying: string, json: unknown): Quotes | null {
  const body = obj(json)
  if (!nasdaqOk(body)) return null
  const data = obj(body?.data)
  const p = obj(data?.primaryData)
  if (!data || !p) return null
  if (typeof data.symbol !== 'string' || data.symbol.toUpperCase() !== underlying.toUpperCase()) return null
  const session = sessionOf(data.marketStatus)
  const quote = (block: Json | null, kind: Kind, parseAt: (s: unknown) => number | null): Quote | null => {
    const last = parseDollars(block?.lastSalePrice)
    const lastAt = parseAt(block?.lastTradeTimestamp)
    if (last === null || lastAt === null) return null
    const realTime = typeof block?.isRealTime === 'boolean' ? block.isRealTime : null
    return { underlying, source: 'nasdaq', kind, last, lastAt, session, realTime }
  }
  const last = quote(p, 'last', parseNasdaqTimestamp)
  const close = quote(obj(data.secondaryData), 'close', parseNasdaqClose) ?? quote(p, 'close', parseNasdaqClose)
  if (!last && !close) return null
  return { source: 'nasdaq', session, last, close }
}

/**
 * Nasdaq's market-info JSON → the market-wide session.
 *
 * It carries the status twice, as `mrktStatus` ("Open") and `marketIndicator`
 * ("Market Open"). When both are recognised and disagree the session is null,
 * because Nasdaq contradicting itself is no opinion.
 */
export function parseMarketInfo(json: unknown): MarketInfo | null {
  const body = obj(json)
  if (!nasdaqOk(body)) return null
  const d = obj(body?.data)
  if (!d) return null
  const labels = [d.mrktStatus, d.marketIndicator].filter((l): l is string => typeof l === 'string')
  if (labels.length === 0) return null
  const seen = new Set(labels.map(sessionOf).filter((s) => s !== null))
  return {
    session: seen.size === 1 ? [...seen][0] : null,
    label: labels.join(' / '),
  }
}

const isWindow = (v: unknown): v is { start: number; end: number } => {
  const w = obj(v)
  return Number.isInteger(w?.start) && Number.isInteger(w?.end) && (w!.start as number) < (w!.end as number)
}

/**
 * Yahoo's chart JSON → its last sale and, outside the session, its close, with
 * the session read from its `currentTradingPeriod` at `now`.
 *
 * `regularMarketPrice` is the regular session's last sale, so outside the
 * session it is the close, not an extended-hours print: read at 18:00 ET on
 * 2026-09-24 it was $767.18 with `regularMarketTime` exactly 16:00:00
 * (test/fixtures/yahoo-chart-SPY-after-hours). `regularMarketTime` is unix
 * seconds, so this source's timestamps need no parsing.
 *
 * So the one pair is both prices, labelled by when it was read. It is the
 * close only when `now` is outside Yahoo's own regular period, and only when
 * it printed inside a regular session by the local calendar, up to and
 * including its last second (`isRegularOpen` a second before it). A time after
 * a close is an extended-hours print however Yahoo filed it, and is not
 * believed as one. A body whose trading periods cannot be read gives no
 * session, and so no close.
 *
 * Yahoo's trading period is for the day it last traded, and on a holiday that
 * can be the day before. The session it gives is only ever used together with
 * the local calendar, which knows the holidays.
 */
export function parseYahooChart(underlying: string, json: unknown, now: Date): Quotes | null {
  const chart = obj(obj(json)?.chart)
  if (!chart || chart.error != null || !Array.isArray(chart.result)) return null
  const meta = obj(obj(chart.result[0])?.meta)
  if (!meta) return null
  if (typeof meta.symbol !== 'string' || meta.symbol.toUpperCase() !== underlying.toUpperCase()) return null
  const last = meta.regularMarketPrice
  const at = meta.regularMarketTime
  if (typeof last !== 'number' || !Number.isFinite(last) || last <= 0) return null
  if (typeof at !== 'number' || !Number.isInteger(at) || at <= 0) return null

  let session: Session | null = null
  let outsideRegular = false
  const period = obj(meta.currentTradingPeriod)
  if (period && isWindow(period.pre) && isWindow(period.regular) && isWindow(period.post)) {
    const t = now.getTime() / 1000
    const inside = (w: { start: number; end: number }) => t >= w.start && t < w.end
    outsideRegular = !inside(period.regular)
    session = inside(period.regular) ? 'regular' : inside(period.pre) ? 'pre' : inside(period.post) ? 'after' : 'closed'
  }
  const sale = { underlying, source: 'yahoo' as const, last, lastAt: at * 1000, session, realTime: null }
  const printedInSession = isRegularOpen(new Date(at * 1000 - 1000)) === true
  return {
    source: 'yahoo',
    session,
    last: { ...sale, kind: 'last' },
    close: outsideRegular && printedInSession ? { ...sale, kind: 'close' } : null,
  }
}

/**
 * A last sale more than two minutes in the future is a timestamp read wrong,
 * whatever the parser thought. The slack covers Nasdaq's minute resolution
 * and a machine clock that runs a little slow.
 */
const FUTURE_SLACK_MS = 120_000

// ----------------------------------------------------------------- fetchers

async function getJson(url: string, headers: Record<string, string>): Promise<unknown> {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

/**
 * A price dated in the future is a timestamp read wrong, and a body with one
 * is not trusted for the other either. Throws, naming which it was.
 */
function notFuture(q: Quotes, now: Date): Quotes {
  const limit = now.getTime() + FUTURE_SLACK_MS
  const label = `${q.source} ${(q.last ?? q.close)!.underlying}`
  if (q.last && q.last.lastAt > limit) throw new Error(`${label}: last sale is in the future`)
  if (q.close && q.close.lastAt > limit) throw new Error(`${label}: close is in the future`)
  return q
}

/** Throws with a reason, so the log can say why a name fell back to Yahoo. */
export async function fetchNasdaqQuote(underlying: string, now = new Date()): Promise<Quotes> {
  const url = `${NASDAQ}/quote/${encodeURIComponent(underlying)}/info?assetclass=${assetClassOf(underlying)}`
  const json = await getJson(url, NASDAQ_HEADERS).catch((e: Error) => {
    throw new Error(`nasdaq ${underlying}: ${e.message}`)
  })
  const q = parseNasdaqQuote(underlying, json)
  if (!q) throw new Error(`nasdaq ${underlying}: no reading (unknown shape, price or timestamp)`)
  return notFuture(q, now)
}

export async function fetchMarketInfo(): Promise<MarketInfo> {
  const json = await getJson(`${NASDAQ}/market-info`, NASDAQ_HEADERS).catch((e: Error) => {
    throw new Error(`nasdaq market-info: ${e.message}`)
  })
  const m = parseMarketInfo(json)
  if (!m) throw new Error('nasdaq market-info: unknown shape')
  return m
}

export async function fetchYahooQuote(underlying: string, now = new Date()): Promise<Quotes> {
  const url = `${YAHOO}/${encodeURIComponent(underlying)}?interval=1m&range=1d`
  const json = await getJson(url, YAHOO_HEADERS).catch((e: Error) => {
    throw new Error(`yahoo ${underlying}: ${e.message}`)
  })
  const q = parseYahooChart(underlying, json, now)
  if (!q) throw new Error(`yahoo ${underlying}: no reading (unknown shape)`)
  return notFuture(q, now)
}

// ------------------------------------------------------------------ verdict

export type SessionSource = 'nasdaq market-info' | 'nasdaq quote' | 'yahoo'

/** What the checker concludes about one underlying. */
export interface Reading {
  underlying: string
  /**
   * The reference to compare against: in the regular session the last sale,
   * outside it the official close (`quote.kind` says which). Nasdaq's, or
   * Yahoo's when Nasdaq had none.
   */
  quote: Quote | null
  /** The local NYSE calendar. Null is no opinion. */
  calendarOpen: boolean | null
  session: Session | null
  /** Which endpoint the session came from. */
  sessionFrom: SessionSource | null
  /**
   * Calendar open AND the source says regular session. Pre-market and
   * after-hours are closed. So is every case where either one has no opinion:
   * a checker that cannot tell must not say open.
   */
  openNow: boolean
  /** Why `openNow` is what it is, in a few words. */
  why: string
  /** What failed on the way, for the log. */
  errors: string[]
}

/**
 * The verdict for one underlying, from readings already taken. Pure.
 *
 * The session comes from market-info when Nasdaq answered it, else from
 * Nasdaq's quote, else from Yahoo's. Market-info goes first because it is the
 * one endpoint whose job is the session; a quote's label is a side field.
 *
 * The reference follows the verdict. Open, it is the last sale. Closed, for
 * whatever reason (after hours, a holiday, a checker that cannot tell), it is
 * the official close, and a source with no close gives no reference at all,
 * whatever its last sale: after the close that sale is an extended-hours
 * print. Nasdaq's price is taken before Yahoo's either way.
 */
export function judge(args: {
  underlying: string
  calendarOpen: boolean | null
  market: MarketInfo | null
  nasdaq: Quotes | null
  yahoo: Quotes | null
  errors?: string[]
}): Reading {
  const { underlying, calendarOpen, market, nasdaq, yahoo } = args
  let session: Session | null = null
  let sessionFrom: SessionSource | null = null
  if (market?.session) [session, sessionFrom] = [market.session, 'nasdaq market-info']
  else if (nasdaq?.session) [session, sessionFrom] = [nasdaq.session, 'nasdaq quote']
  else if (yahoo?.session) [session, sessionFrom] = [yahoo.session, 'yahoo']

  const openNow = calendarOpen === true && session === 'regular'
  const pick = (q: Quotes | null) => (openNow ? q?.last : q?.close) ?? null
  const quote = pick(nasdaq) ?? pick(yahoo)
  let why: string
  if (calendarOpen === null) why = 'calendar has no opinion'
  else if (session === null) why = 'no source said which session it is'
  else if (openNow) why = `calendar and ${sessionFrom} agree: open`
  else if (calendarOpen && session !== 'regular') why = `calendar open, but ${sessionFrom} says ${session}`
  // Worth saying out loud: the table says closed and the market says open,
  // which is a closure the table does not know about, or one it has wrong.
  else if (!calendarOpen && session === 'regular') why = `calendar closed, but ${sessionFrom} says regular`
  else why = `calendar closed, ${sessionFrom} says ${session}`

  return { underlying, quote, calendarOpen, session, sessionFrom, openNow, why, errors: args.errors ?? [] }
}

/**
 * Whether a reading can be pushed as the checker's word on chain, and if not,
 * why. Pure.
 *
 * The on-chain check is what every fill has to agree with, so the checker
 * says nothing rather than something it cannot stand behind:
 *
 * - No opinion is not "closed". A night fill needs the checker to say the
 *   market is shut, so a checker that cannot tell (the calendar has no
 *   opinion, or no source said which session it is) must not say it, and
 *   neither may one whose own sources contradict each other: the calendar
 *   closed while the market says regular session.
 * - No reference, no push. In session that is the last sale, and outside it
 *   the official close; a last sale is never pushed as the night reference.
 *   A source that failed to parse gives none, and Yahoo stands in only as a
 *   reading that did parse, labelled as Yahoo's.
 * - In session the sale has to be recent, `maxSessionAgeS` at most (the
 *   program's MAX_SESSION_REF_AGE_SECONDS). A stock that trades every few
 *   seconds with an old last sale means the feed has stopped. Out of session
 *   the close is pushed however old it is, and the program judges its age
 *   against its own night bound (MAX_NIGHT_REF_AGE_SECONDS, twelve hours):
 *   a close the program will not price a night fill against still carries the
 *   checker's closed verdict, which is true.
 *
 * Calendar open while the market says pre-market or after-hours is closed, as
 * `judge` says: the conservative answer for a session fill, and the market's
 * own word for a night one.
 */
export type Usable =
  | { ok: true; openNow: boolean; quote: Quote; ageS: number }
  | { ok: false; why: string }

export function usableReading(reading: Reading | undefined, now: Date, maxSessionAgeS: number): Usable {
  if (!reading) return { ok: false, why: 'no reading' }
  if (reading.calendarOpen === null) return { ok: false, why: 'the calendar has no opinion, so the checker has none' }
  if (reading.session === null) {
    const errors = reading.errors.length ? ` (${reading.errors.join('; ')})` : ''
    return { ok: false, why: `no source said which session it is${errors}` }
  }
  if (!reading.calendarOpen && reading.session === 'regular') {
    return { ok: false, why: `the calendar says closed but ${reading.sessionFrom} says regular session: its own sources disagree` }
  }
  const quote = reading.quote
  const wanted: Kind = reading.openNow ? 'last' : 'close'
  const name = wanted === 'last' ? 'last sale' : 'official close'
  if (!quote) {
    return { ok: false, why: `no ${name} (${reading.errors.join('; ') || 'no source gave one'})` }
  }
  // `judge` never pairs a verdict with the other kind; a Reading built by hand could.
  if (quote.kind !== wanted) {
    return { ok: false, why: `the reference is a ${quote.kind === 'last' ? 'last sale' : 'close'}, and ${reading.openNow ? 'in session' : 'outside the session'} it must be the ${name}` }
  }
  const ageS = (now.getTime() - quote.lastAt) / 1000
  if (reading.openNow && ageS > maxSessionAgeS) {
    return { ok: false, why: `the last sale is ${Math.round(ageS)}s old in session, over ${maxSessionAgeS}s` }
  }
  return { ok: true, openNow: reading.openNow, quote, ageS }
}

type Settled<T> = { ok: true; value: T } | { ok: false; error: string }
const settle = <T>(p: Promise<T>): Promise<Settled<T>> =>
  p.then(
    (value) => ({ ok: true as const, value }),
    (e: unknown) => ({ ok: false as const, error: e instanceof Error ? e.message : String(e) }),
  )

/** One pass over every underlying. */
export interface Pass {
  at: Date
  calendarOpen: boolean | null
  /** Nasdaq's market-wide status, or null when market-info failed. */
  market: MarketInfo | null
  /** Why market-info failed, said once rather than on every name. */
  marketError: string | null
  readings: Map<string, Reading>
}

/**
 * Every underlying's reading, in one pass.
 *
 * Nasdaq first, all at once: one market-info call and one quote per name.
 * Yahoo is asked only for the names Nasdaq gave nothing usable for: no
 * session from any Nasdaq endpoint, or not the price the verdict needs (the
 * last sale in session, the close outside it). So a healthy pass never
 * touches it.
 *
 * A close from either source counts only if it is the latest session's
 * (`isLatestClose`): a previous day's close still being served, or a Yahoo
 * sale from before the end of the session, is dropped, and the reading says
 * which.
 */
export async function readReferences(underlyings: readonly string[], now = new Date()): Promise<Pass> {
  const calendarOpen = isRegularOpen(now)
  const [market, ...quotes] = await Promise.all([
    settle(fetchMarketInfo()),
    ...underlyings.map((u) => settle(fetchNasdaqQuote(u, now))),
  ])
  const marketInfo = market.ok ? market.value : null

  // A close that is not the latest session's is dropped before anything is
  // judged, so a source still serving yesterday's close gives no night
  // reference and the other source is asked.
  const stale: (string | null)[][] = underlyings.map(() => [null, null])
  const latest = (q: Quotes, u: string, i: number, j: 0 | 1): Quotes => {
    if (!q.close || isLatestClose(q.close, now)) return q
    stale[i][j] = `${q.source} ${u}: its close, dated ${new Date(q.close.lastAt).toISOString()}, is not the latest session's`
    return { ...q, close: null }
  }
  const nasdaq = underlyings.map((u, i) => {
    const q = quotes[i]
    return q.ok ? latest(q.value, u, i, 0) : null
  })

  // Nasdaq's verdict alone, to see what it lacks.
  const alone = underlyings.map((u, i) =>
    judge({ underlying: u, calendarOpen, market: marketInfo, nasdaq: nasdaq[i], yahoo: null }),
  )
  const yahoo = await Promise.all(
    underlyings.map((u, i) =>
      alone[i].session === null || alone[i].quote === null ? settle(fetchYahooQuote(u, now)) : null,
    ),
  )

  const readings = new Map<string, Reading>()
  underlyings.forEach((u, i) => {
    const q = quotes[i]
    const y = yahoo[i]
    const fromYahoo = y?.ok ? latest(y.value, u, i, 1) : null
    const errors: string[] = []
    if (!q.ok) errors.push(q.error)
    // Nasdaq answered, knew the session, and still had not the price needed:
    // an after-hours quote with no close stamp it could read, say.
    else if (alone[i].session !== null && alone[i].quote === null) {
      errors.push(stale[i][0] ?? `nasdaq ${u}: no ${alone[i].openNow ? 'last sale' : 'official close'} in a form read here`)
    }
    if (y && !y.ok) errors.push(y.error)
    const reading = judge({ underlying: u, calendarOpen, market: marketInfo, nasdaq: nasdaq[i], yahoo: fromYahoo, errors })
    // Said only when it cost the reading its reference.
    if (reading.quote === null && stale[i][1]) errors.push(stale[i][1]!)
    readings.set(u, reading)
  })
  return { at: now, calendarOpen, market: marketInfo, marketError: market.ok ? null : market.error, readings }
}
