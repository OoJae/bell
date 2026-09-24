/**
 * The bounds every order carries, whoever places it.
 *
 * Shared by the page and `scripts/queue.ts` so an order placed from either is
 * the same order. Pure, no I/O.
 */
import type { Listing } from '../listings.ts'

/**
 * The loss cap: an order will not fill for less than this fraction of what
 * the mark said it was worth when it was placed.
 *
 * The mark is the one attested price in the system, and a leaked attestor key
 * could push a near-zero one. Strict mode does not stop that — it trusts the
 * same attestor's session — so without a floor a parked order could be filled
 * for dust. Three quarters of the placement-time value leaves room for any
 * real overnight gap in these names and none for a forged price.
 */
export const LOSS_FLOOR = { num: 3n, den: 4n } as const

/** `floor_rate_q64` for an order placed against this mark; 0 (no floor) without one. */
export function lossFloor(markRateQ64: bigint | null | undefined): bigint {
  return markRateQ64 && markRateQ64 > 0n ? (markRateQ64 * LOSS_FLOOR.num) / LOSS_FLOOR.den : 0n
}

/** A mark's price as the program stores it: `num × 10^expo` quote units per share. */
export interface MarkPrice {
  num: bigint
  expo: number
}

/**
 * `floor_rate_q64` for a user's limit: "don't pay more than `limitUsd` a share".
 *
 * The program measures a floor as raw stock out per raw quote in (Q64.64), the
 * same unit as the mark's rate, and the mark carries the per-share price that
 * rate stands for. Price and rate are inverse, so a limit P against a mark at
 * price M is the mark's rate scaled by M / P. No decimals or multiplier are
 * needed: the mark has already folded both in.
 *
 * Rounded up. A floor a hair above the exact limit asks for a hair more stock,
 * which can only keep the price at or under the limit.
 */
export function limitFloor(markRateQ64: bigint, markPx: MarkPrice, limitUsd: number): bigint {
  if (!(limitUsd > 0) || markRateQ64 <= 0n || markPx.num <= 0n) return 0n
  // The limit in the mark's own units, so the ratio is exact integer arithmetic.
  const scale = 10 ** -markPx.expo
  const limit = BigInt(Math.round(limitUsd * scale))
  if (limit <= 0n) return 0n
  return (markRateQ64 * markPx.num + limit - 1n) / limit
}

/**
 * The floor an order is placed with: the stricter of the loss cap and the
 * user's own limit. The user can only ever tighten the protection, never loosen
 * it below the loss cap.
 */
export function orderFloor(
  markRateQ64: bigint | null | undefined,
  markPx: MarkPrice | null | undefined,
  limitUsd: number | null | undefined,
): bigint {
  const loss = lossFloor(markRateQ64)
  const limit = markRateQ64 && markPx && limitUsd ? limitFloor(markRateQ64, markPx, limitUsd) : 0n
  return limit > loss ? limit : loss
}

/**
 * The most an order can ever pay per share, whatever the price does before it
 * fills: the user's limit, or the loss cap (the placement price ÷ 3/4),
 * whichever is lower. This is the absolute promise; the band is relative to
 * the price at the bell.
 */
export function maxPricePerShare(markPxUsd: number, limitUsd: number | null | undefined): number {
  const byLoss = (markPxUsd * Number(LOSS_FLOOR.den)) / Number(LOSS_FLOOR.num)
  return limitUsd && limitUsd > 0 ? Math.min(limitUsd, byLoss) : byLoss
}

/**
 * The next `count` regular-session opens, as unix seconds, that an order placed
 * `now` could still reach before the program's lifetime cap.
 *
 * A recurring buy is several ordinary bell orders, each one held back until its
 * own open by `not_before`. The program limits how long an order may live, so
 * only opens inside that horizon (less an hour, to leave it time to fill) are
 * offered, and the calendar's own holidays and early closes decide which days
 * count. Where the calendar has no opinion (outside the years it covers) it
 * stops rather than guesses.
 */
export function upcomingOpens(
  now: number,
  count: number,
  isOpenAt: (at: number) => boolean | null,
  nextChangeAfter: (at: number) => number | null,
  horizonSeconds: number,
): number[] {
  const opens: number[] = []
  const limit = now + horizonSeconds - 3_600
  let t = now
  while (opens.length < count) {
    const change = nextChangeAfter(t)
    if (change === null || change > limit) break
    // A change into an open session is an open; a change out of one is a close.
    if (isOpenAt(change) === true) opens.push(change)
    t = change
  }
  return opens
}

/** The widest mark uncertainty (the quote's price impact) an order accepts at fill time, when a listing sets none. */
export const DEFAULT_CONF_BPS = 50

export const confCap = (listing: Pick<Listing, 'maxConfBps'>): number => listing.maxConfBps ?? DEFAULT_CONF_BPS

interface OrderLike {
  symbol: string
  amountIn: bigint
  filledIn: bigint
  expiresAt: bigint
  expectedMultiplierBits: bigint
}

/**
 * Why an order can never fill, or null if it still can.
 *
 * `multiplierBits` is the multiplier in force for the order's symbol, when
 * known. An order snapshots it at placement and the gate refuses it forever
 * once it moves, so a corporate action kills every order parked across it.
 */
export function deadReason(
  o: OrderLike,
  now: number,
  multiplierBits: bigint | null | undefined,
): 'expired' | 'resized' | null {
  if (now >= Number(o.expiresAt)) return 'expired'
  if (multiplierBits != null && multiplierBits !== o.expectedMultiplierBits) return 'resized'
  return null
}

/** Raw quote still owed across a set of orders. */
export const committedOf = (orders: readonly { amountIn: bigint; filledIn: bigint }[]): bigint =>
  orders.reduce((n, o) => n + (o.amountIn - o.filledIn), 0n)

/**
 * Raw quote the delegation must cover: every order that can still fill.
 *
 * SPL `Approve` assigns rather than adds, so each new approval is for the
 * whole book. A dead order is left out — funding it only keeps quote tied up
 * for an order that will never settle, and once unfunded anyone may close it,
 * which returns its rent to the owner.
 */
export function stillOwed<T extends OrderLike>(
  orders: readonly T[],
  now: number,
  multiplierBitsOf: (symbol: string) => bigint | null | undefined,
): bigint {
  return committedOf(orders.filter((o) => deadReason(o, now, multiplierBitsOf(o.symbol)) === null))
}
