/**
 * Order lifetime, shared by the browser and the CLI so they cannot disagree.
 */
import { LIMITS } from '../chain/codec.ts'

/**
 * When an order should lapse.
 *
 * It used to be a flat 24 hours, which silently broke the core promise for the
 * one case it exists for: an order placed on Friday evening expired before
 * Monday's bell. Now it lasts until six hours after the next open (at least a
 * day), and falls back to four days — enough to cross any weekend, including a
 * holiday Monday — when the next open is not known. Capped an hour inside the
 * program's own `MAX_ORDER_LIFETIME_SECONDS`, so clock skew between browser and
 * cluster can never push it over and get the order refused.
 */
export function orderExpiry(now: number, nextOpen: number | null): number {
  const ceiling = now + (LIMITS.MAX_ORDER_LIFETIME_SECONDS ?? 7 * 86_400) - 3_600
  const target =
    nextOpen && nextOpen > now ? Math.max(now + 86_400, nextOpen + 6 * 3_600) : now + 4 * 86_400
  return Math.min(target, ceiling)
}
