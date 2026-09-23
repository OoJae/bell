import assert from 'node:assert/strict'
import test from 'node:test'
import { parseEquitySessions } from '../src/sensor/pyth.ts'
import { fetchHolidays, fetchSecurities, fetchSessions } from '../src/sensor/backpack.ts'
import { decide, type Observation } from '../src/chain/keeper.ts'
import { ALLOWLIST } from '../src/config.ts'
import type { XStock } from '../src/sensor/xstocks.ts'

const feed = (ticker: string, isOpen: unknown) => ({
  id: `${ticker}-feed`,
  market_hours: { is_open: isOpen, next_open: null, next_close: null },
  attributes: { symbol: `Equity.US.${ticker}/USD`, schedule: null },
})

test('one malformed Pyth row is dropped, and said once rather than every tick', (t) => {
  const warn = t.mock.method(console, 'warn', () => {})
  const body = [feed('SPY', true), feed('QQQ', 'yes'), feed('AAPL', false)]

  const sessions = parseEquitySessions(body)
  assert.deepEqual([...sessions.keys()], ['SPY', 'AAPL'])
  // Dropped reads as missing, and a US listing with no feed is closed.
  assert.equal(sessions.has('QQQ'), false)
  assert.equal(warn.mock.callCount(), 1)
  assert.match(String(warn.mock.calls[0].arguments[0]), /dropped 1 of 3 .*Equity\.US\.QQQ\/USD/)

  parseEquitySessions(body)
  assert.equal(warn.mock.callCount(), 1, 'the same problem on the next tick is not news')

  parseEquitySessions([feed('SPY', true), feed('QQQ', true)])
  assert.equal(warn.mock.callCount(), 2, 'its clearing is')
  assert.match(String(warn.mock.calls[1].arguments[0]), /parses again/)
})

test('a Pyth body that is not a list still fails: that is a different API, not a bad row', () => {
  assert.throws(() => parseEquitySessions({ error: 'rate limited' }))
})

/** Answer each Backpack path with the given body. */
function backpackReturns(t: test.TestContext, bodies: Record<string, unknown>) {
  t.mock.method(console, 'warn', () => {})
  t.mock.method(globalThis, 'fetch', async (url: string | URL) => {
    const path = String(url).split('/api/v1/')[1]
    return new Response(JSON.stringify(bodies[path]), { status: 200 })
  })
}

const REGULAR = {
  name: 'US_EQUITIES_REGULAR',
  startTime: '09:30:00',
  endTime: '16:00:00',
  startWeekday: 1,
  endWeekday: 5,
  timezone: 'America/New_York',
}

test('one malformed Backpack security or session is dropped, not the whole list', async (t) => {
  backpackReturns(t, {
    securities: [
      { asset: 'PFE.US', name: 'Pfizer', sessions: [] },
      { asset: 'LMT.US', name: 42 },
      { asset: 'AAPL.US', name: 'Apple' },
    ],
    'market-sessions': [REGULAR, { ...REGULAR, name: 'US_EQUITIES_OVERNIGHT', startWeekday: 'Sunday' }],
  })
  assert.deepEqual(
    (await fetchSecurities()).map((s) => s.asset),
    ['PFE.US', 'AAPL.US'],
  )
  assert.deepEqual(
    (await fetchSessions()).map((s) => s.name),
    ['US_EQUITIES_REGULAR'],
  )
})

test('a malformed holiday fails the calendar, because a missing holiday reads as open', async (t) => {
  const good = { date: '2026-11-26', name: 'Thanksgiving', market: 'US', startTime: '00:00:00', endTime: '23:59:59', timezone: 'America/New_York' }
  backpackReturns(t, { 'market-holidays': [good, { ...good, date: '2026-12-25', startTime: null }] })
  await assert.rejects(fetchHolidays(), /1 of 2 rows did not parse/)
})

test('without Backpack, only the Backpack listings close', () => {
  const at = new Date('2026-09-23T15:00:00Z') // Wed 11:00 ET, session open
  const obs: Observation = {
    at,
    xstocks: new Map(
      ALLOWLIST.filter((l) => l.issuer === 'backed').map((l) => [
        l.mainnetMint,
        { mint: l.mainnetMint, openNow: true, halted: false, nextChangeAt: null } as XStock,
      ]),
    ),
    pyth: new Map(
      ALLOWLIST.map((l) => [
        l.underlying,
        { ticker: l.underlying, feedId: 'f', isOpen: true, nextOpen: null, nextClose: null, schedule: null },
      ]),
    ),
    halts: new Map(),
    backpack: null,
    backpackError: 'backpack market-holidays: 1 of 2 rows did not parse, so the calendar is incomplete',
  }
  const backpackListings = ALLOWLIST.filter((l) => l.issuer !== 'backed')
  assert.ok(backpackListings.length > 0, 'the allowlist has Backpack listings to close')
  for (const d of decide(obs)) {
    if (d.listing.issuer === 'backed') assert.equal(d.verdict.openNow, true, d.listing.symbol)
    else {
      assert.equal(d.verdict.openNow, false, d.listing.symbol)
      assert.equal(d.sources.issuerOpen, null, d.listing.symbol)
    }
  }
})
