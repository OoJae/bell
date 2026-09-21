/**
 * Jupiter: on-chain depth, and what a trade would actually cost right now.
 *
 * Two distinct uses:
 *   - `fetchTokens` for the liquidity census (depth, holders, organic flow)
 *   - `quote` for the execution-quality gate, which is the one that stops a
 *     $1,000 order from being filled at 95% price impact.
 */
import { z } from 'zod'

const LITE = 'https://lite-api.jup.ag'
export const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'

const Stats = z
  .object({
    numBuys: z.number().nullable().optional(),
    numSells: z.number().nullable().optional(),
    buyVolume: z.number().nullable().optional(),
    sellVolume: z.number().nullable().optional(),
    buyOrganicVolume: z.number().nullable().optional(),
    numOrganicBuyers: z.number().nullable().optional(),
  })
  .nullable()
  .optional()

const Token = z.object({
  id: z.string(),
  symbol: z.string().nullable().optional(),
  name: z.string().nullable().optional(),
  decimals: z.number(),
  tokenProgram: z.string().nullable().optional(),
  usdPrice: z.number().nullable().optional(),
  mcap: z.number().nullable().optional(),
  liquidity: z.number().nullable().optional(),
  holderCount: z.number().nullable().optional(),
  tags: z.array(z.string()).nullable().optional(),
  stats24h: Stats,
})
export type JupToken = z.infer<typeof Token>

/** Jupiter's search endpoint accepts comma-separated mints, ~90 per call. */
export async function fetchTokens(mints: string[]): Promise<Map<string, JupToken>> {
  const out = new Map<string, JupToken>()
  for (let i = 0; i < mints.length; i += 90) {
    const batch = mints.slice(i, i + 90).join(',')
    const res = await fetch(`${LITE}/tokens/v2/search?query=${batch}`, {
      signal: AbortSignal.timeout(30_000),
    })
    if (!res.ok) throw new Error(`jupiter search: HTTP ${res.status}`)
    for (const t of z.array(Token).parse(await res.json())) out.set(t.id, t)
  }
  return out
}

export interface Quote {
  /** Fractional price impact, e.g. 0.954 for a 95.4% haircut. */
  priceImpact: number
  outAmount: bigint
  routes: number
}

/**
 * A real executable quote. Returns null when no route exists at all —
 * which for the long tail is the common case, not an error.
 */
export async function quote(
  inputMint: string,
  outputMint: string,
  amount: bigint,
  slippageBps = 300,
): Promise<Quote | null> {
  const url =
    `${LITE}/swap/v1/quote?inputMint=${inputMint}&outputMint=${outputMint}` +
    `&amount=${amount}&slippageBps=${slippageBps}`
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) })
  if (!res.ok) return null
  const body = (await res.json()) as Record<string, unknown>
  if (typeof body.outAmount !== 'string') return null
  return {
    priceImpact: Number(body.priceImpactPct ?? 0),
    outAmount: BigInt(body.outAmount),
    routes: Array.isArray(body.routePlan) ? body.routePlan.length : 0,
  }
}

/** USD notional -> raw base units, for quoting a fixed dollar size. */
export function usdc(amount: number): bigint {
  return BigInt(Math.round(amount * 1e6))
}
