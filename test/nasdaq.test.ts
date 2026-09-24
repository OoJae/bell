import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { MAX_NIGHT_REF_AGE_SECONDS, MAX_SESSION_REF_AGE_SECONDS } from '../src/chain/codec.ts'
import {
  CLOSE_PRINT_S,
  assetClassOf,
  isLatestClose,
  isSessionClose,
  lastSessionClose,
  judge,
  parseDollars,
  parseMarketInfo,
  parseNasdaqClose,
  parseNasdaqQuote,
  parseNasdaqTimestamp,
  parseYahooChart,
  readReferences,
  sessionOf,
  usableReading,
  type MarketInfo,
  type Quote,
  type Quotes,
  type Reading,
} from '../src/sensor/nasdaq.ts'

// Real responses, saved byte for byte, captured 2026-09-24 between 16:34 and
// 16:38 UTC (12:34 to 12:38 New York time, the regular session on a Thursday):
//   nasdaq-quote-{SPY,NVDA,PFE}   api.nasdaq.com/api/quote/{T}/info?assetclass={etf|stocks}
//   nasdaq-quote-SPY-as-stocks    the same for SPY under the wrong asset class
//   nasdaq-market-info            api.nasdaq.com/api/market-info
//   yahoo-chart-SPY               the v8 chart endpoint, interval=1m&range=1d
//   yahoo-chart-unknown           the same for a ticker that does not exist (HTTP 404)
// and the same endpoints after hours on the same day, the market closed:
//   nasdaq-*-after-hours          21:58 UTC (17:58 New York), marketStatus "After-Hours"
//   yahoo-chart-SPY-after-hours   22:00 UTC (18:00 New York)
const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}-2026-09-24.json`, import.meta.url), 'utf8'))
const SPY = fixture('nasdaq-quote-SPY')
const NVDA = fixture('nasdaq-quote-NVDA')
const PFE = fixture('nasdaq-quote-PFE')
const SPY_AS_STOCKS = fixture('nasdaq-quote-SPY-as-stocks')
const MARKET = fixture('nasdaq-market-info')
const YAHOO_SPY = fixture('yahoo-chart-SPY')
const YAHOO_UNKNOWN = fixture('yahoo-chart-unknown')
const SPY_AH = fixture('nasdaq-quote-SPY-after-hours')
const NVDA_AH = fixture('nasdaq-quote-NVDA-after-hours')
const PFE_AH = fixture('nasdaq-quote-PFE-after-hours')
const MARKET_AH = fixture('nasdaq-market-info-after-hours')
const YAHOO_SPY_AH = fixture('yahoo-chart-SPY-after-hours')

/** A deep copy with one edit, so every altered case starts from a real body. */
function edited<T>(body: T, edit: (b: any) => void): T {
  const copy = structuredClone(body)
  edit(copy)
  return copy
}

/** New York is UTC-4 in September. */
const ny = (h: number, m: number) => Date.UTC(2026, 8, 24, h + 4, m)

test('a real Nasdaq quote becomes a reading: ETF, Nasdaq-listed stock and NYSE stock alike', () => {
  // In the session there is a last sale and no close.
  assert.deepEqual(parseNasdaqQuote('SPY', SPY), {
    source: 'nasdaq',
    session: 'regular',
    last: { underlying: 'SPY', source: 'nasdaq', kind: 'last', last: 766.7494, lastAt: ny(12, 34), session: 'regular', realTime: true },
    close: null,
  })
  assert.deepEqual(parseNasdaqQuote('NVDA', NVDA), {
    source: 'nasdaq',
    session: 'regular',
    last: { underlying: 'NVDA', source: 'nasdaq', kind: 'last', last: 223.405, lastAt: ny(12, 35), session: 'regular', realTime: true },
    close: null,
  })
  assert.equal(parseNasdaqQuote('PFE', PFE)?.last?.last, 28.5699)
  assert.equal(parseNasdaqQuote('PFE', PFE)?.last?.lastAt, ny(12, 38))
})

test('after hours a real Nasdaq quote gives the extended-hours sale and the official close, each labelled', () => {
  assert.deepEqual(parseNasdaqQuote('SPY', SPY_AH), {
    source: 'nasdaq',
    session: 'after',
    last: { underlying: 'SPY', source: 'nasdaq', kind: 'last', last: 766.5676, lastAt: ny(17, 57), session: 'after', realTime: true },
    // "Closed at Sep 24, 2026 4:00 PM ET": 20:00 UTC, the close to the second.
    close: { underlying: 'SPY', source: 'nasdaq', kind: 'close', last: 767.27, lastAt: 1_790_280_000_000, session: 'after', realTime: false },
  })
  assert.equal(parseNasdaqQuote('NVDA', NVDA_AH)?.close?.last, 224.58)
  assert.equal(parseNasdaqQuote('NVDA', NVDA_AH)?.close?.lastAt, ny(16, 0))
  assert.equal(parseNasdaqQuote('PFE', PFE_AH)?.close?.last, 28.43)
  assert.equal(parseNasdaqQuote('PFE', PFE_AH)?.close?.lastAt, ny(16, 0))

  // A close it cannot read is no close; the last sale beside it is kept.
  for (const stamp of ['Closed at Sep 24, 2026', 'Closed at Sep 24, 2026 4:05 PM ET', 'Sep 24, 2026 4:00 PM ET']) {
    const q = parseNasdaqQuote('SPY', edited(SPY_AH, (b) => (b.data.secondaryData.lastTradeTimestamp = stamp)))
    assert.equal(q?.close, null, stamp)
    assert.equal(q?.last?.last, 766.5676, stamp)
  }
  assert.equal(parseNasdaqQuote('SPY', edited(SPY_AH, (b) => (b.data.secondaryData.lastSalePrice = '')))?.close, null)
  // The stamp read from primaryData, should Nasdaq ever move it there. That
  // block's price is then the close, and there is no last sale.
  const moved = parseNasdaqQuote(
    'SPY',
    edited(SPY_AH, (b) => {
      b.data.primaryData = b.data.secondaryData
      b.data.secondaryData = null
    }),
  )
  assert.equal(moved?.last, null)
  assert.equal(moved?.close?.last, 767.27)
  assert.equal(moved?.close?.lastAt, ny(16, 0))
  // A date alone where the time should be, and no close: nothing at all.
  const bare = edited(SPY_AH, (b) => {
    b.data.primaryData.lastTradeTimestamp = 'Sep 24, 2026'
    b.data.secondaryData = null
  })
  assert.equal(parseNasdaqQuote('SPY', bare), null)
})

test('a close is believed only at an instant a regular session ended', () => {
  assert.equal(parseNasdaqClose('Closed at Sep 24, 2026 4:00 PM ET'), ny(16, 0))
  assert.equal(parseNasdaqClose('Closed at Sep 24, 2026 04:00 PM ET'), ny(16, 0))
  // The early closes, at 13:00 New York (UTC-5 in late November and December).
  assert.equal(parseNasdaqClose('Closed at Nov 27, 2026 1:00 PM ET'), Date.UTC(2026, 10, 27, 18, 0))
  assert.equal(parseNasdaqClose('Closed at Dec 24, 2026 1:00 PM ET'), Date.UTC(2026, 11, 24, 18, 0))
  // A Friday close in winter.
  assert.equal(parseNasdaqClose('Closed at Dec 4, 2026 4:00 PM ET'), Date.UTC(2026, 11, 4, 21, 0))
  for (const bad of [
    'Closed at Nov 27, 2026 4:00 PM ET', // that day closed at 13:00
    'Closed at Sep 24, 2026 1:00 PM ET', // and this one at 16:00
    'Closed at Sep 24, 2026 3:59 PM ET',
    'Closed at Sep 24, 2026 4:01 PM ET',
    'Closed at Sep 24, 2026 9:30 AM ET', // the open, not the close
    'Closed at Sep 26, 2026 4:00 PM ET', // a Saturday
    'Closed at Nov 26, 2026 4:00 PM ET', // Thanksgiving
    'Closed at Sep 24, 2028 4:00 PM ET', // a year the calendar does not cover
    'Closed at Sep 24, 2026', // a date is not a time
    'Closed at Sep 24, 2026 4:00 PM',
    'Closed at  Sep 24, 2026 4:00 PM ET',
    'closed at Sep 24, 2026 4:00 PM ET',
    'Closed at Sep 24, 2026 4:00 PM ET ',
    'Sep 24, 2026 4:00 PM ET', // a last sale's form, not a close's
    'Closed',
    '',
  ]) {
    assert.equal(parseNasdaqClose(bad), null, bad)
  }
  assert.equal(parseNasdaqClose(1_790_280_000), null)
  assert.equal(parseNasdaqClose(null), null)
  assert.equal(isSessionClose(ny(16, 0)), true)
  assert.equal(isSessionClose(ny(16, 0) + 1000), false)
  assert.equal(isSessionClose(ny(15, 59)), false)
})

test('a Nasdaq body that is not this reading is no reading at all', () => {
  // The wrong asset class answers 200 with data: null and rCode 400 inside.
  assert.equal(parseNasdaqQuote('SPY', SPY_AS_STOCKS), null)
  // A true quote for a different symbol.
  assert.equal(parseNasdaqQuote('QQQ', SPY), null)
  // After the close Nasdaq prints the date alone. No time and no close, no reading.
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
  assert.equal(odd?.last?.last, 766.7494)
  assert.equal(odd?.session, null)
  assert.equal(odd?.last?.session, null)
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
  // The real answer after the close.
  assert.deepEqual(parseMarketInfo(MARKET_AH), { session: 'after', label: 'After-Hours / After Hours' })
})

test('a real Yahoo chart becomes a reading, with the session read from its trading periods', () => {
  const during = new Date(ny(12, 37))
  // In its regular period the one price is a last sale, and there is no close.
  assert.deepEqual(parseYahooChart('SPY', YAHOO_SPY, during), {
    source: 'yahoo',
    session: 'regular',
    last: { underlying: 'SPY', source: 'yahoo', kind: 'last', last: 767.43, lastAt: 1_790_267_775_000, session: 'regular', realTime: null },
    close: null,
  })
  // The same body read at other times of the same day.
  assert.equal(parseYahooChart('SPY', YAHOO_SPY, new Date(ny(9, 29)))?.session, 'pre')
  assert.equal(parseYahooChart('SPY', YAHOO_SPY, new Date(ny(9, 30)))?.session, 'regular')
  assert.equal(parseYahooChart('SPY', YAHOO_SPY, new Date(ny(16, 0)))?.session, 'after')
  assert.equal(parseYahooChart('SPY', YAHOO_SPY, new Date(ny(20, 0)))?.session, 'closed')
  assert.equal(parseYahooChart('SPY', YAHOO_SPY, new Date(ny(3, 59)))?.session, 'closed')
})

test("after hours Yahoo's regular-market price is the close, labelled as one", () => {
  const evening = new Date(ny(18, 0))
  const sale = { underlying: 'SPY', source: 'yahoo', last: 767.18, lastAt: ny(16, 0), session: 'after', realTime: null }
  assert.deepEqual(parseYahooChart('SPY', YAHOO_SPY_AH, evening), {
    source: 'yahoo',
    session: 'after',
    last: { ...sale, kind: 'last' },
    close: { ...sale, kind: 'close' },
  })
  // Overnight, after its post-market period.
  const night = parseYahooChart('SPY', YAHOO_SPY_AH, new Date(ny(21, 0)))
  assert.equal(night?.session, 'closed')
  assert.equal(night?.close?.last, 767.18)
  // Read inside its regular period the same price is not a close.
  assert.equal(parseYahooChart('SPY', YAHOO_SPY_AH, new Date(ny(15, 0)))?.close, null)
  // A regular-market time after the close is an extended-hours print, whatever Yahoo filed it as.
  const late = edited(YAHOO_SPY_AH, (b) => (b.chart.result[0].meta.regularMarketTime = ny(17, 0) / 1000))
  assert.equal(parseYahooChart('SPY', late, evening)?.close, null)
  assert.equal(parseYahooChart('SPY', late, evening)?.last?.last, 767.18)
  // No trading periods, no session, and so no close.
  const noPeriod = edited(YAHOO_SPY_AH, (b) => delete b.chart.result[0].meta.currentTradingPeriod)
  assert.equal(parseYahooChart('SPY', noPeriod, evening)?.close, null)
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
  assert.equal(noPeriod?.last?.last, 767.43)
  assert.equal(noPeriod?.session, null)
})

test('Nasdaq files the ETFs as ETFs', () => {
  assert.equal(assetClassOf('SPY'), 'etf')
  assert.equal(assetClassOf('JPST'), 'etf')
  assert.equal(assetClassOf('NVDA'), 'stocks')
  assert.equal(assetClassOf('PFE'), 'stocks')
})

const q = (source: 'nasdaq' | 'yahoo', session: Quote['session'], kind: Quote['kind'] = 'last'): Quote => ({
  underlying: 'SPY',
  source,
  kind,
  last: 700,
  lastAt: 0,
  session,
  realTime: null,
})
/** One source's answer holding just these prices. */
const answer = (...prices: Quote[]): Quotes => ({
  source: prices[0]!.source,
  session: prices[0]!.session,
  last: prices.find((p) => p.kind === 'last') ?? null,
  close: prices.find((p) => p.kind === 'close') ?? null,
})
const mkt = (session: MarketInfo['session']): MarketInfo => ({ session, label: String(session) })

test('the checker says open only when the calendar and the market both do', () => {
  const base = { underlying: 'SPY', market: mkt('regular'), nasdaq: answer(q('nasdaq', 'regular')), yahoo: null }
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
  const silent = judge({ ...base, calendarOpen: true, market: mkt(null), nasdaq: answer(q('nasdaq', null)) })
  assert.equal(silent.openNow, false)
  assert.equal(silent.session, null)
})

test('the session falls back from market-info to the quote to Yahoo, and says which', () => {
  const quoteOnly = judge({ underlying: 'SPY', calendarOpen: true, market: null, nasdaq: answer(q('nasdaq', 'regular')), yahoo: null })
  assert.equal(quoteOnly.sessionFrom, 'nasdaq quote')
  assert.equal(quoteOnly.openNow, true)
  const yahooOnly = judge({ underlying: 'SPY', calendarOpen: true, market: null, nasdaq: null, yahoo: answer(q('yahoo', 'regular')) })
  assert.equal(yahooOnly.sessionFrom, 'yahoo')
  assert.equal(yahooOnly.quote?.source, 'yahoo')
  assert.equal(yahooOnly.openNow, true)
  // A Nasdaq price with Yahoo's session keeps Nasdaq's price.
  const mixed = judge({
    underlying: 'SPY',
    calendarOpen: true,
    market: null,
    nasdaq: answer(q('nasdaq', null), q('nasdaq', null, 'close')),
    yahoo: answer(q('yahoo', 'after'), q('yahoo', 'after', 'close')),
  })
  assert.equal(mixed.quote?.source, 'nasdaq')
  assert.equal(mixed.sessionFrom, 'yahoo')
  assert.equal(mixed.openNow, false)
})

test('the reference is the last sale in session and the official close outside it, never the other way', () => {
  const sale = { ...q('nasdaq', 'after'), last: 714.68 }
  const close = { ...q('nasdaq', 'after', 'close'), last: 767.27 }
  const both = answer(sale, close)
  // After hours: the close, however far the last sale has wandered from it.
  const evening = judge({ underlying: 'SPY', calendarOpen: false, market: mkt('after'), nasdaq: both, yahoo: null })
  assert.equal(evening.openNow, false)
  assert.deepEqual(evening.quote, close)
  // Calendar open while the market says pre-market: closed, so the close too.
  assert.equal(judge({ underlying: 'SPY', calendarOpen: true, market: mkt('pre'), nasdaq: both, yahoo: null }).quote?.kind, 'close')
  // A Nasdaq answer with no close leaves it to Yahoo's, labelled as Yahoo's.
  const yahooClose = q('yahoo', 'after', 'close')
  const fallback = judge({ underlying: 'SPY', calendarOpen: false, market: mkt('after'), nasdaq: answer(sale), yahoo: answer(q('yahoo', 'after'), yahooClose) })
  assert.deepEqual(fallback.quote, yahooClose)
  // No close anywhere is no reference, not the last sale.
  assert.equal(judge({ underlying: 'SPY', calendarOpen: false, market: mkt('after'), nasdaq: answer(sale), yahoo: null }).quote, null)
  // In session, the last sale, and a close on offer is not taken.
  const regular = answer({ ...sale, session: 'regular' }, { ...close, session: 'regular' })
  const open = judge({ underlying: 'SPY', calendarOpen: true, market: mkt('regular'), nasdaq: regular, yahoo: null })
  assert.equal(open.openNow, true)
  assert.equal(open.quote?.kind, 'last')
  assert.equal(open.quote?.last, 714.68)
})

test('the checker pushes a reading only when it can stand behind it', () => {
  const now = new Date(ny(12, 40))
  const at = (min: number, kind: Quote['kind'] = 'last') => ({ ...q('nasdaq', 'regular', kind), lastAt: now.getTime() - min * 60_000 })
  const base = { underlying: 'SPY', market: mkt('regular'), nasdaq: answer(at(1)), yahoo: null }
  const open = usableReading(judge({ ...base, calendarOpen: true }), now, 300)
  assert.ok(open.ok && open.openNow && open.quote.source === 'nasdaq' && open.ageS === 60)
  // Yahoo standing in for Nasdaq is a reading that parsed, and says it is Yahoo's.
  const yahoo = usableReading(judge({ ...base, nasdaq: null, yahoo: answer({ ...at(1), source: 'yahoo' }), calendarOpen: true }), now, 300)
  assert.ok(yahoo.ok && yahoo.quote.source === 'yahoo')

  const refused = (r: Parameters<typeof judge>[0] | undefined) => {
    const u = usableReading(r && judge(r), now, 300)
    assert.equal(u.ok, false)
    return (u as { why: string }).why
  }
  assert.equal(refused(undefined), 'no reading')
  // No opinion is not "closed": a night fill needs the checker to say closed.
  assert.match(refused({ ...base, calendarOpen: null }), /calendar has no opinion/)
  assert.match(refused({ ...base, calendarOpen: true, market: mkt(null), nasdaq: answer({ ...at(1), session: null }) }), /no source said which session/)
  // Nor is a contradiction between its own sources.
  assert.match(refused({ ...base, calendarOpen: false }), /calendar says closed but nasdaq market-info says regular session/)
  // A source that failed to parse gave no quote, and no quote is no reference.
  assert.match(
    refused({ ...base, calendarOpen: true, nasdaq: null, errors: ['nasdaq SPY: no reading (unknown shape, price or timestamp)'] }),
    /^no last sale \(nasdaq SPY: no reading \(unknown shape/,
  )
  // Five minutes in session, the program's bound; none outside it, where the
  // program judges the close's age itself.
  assert.match(refused({ ...base, calendarOpen: true, nasdaq: answer(at(5.5)) }), /last sale is 330s old in session, over 300s/)
  const evening = usableReading(judge({ ...base, calendarOpen: false, market: mkt('after'), nasdaq: answer(at(1), at(600, 'close')) }), now, 300)
  assert.ok(evening.ok && !evening.openNow && evening.quote.kind === 'close' && evening.ageS === 36_000)
  // Past the program's twelve hours it is still pushed: the program refuses night fills on it, not the checker.
  const stale = usableReading(judge({ ...base, calendarOpen: false, market: mkt('after'), nasdaq: answer(at(20 * 60, 'close')) }), now, 300)
  assert.ok(stale.ok && stale.ageS === 72_000)
  // Outside the session a last sale alone is no reference: it is an extended-hours print.
  assert.match(
    refused({ ...base, calendarOpen: false, market: mkt('after'), nasdaq: answer(at(1)) }),
    /^no official close \(no source gave one\)$/,
  )
  // And a Reading that pairs a verdict with the other kind is refused either way.
  const wrong = (openNow: boolean, kind: Quote['kind']): Reading => ({
    ...judge({ ...base, calendarOpen: openNow, market: mkt(openNow ? 'regular' : 'after') }),
    quote: at(1, kind),
  })
  assert.deepEqual(usableReading(wrong(false, 'last'), now, 300), {
    ok: false,
    why: 'the reference is a last sale, and outside the session it must be the official close',
  })
  assert.deepEqual(usableReading(wrong(true, 'close'), now, 300), {
    ok: false,
    why: 'the reference is a close, and in session it must be the last sale',
  })
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

test('after hours every name is referenced to its official close, from the real answers, and Yahoo is not asked', async (t) => {
  const asked = upstream(t, (url) => {
    if (url.endsWith('/market-info')) return json(MARKET_AH)
    if (url.includes('/quote/SPY/')) return json(SPY_AH)
    if (url.includes('/quote/NVDA/')) return json(NVDA_AH)
    if (url.includes('/quote/PFE/')) return json(PFE_AH)
    throw new Error(`unexpected ${url}`)
  })
  const now = new Date(ny(17, 58))
  const pass = await readReferences(['SPY', 'NVDA', 'PFE'], now)
  assert.equal(pass.calendarOpen, false)
  assert.equal(pass.market?.session, 'after')
  const closes = { SPY: 767.27, NVDA: 224.58, PFE: 28.43 }
  for (const [name, price] of Object.entries(closes)) {
    const r = pass.readings.get(name)!
    assert.equal(r.openNow, false, name)
    assert.equal(r.quote?.kind, 'close', name)
    assert.equal(r.quote?.source, 'nasdaq', name)
    assert.equal(r.quote?.last, price, name)
    assert.equal(r.quote?.lastAt, ny(16, 0), name)
    assert.deepEqual(r.errors, [], name)
    // Pushed, an hour and 58 minutes old; the program's twelve hours judge it from here.
    const u = usableReading(r, now, 300)
    assert.ok(u.ok && !u.openNow && u.ageS === 7_080, name)
  }
  assert.ok(!asked.some((a) => a.url.includes('yahoo')))
})

test("an after-hours outlier print is not the night reference: SPY's $714.68 at 16:56", async (t) => {
  upstream(t, (url) => {
    if (url.endsWith('/market-info')) return json(MARKET_AH)
    if (url.includes('/quote/SPY/')) {
      return json(
        edited(SPY_AH, (b) => {
          b.data.primaryData.lastSalePrice = '$714.68'
          b.data.primaryData.lastTradeTimestamp = 'Sep 24, 2026 4:56 PM ET'
        }),
      )
    }
    throw new Error(`unexpected ${url}`)
  })
  const spy = (await readReferences(['SPY'], new Date(ny(16, 57)))).readings.get('SPY')!
  assert.equal(spy.quote?.kind, 'close')
  assert.equal(spy.quote?.last, 767.27)
  assert.equal(spy.quote?.lastAt, ny(16, 0))
})

test("after hours with no close from Nasdaq, Yahoo's close stands in, labelled; with none from either, nothing is pushed", async (t) => {
  const noClose = edited(SPY_AH, (b) => (b.data.secondaryData = null))
  const asked = upstream(t, (url) => {
    if (url.endsWith('/market-info')) return json(MARKET_AH)
    if (url.includes('/quote/SPY/')) return json(noClose)
    if (url.includes('finance/chart/SPY')) return json(YAHOO_SPY_AH)
    throw new Error(`unexpected ${url}`)
  })
  const now = new Date(ny(18, 1))
  const spy = (await readReferences(['SPY'], now)).readings.get('SPY')!
  assert.deepEqual(spy.quote, {
    underlying: 'SPY',
    source: 'yahoo',
    kind: 'close',
    last: 767.18,
    lastAt: ny(16, 0),
    session: 'after',
    realTime: null,
  })
  assert.deepEqual(spy.errors, ['nasdaq SPY: no official close in a form read here'])
  assert.ok(asked.some((a) => a.url.includes('finance/chart/SPY')))
  assert.ok(usableReading(spy, now, 300).ok)
  t.mock.restoreAll()

  upstream(t, (url) => {
    if (url.endsWith('/market-info')) return json(MARKET_AH)
    if (url.includes('/quote/SPY/')) return json(noClose)
    if (url.includes('finance/chart/SPY')) return json({}, 503)
    throw new Error(`unexpected ${url}`)
  })
  const none = (await readReferences(['SPY'], now)).readings.get('SPY')!
  assert.equal(none.quote, null)
  assert.deepEqual(usableReading(none, now, 300), {
    ok: false,
    why: 'no official close (nasdaq SPY: no official close in a form read here; yahoo SPY: HTTP 503)',
  })
})

test('the latest session close, by the calendar: after the bell, overnight, a weekend, a holiday, an early close, across daylight saving', () => {
  const edt = (y: number, mo: number, d: number, h: number, m: number, sec = 0) => Date.UTC(y, mo - 1, d, h + 4, m, sec)
  const est = (y: number, mo: number, d: number, h: number, m: number, sec = 0) => Date.UTC(y, mo - 1, d, h + 5, m, sec)
  // Thursday 24 September 2026 and the night after it.
  assert.equal(lastSessionClose(edt(2026, 9, 24, 15, 59, 59)), edt(2026, 9, 23, 16, 0))
  assert.equal(lastSessionClose(edt(2026, 9, 24, 16, 0)), edt(2026, 9, 24, 16, 0))
  assert.equal(lastSessionClose(edt(2026, 9, 24, 16, 0, 30)), edt(2026, 9, 24, 16, 0))
  assert.equal(lastSessionClose(edt(2026, 9, 24, 20, 1)), edt(2026, 9, 24, 16, 0))
  assert.equal(lastSessionClose(edt(2026, 9, 25, 4, 1)), edt(2026, 9, 24, 16, 0))
  assert.equal(lastSessionClose(edt(2026, 9, 25, 9, 29)), edt(2026, 9, 24, 16, 0))
  // A weekend, and Labor Day after one: Friday's close.
  assert.equal(lastSessionClose(edt(2026, 9, 26, 12, 0)), edt(2026, 9, 25, 16, 0))
  assert.equal(lastSessionClose(edt(2026, 9, 7, 12, 0)), edt(2026, 9, 4, 16, 0))
  // Thanksgiving, then the early close the day after, then the Monday after that.
  assert.equal(lastSessionClose(est(2026, 11, 26, 12, 0)), est(2026, 11, 25, 16, 0))
  assert.equal(lastSessionClose(est(2026, 11, 27, 12, 59)), est(2026, 11, 25, 16, 0))
  assert.equal(lastSessionClose(est(2026, 11, 27, 13, 0, 30)), est(2026, 11, 27, 13, 0))
  assert.equal(lastSessionClose(est(2026, 11, 30, 9, 0)), est(2026, 11, 27, 13, 0))
  // The Monday after the clocks go back: Friday's close was 16:00 EDT, 20:00 UTC.
  assert.equal(lastSessionClose(est(2026, 11, 2, 9, 0)), Date.UTC(2026, 9, 30, 20, 0))
  // The Monday after they go forward: Friday's close was 16:00 EST, 21:00 UTC.
  assert.equal(lastSessionClose(edt(2027, 3, 15, 9, 0)), Date.UTC(2027, 2, 12, 21, 0))
  // No opinion outside the tables.
  assert.equal(lastSessionClose(Date.UTC(2025, 11, 31, 22, 0)), null)
  assert.equal(lastSessionClose(Date.UTC(2028, 0, 4, 22, 0)), null)
})

test("a close is the night reference only if it is the latest session's, and printed at its end", () => {
  assert.equal(CLOSE_PRINT_S, MAX_SESSION_REF_AGE_SECONDS)
  const close = (lastAt: number, source: Quote['source'] = 'nasdaq'): Quote => ({
    underlying: 'SPY', source, kind: 'close', last: 767.27, lastAt, session: 'after', realTime: false,
  })
  const at = (h: number, m: number) => new Date(ny(h, m))
  assert.ok(isLatestClose(close(ny(16, 0)), at(16, 1)))
  assert.ok(isLatestClose(close(ny(16, 0)), at(23, 59)))
  // Yesterday's close, still served after today's.
  assert.ok(!isLatestClose(close(ny(16, 0) - 86_400_000), at(16, 1)))
  // But before today's close it is the latest.
  assert.ok(isLatestClose(close(ny(16, 0) - 86_400_000), at(9, 29)))
  // A print five minutes before the end is taken; one a second earlier is a feed that stopped.
  assert.ok(isLatestClose(close(ny(15, 55), 'yahoo'), at(18, 0)))
  assert.ok(!isLatestClose(close(ny(15, 55) - 1000, 'yahoo'), at(18, 0)))
  assert.ok(!isLatestClose(close(ny(14, 32), 'yahoo'), at(18, 0)))
  // Dated after the latest close: not a close at all.
  assert.ok(!isLatestClose(close(ny(16, 0)), at(15, 59)))
})

/** Nasdaq's answer at a given moment of the night, built from the real after-hours one. */
const nasdaqAt = (o: { status: string; last: string | null; close: string | null }) =>
  edited(SPY_AH, (b) => {
    b.data.marketStatus = o.status
    if (o.last === null) b.data.primaryData.lastTradeTimestamp = 'Sep 24, 2026'
    else b.data.primaryData.lastTradeTimestamp = o.last
    if (o.close === null) b.data.secondaryData = null
    else b.data.secondaryData.lastTradeTimestamp = o.close
  })
const marketAt = (status: string) =>
  edited(MARKET_AH, (b) => {
    b.data.mrktStatus = status
    b.data.marketIndicator = status
  })

test('what the checker pushes through the night: 16:00:30, 19:59, 20:01, 04:01 and 09:29', async (t) => {
  const CLOSE_24 = 'Closed at Sep 24, 2026 4:00 PM ET'
  const CLOSE_23 = 'Closed at Sep 23, 2026 4:00 PM ET'
  const run = async (
    now: number,
    o: { market: string; status: string; last: string | null; close: string | null; yahoo?: unknown },
  ) => {
    const asked = upstream(t, (url) => {
      if (url.endsWith('/market-info')) return json(marketAt(o.market))
      if (url.includes('/quote/SPY/')) return json(nasdaqAt(o))
      if (url.includes('finance/chart/SPY')) return o.yahoo === undefined ? json({}, 503) : json(o.yahoo)
      throw new Error(`unexpected ${url}`)
    })
    const r = (await readReferences(['SPY'], new Date(now))).readings.get('SPY')!
    t.mock.restoreAll()
    return { r, u: usableReading(r, new Date(now), MAX_SESSION_REF_AGE_SECONDS), yahoo: asked.some((a) => a.url.includes('yahoo')) }
  }
  const s = (ms: number) => ms / 1000

  // 16:00:30: the close is out, and it is the reference.
  let x = await run(ny(16, 0) + 30_000, { market: 'After-Hours', status: 'After-Hours', last: 'Sep 24, 2026 4:00 PM ET', close: CLOSE_24 })
  assert.ok(x.u.ok && !x.u.openNow && x.u.quote.kind === 'close' && x.u.quote.lastAt === ny(16, 0) && x.u.ageS === 30)
  assert.equal(x.yahoo, false)
  // 16:00:30 with Nasdaq still serving yesterday's close: not believed; Yahoo's today's close stands in.
  x = await run(ny(16, 0) + 30_000, { market: 'After-Hours', status: 'After-Hours', last: 'Sep 24, 2026 4:00 PM ET', close: CLOSE_23, yahoo: YAHOO_SPY_AH })
  assert.ok(x.u.ok && x.u.quote.source === 'yahoo' && x.u.quote.lastAt === ny(16, 0))
  assert.match(x.r.errors.join('; '), /nasdaq SPY: its close, dated 2026-09-23T20:00:00.000Z, is not the latest session's/)
  // And with Yahoo down too, nothing is pushed rather than yesterday's close.
  x = await run(ny(16, 0) + 30_000, { market: 'After-Hours', status: 'After-Hours', last: 'Sep 24, 2026 4:00 PM ET', close: CLOSE_23 })
  assert.ok(!x.u.ok && /^no official close/.test(x.u.why))
  // 16:00:30 with Nasdaq's market-info still saying open: its sources disagree with the calendar, so nothing.
  x = await run(ny(16, 0) + 30_000, { market: 'Market Open', status: 'Open', last: 'Sep 24, 2026 4:00 PM ET', close: null })
  assert.ok(!x.u.ok && /disagree/.test(x.u.why))

  // 19:59: still the 16:00 close, never the extended-hours sale beside it.
  x = await run(ny(19, 59), { market: 'After-Hours', status: 'After-Hours', last: 'Sep 24, 2026 7:59 PM ET', close: CLOSE_24 })
  assert.ok(x.u.ok && x.u.quote.source === 'nasdaq' && x.u.quote.lastAt === ny(16, 0) && x.u.ageS === s(ny(19, 59) - ny(16, 0)))

  // 20:01: Nasdaq's overnight answer as recorded, a bare date and no close stamp. Yahoo's close stands in.
  x = await run(ny(20, 1), { market: 'Market Closed', status: 'Closed', last: null, close: null, yahoo: YAHOO_SPY_AH })
  assert.ok(x.u.ok && !x.u.openNow && x.u.quote.source === 'yahoo' && x.u.quote.last === 767.18 && x.u.quote.lastAt === ny(16, 0))
  // With Yahoo down as well there is no reference, and nothing is pushed.
  x = await run(ny(20, 1), { market: 'Market Closed', status: 'Closed', last: null, close: null })
  assert.ok(!x.u.ok)

  // 04:01 and 09:29 the next morning: the same close, pushed; now past the program's twelve hours, so night fills stop.
  for (const [h, m] of [[4, 1], [9, 29]] as const) {
    const now = Date.UTC(2026, 8, 25, h + 4, m)
    x = await run(now, { market: 'Pre-Market', status: 'Pre-Market', last: `Sep 25, 2026 ${h}:${String(m).padStart(2, '0')} AM ET`, close: CLOSE_24 })
    assert.ok(x.u.ok && !x.u.openNow && x.u.quote.lastAt === ny(16, 0), `${h}:${m}`)
    assert.ok(x.u.ageS > MAX_NIGHT_REF_AGE_SECONDS, `${h}:${m}`)
  }
})

test("Yahoo's close is refused when its last regular sale is from before the end of the session", async (t) => {
  // Yahoo's feed stopped at 14:32 and still says so at 18:00: labelled a close by its trading period, but not the close.
  const stopped = edited(YAHOO_SPY_AH, (b) => (b.chart.result[0].meta.regularMarketTime = Math.floor(ny(14, 32) / 1000)))
  upstream(t, (url) => {
    if (url.endsWith('/market-info')) return json(MARKET_AH)
    if (url.includes('/quote/SPY/')) return json(edited(SPY_AH, (b) => (b.data.secondaryData = null)))
    if (url.includes('finance/chart/SPY')) return json(stopped)
    throw new Error(`unexpected ${url}`)
  })
  const spy = (await readReferences(['SPY'], new Date(ny(18, 0)))).readings.get('SPY')!
  assert.equal(spy.quote, null)
  assert.deepEqual(spy.errors, [
    'nasdaq SPY: no official close in a form read here',
    "yahoo SPY: its close, dated 2026-09-24T18:32:00.000Z, is not the latest session's",
  ])
  assert.ok(!usableReading(spy, new Date(ny(18, 0)), 300).ok)
})
