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

/** The widest source disagreement an order accepts at fill time, when a listing sets none. */
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
