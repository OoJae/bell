import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  assetClassOf,
  judge,
  parseDollars,
  parseMarketInfo,
  parseNasdaqQuote,
  parseNasdaqTimestamp,
  parseYahooChart,
  readReferences,
  sessionOf,
  type MarketInfo,
  type Quote,
} from '../src/sensor/nasdaq.ts'

// Real responses, saved byte for byte, captured 2026-09-24 between 16:34 and
// 16:38 UTC (12:34 to 12:38 New York time, the regular session on a Thursday):
//   nasdaq-quote-{SPY,NVDA,PFE}   api.nasdaq.com/api/quote/{T}/info?assetclass={etf|stocks}
//   nasdaq-quote-SPY-as-stocks    the same for SPY under the wrong asset class
//   nasdaq-market-info            api.nasdaq.com/api/market-info
//   yahoo-chart-SPY               the v8 chart endpoint, interval=1m&range=1d
//   yahoo-chart-unknown           the same for a ticker that does not exist (HTTP 404)
const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}-2026-09-24.json`, import.meta.url), 'utf8'))
const SPY = fixture('nasdaq-quote-SPY')
const NVDA = fixture('nasdaq-quote-NVDA')
const PFE = fixture('nasdaq-quote-PFE')
const SPY_AS_STOCKS = fixture('nasdaq-quote-SPY-as-stocks')
const MARKET = fixture('nasdaq-market-info')
const YAHOO_SPY = fixture('yahoo-chart-SPY')
const YAHOO_UNKNOWN = fixture('yahoo-chart-unknown')

/** A deep copy with one edit, so every altered case starts from a real body. */
function edited<T>(body: T, edit: (b: any) => void): T {
  const copy = structuredClone(body)
  edit(copy)
  return copy
}

/** New York is UTC-4 in September. */
const ny = (h: number, m: number) => Date.UTC(2026, 8, 24, h + 4, m)

test('a real Nasdaq quote becomes a reading: ETF, Nasdaq-listed stock and NYSE stock alike', () => {
  assert.deepEqual(parseNasdaqQuote('SPY', SPY), {
    underlying: 'SPY',
    source: 'nasdaq',
    last: 766.7494,
    lastAt: ny(12, 34),
    session: 'regular',
    realTime: true,
  })
  assert.deepEqual(parseNasdaqQuote('NVDA', NVDA), {
    underlying: 'NVDA',
    source: 'nasdaq',
    last: 223.405,
    lastAt: ny(12, 35),
    session: 'regular',
    realTime: true,
  })
  assert.equal(parseNasdaqQuote('PFE', PFE)?.last, 28.5699)
  assert.equal(parseNasdaqQuote('PFE', PFE)?.lastAt, ny(12, 38))
})

test('a Nasdaq body that is not this reading is no reading at all', () => {
  // The wrong asset class answers 200 with data: null and rCode 400 inside.
  assert.equal(parseNasdaqQuote('SPY', SPY_AS_STOCKS), null)
  // A true quote for a different symbol.
  assert.equal(parseNasdaqQuote('QQQ', SPY), null)
  // After the close Nasdaq prints the date alone. No time, no reading.
  assert.equal(
    parseNasdaqQuote('SPY', edited(SPY, (b) => (b.data.primaryData.lastTradeTimestamp = 'Sep 23, 2026'))),
    null,
  )
  assert.equal(parseNasdaqQuote('SPY', edited(SPY, (b) => (b.data.primaryData.lastSalePrice = 'N/A'))), null)
  assert.equal(parseNasdaqQuote('SPY', edited(SPY, (b) => delete b.data.primaryData)), null)
  assert.equal(parseNasdaqQuote('SPY', edited(SPY, (b) => (b.status.rCode = 500))), null)
  assert.equal(parseNasdaqQuote('SPY', 'garbage'), null)
  assert.equal(parseNasdaqQuote('SPY', null), null)
  // An unknown session label keeps the price and drops only the opinion.
  const odd = parseNasdaqQuote('SPY', edited(SPY, (b) => (b.data.marketStatus = 'Auction')))
  assert.equal(odd?.last, 766.7494)
  assert.equal(odd?.session, null)
})

test('Nasdaq timestamps parse in exactly one form, in New York time across daylight saving', () => {
  assert.equal(parseNasdaqTimestamp('Sep 24, 2026 12:35 PM ET'), ny(12, 35))
  assert.equal(parseNasdaqTimestamp('Sep 24, 2026 9:30 AM ET'), ny(9, 30))
  assert.equal(parseNasdaqTimestamp('Sep 24, 2026 12:05 AM ET'), ny(0, 5))
  // Quotes print "1:01 PM ET"; market-info prints "09:30 AM ET". Same instant.
  assert.equal(parseNasdaqTimestamp('Sep 24, 2026 1:01 PM ET'), ny(13, 1))
  assert.equal(parseNasdaqTimestamp('Sep 24, 2026 01:01 PM ET'), ny(13, 1))
  assert.equal(parseNasdaqTimestamp('Sep 24, 2026 09:30 AM ET'), ny(9, 30))
  // The last minute of the session, and the close, in New York time.
  assert.equal(parseNasdaqTimestamp('Sep 24, 2026 3:59 PM ET'), ny(15, 59))
  assert.equal(parseNasdaqTimestamp('Sep 24, 2026 4:00 PM ET'), ny(16, 0))
  // EST in winter is UTC-5.
  assert.equal(parseNasdaqTimestamp('Dec 1, 2026 10:00 AM ET'), Date.UTC(2026, 11, 1, 15, 0))
  // Either side of 2026's spring change (8 March).
  assert.equal(parseNasdaqTimestamp('Mar 6, 2026 9:30 AM ET'), Date.UTC(2026, 2, 6, 14, 30))
  assert.equal(parseNasdaqTimestamp('Mar 9, 2026 9:30 AM ET'), Date.UTC(2026, 2, 9, 13, 30))
  // 02:30 on 8 March never happened in New York.
  assert.equal(parseNasdaqTimestamp('Mar 8, 2026 2:30 AM ET'), null)

  for (const bad of [
    'Sep 23, 2026', // the after-close form: a date is not a time
    'Sep 31, 2026 10:00 AM ET', // no such day; Date would roll it into October
    'Feb 29, 2026 10:00 AM ET', // not a leap year
    'Sep 24, 2026 13:05 PM ET',
    'Sep 24, 2026 0:05 AM ET',
    'Sep 24, 2026 00:05 AM ET',
    'Sep 24, 2026 012:05 PM ET',
    'Sep 24, 2026 12:5 PM ET',
    'Sep 24, 2026 12:35 PM', // no zone
    'Sep 24, 2026 12:35 PM EST',
    'Sep 24, 2026 12:35 pm ET',
    ' Sep 24, 2026 12:35 PM ET',
    'Closed at Sep 24, 2026 4:00 PM ET',
    'Spt 24, 2026 12:35 PM ET',
    '2026-09-24T16:35:00Z',
    '',
  ]) {
    assert.equal(parseNasdaqTimestamp(bad), null, bad)
  }
  assert.equal(parseNasdaqTimestamp(1790267700), null)
  assert.equal(parseNasdaqTimestamp(null), null)
})

test('dollars parse only as dollars', () => {
  assert.equal(parseDollars('$766.7494'), 766.7494)
  assert.equal(parseDollars('$1,234.50'), 1234.5)
  assert.equal(parseDollars('$28'), 28)
  for (const bad of ['$0.00', 'N/A', '766.74', '$12abc', '$1,23', '$1,2345.00', '$-1.00', '$ 5', '$', '']) {
    assert.equal(parseDollars(bad), null, bad)
  }
  assert.equal(parseDollars(766.74), null)
})

test('session labels: regular only for open, and anything unknown is no opinion', () => {
  assert.equal(sessionOf('Open'), 'regular')
  assert.equal(sessionOf('Market Open'), 'regular')
  assert.equal(sessionOf('Closed'), 'closed')
  assert.equal(sessionOf('Market Closed'), 'closed')
  assert.equal(sessionOf('Pre-Market'), 'pre')
  assert.equal(sessionOf('After-Hours'), 'after')
  assert.equal(sessionOf('After Hours'), 'after')
  assert.equal(sessionOf('Opening soon'), null)
  assert.equal(sessionOf(''), null)
  assert.equal(sessionOf(true), null)
})

test("Nasdaq's market-info gives the market-wide session, and a contradiction is no opinion", () => {
  assert.deepEqual(parseMarketInfo(MARKET), { session: 'regular', label: 'Open / Market Open' })
  const closed = edited(MARKET, (b) => {
    b.data.mrktStatus = 'Closed'
    b.data.marketIndicator = 'Market Closed'
  })
  assert.equal(parseMarketInfo(closed)?.session, 'closed')
  const after = edited(MARKET, (b) => {
    b.data.mrktStatus = 'After-Hours'
    b.data.marketIndicator = 'After Hours'
  })
  assert.equal(parseMarketInfo(after)?.session, 'after')
  assert.equal(parseMarketInfo(edited(MARKET, (b) => (b.data.mrktStatus = 'Closed')))?.session, null)
  // One label unknown: the other one stands.
  assert.equal(parseMarketInfo(edited(MARKET, (b) => (b.data.mrktStatus = 'Halted?')))?.session, 'regular')
  assert.equal(parseMarketInfo(edited(MARKET, (b) => (b.status.rCode = 400))), null)
  assert.equal(parseMarketInfo({ data: {} }), null)
  assert.equal(parseMarketInfo('garbage'), null)
})

test('a real Yahoo chart becomes a reading, with the session read from its trading periods', () => {
  const during = new Date(ny(12, 37))
  assert.deepEqual(parseYahooChart('SPY', YAHOO_SPY, during), {
    underlying: 'SPY',
    source: 'yahoo',
    last: 767.43,
    lastAt: 1_790_267_775_000,
    session: 'regular',
    realTime: null,
  })
  // The same body read at other times of the same day.
  assert.equal(parseYahooChart('SPY', YAHOO_SPY, new Date(ny(9, 29)))?.session, 'pre')
  assert.equal(parseYahooChart('SPY', YAHOO_SPY, new Date(ny(9, 30)))?.session, 'regular')
  assert.equal(parseYahooChart('SPY', YAHOO_SPY, new Date(ny(16, 0)))?.session, 'after')
  assert.equal(parseYahooChart('SPY', YAHOO_SPY, new Date(ny(20, 0)))?.session, 'closed')
  assert.equal(parseYahooChart('SPY', YAHOO_SPY, new Date(ny(3, 59)))?.session, 'closed')
})

test('a Yahoo body that is not this reading is no reading at all', () => {
  const now = new Date(ny(12, 37))
  assert.equal(parseYahooChart('NOTATICKERXYZ', YAHOO_UNKNOWN, now), null)
  assert.equal(parseYahooChart('QQQ', YAHOO_SPY, now), null)
  assert.equal(parseYahooChart('SPY', edited(YAHOO_SPY, (b) => (b.chart.result[0].meta.regularMarketPrice = 0)), now), null)
  assert.equal(parseYahooChart('SPY', edited(YAHOO_SPY, (b) => (b.chart.result[0].meta.regularMarketTime = '1790267775')), now), null)
  assert.equal(parseYahooChart('SPY', edited(YAHOO_SPY, (b) => (b.chart.result[0].meta.regularMarketTime = 1790267775.5)), now), null)
  assert.equal(parseYahooChart('SPY', edited(YAHOO_SPY, (b) => (b.chart.error = { code: 'x' })), now), null)
  assert.equal(parseYahooChart('SPY', { chart: { result: [] } }, now), null)
  // Trading periods it cannot read keep the price and drop only the session.
  const noPeriod = parseYahooChart('SPY', edited(YAHOO_SPY, (b) => delete b.chart.result[0].meta.currentTradingPeriod), now)
  assert.equal(noPeriod?.last, 767.43)
  assert.equal(noPeriod?.session, null)
})

test('Nasdaq files the ETFs as ETFs', () => {
  assert.equal(assetClassOf('SPY'), 'etf')
  assert.equal(assetClassOf('JPST'), 'etf')
  assert.equal(assetClassOf('NVDA'), 'stocks')
  assert.equal(assetClassOf('PFE'), 'stocks')
})

const q = (source: 'nasdaq' | 'yahoo', session: Quote['session']): Quote => ({
  underlying: 'SPY',
  source,
  last: 700,
  lastAt: 0,
  session,
  realTime: null,
})
const mkt = (session: MarketInfo['session']): MarketInfo => ({ session, label: String(session) })

test('the checker says open only when the calendar and the market both do', () => {
  const base = { underlying: 'SPY', market: mkt('regular'), nasdaq: q('nasdaq', 'regular'), yahoo: null }
  const open = judge({ ...base, calendarOpen: true })
  assert.equal(open.openNow, true)
  assert.equal(open.sessionFrom, 'nasdaq market-info')
  assert.equal(open.quote?.source, 'nasdaq')

  // Extended hours are closed, whatever the calendar says.
  assert.equal(judge({ ...base, calendarOpen: true, market: mkt('pre') }).openNow, false)
  assert.equal(judge({ ...base, calendarOpen: true, market: mkt('after') }).openNow, false)
  // A closure the calendar knows about and the market does not.
  const holiday = judge({ ...base, calendarOpen: false })
  assert.equal(holiday.openNow, false)
  assert.match(holiday.why, /calendar closed, but nasdaq market-info says regular/)
  // No opinion from either side is closed, never open.
  assert.equal(judge({ ...base, calendarOpen: null }).openNow, false)
  const silent = judge({ ...base, calendarOpen: true, market: mkt(null), nasdaq: q('nasdaq', null) })
  assert.equal(silent.openNow, false)
  assert.equal(silent.session, null)
})

test('the session falls back from market-info to the quote to Yahoo, and says which', () => {
  const quoteOnly = judge({ underlying: 'SPY', calendarOpen: true, market: null, nasdaq: q('nasdaq', 'regular'), yahoo: null })
  assert.equal(quoteOnly.sessionFrom, 'nasdaq quote')
  assert.equal(quoteOnly.openNow, true)
  const yahooOnly = judge({ underlying: 'SPY', calendarOpen: true, market: null, nasdaq: null, yahoo: q('yahoo', 'regular') })
  assert.equal(yahooOnly.sessionFrom, 'yahoo')
  assert.equal(yahooOnly.quote?.source, 'yahoo')
  assert.equal(yahooOnly.openNow, true)
  // A Nasdaq price with Yahoo's session keeps Nasdaq's price.
  const mixed = judge({ underlying: 'SPY', calendarOpen: true, market: null, nasdaq: q('nasdaq', null), yahoo: q('yahoo', 'after') })
  assert.equal(mixed.quote?.source, 'nasdaq')
  assert.equal(mixed.sessionFrom, 'yahoo')
  assert.equal(mixed.openNow, false)
})

/** Answer Nasdaq and Yahoo from the fixtures, and record every URL asked for. */
function upstream(t: test.TestContext, answer: (url: string) => Response) {
  const asked: { url: string; ua: string }[] = []
  t.mock.method(globalThis, 'fetch', async (url: string | URL, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>
    asked.push({ url: String(url), ua: headers['user-agent'] ?? '' })
    return answer(String(url))
  })
  return asked
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

test('Yahoo is asked only for the name Nasdaq failed, and the reading says so', async (t) => {
  const asked = upstream(t, (url) => {
    if (url.endsWith('/market-info')) return json(MARKET)
    if (url.includes('/quote/SPY/')) return json({}, 503)
    if (url.includes('/quote/NVDA/')) return json(NVDA)
    if (url.includes('/quote/PFE/')) return json(PFE)
    if (url.includes('finance/chart/SPY')) return json(YAHOO_SPY)
    throw new Error(`unexpected ${url}`)
  })
  const pass = await readReferences(['SPY', 'NVDA', 'PFE'], new Date(ny(12, 39)))
  assert.equal(pass.calendarOpen, true)
  assert.equal(pass.market?.session, 'regular')
  assert.equal(pass.marketError, null)

  const spy = pass.readings.get('SPY')!
  assert.equal(spy.quote?.source, 'yahoo')
  assert.equal(spy.quote?.last, 767.43)
  assert.equal(spy.openNow, true)
  assert.deepEqual(spy.errors, ['nasdaq SPY: HTTP 503'])
  assert.equal(pass.readings.get('NVDA')?.quote?.source, 'nasdaq')
  assert.equal(pass.readings.get('PFE')?.quote?.source, 'nasdaq')

  const yahoo = asked.filter((a) => a.url.includes('yahoo'))
  assert.deepEqual(yahoo.map((a) => a.url), ['https://query1.finance.yahoo.com/v8/finance/chart/SPY?interval=1m&range=1d'])
  // Yahoo's edge refused the full Chrome string; Nasdaq is asked as a browser.
  assert.equal(yahoo[0].ua, 'Mozilla/5.0')
  assert.match(asked.find((a) => a.url.includes('/quote/NVDA/'))!.ua, /Chrome/)
  assert.ok(asked.some((a) => a.url.endsWith('/quote/SPY/info?assetclass=etf')))
  assert.ok(asked.some((a) => a.url.endsWith('/quote/NVDA/info?assetclass=stocks')))
})

test('with every source down the checker has no reference and says closed', async (t) => {
  upstream(t, () => {
    throw new TypeError('fetch failed')
  })
  const pass = await readReferences(['SPY'], new Date(ny(12, 39)))
  const spy = pass.readings.get('SPY')!
  assert.equal(spy.quote, null)
  assert.equal(spy.openNow, false)
  assert.equal(pass.market, null)
  assert.equal(pass.marketError, 'nasdaq market-info: fetch failed')
  assert.deepEqual(spy.errors, ['nasdaq SPY: fetch failed', 'yahoo SPY: fetch failed'])
})

test('a last sale from the future is a timestamp read wrong, from either source', async (t) => {
  upstream(t, (url) => {
    if (url.endsWith('/market-info')) return json(MARKET)
    if (url.includes('/quote/SPY/')) return json(SPY)
    if (url.includes('finance/chart/SPY')) return json(YAHOO_SPY)
    throw new Error(`unexpected ${url}`)
  })
  // The SPY quote printed at 12:34; read it as though it were 12:30.
  const pass = await readReferences(['SPY'], new Date(ny(12, 30)))
  const spy = pass.readings.get('SPY')!
  assert.deepEqual(spy.errors, ['nasdaq SPY: last sale is in the future', 'yahoo SPY: last sale is in the future'])
  assert.equal(spy.quote, null)
})

test('open_now follows the calendar at the bell, the close, a holiday and an early close', async (t) => {
  // Nasdaq says "Market Open" every time, as a cached or lagging answer would.
  // Only the calendar can make these closed, and it must.
  upstream(t, (url) => {
    if (url.endsWith('/market-info')) return json(MARKET)
    if (url.includes('/quote/SPY/')) return json(edited(SPY, (b) => (b.data.primaryData.lastTradeTimestamp = 'Jan 2, 2026 9:30 AM ET')))
    throw new Error(`unexpected ${url}`)
  })
  const at = async (d: Date) => (await readReferences(['SPY'], d)).readings.get('SPY')!.openNow
  const edt = (mo: number, d: number, h: number, m: number) => new Date(Date.UTC(2026, mo - 1, d, h + 4, m))
  const est = (mo: number, d: number, h: number, m: number) => new Date(Date.UTC(2026, mo - 1, d, h + 5, m))
  assert.equal(await at(edt(9, 24, 9, 29)), false)
  assert.equal(await at(edt(9, 24, 9, 31)), true)
  assert.equal(await at(edt(9, 24, 15, 59)), true)
  assert.equal(await at(edt(9, 24, 16, 1)), false)
  assert.equal(await at(edt(9, 26, 11, 0)), false) // a Saturday
  assert.equal(await at(est(11, 26, 11, 0)), false) // Thanksgiving
  assert.equal(await at(est(11, 27, 12, 59)), true) // the early close is 13:00
  assert.equal(await at(est(11, 27, 13, 1)), false)
})

test('Nasdaq blocking the request leaves Yahoo standing in, labelled, for price and session', async (t) => {
  // What an edge block looks like: a 403 page, or a 200 that is not JSON.
  for (const blocked of [
    () => new Response('<html><body>Access Denied</body></html>', { status: 403 }),
    () => new Response('<html><body>Access Denied</body></html>', { status: 200 }),
    () => new Response('', { status: 200 }),
  ]) {
    const asked = upstream(t, (url) => {
      if (url.includes('api.nasdaq.com')) return blocked()
      if (url.includes('finance/chart/SPY')) return json(YAHOO_SPY)
      throw new Error(`unexpected ${url}`)
    })
    const pass = await readReferences(['SPY'], new Date(ny(12, 39)))
    const spy = pass.readings.get('SPY')!
    assert.equal(pass.market, null)
    assert.ok(pass.marketError?.startsWith('nasdaq market-info: '))
    assert.equal(spy.quote?.source, 'yahoo')
    assert.equal(spy.sessionFrom, 'yahoo')
    assert.equal(spy.openNow, true)
    assert.equal(spy.errors.length, 1)
    assert.match(spy.errors[0], /^nasdaq SPY: /)
    assert.ok(asked.some((a) => a.url.includes('yahoo')))
    t.mock.restoreAll()
  }
})
