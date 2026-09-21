/**
 * Pyth, for market hours only.
 *
 * `/v2/price_feeds` is public and needs no key, and every equity feed carries
 * `market_hours` plus a machine-readable `schedule` string. That covers 1,245
 * equity feeds — far wider than any single issuer — and it is the input BELL
 * uses to decide whether a *session* is open.
 *
 * Prices are a different matter: since the Core upgrade of 2026-08-26 they
 * require a subscription, and a free key returns 403 for every feed in this
 * asset class. Nothing here reads a price. See `docs/PYTH.md`.
 */
import { z } from 'zod'

const HERMES = 'https://hermes.pyth.network/v2'

const Feed = z.object({
  id: z.string(),
  market_hours: z
    .object({
      is_open: z.boolean(),
      next_open: z.number().nullable().optional(),
      next_close: z.number().nullable().optional(),
    })
    .nullable()
    .optional(),
  attributes: z
    .object({
      symbol: z.string().nullable().optional(),
      display_symbol: z.string().nullable().optional(),
      asset_type: z.string().nullable().optional(),
      /**
       * `TZ; Mon..Sun; holiday overrides`, e.g.
       * `America/New_York;0930-1600,...,C,C;1225/C,1127/0930-1300`
       * where `C` is closed and `O` is always open.
       */
      schedule: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
})

/** One equity's session state as Pyth reports it. */
export interface PythSession {
  /** Underlying ticker, e.g. `SPY` — the join key against an issuer feed. */
  ticker: string
  feedId: string
  isOpen: boolean
  nextOpen: number | null
  nextClose: number | null
  schedule: string | null
}

/** `Equity.US.SPY/USD` -> `SPY`. Anything else is not a US equity feed. */
function tickerOf(symbol: string | null | undefined): string | null {
  const m = /^Equity\.US\.(.+)\/USD$/.exec(symbol ?? '')
  return m ? m[1] : null
}

/**
 * Every US equity feed, keyed by underlying ticker.
 *
 * Note the coverage gap this exposes: roughly a third of xStocks track
 * non-US listings (London, Hong Kong) for which no `Equity.US.*` feed exists.
 * Those symbols are single-sourced, and the reconciler marks them degraded
 * rather than pretending to a confirmation it does not have.
 */
export async function fetchEquitySessions(): Promise<Map<string, PythSession>> {
  const res = await fetch(`${HERMES}/price_feeds?asset_type=equity`, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) throw new Error(`pyth price_feeds: HTTP ${res.status}`)

  const out = new Map<string, PythSession>()
  for (const f of z.array(Feed).parse(await res.json())) {
    const ticker = tickerOf(f.attributes?.symbol)
    if (!ticker || !f.market_hours) continue
    out.set(ticker, {
      ticker,
      feedId: f.id,
      isOpen: f.market_hours.is_open,
      nextOpen: f.market_hours.next_open ?? null,
      nextClose: f.market_hours.next_close ?? null,
      schedule: f.attributes?.schedule ?? null,
    })
  }
  return out
}
