/**
 * Nasdaq's public quote pages, with Yahoo behind them: the checker's inputs.
 *
 * The checker is a second opinion on the keeper, so it reads sources the
 * keeper does not. The keeper decides the session from Pyth's market hours,
 * Backed's feed, Backpack's calendar and the local NYSE table, and prices from
 * a Jupiter quote. None of those are here. What is here is what the US market
 * itself says: whether the regular session is open, and the last sale of each
 * underlying.
 *
 * Two endpoints on Nasdaq, both public and keyless:
 *
 * - `/api/market-info` says which session the US market is in. One call a pass.
 * - `/api/quote/{T}/info` gives each name's last sale, when it printed, and
 *   the session label again.
 *
 * Yahoo's chart endpoint stands in for a name only when Nasdaq gives no
 * reading for it, and every reading says which source it came from.
 *
 * What a reading is not: a settlement price. Neither endpoint documents where
 * its last sale comes from or promises the consolidated tape, so either can be
 * a trade or two away from the primary listing's last print. That is fine for
 * a band measured in basis points, and nothing here is used as more than that.
 *
 * Parsing is strict. A price or a time that is not in the exact form seen in
 * the captured samples (test/fixtures/nasdaq-*, yahoo-*) gives no reading at
 * all. A reading with the wrong time would make a stale price look fresh.
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

/** One underlying's last sale, as one source reported it. */
export interface Quote {
  underlying: string
  source: Source
  /** Last sale, in dollars. */
  last: number
  /**
   * When that sale printed, in unix milliseconds. Nasdaq prints the time to the
   * minute, so for Nasdaq this is the start of that minute, and an age read
   * from it can be up to 59 seconds more than the true age.
   */
  lastAt: number
  /** The session this source said it was when asked. Null when it said something unrecognised. */
  session: Session | null
  /** Nasdaq's own `isRealTime`. Null for Yahoo, which does not say. */
  realTime: boolean | null
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

type Json = Record<string, unknown>
const obj = (v: unknown): Json | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null)

/** Nasdaq's envelope carries its own status; anything but 200 inside it is an error body. */
const nasdaqOk = (body: Json | null): boolean => {
  const code = obj(body?.status)?.rCode
  return code === undefined || code === 200
}

/**
 * Nasdaq's quote JSON → a Quote, or null when any field the checker relies on
 * is missing or not in the known form. A body for a different symbol is null
 * too: it would be a true reading of the wrong thing.
 */
export function parseNasdaqQuote(underlying: string, json: unknown): Quote | null {
  const body = obj(json)
  if (!nasdaqOk(body)) return null
  const data = obj(body?.data)
  const p = obj(data?.primaryData)
  if (!data || !p) return null
  if (typeof data.symbol !== 'string' || data.symbol.toUpperCase() !== underlying.toUpperCase()) return null
  const last = parseDollars(p.lastSalePrice)
  const lastAt = parseNasdaqTimestamp(p.lastTradeTimestamp)
  if (last === null || lastAt === null) return null
  return {
    underlying,
    source: 'nasdaq',
    last,
    lastAt,
    session: sessionOf(data.marketStatus),
    realTime: typeof p.isRealTime === 'boolean' ? p.isRealTime : null,
  }
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
 * Yahoo's chart JSON → a Quote, with the session read from its
 * `currentTradingPeriod` at `now`.
 *
 * `regularMarketPrice` is the regular session's last sale, so outside the
 * session it is the close, not an extended-hours print. `regularMarketTime` is
 * unix seconds, so this source's timestamps need no parsing.
 *
 * Yahoo's trading period is for the day it last traded, and on a holiday that
 * can be the day before. The session it gives is only ever used together with
 * the local calendar, which knows the holidays.
 */
export function parseYahooChart(underlying: string, json: unknown, now: Date): Quote | null {
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
  const period = obj(meta.currentTradingPeriod)
  if (period && isWindow(period.pre) && isWindow(period.regular) && isWindow(period.post)) {
    const t = now.getTime() / 1000
    const inside = (w: { start: number; end: number }) => t >= w.start && t < w.end
    session = inside(period.regular) ? 'regular' : inside(period.pre) ? 'pre' : inside(period.post) ? 'after' : 'closed'
  }
  return { underlying, source: 'yahoo', last, lastAt: at * 1000, session, realTime: null }
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

/** Throws with a reason, so the log can say why a name fell back to Yahoo. */
export async function fetchNasdaqQuote(underlying: string, now = new Date()): Promise<Quote> {
  const url = `${NASDAQ}/quote/${encodeURIComponent(underlying)}/info?assetclass=${assetClassOf(underlying)}`
  const json = await getJson(url, NASDAQ_HEADERS).catch((e: Error) => {
    throw new Error(`nasdaq ${underlying}: ${e.message}`)
  })
  const q = parseNasdaqQuote(underlying, json)
  if (!q) throw new Error(`nasdaq ${underlying}: no reading (unknown shape, price or timestamp)`)
  if (q.lastAt > now.getTime() + FUTURE_SLACK_MS) throw new Error(`nasdaq ${underlying}: last sale is in the future`)
  return q
}

export async function fetchMarketInfo(): Promise<MarketInfo> {
  const json = await getJson(`${NASDAQ}/market-info`, NASDAQ_HEADERS).catch((e: Error) => {
    throw new Error(`nasdaq market-info: ${e.message}`)
  })
  const m = parseMarketInfo(json)
  if (!m) throw new Error('nasdaq market-info: unknown shape')
  return m
}

export async function fetchYahooQuote(underlying: string, now = new Date()): Promise<Quote> {
  const url = `${YAHOO}/${encodeURIComponent(underlying)}?interval=1m&range=1d`
  const json = await getJson(url, YAHOO_HEADERS).catch((e: Error) => {
    throw new Error(`yahoo ${underlying}: ${e.message}`)
  })
  const q = parseYahooChart(underlying, json, now)
  if (!q) throw new Error(`yahoo ${underlying}: no reading (unknown shape)`)
  if (q.lastAt > now.getTime() + FUTURE_SLACK_MS) throw new Error(`yahoo ${underlying}: last sale is in the future`)
  return q
}

// ------------------------------------------------------------------ verdict

export type SessionSource = 'nasdaq market-info' | 'nasdaq quote' | 'yahoo'

/** What the checker concludes about one underlying. */
export interface Reading {
  underlying: string
  /** The last sale to compare against: Nasdaq's, or Yahoo's when Nasdaq had none. */
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
 */
export function judge(args: {
  underlying: string
  calendarOpen: boolean | null
  market: MarketInfo | null
  nasdaq: Quote | null
  yahoo: Quote | null
  errors?: string[]
}): Reading {
  const { underlying, calendarOpen, market, nasdaq, yahoo } = args
  const quote = nasdaq ?? yahoo
  let session: Session | null = null
  let sessionFrom: SessionSource | null = null
  if (market?.session) [session, sessionFrom] = [market.session, 'nasdaq market-info']
  else if (nasdaq?.session) [session, sessionFrom] = [nasdaq.session, 'nasdaq quote']
  else if (yahoo?.session) [session, sessionFrom] = [yahoo.session, 'yahoo']

  const openNow = calendarOpen === true && session === 'regular'
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
 * Yahoo is asked only for the names Nasdaq gave nothing usable for, either no
 * quote or no session from any Nasdaq endpoint, so a healthy pass never
 * touches it.
 */
export async function readReferences(underlyings: readonly string[], now = new Date()): Promise<Pass> {
  const calendarOpen = isRegularOpen(now)
  const [market, ...quotes] = await Promise.all([
    settle(fetchMarketInfo()),
    ...underlyings.map((u) => settle(fetchNasdaqQuote(u, now))),
  ])
  const marketInfo = market.ok ? market.value : null

  const needsYahoo = underlyings.map((_, i) => {
    const q = quotes[i]
    return !q.ok || (!marketInfo?.session && !q.value.session)
  })
  const yahoo = await Promise.all(
    underlyings.map((u, i) => (needsYahoo[i] ? settle(fetchYahooQuote(u, now)) : null)),
  )

  const readings = new Map<string, Reading>()
  underlyings.forEach((u, i) => {
    const q = quotes[i]
    const y = yahoo[i]
    const errors: string[] = []
    if (!q.ok) errors.push(q.error)
    if (y && !y.ok) errors.push(y.error)
    readings.set(
      u,
      judge({
        underlying: u,
        calendarOpen,
        market: marketInfo,
        nasdaq: q.ok ? q.value : null,
        yahoo: y?.ok ? y.value : null,
        errors,
      }),
    )
  })
  return { at: now, calendarOpen, market: marketInfo, marketError: market.ok ? null : market.error, readings }
}
