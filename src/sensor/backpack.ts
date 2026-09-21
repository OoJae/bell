/**
 * Backpack Securities.
 *
 * Unlike Backed's tracker certificates, these are UCC Article 8 security
 * entitlements — the holder's claim is on the real share, with dividends and
 * ACATS redemption. Under SEC Order 34-106402 that distinction is the
 * difference between a "Tokenized NMS Stock" and an instrument the order
 * explicitly excludes.
 *
 * Every endpoint used here is public and unauthenticated. BELL deliberately
 * calls no private endpoint, so it has no KYC or API-key dependency.
 */
import { z } from 'zod'

const BASE = 'https://api.backpack.exchange/api/v1'

const Session = z.object({
  name: z.string(),
  description: z.string().nullable().optional(),
  startTime: z.string(),
  endTime: z.string(),
  startWeekday: z.number(),
  endWeekday: z.number(),
  timezone: z.string(),
})
export type Session = z.infer<typeof Session>

const Holiday = z.object({
  date: z.string(),
  name: z.string(),
  market: z.string(),
  startTime: z.string(),
  endTime: z.string(),
  timezone: z.string(),
})
export type Holiday = z.infer<typeof Holiday>

const AssetToken = z.object({
  blockchain: z.string(),
  contractAddress: z.string().nullable().optional(),
  depositEnabled: z.boolean().nullable().optional(),
  withdrawEnabled: z.boolean().nullable().optional(),
})
const Asset = z.object({
  symbol: z.string(),
  tokens: z.array(AssetToken).nullable().optional(),
})

const SecuritySession = z.object({
  name: z.string(),
  minQuantity: z.string(),
  maxQuantity: z.string(),
  stepSize: z.string(),
})
const Security = z.object({
  asset: z.string(),
  name: z.string(),
  cusip: z.string().nullable().optional(),
  sessions: z.array(SecuritySession).nullable().optional(),
})

async function get<T>(path: string, schema: z.ZodType<T>): Promise<T> {
  const res = await fetch(`${BASE}/${path}`, { headers: { accept: 'application/json' } })
  if (!res.ok) throw new Error(`backpack ${path}: HTTP ${res.status}`)
  return schema.parse(await res.json())
}

/** Canonical US equity session boundaries, straight from the venue. */
export const fetchSessions = () => get('market-sessions', z.array(Session))

/** Full-day closures and early closes. A holiday is a halt you can see coming. */
export const fetchHolidays = () => get('market-holidays', z.array(Holiday))

/** Every security Backpack lists — tradeable inside the venue. */
export const fetchSecurities = () => get('securities', z.array(Security))

export interface RightsBearingMint {
  symbol: string
  mint: string
}

/**
 * The securities that can actually leave the venue and live in a user's wallet.
 *
 * Thousands of mints are provisioned but only a small subset set
 * `withdrawEnabled`. Everything else is an internal book entry: tradeable at
 * Backpack, not self-custodiable, and therefore not addressable from Solana.
 * BELL's allowlist is built from this call and pinned by address.
 */
export async function fetchWithdrawableSecurities(): Promise<RightsBearingMint[]> {
  const [assets, securities] = await Promise.all([
    get('assets', z.array(Asset)),
    fetchSecurities(),
  ])
  const isSecurity = new Set(securities.map((s) => s.asset))
  const out: RightsBearingMint[] = []
  for (const a of assets) {
    if (!isSecurity.has(a.symbol)) continue
    for (const t of a.tokens ?? []) {
      if (t.blockchain === 'Solana' && t.withdrawEnabled && t.contractAddress) {
        out.push({ symbol: a.symbol.replace(/\.US$/, ''), mint: t.contractAddress })
      }
    }
  }
  return out
}
