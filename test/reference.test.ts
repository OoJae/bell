import assert from 'node:assert/strict'
import test from 'node:test'
import { parseDollars, parseQuote, premiumBps } from '../web/lib/reference.ts'

// Nasdaq's public quote JSON for SPY after the close on 23 Sep 2026, trimmed.
const SPY = {
  data: {
    symbol: 'SPY',
    primaryData: { lastSalePrice: '$767.81', lastTradeTimestamp: 'Sep 23, 2026', isRealTime: false },
    marketStatus: 'Closed',
  },
}

test('a Nasdaq quote becomes a labelled reference, and anything else becomes nothing', () => {
  assert.deepEqual(parseQuote('SPY', SPY), {
    underlying: 'SPY',
    last: 767.81,
    marketStatus: 'Closed',
    asOf: 'Sep 23, 2026',
    realTime: false,
  })
  assert.equal(parseQuote('SPY', { data: null }), null)
  assert.equal(parseQuote('SPY', { data: { primaryData: { lastSalePrice: 'N/A' } } }), null)
  assert.equal(parseQuote('SPY', 'garbage'), null)
  assert.equal(parseDollars('$1,234.50'), 1234.5)
  assert.equal(parseDollars('$0.00'), null)
})

test('the premium is positive when the pool charges more than the market last traded', () => {
  assert.ok(Math.abs(premiumBps(101, 100) - 100) < 1e-9)
  assert.ok(Math.abs(premiumBps(767.65, 767.81) - -2.08) < 0.01)
})
