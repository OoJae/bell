/**
 * Backed xStocks issuer feed.
 *
 * This is the only public source that states, per asset, whether the underlying
 * is halted and which trading session it is currently in. Nothing on Solana
 * consumes it today. It is the primary input to BELL's session and halt gates.
 *
 * The API rejects non-browser user agents with 403.
 */
import { z } from 'zod'

const BASE = 'https://api.xstocks.fi/api/v2/public'
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36'

/** Per-asset session mode. The universe is not uniform — all three occur. */
export const TradingHoursMode = z.enum(['TwentyFourFive', 'MarketHours', 'Regular'])
export type TradingHoursMode = z.infer<typeof TradingHoursMode>

/** Session the asset is in right now, as the issuer reports it. */
export const Period = z.enum(['market', 'extended', 'overnight', 'closed'])
export type Period = z.infer<typeof Period>

const OrderLimits = z.object({
  minOrderFiatValue: z.number().nullable().optional(),
  maxOrderFiatValue: z.number().nullable().optional(),
})

const Trading = z.object({
  currency: z.string().nullable().optional(),
  tradingHoursMode: TradingHoursMode.nullable().optional(),
  isTradingHalted: z.boolean().nullable().optional(),
  currentPeriod: Period.nullable().optional(),
  openNow: z.boolean().nullable().optional(),
  nextChangeAt: z.string().nullable().optional(),
  exchange: z
    .object({
      mic: z.string().nullable().optional(),
      abbreviation: z.string().nullable().optional(),
      name: z.string().nullable().optional(),
      timezone: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
  limitsPerPeriod: z.record(z.string(), OrderLimits).nullable().optional(),
})

const Deployment = z.object({
  address: z.string(),
  network: z.string(),
  supportsAtomicSwaps: z.boolean().nullable().optional(),
})

const Asset = z.object({
  id: z.string(),
  symbol: z.string(),
  name: z.string(),
  isin: z.string().nullable().optional(),
  underlyingSymbol: z.string().nullable().optional(),
  isTradingHalted: z.boolean().nullable().optional(),
  deployments: z.array(Deployment).nullable().optional(),
  trading: Trading.nullable().optional(),
})

const Page = z.object({
  nodes: z.array(Asset),
  page: z.object({ currentPage: z.number(), hasNextPage: z.boolean() }),
})

/** One xStock as BELL cares about it: a Solana mint plus its live market state. */
export interface XStock {
  symbol: string
  name: string
  underlyingSymbol: string | null
  isin: string | null
  mint: string
  /** Backed's atomic issuance/redemption (xChange) is available for this deployment. */
  supportsAtomicSwaps: boolean
  halted: boolean
  period: Period | null
  openNow: boolean
  hoursMode: TradingHoursMode | null
  /** ISO-8601 instant at which `period` next changes. */
  nextChangeAt: string | null
  /** MIC of the primary listing exchange — what §II.H halt sync is measured against. */
  exchangeMic: string | null
  minOrderUsd: number | null
  /** Issuance/redemption is hard-closed at weekends: maxOrderFiatValue drops to 0. */
  maxOrderUsdNow: number | null
}

async function getPage(page: number): Promise<z.infer<typeof Page>> {
  const res = await fetch(`${BASE}/assets?network=Solana&page=${page}`, {
    headers: { 'user-agent': UA, accept: 'application/json' },
  })
  if (!res.ok) throw new Error(`xstocks assets page ${page}: HTTP ${res.status}`)
  return Page.parse(await res.json())
}

/** Every xStock deployed on Solana, with its current session and halt state. */
export async function fetchUniverse(): Promise<XStock[]> {
  const out: XStock[] = []
  const seen = new Set<string>()
  for (let page = 0; page < 50; page++) {
    const { nodes, page: meta } = await getPage(page)
    for (const a of nodes) {
      if (seen.has(a.id)) continue
      seen.add(a.id)
      const sol = (a.deployments ?? []).find((d) => d.network.toLowerCase().startsWith('sol'))
      if (!sol) continue
      const t = a.trading ?? {}
      const period = t.currentPeriod ?? null
      const limits = period ? t.limitsPerPeriod?.[period] : undefined
      out.push({
        symbol: a.symbol,
        name: a.name,
        underlyingSymbol: a.underlyingSymbol ?? null,
        isin: a.isin ?? null,
        mint: sol.address,
        supportsAtomicSwaps: sol.supportsAtomicSwaps ?? false,
        halted: Boolean(a.isTradingHalted || t.isTradingHalted),
        period,
        openNow: t.openNow ?? false,
        hoursMode: t.tradingHoursMode ?? null,
        nextChangeAt: t.nextChangeAt ?? null,
        exchangeMic: t.exchange?.mic ?? null,
        minOrderUsd: limits?.minOrderFiatValue ?? null,
        maxOrderUsdNow: limits?.maxOrderFiatValue ?? null,
      })
    }
    if (!meta.hasNextPage) break
  }
  return out
}

const MultiplierResponse = z.object({
  currentMultiplier: z.number(),
  newMultiplier: z.number(),
  activationDateTime: z.number(),
  reason: z.string().nullable(),
})

/**
 * The scaledUiAmount rebase. Raw on-chain balances are NOT share units — the
 * displayed balance is raw x currentMultiplier. A pending change is published
 * ahead of time via `activationDateTime`, which is what makes the dividend
 * drain predictable, and what BELL's rebase gate refuses to trade through.
 *
 * `newMultiplier === 0 && activationDateTime === 0` means nothing is pending.
 */
export async function fetchMultiplier(symbol: string) {
  const res = await fetch(`${BASE}/assets/${symbol}/multiplier?network=Solana`, {
    headers: { 'user-agent': UA, accept: 'application/json' },
  })
  if (!res.ok) throw new Error(`xstocks multiplier ${symbol}: HTTP ${res.status}`)
  const m = MultiplierResponse.parse(await res.json())
  const pending = m.newMultiplier !== 0 && m.activationDateTime !== 0
  return {
    symbol,
    current: m.currentMultiplier,
    next: pending ? m.newMultiplier : null,
    activatesAt: pending ? new Date(m.activationDateTime * 1000).toISOString() : null,
    reason: m.reason,
  }
}
