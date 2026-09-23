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

interface Rows<T> {
  rows: T[]
  /** Rows that did not match the schema and were left out. */
  dropped: number
  total: number
}

/** Per endpoint, how many rows the last parse dropped, so a standing problem is reported once. */
const lastDropped = new Map<string, number>()

/**
 * One of Backpack's list endpoints, parsed a row at a time.
 *
 * Parsing the list as a whole meant one malformed security threw the endpoint,
 * and with it the keeper's tick; a tick that pushes nothing closes all nine
 * symbols 120 seconds later. A bad row now costs only itself. For sessions and
 * securities that is still fail-closed: a missing session never reads as the
 * regular one, and a security with no row has no issuer reading, which
 * `reconcile` closes. Holidays are the exception, and `fetchHolidays` handles
 * them.
 *
 * A body that is not a list is still an error: that is a different API, not a
 * bad row.
 */
async function list<T>(path: string, row: z.ZodType<T>): Promise<Rows<T>> {
  const res = await fetch(`${BASE}/${path}`, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) throw new Error(`backpack ${path}: HTTP ${res.status}`)
  const body = z.array(z.unknown()).parse(await res.json())
  const rows: T[] = []
  let example = ''
  for (const r of body) {
    const parsed = row.safeParse(r)
    if (parsed.success) rows.push(parsed.data)
    else if (!example) example = describe(r, parsed.error.issues[0])
  }
  const dropped = body.length - rows.length
  // Said when the count changes rather than every tick, so a row Backpack keeps
  // publishing malformed is one line in the log, not two thousand a day.
  if (dropped !== (lastDropped.get(path) ?? 0)) {
    console.warn(
      dropped === 0
        ? `backpack ${path}: every row parses again`
        : `backpack ${path}: dropped ${dropped} of ${body.length} rows that did not parse, e.g. ${example}`,
    )
    lastDropped.set(path, dropped)
  }
  return { rows, dropped, total: body.length }
}

/** Enough of a rejected row to find it in the response: its name and what was wrong. */
function describe(row: unknown, issue: { path: PropertyKey[]; message: string } | undefined): string {
  const r = (row ?? {}) as Record<string, unknown>
  const name = ['asset', 'symbol', 'name', 'date'].map((k) => r[k]).find((v): v is string => typeof v === 'string') ?? 'a row'
  return issue ? `${name} (${issue.path.map(String).join('.') || 'row'}: ${issue.message})` : name
}

/** Canonical US equity session boundaries, straight from the venue. */
export const fetchSessions = async () => (await list('market-sessions', Session)).rows

/**
 * Full-day closures and early closes. A holiday is a halt you can see coming.
 *
 * All or nothing, unlike every other list here. This is the one list whose
 * rows close the market, so dropping a row closes nothing: its date reads as an
 * ordinary trading day, which is fail-open. An incomplete calendar is therefore
 * an error, and the keeper confines it to the listings that depend on Backpack.
 */
export async function fetchHolidays(): Promise<Holiday[]> {
  const { rows, dropped, total } = await list('market-holidays', Holiday)
  if (dropped > 0) {
    throw new Error(`backpack market-holidays: ${dropped} of ${total} rows did not parse, so the calendar is incomplete`)
  }
  return rows
}

/** Every security Backpack lists — tradeable inside the venue. */
export const fetchSecurities = async () => (await list('securities', Security)).rows

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
  const [{ rows: assets }, securities] = await Promise.all([
    list('assets', Asset),
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
