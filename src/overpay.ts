/**
 * Did you overpay? A read-only look at a wallet's mainnet buys of the listed
 * stocks, and at what each buy made outside the regular session paid against
 * the price the real market opened at next.
 *
 * While New York is shut a pool still quotes these tokens, and a buyer pays
 * whatever the pool says. The next regular-session open is the first price the
 * real market set after that buy, so it is the plainest thing to hold the buy
 * up against. What the gap does and does not measure:
 *
 * - It is all-in: the USDC that left the wallet over the shares that arrived,
 *   so fees, the pool's spread and slippage are all inside it.
 * - It also holds whatever genuinely happened overnight. A buy before good news
 *   shows a negative gap and one before bad news a positive gap, and none of
 *   that is the pool's doing. One buy's gap says little; many buys' median
 *   says more.
 * - The open is a quote, not a fill. Nobody here could have bought at it, and
 *   waiting for it has its own cost: the price can run away before 09:30.
 *
 * Mainnet only, whatever cluster the rest of the deployment points at: the
 * question is about real money.
 *
 * Pure parts first (a transaction in, buys out; a Nasdaq answer in, opens
 * out). The loaders at the bottom take their transports as arguments, so the
 * tests stand in for the RPC and for Nasdaq, and the census script reuses them.
 */
import { explorerTx, fromBase58, multiplierAt, scaledUiOf, type Rpc, type ScaledUi } from '../web/lib/tape.ts'
import { parseDollars } from '../web/lib/reference.ts'
import type { Listing } from './listings.ts'
import { HOLIDAYS, isRegularOpen, nextChange } from './policy/calendar.ts'

export type { Rpc } from '../web/lib/tape.ts'

/** Mainnet USDC. The only thing a buy is counted as paid in, since it is the only one worth a dollar. */
export const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'

// ---------------------------------------------------------------- transaction

export interface TokenBalance {
  accountIndex: number
  mint: string
  /** Absent on very old transactions, which are then simply not read. */
  owner?: string
  uiTokenAmount: { amount: string; decimals: number }
}

/** `getTransaction` with `encoding: 'json'`, as far as this file reads it. */
export interface MainnetTx {
  slot: number
  blockTime: number | null
  version?: number | 'legacy'
  meta: {
    err: unknown
    preTokenBalances?: TokenBalance[] | null
    postTokenBalances?: TokenBalance[] | null
  } | null
  transaction: {
    signatures: string[]
    message: { accountKeys: string[]; header?: { numRequiredSignatures: number } }
  }
}

/** One wallet's purchase of one listed stock, in raw units, before any pricing. */
export interface BuyLeg {
  signature: string
  slot: number
  blockTime: number
  owner: string
  /**
   * Whether the owner signed the transaction. A pool's vault authority also
   * gains stock and loses USDC, when someone sells into it; it is a program
   * address and never signs. The census counts signers only, for that reason.
   */
  signed: boolean
  /**
   * Whether this is a market maker's side of a quoted fill rather than a
   * customer's buy: the owner paid the transaction's fee, and another signer
   * sold it that very stock for USDC in the same transaction. That is the
   * shape of a request-for-quote venue, where the maker submits the trade its
   * customer signed; on 24 September four of four such fills checked by hand
   * had the maker, holding hundreds of thousands of USDC, as the fee payer. Its
   * "buy" is the customer's sale, so the census leaves it out. A wallet's own
   * lookup keeps it: those are still that wallet's buys.
   */
  maker: boolean
  mint: string
  stockRaw: bigint
  stockDecimals: number
  usdcRaw: bigint
  usdcDecimals: number
}

/**
 * The buys in one transaction: an owner whose balance of a listed mint rose
 * while its USDC fell.
 *
 * Counted only when those are the owner's only two token changes. When some
 * other token also moved, the USDC cannot be split between them, so the
 * transaction is counted in `mixed` and not priced. That drops some genuine
 * buys (two stocks in one transaction, say) rather than print a wrong price.
 * Balances are netted per owner, so stock moved between two of one wallet's
 * accounts is not a buy.
 */
export function buysIn(
  tx: MainnetTx,
  stockMints: ReadonlySet<string>,
  owner?: string,
): { buys: BuyLeg[]; mixed: number } {
  const meta = tx.meta
  if (!meta || (meta.err !== null && meta.err !== undefined) || tx.blockTime === null) return { buys: [], mixed: 0 }
  // Every owner's changes, even when one wallet is asked about, since telling
  // a maker's leg from a customer's needs the other side of the trade.
  const change = new Map<string, Map<string, bigint>>()
  const decimals = new Map<string, number>()
  const add = (b: TokenBalance, sign: bigint) => {
    if (!b.owner) return
    decimals.set(b.mint, b.uiTokenAmount.decimals)
    const byMint = change.get(b.owner) ?? new Map<string, bigint>()
    byMint.set(b.mint, (byMint.get(b.mint) ?? 0n) + sign * BigInt(b.uiTokenAmount.amount))
    change.set(b.owner, byMint)
  }
  for (const b of meta.preTokenBalances ?? []) add(b, -1n)
  for (const b of meta.postTokenBalances ?? []) add(b, 1n)

  const { accountKeys, header } = tx.transaction.message
  const signers = new Set(accountKeys.slice(0, header?.numRequiredSignatures ?? 1))
  const feePayer = accountKeys[0]
  const buys: BuyLeg[] = []
  let mixed = 0
  for (const [who, byMint] of change) {
    if (owner && who !== owner) continue
    const up = [...byMint].filter(([, d]) => d > 0n)
    const down = [...byMint].filter(([, d]) => d < 0n)
    const paid = byMint.get(USDC) ?? 0n
    if (paid >= 0n || !up.some(([m]) => stockMints.has(m))) continue
    if (up.length !== 1 || down.length !== 1) {
      mixed++
      continue
    }
    const [mint, stockRaw] = up[0]
    const soldToIt = [...change].some(
      ([other, m]) => other !== who && signers.has(other) && (m.get(mint) ?? 0n) < 0n && (m.get(USDC) ?? 0n) > 0n,
    )
    buys.push({
      signature: tx.transaction.signatures[0],
      slot: tx.slot,
      blockTime: tx.blockTime,
      owner: who,
      signed: signers.has(who),
      maker: who === feePayer && soldToIt,
      mint,
      stockRaw,
      stockDecimals: decimals.get(mint)!,
      usdcRaw: -paid,
      usdcDecimals: decimals.get(USDC)!,
    })
  }
  return { buys, mixed }
}

// -------------------------------------------------------------------- session

const ZONE = 'America/New_York'
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const NY = new Intl.DateTimeFormat('en-US', {
  timeZone: ZONE,
  hourCycle: 'h23',
  weekday: 'short',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
})

/** New York's wall clock at an instant: its date, weekday and minutes past midnight, and a label. */
export function nyWall(unix: number): { date: string; weekday: string; minutes: number; label: string } {
  const parts = NY.formatToParts(new Date(unix * 1000))
  const get = (t: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === t)?.value ?? ''
  const [y, m, d, hh, mm] = [get('year'), get('month'), get('day'), get('hour'), get('minute')]
  const hour = Number(hh) % 24
  return {
    date: `${y}-${m}-${d}`,
    weekday: get('weekday'),
    minutes: hour * 60 + Number(mm),
    label: `${get('weekday')} ${Number(d)} ${MONTHS[Number(m) - 1]} ${y} ${String(hour).padStart(2, '0')}:${mm} ET`,
  }
}

/** Which part of the closed hours a buy fell in. Descriptive only; nothing is decided by it. */
export type Window = 'pre-market' | 'after-hours' | 'overnight' | 'closed day'

export interface SessionView {
  /** Unknown outside the years the calendar covers, where it has no opinion. */
  session: 'regular' | 'outside' | 'unknown'
  window: Window | null
  /** The next regular-session open, unix seconds, and its New York date. Outside-session only. */
  nextOpenAt: number | null
  nextOpenDate: string | null
}

/**
 * The session a buy fell in, by the exchange calendar in `policy/calendar.ts`,
 * and for one outside it, when the real market opened next. The calendar's own
 * `nextChange` from a closed instant is exactly that open, holidays and early
 * closes included.
 */
export function sessionOf(unix: number): SessionView {
  const open = isRegularOpen(new Date(unix * 1000))
  if (open === null) return { session: 'unknown', window: null, nextOpenAt: null, nextOpenDate: null }
  if (open) return { session: 'regular', window: null, nextOpenAt: null, nextOpenDate: null }
  const next = nextChange(new Date(unix * 1000))
  const wall = nyWall(unix)
  const window: Window =
    wall.weekday === 'Sat' || wall.weekday === 'Sun' || HOLIDAYS.has(wall.date)
      ? 'closed day'
      : wall.minutes < 4 * 60 || wall.minutes >= 20 * 60
        ? 'overnight'
        : wall.minutes < 9 * 60 + 30
          ? 'pre-market'
          : 'after-hours'
  return {
    session: 'outside',
    window,
    nextOpenAt: next,
    nextOpenDate: next === null ? null : nyWall(next).date,
  }
}

// ---------------------------------------------------------------------- opens

/**
 * Browser-like headers, as `web/lib/reference.ts` sends them to the same host
 * and for the same reason: without them the endpoint stalls for seconds or
 * refuses. Restated because that file keeps its own private.
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
 * Nasdaq files ETFs and stocks under different asset classes and answers the
 * wrong one with "Symbol not exists". These are tried as ETFs first; anything
 * else as a stock; and either way the other class is tried when the first says
 * no, so a listing added later does not need adding here.
 */
const ETFS = new Set(['SPY', 'QQQ', 'IWM', 'JPST', 'DIA', 'VTI', 'VOO', 'IVV', 'GLD', 'TLT'])

export type AssetClass = 'etf' | 'stocks'

/** `YYYY-MM-DD` plus some days, by the calendar, with no time zone involved. */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10)
}

/**
 * Nasdaq's daily history for one underlying between two New York dates. The
 * endpoint refuses a `todate` that is not after `fromdate`, so the range always
 * runs a day past the last date wanted; a future `todate` is accepted.
 */
export function historyUrl(underlying: string, cls: AssetClass, from: string, through: string): string {
  const to = addDays(through, 1)
  const days = Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) + 1
  return (
    `https://api.nasdaq.com/api/quote/${encodeURIComponent(underlying)}/historical` +
    `?assetclass=${cls}&fromdate=${from}&todate=${to}&limit=${days}`
  )
}

/**
 * Nasdaq's history JSON → each date's regular-session open, in dollars.
 *
 * Null when there is no table at all, which is how it answers a symbol filed
 * under the other asset class. An empty map when the table is there but has no
 * rows in the range: a weekend, or today while the session is still running,
 * since a day's row appears only after its close. Dates arrive as MM/DD/YYYY
 * and prices as strings, a stock's with a "$" and an ETF's without.
 */
export function parseHistory(json: unknown): Map<string, number> | null {
  const data = (json as { data?: { tradesTable?: { rows?: unknown } } | null } | null)?.data
  if (!data || typeof data !== 'object') return null
  const rows = data.tradesTable?.rows
  const out = new Map<string, number>()
  if (!Array.isArray(rows)) return out
  for (const r of rows as { date?: unknown; open?: unknown }[]) {
    const m = typeof r?.date === 'string' ? /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(r.date) : null
    const open = parseDollars(r?.open)
    if (m && open !== null) out.set(`${m[3]}-${m[1]}-${m[2]}`, open)
  }
  return out
}

export type OpenStatus = 'recorded' | 'not yet recorded' | 'unavailable'
export interface Open {
  price: number | null
  status: OpenStatus
}
/** The regular-session open of each of these New York dates, for one underlying. */
export type Opens = (underlying: string, dates: readonly string[]) => Promise<Map<string, Open>>

export type FetchJson = (url: string) => Promise<unknown>

/**
 * GET a Nasdaq URL as a browser would; null on any failure, which reads as
 * "unavailable". Seven seconds each: with the headers it answers in well under
 * one, and a lookup may ask twice per underlying (the other asset class) after
 * its chain budget is spent, so this is what keeps the whole under a minute.
 */
export const nasdaqJson: FetchJson = async (url) => {
  try {
    const res = await fetch(url, { headers: NASDAQ_HEADERS, signal: AbortSignal.timeout(7_000) })
    return res.ok ? await res.json() : null
  } catch {
    return null
  }
}

/** How long a date whose open Nasdaq did not have is left before it is asked again. */
const MISS_TTL_MS = 5 * 60_000

/**
 * Opens from Nasdaq, one request per underlying per call however many dates
 * are wanted, and a recorded open is kept for good: it never changes.
 *
 * A date after today in New York, or today before its row has appeared, is
 * "not yet recorded", which is not the same as missing. A past date Nasdaq has
 * no row for, or a request that failed, is "unavailable".
 */
export function createOpens(opts: { fetchJson?: FetchJson; clock?: () => number } = {}): Opens {
  const fetchJson = opts.fetchJson ?? nasdaqJson
  const clock = opts.clock ?? Date.now
  const known = new Map<string, Map<string, number>>()
  const missedAt = new Map<string, number>()
  const classOf = new Map<string, AssetClass>()

  return async (underlying, dates) => {
    const today = nyWall(Math.floor(clock() / 1000)).date
    const have = known.get(underlying) ?? new Map<string, number>()
    known.set(underlying, have)
    const wanted = [...new Set(dates)].sort()
    const ask = wanted.filter(
      (d) => !have.has(d) && d <= today && clock() - (missedAt.get(`${underlying} ${d}`) ?? -Infinity) > MISS_TTL_MS,
    )
    if (ask.length > 0) {
      const first = classOf.get(underlying) ?? (ETFS.has(underlying) ? 'etf' : 'stocks')
      for (const cls of [first, first === 'etf' ? 'stocks' : 'etf'] as const) {
        // Always through today, however old the dates wanted. Asked for a range
        // that ends in the past, Nasdaq leaves out every row older than about a
        // month: on 24 September, AAPL from 17 August through 1 September came
        // back as 24 August onwards, and 17 to 18 August as nothing, while 10
        // August through today came back whole.
        const rows = parseHistory(await fetchJson(historyUrl(underlying, cls, ask[0], today)))
        if (!rows) continue
        classOf.set(underlying, cls)
        for (const [d, p] of rows) have.set(d, p)
        break
      }
      for (const d of ask) if (!have.has(d)) missedAt.set(`${underlying} ${d}`, clock())
    }
    return new Map(
      wanted.map((d): [string, Open] => {
        const price = have.get(d)
        if (price !== undefined) return [d, { price, status: 'recorded' }]
        if (d >= today) return [d, { price: null, status: 'not yet recorded' }]
        // A past date with no row, whether Nasdaq answered without it or did
        // not answer: not asked again for a few minutes, and unavailable meanwhile.
        return [d, { price: null, status: 'unavailable' }]
      }),
    )
  }
}

// --------------------------------------------------------------------- buys

export interface Buy {
  signature: string
  explorer: string
  /** The wallet that bought. Set by the census; a lookup's rows are all the wallet asked about. */
  owner?: string
  /** Block time, UTC, ISO 8601. */
  time: string
  /** The same instant on New York's wall clock, for reading. */
  timeEt: string
  symbol: string
  underlying: string
  mint: string
  /** Shares that arrived, raw units times the mint's multiplier then; null if the mint could not be read. */
  shares: number | null
  usdcPaid: number
  /** All-in dollars per share: `usdcPaid / shares`. */
  pricePerShare: number | null
  /** The scaled-UI multiplier `shares` was computed with. */
  multiplier: number | null
  /**
   * False when that multiplier may not be the one in force at the buy: the buy
   * is older than the mint's latest step, and the mint no longer records the
   * value before it. Such a buy's price can be off by a dividend's worth, so it
   * is shown but kept out of the summary's figures.
   */
  multiplierExact: boolean
  session: SessionView['session']
  window: Window | null
  /** Outside-session buys only: the next regular-session open and what Nasdaq recorded for it. */
  nextOpen: { date: string; atEt: string; price: number | null; status: OpenStatus } | null
  /** `(pricePerShare / open − 1) × 10,000`: positive means the buy paid more than the open. */
  gapBps: number | null
}

const iso = (unix: number) => new Date(unix * 1000).toISOString().replace('.000Z', 'Z')

/** Positive when the buy paid more per share than the open. */
export const gapBps = (paid: number, open: number): number => (paid / open - 1) * 10_000

/**
 * Whether the multiplier `multiplierAt` gives for this instant is known to be
 * the one in force then.
 *
 * A mint holds its current multiplier and one change: `multiplier` until
 * `effectiveAt`, `newMultiplier` from then on. Backed schedules each step ahead,
 * so the value before its latest step is still there. Ondo writes each step
 * already in force, both fields the same, so the value before it is gone, and
 * a buy from before it would be priced with the multiplier after. Neither kind
 * of mint remembers the step before the latest; a buy older than that is not
 * detectable here, and is the residual error the notes admit to.
 *
 * One exception: a multiplier still exactly 1 has never stepped, since each
 * dividend moves it off 1 for good. Ondo rewrites every mint's configuration at
 * once, TSLAon's included at 1 and 1 on 18 September, and TSLA pays none.
 */
export const multiplierKnown = (cfg: ScaledUi, unix: number): boolean =>
  cfg.effectiveAt === 0 ||
  unix >= cfg.effectiveAt ||
  cfg.multiplier !== cfg.newMultiplier ||
  (cfg.multiplier === 1 && cfg.newMultiplier === 1)

/**
 * A buy priced and placed in the session, without its open yet.
 *
 * Shares are the raw amount times the multiplier in force at the block time, by
 * the tape's own `multiplierAt`, and `multiplierExact` says when that cannot be
 * vouched for.
 */
export function priceBuy(
  leg: BuyLeg,
  listing: Pick<Listing, 'symbol' | 'underlying'>,
  scaled: ScaledUi | null,
): Buy {
  const multiplier = scaled ? multiplierAt(scaled, leg.blockTime) : null
  const shares = multiplier === null ? null : (Number(leg.stockRaw) / 10 ** leg.stockDecimals) * multiplier
  const usdcPaid = Number(leg.usdcRaw) / 10 ** leg.usdcDecimals
  const s = sessionOf(leg.blockTime)
  return {
    signature: leg.signature,
    explorer: explorerTx(leg.signature, 'mainnet'),
    time: iso(leg.blockTime),
    timeEt: nyWall(leg.blockTime).label,
    symbol: listing.symbol,
    underlying: listing.underlying,
    mint: leg.mint,
    shares,
    usdcPaid,
    pricePerShare: shares ? usdcPaid / shares : null,
    multiplier,
    multiplierExact: scaled !== null && multiplierKnown(scaled, leg.blockTime),
    session: s.session,
    window: s.window,
    nextOpen:
      s.nextOpenAt !== null && s.nextOpenDate !== null
        ? { date: s.nextOpenDate, atEt: nyWall(s.nextOpenAt).label, price: null, status: 'unavailable' }
        : null,
    gapBps: null,
  }
}

/** Fill in each outside-session buy's next open and its gap: one Nasdaq request per underlying. */
export async function withOpens(buys: readonly Buy[], opens: Opens): Promise<Buy[]> {
  const dates = new Map<string, string[]>()
  for (const b of buys) if (b.nextOpen) dates.set(b.underlying, [...(dates.get(b.underlying) ?? []), b.nextOpen.date])
  const found = new Map(
    await Promise.all([...dates].map(async ([u, ds]) => [u, await opens(u, ds)] as const)),
  )
  return buys.map((b) => {
    if (!b.nextOpen) return b
    const o = found.get(b.underlying)?.get(b.nextOpen.date) ?? { price: null, status: 'unavailable' as const }
    return {
      ...b,
      nextOpen: { ...b.nextOpen, price: o.price, status: o.status },
      gapBps: o.price !== null && b.pricePerShare !== null ? Math.round(gapBps(b.pricePerShare, o.price) * 10) / 10 : null,
    }
  })
}

// ------------------------------------------------------------------ summary

/** The q-quantile of an ascending list, interpolating between neighbours. */
export function quantile(sorted: readonly number[], q: number): number | null {
  if (sorted.length === 0) return null
  const at = (sorted.length - 1) * q
  const lo = Math.floor(at)
  const hi = Math.ceil(at)
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (at - lo)
}

export interface Summary {
  buys: number
  regular: number
  outside: number
  unknown: number
  /**
   * Outside-session buys with a recorded open and a multiplier known to be
   * right, which is what the gap figures are over.
   */
  compared: number
  /** Buys with a gap left out of the figures because their multiplier could not be vouched for. */
  inexact: number
  notYetRecorded: number
  medianGapBps: number | null
  /** How many compared buys paid more per share than the next open. */
  paidMore: number
  /** The compared buy that paid most over its open. */
  worst: { signature: string; explorer: string; symbol: string; timeEt: string; gapBps: number } | null
}

export function summarize(buys: readonly Buy[]): Summary {
  const compared = buys.filter((b) => b.gapBps !== null && b.multiplierExact)
  const gaps = compared.map((b) => b.gapBps!).sort((a, b) => a - b)
  const worst = compared.reduce<Buy | null>((w, b) => (w === null || b.gapBps! > w.gapBps! ? b : w), null)
  const median = quantile(gaps, 0.5)
  return {
    buys: buys.length,
    regular: buys.filter((b) => b.session === 'regular').length,
    outside: buys.filter((b) => b.session === 'outside').length,
    unknown: buys.filter((b) => b.session === 'unknown').length,
    compared: compared.length,
    inexact: buys.filter((b) => b.gapBps !== null && !b.multiplierExact).length,
    notYetRecorded: buys.filter((b) => b.nextOpen?.status === 'not yet recorded').length,
    medianGapBps: median === null ? null : Math.round(median * 10) / 10,
    paidMore: gaps.filter((g) => g > 0).length,
    worst: worst && {
      signature: worst.signature,
      explorer: worst.explorer,
      symbol: worst.symbol,
      timeEt: worst.timeEt,
      gapBps: worst.gapBps!,
    },
  }
}

// ------------------------------------------------------------------ transport

/** Thrown once a rate limit has outlasted every retry, so a caller can stop rather than press on. */
export class RateLimited extends Error {}

/** Thrown when a call could not finish before its caller's deadline: it is dropped, not left queued. */
export class OutOfTime extends Error {}

/**
 * An RPC that can also be held to a deadline. `until(deadline)` gives the same
 * transport, sharing its pace and its calls in flight, whose calls give up with
 * `OutOfTime` rather than finish after `deadline` (a `Date.now()` time): one
 * still queued is taken out of the queue, one waiting out a 429 stops waiting,
 * and one in flight is aborted. So a lookup's budget bounds all of it, not only
 * the part after the first call.
 */
export type BoundedRpc = Rpc & { until(deadline: number): Rpc }

/**
 * A JSON-RPC transport for mainnet, gentle by construction: a fixed number of
 * calls in flight, at most `perWindow` calls of any one method in any
 * `windowMs` however many callers there are, a timeout on each, and on a 429 a
 * pause that doubles each time (or the server's own Retry-After) before trying
 * again.
 *
 * The window is the part that matters, and its default is measured, not
 * quoted. On 24 September the public endpoint answered ten `getTransaction`s
 * sent 0.3 seconds apart and refused the eleventh with 429 and Retry-After: 10,
 * a quarter of the forty per ten seconds its documentation gives. A lookup
 * that ran into that read 32 transactions in 45 seconds, nearly all of it
 * spent waiting out penalties; kept under the limit, it is never refused.
 *
 * Error messages carry the method and the status, never the URL, which for a
 * paid provider holds its key.
 */
export function httpRpc(
  url: string,
  opts: {
    concurrency?: number
    /** Calls of one method started in any `windowMs`, retries included. */
    perWindow?: number
    windowMs?: number
    retries?: number
    timeoutMs?: number
    onCall?: (method: string) => void
  } = {},
): BoundedRpc {
  const concurrency = opts.concurrency ?? 3
  const perWindow = opts.perWindow ?? 9
  const windowMs = opts.windowMs ?? 10_000
  const retries = opts.retries ?? 4
  const timeoutMs = opts.timeoutMs ?? 20_000
  const late = (method: string) => new OutOfTime(`${method}: out of time`)
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
  const started = new Map<string, number[]>()
  /**
   * Wait until this method has had fewer than `perWindow` starts in the last
   * `windowMs`, then take one; or give up at once if that wait would run past
   * the deadline, so a call that cannot start in time never takes a start.
   */
  const pace = async (method: string, deadline: number) => {
    for (;;) {
      const now = Date.now()
      const recent = (started.get(method) ?? []).filter((t) => now - t < windowMs)
      started.set(method, recent)
      if (recent.length < perWindow) {
        recent.push(now)
        return
      }
      const wait = recent[0] + windowMs - now
      if (now + wait > deadline) throw late(method)
      await sleep(wait)
    }
  }
  let active = 0
  const waiting: { go: () => void }[] = []
  const acquire = (method: string, deadline: number) => {
    if (active < concurrency) {
      active++
      return Promise.resolve()
    }
    return new Promise<void>((resolve, reject) => {
      const entry = { go: () => (clearTimeout(timer), resolve()) }
      const timer =
        deadline === Infinity
          ? undefined
          : setTimeout(() => {
              const i = waiting.indexOf(entry)
              if (i >= 0) waiting.splice(i, 1)
              reject(late(method))
            }, Math.max(0, deadline - Date.now()))
      waiting.push(entry)
    })
  }
  // A slot passes straight to the next waiter, so `active` counts it throughout.
  const release = () => {
    const next = waiting.shift()
    if (next) next.go()
    else active--
  }
  let id = 0
  const call = async (method: string, params: unknown[], deadline: number) => {
    if (Date.now() >= deadline) throw late(method)
    await acquire(method, deadline)
    try {
      for (let attempt = 0; ; attempt++) {
        await pace(method, deadline)
        const left = deadline - Date.now()
        if (left <= 0) throw late(method)
        opts.onCall?.(method)
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
          signal: AbortSignal.timeout(Math.min(timeoutMs, left)),
        }).catch((e: unknown) => {
          if ((e as Error).name !== 'TimeoutError') throw new Error(`${method}: network error`)
          throw timeoutMs < left ? new Error(`${method}: timed out`) : late(method)
        })
        const body = res.status === 429 ? null : ((await res.json().catch(() => null)) as {
          result?: unknown
          error?: { code?: number; message?: string }
        } | null)
        const limited = res.status === 429 || body?.error?.code === 429
        if (limited) {
          if (attempt >= retries) throw new RateLimited(`${method}: rate limited`)
          const after = Number(res.headers.get('retry-after'))
          const wait = after > 0 ? Math.min(after, 30) * 1000 : 1000 * 2 ** attempt
          if (Date.now() + wait > deadline) throw late(method)
          await sleep(wait)
          continue
        }
        if (!res.ok) throw new Error(`${method}: HTTP ${res.status}`)
        if (!body) throw new Error(`${method}: unreadable answer`)
        if (body.error) throw new Error(`${method}: ${body.error.message ?? 'RPC error'}`)
        return body.result
      }
    } finally {
      release()
    }
  }
  const rpc = ((method: string, params: unknown[]) => call(method, params, Infinity)) as BoundedRpc
  rpc.until = (deadline) => (method, params) => call(method, params, deadline)
  return rpc
}

/**
 * `rpc` held to a deadline on `clock`: through the transport's own `until`
 * when it has one, so queued calls are dropped too (that one reads `Date.now`,
 * which is the clock everywhere but the tests); otherwise by refusing any call
 * started after it.
 */
export function bounded(rpc: Rpc, deadline: number, clock: () => number): Rpc {
  const own = (rpc as Partial<BoundedRpc>).until
  if (typeof own === 'function') return own(deadline)
  return (method, params) => (clock() >= deadline ? Promise.reject(new OutOfTime(`${method}: out of time`)) : rpc(method, params))
}

const fromBase64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))

/**
 * Every listing's scaled-UI configuration, from one read of all their mint
 * accounts, and the token programs that own them, which is where a wallet's
 * accounts of these mints are looked for.
 */
export async function readMints(
  rpc: Rpc,
  listings: readonly Listing[],
): Promise<{ scaled: Map<string, ScaledUi | null>; programs: string[] }> {
  const got = (await rpc('getMultipleAccounts', [
    listings.map((l) => l.mainnetMint),
    { encoding: 'base64', commitment: 'confirmed' },
  ])) as { value: ({ data: [string, string]; owner: string } | null)[] }
  const scaled = new Map(
    listings.map((l, i) => [l.mainnetMint, got.value[i] ? scaledUiOf(fromBase64(got.value[i]!.data[0])) : null]),
  )
  const programs = [...new Set(got.value.flatMap((a) => (a ? [a.owner] : [])))]
  return { scaled, programs }
}

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')

/**
 * The wallet's token accounts of listed mints, by asking each token program
 * for the wallet's accounts and keeping those whose first 32 bytes, the mint,
 * are listed. Only the mint is fetched (`dataSlice`), so a wallet holding
 * thousands of tokens costs kilobytes, not megabytes.
 */
export async function stockAccounts(
  rpc: Rpc,
  wallet: string,
  programs: readonly string[],
  listings: readonly Listing[],
): Promise<{ account: string; mint: string }[]> {
  const byHex = new Map(listings.map((l) => [hex(fromBase58(l.mainnetMint)), l.mainnetMint]))
  const found: { account: string; mint: string }[] = []
  for (const programId of programs) {
    const got = (await rpc('getTokenAccountsByOwner', [
      wallet,
      { programId },
      { encoding: 'base64', dataSlice: { offset: 0, length: 32 }, commitment: 'confirmed' },
    ])) as { value: { pubkey: string; account: { data: [string, string] } }[] }
    for (const a of got.value) {
      const mint = byHex.get(hex(fromBase64(a.account.data[0])))
      if (mint) found.push({ account: a.pubkey, mint })
    }
  }
  return found
}

/**
 * `getTransaction`, asking for version 1 as well as 0 and legacy. Mainnet
 * serves version-1 transactions, and a client that says 0 is refused each one
 * outright with an error rather than given the rest of the transaction; four
 * of twelve sampled SPYx transactions on 23 September were version 1. Their
 * token balances read exactly as the older versions' do.
 */
export const getTx = (rpc: Rpc, signature: string) =>
  rpc('getTransaction', [
    signature,
    { encoding: 'json', maxSupportedTransactionVersion: 1, commitment: 'confirmed' },
  ]) as Promise<MainnetTx | null>

/**
 * Read transactions with a few workers, each taking the next signature when it
 * is done, until the list or the time runs out. Workers rather than batches, so
 * one call waiting out a 429's Retry-After holds up only itself. A rate limit
 * that outlasts its retries, or a call that cannot finish in time, stops the
 * reading and says so, keeping what was read; any other failure marks that one
 * transaction unreadable and goes on.
 */
export async function readTransactions(
  rpc: Rpc,
  signatures: readonly string[],
  opts: { workers: number; deadline: number; clock: () => number },
): Promise<{ txs: MainnetTx[]; unreadable: number; stopped: string | null }> {
  const txs: MainnetTx[] = []
  let unreadable = 0
  let why: string | null = null
  let next = 0
  const worker = async () => {
    while (why === null && next < signatures.length) {
      if (opts.clock() > opts.deadline) {
        why = 'ran out of time'
        return
      }
      const sig = signatures[next++]
      try {
        const tx = await getTx(rpc, sig)
        if (tx) txs.push(tx)
        else unreadable++
      } catch (e) {
        if (e instanceof OutOfTime) why ??= 'ran out of time'
        else if (e instanceof RateLimited) why ??= `the RPC is rate limiting: ${e.message}`
        else unreadable++
      }
    }
  }
  await Promise.all(Array.from({ length: opts.workers }, worker))
  const unread = signatures.length - txs.length - unreadable
  return { txs, unreadable, stopped: why === null ? null : `${why} with ${unread} transactions unread` }
}

// ------------------------------------------------------------------ the lookup

/** A string that decodes to 32 bytes of base58, which every Solana wallet address is. */
export function isAddress(s: string): boolean {
  if (s.length < 32 || s.length > 44) return false
  try {
    return fromBase58(s).length === 32
  } catch {
    return false
  }
}

export class LookupError extends Error {
  code: 'bad-wallet' | 'busy'
  constructor(code: 'bad-wallet' | 'busy', message: string) {
    super(message)
    this.code = code
  }
}

export interface Report {
  wallet: string
  cluster: 'mainnet'
  generatedAt: string
  scanned: {
    /** The wallet's open accounts of listed stocks, whose recent histories are read first. */
    stockAccounts: number
    /** Signatures from those histories, the latest `perAccount` of each. */
    fromStockAccounts: number
    perAccount: number
    /** The wallet's own latest signatures, at most `limit`. */
    signatures: number
    limit: number
    /** Failed transactions among all of those, which move no tokens and are not read. */
    failed: number
    /** Transactions read: at most `cap`, the stock accounts' first. */
    read: number
    cap: number
    unreadable: number
    /** Buys left unpriced because the same transaction moved another token too. */
    mixed: number
    /** Set when reading stopped early, with why. */
    stopped: string | null
    /** The oldest block time read, UTC, ISO 8601: how far back "the last hundred" reached. */
    oldest: string | null
  }
  buys: Buy[]
  summary: Summary
  notes: Record<string, string>
}

export const LOOKUP_LIMITS = {
  /** The wallet's own most recent signatures listed. */
  signatures: 100,
  /** The most recent signatures listed per stock account, and the stock accounts looked at. */
  perAccount: 50,
  accounts: 20,
  /** Transactions read per lookup, at most. */
  transactions: 100,
  /**
   * `getTransaction`s in flight. There is no pause of its own: `httpRpc` paces
   * every call, across all lookups. On the public endpoint that pace is nine a
   * ten seconds, and in practice fewer when it answers 429 anyway, so a lookup
   * reads some fifteen to forty transactions before its budget runs out, the
   * stock accounts' first. A keyed provider in BELL_MAINNET_RPC reads the hundred.
   */
  workers: 3,
  /**
   * Past this, a lookup returns what it has read, and says so. It covers every
   * chain call; Nasdaq's opens come after it, at most two seven-second asks.
   */
  budgetMs: 45_000,
  /** How long a wallet's report is served before its chain is read again. */
  cacheMs: 5 * 60_000,
  maxCached: 500,
  /** Lookups running at once; one more is turned away rather than queued. */
  concurrent: 4,
  /** How long the mints' multipliers are kept before they are read again. */
  mintsMs: 10 * 60_000,
}

/**
 * A wallet lookup with a five-minute memory, so a refresh or a second visitor
 * asking about the same wallet costs nothing, and a cap on how many run at
 * once, so a burst of different wallets is refused rather than turned into a
 * burst on the RPC.
 */
export function createOverpay(opts: {
  rpc: Rpc
  listings: readonly Listing[]
  opens?: Opens
  clock?: () => number
  limits?: Partial<typeof LOOKUP_LIMITS>
}): (wallet: string) => Promise<Report> {
  const clock = opts.clock ?? Date.now
  const limits = { ...LOOKUP_LIMITS, ...opts.limits }
  const opens = opts.opens ?? createOpens({ clock })
  const byMint = new Map(opts.listings.map((l) => [l.mainnetMint, l]))
  const stockMints = new Set(byMint.keys())
  const cache = new Map<string, { at: number; report: Report }>()
  const inflight = new Map<string, Promise<Report>>()
  let mints: { at: number; scaled: Map<string, ScaledUi | null>; programs: string[] } | null = null

  type Sig = { signature: string; err: unknown; blockTime?: number | null }
  const signaturesOf = (rpc: Rpc, address: string, limit: number) =>
    rpc('getSignaturesForAddress', [address, { limit, commitment: 'confirmed' }]) as Promise<Sig[]>

  /**
   * Which transactions to read, in order. A buy always changes the wallet's
   * balance in a stock account, so each open stock account's own history holds
   * every buy into it, however busy the wallet is otherwise; those come first,
   * newest first. The wallet's own latest signatures come after, which is what
   * finds a buy into an account since closed. On 24 September a wallet the
   * census saw buy LMT twice that week had its latest hundred signatures inside
   * twenty minutes, none of them a buy.
   *
   * A stock account whose history cannot be listed in time is passed over and
   * counted, rather than failing the lookup; the wallet's own list still runs.
   */
  async function toRead(rpc: Rpc, wallet: string, programs: readonly string[]) {
    const [own, accounts] = await Promise.all([
      signaturesOf(rpc, wallet, limits.signatures),
      stockAccounts(rpc, wallet, programs, opts.listings),
    ])
    const looked = accounts.slice(0, limits.accounts)
    const histories = await Promise.allSettled(looked.map((a) => signaturesOf(rpc, a.account, limits.perAccount)))
    const accountsUnlisted = histories.filter((h) => h.status === 'rejected').length
    const fromAccounts = histories
      .flatMap((h) => (h.status === 'fulfilled' ? h.value : []))
      .sort((a, b) => (b.blockTime ?? Infinity) - (a.blockTime ?? Infinity))
    const seen = new Set<string>()
    const unique: Sig[] = []
    for (const s of [...fromAccounts, ...own]) {
      if (seen.has(s.signature)) continue
      seen.add(s.signature)
      unique.push(s)
    }
    const ok = unique.filter((s) => s.err === null || s.err === undefined).map((s) => s.signature)
    return {
      signatures: ok.slice(0, limits.transactions),
      accountsUnlisted,
      counts: {
        stockAccounts: looked.length,
        fromStockAccounts: fromAccounts.length,
        perAccount: limits.perAccount,
        signatures: own.length,
        limit: limits.signatures,
        failed: unique.length - ok.length,
        cap: limits.transactions,
      },
    }
  }

  async function lookup(wallet: string): Promise<Report> {
    const started = clock()
    // One budget over every chain call, the mints and the listing included,
    // since those queue behind other lookups' calls on the shared pace too.
    const deadline = started + limits.budgetMs
    const rpc = bounded(opts.rpc, deadline, clock)
    if (!mints || started - mints.at > limits.mintsMs) {
      mints = { at: started, ...(await readMints(rpc, opts.listings)) }
    }
    const scaled = mints.scaled
    const plan = await toRead(rpc, wallet, mints.programs)
    const read = await readTransactions(rpc, plan.signatures, { workers: limits.workers, deadline, clock })
    const { txs, unreadable } = read
    const stopped =
      [
        plan.accountsUnlisted > 0
          ? `${plan.accountsUnlisted} of ${plan.counts.stockAccounts} stock accounts' histories could not be listed`
          : null,
        read.stopped,
      ]
        .filter(Boolean)
        .join('; ') || null
    let mixed = 0
    const priced: Buy[] = []
    for (const tx of txs) {
      const found = buysIn(tx, stockMints, wallet)
      mixed += found.mixed
      for (const leg of found.buys) priced.push(priceBuy(leg, byMint.get(leg.mint)!, scaled.get(leg.mint) ?? null))
    }
    const buys = (await withOpens(priced, opens)).sort((a, b) => (a.time < b.time ? 1 : a.time > b.time ? -1 : 0))
    const times = txs.map((t) => t.blockTime).filter((t): t is number => t !== null)
    return {
      wallet,
      cluster: 'mainnet',
      generatedAt: iso(Math.floor(clock() / 1000)),
      scanned: {
        ...plan.counts,
        read: txs.length,
        unreadable,
        mixed,
        stopped,
        oldest: times.length ? iso(Math.min(...times)) : null,
      },
      buys,
      summary: summarize(buys),
      notes: NOTES,
    }
  }

  return async function overpay(wallet: string): Promise<Report> {
    if (!isAddress(wallet)) throw new LookupError('bad-wallet', 'That is not a Solana address.')
    const now = clock()
    const hit = cache.get(wallet)
    if (hit && now - hit.at < limits.cacheMs) return hit.report
    const running = inflight.get(wallet)
    if (running) return running
    if (inflight.size >= limits.concurrent) {
      throw new LookupError('busy', 'Several wallets are being read already. Try again in a minute.')
    }
    const p = lookup(wallet)
      .then((report) => {
        cache.delete(wallet)
        cache.set(wallet, { at: clock(), report })
        // A Map iterates in insertion order, so the first key is the oldest.
        while (cache.size > limits.maxCached) cache.delete(cache.keys().next().value!)
        return report
      })
      .finally(() => inflight.delete(wallet))
    inflight.set(wallet, p)
    return p
  }
}

/** What a reader needs to use the numbers, published with them. */
export const NOTES: Record<string, string> = {
  buy:
    "A buy is a transaction in which this wallet's balance of a listed stock rose and its USDC fell, and " +
    'nothing else it holds moved. Buys paid in SOL or any other token are not counted; transactions that ' +
    'moved a third token are counted as mixed and not priced, since their USDC cannot be split. The rule reads ' +
    'balances, not intent: repaying a USDC loan while withdrawing stock held as collateral has the same shape ' +
    'and would read as a buy.',
  price:
    'Price per share is all-in: the USDC that left the wallet divided by the shares that arrived, where ' +
    "shares are raw units times the mint's scaled-UI multiplier at the block time. Fees and slippage are inside it. " +
    'A mint records only its latest multiplier step, and an Ondo mint not even the value before that step, so ' +
    'a buy older than the latest step may be priced a dividend off: those are marked multiplierExact: false and ' +
    'kept out of the summary.',
  open:
    "The next open is the underlying's opening price for the next regular session, as Nasdaq's daily history " +
    "records it. A day's row appears only after its close, so until then the open is not yet recorded.",
  gap:
    'The gap is price per share over the next open, less one, in basis points: positive means the buy paid ' +
    'more. It includes whatever genuinely happened between the buy and the open, not only what the pool charged. ' +
    'The open is a quote, not a fill: nobody could be sure of buying at it.',
  scope:
    "Read first: the latest transactions of each stock account the wallet still holds, where every buy into " +
    "it appears. Then the wallet's own latest transactions, which finds a buy into an account since closed. " +
    'At most the cap shown in all, and older ones are not read. Mainnet only; nothing is signed.',
}
