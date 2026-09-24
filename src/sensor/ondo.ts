/**
 * Ondo Global Markets: the issuer's own word on each of its tokens.
 *
 * Read from the list Ondo's web app loads, `app.ondo.finance/api/v2/assets`:
 * public, no key, and heavy. Measured 2026-09-24 it was 3.0 MB for 452 assets
 * and took about 12 seconds, so it is never read inside the keeper's 45-second
 * tick. A background loop reads it every five minutes into a cache, and the
 * tick takes whatever the cache holds at that instant.
 *
 * A cached reading older than ten minutes is no reading. The keeper then has
 * no issuer view for an Ondo token, and `reconcile` closes it: "no issuer
 * reading; closed until one arrives". So a dead feed closes Ondo's names within
 * two missed reads, and costs nothing else on the board.
 *
 * Per asset, BELL reads four things and trusts none of them to be present:
 * `isTradingPaused`, and in `assetTradingStatus` whether the asset is
 * tradeable, why it is paused, and whether Ondo's market is open and in which
 * session. A row missing any of the flags is dropped, so it reads as no
 * reading rather than as "not paused".
 *
 * This is a web app's API, not a published one. Its shape can change without
 * notice, which is why every row is validated and a change fails closed.
 */
import { z } from 'zod'

export const ONDO_ASSETS_URL = 'https://app.ondo.finance/api/v2/assets'
/** Five times the ~12 s it took when measured, for a slow day. */
const TIMEOUT_MS = 60_000
/** How often the background loop reads the list. */
export const ONDO_REFRESH_MS = 5 * 60_000
/** Past this a reading is no reading. Two missed refreshes, not one. */
export const ONDO_MAX_AGE_MS = 10 * 60_000
/** A failed read is retried this soon, so one blip does not cost ten minutes. */
const RETRY_MS = 60_000
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36'

const TradingStatus = z.object({
  isAssetTradeable: z.boolean(),
  // Null on all 452 assets when measured, so its shape when set is unknown.
  // Anything but null or an empty string is read as a pause.
  assetPauseReason: z.unknown().optional(),
  isMarketOpen: z.boolean(),
  currentSession: z.string(),
})

const Asset = z.object({
  symbol: z.string(),
  ticker: z.string().nullable().optional(),
  isTradingPaused: z.boolean(),
  assetTradingStatus: TradingStatus,
})

const Body = z.object({
  lastUpdatedAt: z.string().nullable().optional(),
  assets: z.array(z.unknown()),
})

/** One Ondo token as BELL reads it. */
export interface OndoAsset {
  /** Ondo's symbol, e.g. `SPYon`: the join key, since the list carries no addresses. */
  symbol: string
  /** The underlying ticker Ondo names, e.g. `SPY`. Checked against the listing. */
  ticker: string | null
  /** `isTradingPaused`, or any pause reason given. Either stops the token. */
  paused: boolean
  pauseReason: string | null
  /** `assetTradingStatus.isAssetTradeable`. */
  tradeable: boolean
  /** `assetTradingStatus.isMarketOpen`: Ondo's market, not the exchange's session. */
  marketOpen: boolean
  /** `assetTradingStatus.currentSession`, e.g. `regular`. Informational. */
  session: string
}

export interface OndoSnapshot {
  /**
   * The instant the reading describes, in ms: Ondo's own `lastUpdatedAt`, but
   * never later than the moment it arrived. Ondo's stamp is what reveals a
   * list served from a stale cache; the cap keeps a clock ahead of ours from
   * buying the reading extra life.
   */
  asOf: number
  assets: Map<string, OndoAsset>
  /** Wanted rows present but malformed, left out. Each reads as no reading. */
  dropped: string[]
}

/** One line, short: it ends up in every Ondo verdict's detail. */
const oneLine = (s: string, max = 120) => s.replace(/\s+/g, ' ').trim().slice(0, max)

function reasonOf(r: unknown): string | null {
  if (r === null || r === undefined) return null
  const text = typeof r === 'string' ? r : JSON.stringify(r)
  return text.trim() === '' ? null : oneLine(text)
}

/**
 * Parse the list, keeping only the symbols asked for.
 *
 * Row by row, as with Backpack's lists: one malformed asset costs itself, not
 * the other names. A body that is not this shape at all throws, because that
 * is a different API rather than a bad row, and the cache then keeps whatever
 * it last had until that ages out.
 */
export function parseOndoAssets(
  body: unknown,
  receivedAt: number,
  want?: ReadonlySet<string>,
): OndoSnapshot {
  const b = Body.parse(body)
  const assets = new Map<string, OndoAsset>()
  const dropped: string[] = []
  for (const row of b.assets) {
    const symbol = (row as { symbol?: unknown } | null)?.symbol
    if (want && (typeof symbol !== 'string' || !want.has(symbol))) continue
    const parsed = Asset.safeParse(row)
    if (!parsed.success) {
      dropped.push(typeof symbol === 'string' ? symbol : '(no symbol)')
      continue
    }
    const a = parsed.data
    const s = a.assetTradingStatus
    const pauseReason = reasonOf(s.assetPauseReason)
    assets.set(a.symbol, {
      symbol: a.symbol,
      ticker: a.ticker ?? null,
      paused: a.isTradingPaused || pauseReason !== null,
      pauseReason,
      tradeable: s.isAssetTradeable,
      marketOpen: s.isMarketOpen,
      session: oneLine(s.currentSession, 40),
    })
  }
  const stamped = b.lastUpdatedAt ? Date.parse(b.lastUpdatedAt) : Number.NaN
  return {
    asOf: Number.isFinite(stamped) ? Math.min(stamped, receivedAt) : receivedAt,
    assets,
    dropped,
  }
}

/** One read of the whole list. Slow; call it from the background loop only. */
export async function fetchOndoAssets(want?: ReadonlySet<string>): Promise<OndoSnapshot> {
  const res = await fetch(ONDO_ASSETS_URL, {
    headers: { 'user-agent': UA, accept: 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`ondo assets: HTTP ${res.status}`)
  return parseOndoAssets(await res.json(), Date.now(), want)
}

/** What the tick gets: the assets, or why there are none. */
export type OndoReading =
  | { assets: Map<string, OndoAsset>; asOf: number; error?: undefined }
  | { assets?: undefined; error: string }

/**
 * The background cache.
 *
 * `start` is idempotent and returns at once; `reading` never waits on the
 * network. Timers are unref'd, so a one-shot keeper run is not held open by
 * the loop, only by a read already in flight.
 */
export class OndoFeed {
  private snapshot: OndoSnapshot | null = null
  private error: string | null = null
  private inflight: Promise<void> | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private retry: ReturnType<typeof setTimeout> | null = null
  /** Symbols last reported as dropped, so a standing problem is said once. */
  private lastDropped = ''
  private readonly load: () => Promise<OndoSnapshot>
  private readonly now: () => number
  private readonly refreshMs: number
  private readonly maxAgeMs: number

  constructor(opts: {
    load: () => Promise<OndoSnapshot>
    now?: () => number
    refreshMs?: number
    maxAgeMs?: number
  }) {
    this.load = opts.load
    this.now = opts.now ?? Date.now
    this.refreshMs = opts.refreshMs ?? ONDO_REFRESH_MS
    this.maxAgeMs = opts.maxAgeMs ?? ONDO_MAX_AGE_MS
  }

  /** Begin the loop if it is not running. Reads once now, then on the cadence. */
  start(): void {
    if (this.timer) return
    void this.refresh()
    this.timer = setInterval(() => void this.refresh(), this.refreshMs)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    if (this.retry) clearTimeout(this.retry)
    this.timer = null
    this.retry = null
  }

  /**
   * One read, never two at once, never throwing. A failure keeps the previous
   * snapshot, which stays usable until it ages out, and schedules one early
   * retry.
   */
  refresh(): Promise<void> {
    if (this.inflight) return this.inflight
    this.inflight = this.load()
      .then((s) => {
        this.snapshot = s
        this.error = null
        const dropped = s.dropped.join(', ')
        if (dropped !== this.lastDropped) {
          console.warn(
            dropped
              ? `ondo assets: left out malformed rows for ${dropped}; they read as no reading`
              : 'ondo assets: every wanted row parses again',
          )
          this.lastDropped = dropped
        }
      })
      .catch((e: unknown) => {
        this.error = oneLine(String((e as Error)?.message ?? e), 160)
        if (this.timer && !this.retry) {
          this.retry = setTimeout(() => {
            this.retry = null
            void this.refresh()
          }, RETRY_MS)
          this.retry.unref?.()
        }
      })
      .finally(() => {
        this.inflight = null
      })
    return this.inflight
  }

  /** The cached reading at `now`, or why there is none. Never touches the network. */
  reading(now: number = this.now()): OndoReading {
    const s = this.snapshot
    if (!s) return { error: this.error ?? 'no reading yet' }
    const age = now - s.asOf
    if (age > this.maxAgeMs) {
      const said = `last reading ${Math.round(age / 1000)}s old, limit ${this.maxAgeMs / 1000}s`
      return { error: this.error ? `${said}; ${this.error}` : said }
    }
    return { assets: s.assets, asOf: s.asOf }
  }
}
