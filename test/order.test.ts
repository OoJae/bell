import assert from 'node:assert/strict'
import test from 'node:test'
import { confCap, deadReason, DEFAULT_CONF_BPS, limitFloor, lossFloor, maxPricePerShare, orderFloor, stillOwed } from '../src/policy/order.ts'
import { MAINNET_LISTINGS } from '../src/listings.ts'

const Q64 = 1n << 64n

test('the loss floor is three quarters of the placement-time rate, and absent without one', () => {
  assert.equal(lossFloor(4n * Q64), 3n * Q64)
  assert.equal(lossFloor(null), 0n)
  assert.equal(lossFloor(undefined), 0n)
  assert.equal(lossFloor(0n), 0n)
})

test('a forged near-zero mark cannot fill below the floor', () => {
  // The program takes max(band, floor) as the minimum delivered. With a mark
  // of 1/1000th of the real rate the band is dust; the floor is not.
  const real = 12_345_678n * Q64
  const forged = real / 1000n
  const amountIn = 200_000_000n
  const band = (amountIn * forged) >> 64n
  const floor = (amountIn * lossFloor(real)) >> 64n
  assert.ok(floor > band * 700n)
  assert.equal(floor, (amountIn * real * 3n) / 4n >> 64n)
})

test('every confidence cap is inside the program ceiling, and the thin names are wider', () => {
  for (const l of MAINNET_LISTINGS) assert.ok(confCap(l) > 0 && confCap(l) <= 200, l.symbol)
  assert.equal(confCap({}), DEFAULT_CONF_BPS)
  const by = new Map(MAINNET_LISTINGS.map((l) => [l.symbol, confCap(l)]))
  assert.equal(by.get('PFE'), 100)
  assert.equal(by.get('LMT'), 100)
  assert.equal(by.get('SPYx'), DEFAULT_CONF_BPS)
})

const order = (over: Partial<Parameters<typeof deadReason>[0]> = {}) => ({
  symbol: 'AAPLx',
  amountIn: 200_000_000n,
  filledIn: 0n,
  expiresAt: 2_000n,
  expectedMultiplierBits: 7n,
  ...over,
})

test('an order is dead once expired or once the multiplier it was built on moves', () => {
  assert.equal(deadReason(order(), 1_000, 7n), null)
  assert.equal(deadReason(order(), 2_000, 7n), 'expired')
  assert.equal(deadReason(order(), 1_000, 8n), 'resized')
  // Not knowing the multiplier is not evidence it moved.
  assert.equal(deadReason(order(), 1_000, null), null)
  assert.equal(deadReason(order(), 1_000, undefined), null)
})

test('the delegation covers every order that can still fill, and nothing else', () => {
  const book = [
    order({ amountIn: 100n }),
    order({ amountIn: 200n, filledIn: 50n }),
    order({ amountIn: 400n, expiresAt: 500n }), // expired
    order({ symbol: 'SPYx', amountIn: 800n, expectedMultiplierBits: 1n }), // resized: SPYx is at 2
  ]
  const bits = (sym: string) => (sym === 'SPYx' ? 2n : 7n)
  assert.equal(stillOwed(book, 1_000, bits), 100n + 150n)
  assert.equal(stillOwed([], 1_000, bits), 0n)
})

test('a limit price becomes the floor that keeps the fill at or under it', () => {
  // A mark at $800.00 a share (micro-dollars) whose rate is R stock per quote.
  const R = 1_250n * Q64
  const px = { num: 800_000_000n, expo: -6 }
  // Limit equal to the mark: the floor is exactly the mark's rate.
  assert.equal(limitFloor(R, px, 800), R)
  // A limit of $1,000 asks for 0.8 of the rate; of $640, for 1.25.
  assert.equal(limitFloor(R, px, 1000), (R * 800n + 999n) / 1000n)
  assert.equal(limitFloor(R, px, 640), (R * 800n + 639n) / 640n)
  // The price the floor enforces never exceeds the limit (rounding goes the user's way).
  for (const limit of [799.99, 812.34, 1_000, 3.21]) {
    const f = limitFloor(R, px, limit)
    const pricePaid = (800 * Number(R)) / Number(f)
    assert.ok(pricePaid <= limit + 1e-9, `limit ${limit} -> ${pricePaid}`)
  }
  // No limit, or nonsense, means no limit floor.
  assert.equal(limitFloor(R, px, 0), 0n)
  assert.equal(limitFloor(R, px, Number.NaN), 0n)
})

test('the order floor is the stricter of the loss cap and the limit, never looser', () => {
  const R = 1_000n * Q64
  const px = { num: 500_000_000n, expo: -6 }
  // A limit above the loss cap's price ($500 / 0.75 = $666.67) cannot loosen it.
  assert.equal(orderFloor(R, px, 900), lossFloor(R))
  // A limit below the mark tightens it.
  assert.equal(orderFloor(R, px, 400), limitFloor(R, px, 400))
  assert.ok(orderFloor(R, px, 400) > lossFloor(R))
  // Without a mark there is nothing to convert against, and no floor.
  assert.equal(orderFloor(null, null, 400), 0n)
})

test('the most you can pay per share is the lower of the limit and the loss cap', () => {
  assert.ok(Math.abs(maxPricePerShare(600, null) - 800) < 1e-9)
  assert.equal(maxPricePerShare(600, 650), 650)
  assert.ok(Math.abs(maxPricePerShare(600, 900) - 800) < 1e-9)
})
