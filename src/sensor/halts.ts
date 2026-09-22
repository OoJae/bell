/**
 * Nasdaq's trade-halt feed — the only source here that covers *every* NMS
 * security regardless of who tokenized it.
 *
 * This matters because the issuers are not symmetric. Backed publishes a
 * per-security `isTradingHalted` flag; Backpack publishes venue sessions and a
 * holiday calendar but no halt state at all. Without this feed a Backpack
 * security could be halted on its primary exchange and BELL would have no way
 * to know — which is precisely the condition SEC Order 34-106402 II.H exists
 * to prevent.
 *
 * Free, public, no key. UTP publishes halts for NASDAQ-listed *and* other
 * exchange-listed issues, so NYSE and Arca names appear here too.
 */
import { z } from 'zod'

const FEED = 'https://www.nasdaqtrader.com/rss.aspx?feed=tradehalts'
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36'

/** Mirrors the on-chain `HaltState` discriminants. */
export const HaltKind = {
  None: 0,
  Luld: 1,
  NewsPending: 2,
  MarketWide: 3,
  Suspension: 4,
  Unspecified: 5,
} as const
export type HaltKind = (typeof HaltKind)[keyof typeof HaltKind]

/**
 * Nasdaq reason codes, collapsed to the categories the gate distinguishes.
 *
 * The distinction that matters downstream is whether a resume is expected: a
 * volatility pause clears in minutes, a regulatory suspension does not.
 */
function classify(reason: string): HaltKind {
  const r = reason.trim().toUpperCase()
  if (r.startsWith('LUD')) return HaltKind.Luld // LUDP, LUDS — volatility pause
  if (r.startsWith('MWC')) return HaltKind.MarketWide // circuit breaker
  if (r === 'T1' || r === 'T2' || r === 'T3' || r === 'D') return HaltKind.NewsPending
  // T12 additional-information-requested, H-series regulatory actions.
  if (r.startsWith('H') || r === 'T12') return HaltKind.Suspension
  return HaltKind.Unspecified
}

export interface Halt {
  ticker: string
  issueName: string
  market: string
  reasonCode: string
  kind: HaltKind
  /** Unix seconds, or 0 if unparseable. */
  haltedAt: number
  /** Unix seconds when trading is expected to resume; 0 if none published. */
  resumesAt: number
}

const Row = z.object({ ticker: z.string().min(1) })

function tag(xml: string, name: string): string {
  const m = new RegExp(`<ndaq:${name}>([\\s\\S]*?)</ndaq:${name}>`).exec(xml)
  return m ? m[1].trim() : ''
}

/** `09/21/2026` + `10:11:11.073` in US Eastern -> unix seconds. */
function easternToUnix(date: string, time: string): number {
  const d = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(date.trim())
  if (!d) return 0
  const [, mm, dd, yyyy] = d
  const hms = (time.trim().split('.')[0] || '00:00:00').padEnd(8, '0')
  // Eastern is UTC-4 in daylight time and UTC-5 in standard time. Resolve it
  // via the IANA database rather than hardcoding an offset that is wrong for
  // four months of the year.
  const naive = Date.parse(`${yyyy}-${mm}-${dd}T${hms}Z`)
  if (!Number.isFinite(naive)) return 0
  const label = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    timeZoneName: 'shortOffset',
  }).format(new Date(naive))
  const off = /GMT([+-]\d{1,2})/.exec(label)
  const hours = off ? Number(off[1]) : -5
  return Math.floor(naive / 1000) - hours * 3600
}

/** Every currently-published halt, keyed by ticker. */
export async function fetchHalts(): Promise<Map<string, Halt>> {
  // nasdaqtrader.com is slow to connect; the default 10s undici timeout trips.
  const res = await fetch(FEED, {
    headers: { 'user-agent': UA },
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) throw new Error(`nasdaq trade halts: HTTP ${res.status}`)
  return parseHalts(await res.text())
}

/**
 * The feed as a map of each ticker's **most recent** halt.
 *
 * The feed lists every halt of the day, so a stock paused, resumed and paused
 * again appears twice — and keeping whichever row came last in the document
 * kept the *first* halt, already resumed, and read a live halt as over. The
 * row with the latest halt time is the one that describes the stock now.
 */
export function parseHalts(xml: string): Map<string, Halt> {
  const out = new Map<string, Halt>()
  for (const [, item] of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const ticker = tag(item, 'IssueSymbol')
    if (!Row.safeParse({ ticker }).success) continue
    const reasonCode = tag(item, 'ReasonCode')
    const halt: Halt = {
      ticker,
      issueName: tag(item, 'IssueName'),
      market: tag(item, 'Market'),
      reasonCode,
      kind: classify(reasonCode),
      haltedAt: easternToUnix(tag(item, 'HaltDate'), tag(item, 'HaltTime')),
      resumesAt: easternToUnix(tag(item, 'ResumptionDate'), tag(item, 'ResumptionTradeTime')),
    }
    const prev = out.get(ticker)
    if (!prev || halt.haltedAt >= prev.haltedAt) out.set(ticker, halt)
  }
  return out
}

/** A halt is over once its published resumption time has passed. */
export function isActive(halt: Halt, nowSeconds: number): boolean {
  return halt.resumesAt === 0 || nowSeconds < halt.resumesAt
}
