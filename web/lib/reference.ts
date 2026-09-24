/**
 * The last US price of each listing's underlying, for the page to set beside
 * the pool's price — what the real market last said, next to what the pool
 * would charge you now.
 *
 * Display only. Nothing here reaches the gate, an order or a fill: the program
 * never sees it, and a wrong or missing number changes a sentence on the page,
 * not a trade. That is also why a free, delayed, unauthenticated source is good
 * enough, where the gate's own inputs are not.
 *
 * Source: Nasdaq's public quote endpoint, which covers NYSE and Arca listings
 * too. Its quotes are delayed during the session; outside it, the last sale is
 * the close or an extended-hours print, and it says which.
 */
// Written without `window`, which the Node-side typecheck (the tests import this) does not know.
if ('window' in globalThis) throw new Error('reference.ts is server-only')

/**
 * Browser-like headers. Without the language, origin and referer, the endpoint
 * stalls for eight seconds or more before answering, if it answers at all.
 */
const HEADERS = {
  'user-agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36',
  accept: 'application/json, text/plain, */*',
  'accept-language': 'en-US,en;q=0.9',
  origin: 'https://www.nasdaq.com',
  referer: 'https://www.nasdaq.com/',
}

/** Nasdaq files ETFs and stocks under different asset classes and 404s the wrong one. */
const ETFS = new Set(['SPY', 'QQQ', 'IWM', 'JPST'])

export interface Reference {
  underlying: string
  /** Last sale in dollars. */
  last: number
  /** Nasdaq's own label: "Closed", "Market Open", "After-Hours", "Pre-Market". */
  marketStatus: string
  /** Nasdaq's own date/time text for the last trade. */
  asOf: string
  /** False for the delayed feed, which is what this endpoint serves in session. */
  realTime: boolean
}

/** "$767.81" → 767.81; null for anything else. */
export function parseDollars(s: unknown): number | null {
  if (typeof s !== 'string') return null
  const n = Number(s.replace(/[$,\s]/g, ''))
  return Number.isFinite(n) && n > 0 ? n : null
}

/** Nasdaq's quote JSON → a Reference, or null if it is not the shape we know. */
export function parseQuote(underlying: string, json: unknown): Reference | null {
  const d = (json as { data?: { primaryData?: Record<string, unknown>; marketStatus?: unknown } })?.data
  const p = d?.primaryData
  const last = parseDollars(p?.lastSalePrice)
  if (!p || last === null) return null
  return {
    underlying,
    last,
    marketStatus: typeof d?.marketStatus === 'string' ? d.marketStatus : 'unknown',
    asOf: typeof p.lastTradeTimestamp === 'string' ? p.lastTradeTimestamp : '',
    realTime: p.isRealTime === true,
  }
}

async function fetchOne(underlying: string): Promise<Reference | null> {
  const cls = ETFS.has(underlying) ? 'etf' : 'stocks'
  try {
    const res = await fetch(
      `https://api.nasdaq.com/api/quote/${encodeURIComponent(underlying)}/info?assetclass=${cls}`,
      { headers: HEADERS, signal: AbortSignal.timeout(15_000) },
    )
    if (!res.ok) return null
    return parseQuote(underlying, await res.json())
  } catch {
    return null
  }
}

const TTL_MS = 60_000
let cache: { at: number; refs: Record<string, Reference | null> } | null = null
let inflight: Promise<Record<string, Reference | null>> | null = null

/**
 * Every underlying's reference, at most one upstream round per minute however
 * many visitors ask. The upstream takes seconds to answer, so a stale answer
 * is served at once while a fresh one is fetched behind it; only the very
 * first request waits. A failed name keeps its last good value, or reads as
 * null and is simply not shown.
 */
export async function references(underlyings: readonly string[]): Promise<Record<string, Reference | null>> {
  const fresh = cache && Date.now() - cache.at < TTL_MS
  if (fresh) return cache!.refs
  inflight ??= Promise.all(underlyings.map(fetchOne))
    .then((list) => {
      const refs = Object.fromEntries(
        underlyings.map((u, i) => [u, list[i] ?? cache?.refs[u] ?? null]),
      )
      cache = { at: Date.now(), refs }
      return refs
    })
    .finally(() => {
      inflight = null
    })
  return cache ? cache.refs : inflight
}

/**
 * How far the pool's price is from the reference, in basis points: positive
 * when the pool charges more than the real market last traded.
 */
export const premiumBps = (poolUsd: number, refUsd: number): number => ((poolUsd - refUsd) / refUsd) * 10_000
