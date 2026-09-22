import assert from 'node:assert/strict'
import test from 'node:test'
import { confCap, deadReason, DEFAULT_CONF_BPS, lossFloor, stillOwed } from '../src/policy/order.ts'
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
