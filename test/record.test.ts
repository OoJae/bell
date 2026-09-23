import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import Database from 'better-sqlite3'
import { Recorder, closedWeekdays, eastern, nightVsOpen, type MarkSample, type TickRow } from '../src/record.ts'

/** A fresh directory per test, removed afterwards, so no test touches a real log. */
function tempDb(t: test.TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'bell-record-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return join(dir, 'bell.db')
}

/** Unix seconds from a wall-clock time with its offset spelled out. */
const at = (iso: string) => Date.parse(iso) / 1000

const tick = (symbol: string, when: number, openNow: boolean): TickRow => ({
  at: when,
  symbol,
  mint: `${symbol}-mint`,
  issuer: 'backed',
  openNow,
  halt: 0,
  confidence: 'confirmed',
  detail: 'test',
  pythOpen: openNow,
  issuerOpen: true,
  issuerHalted: false,
  exchangeHalt: null,
  pushed: true,
  signature: null,
})

test('opening a log that predates marks adds the table and keeps every row', (t) => {
  const path = tempDb(t)
  // The hosted log as it was before this change: ticks and transitions only.
  const old = new Database(path)
  old.exec(`
    CREATE TABLE ticks (id INTEGER PRIMARY KEY, at INTEGER NOT NULL, symbol TEXT NOT NULL,
      mint TEXT NOT NULL, issuer TEXT NOT NULL, open_now INTEGER NOT NULL, halt INTEGER NOT NULL,
      confidence TEXT NOT NULL, detail TEXT NOT NULL, pyth_open INTEGER, issuer_open INTEGER,
      issuer_halted INTEGER, exchange_halt INTEGER, pushed INTEGER NOT NULL, signature TEXT);
    CREATE TABLE transitions (id INTEGER PRIMARY KEY, at INTEGER NOT NULL, symbol TEXT NOT NULL,
      from_open INTEGER NOT NULL, to_open INTEGER NOT NULL, from_halt INTEGER NOT NULL,
      to_halt INTEGER NOT NULL, detail TEXT NOT NULL);
    INSERT INTO ticks (at, symbol, mint, issuer, open_now, halt, confidence, detail, pushed)
      VALUES (1758484196, 'SPYx', 'm', 'backed', 1, 0, 'confirmed', 'from before', 1);
  `)
  old.close()

  // Twice, because the keeper opens it on every start.
  new Recorder(path).close()
  const r = new Recorder(path)
  assert.deepEqual(r.counts(), { ticks: 1, transitions: 0, marks: 0 })
  // The state carried across the restart is the old row's, so the next tick
  // that closes SPYx is still a transition.
  assert.equal(r.record([tick('SPYx', 1758484241, false)]).length, 1)
  r.close()
})

test('a mark round-trips exactly, including a rate wider than SQLite integers', (t) => {
  const path = tempDb(t)
  const r = new Recorder(path)
  // A real SPYx-sized rate is above 2^64; stored as a number it would be rounded.
  const rateQ64 = (1n << 64n) * 12_345n + 6_789n
  r.recordMarks([
    {
      at: 1758484241,
      observedAt: 1758484240,
      symbol: 'SPYx',
      pxNum: 663_421_337n,
      pxExpo: -6,
      confBps: 3,
      source: 'Jupiter',
      rateQ64,
      signature: 'sig',
    },
  ])
  assert.equal(r.counts().marks, 1)
  r.close()

  const db = new Database(path, { readonly: true })
  const row = db.prepare('SELECT * FROM marks').get() as Record<string, unknown>
  db.close()
  assert.equal(row.at, 1758484241)
  assert.equal(row.observed_at, 1758484240)
  assert.equal(row.symbol, 'SPYx')
  assert.equal(row.px_num, '663421337')
  assert.equal(row.px_expo, -6)
  assert.ok(Math.abs((row.price as number) - 663.421337) < 1e-9)
  assert.equal(row.conf_bps, 3)
  assert.equal(row.source, 'Jupiter')
  assert.equal(BigInt(row.rate_q64 as string), rateQ64)
  assert.equal(row.signature, 'sig')
})

test('a failed tick write leaves the remembered state where the log is', (t) => {
  const r = new Recorder(tempDb(t))
  r.record([tick('SPYx', 100, true)])
  // The second row violates NOT NULL, so the whole batch rolls back.
  const bad = { ...tick('QQQx', 200, true), mint: null as unknown as string }
  assert.throws(() => r.record([tick('SPYx', 200, false), bad]))
  assert.equal(r.counts().ticks, 1)
  // SPYx never closed as far as the log knows, so closing it now is still news.
  assert.equal(r.record([tick('SPYx', 300, false)]).length, 1)
  r.close()
})

// ------------------------------------------------------------------ overnight

const mark = (symbol: string, iso: string, price: number): MarkSample => ({
  symbol,
  observedAt: at(iso),
  price,
})

test('eastern time follows daylight saving rather than a fixed offset', () => {
  // The same UTC hour is 09:40 in October and 08:40 in November.
  assert.deepEqual(eastern(at('2026-10-30T13:40:00Z')), { date: '2026-10-30', weekday: 5, minute: 9 * 60 + 40 })
  assert.deepEqual(eastern(at('2026-11-02T13:40:00Z')), { date: '2026-11-02', weekday: 1, minute: 8 * 60 + 40 })
})

test('one weeknight: each night mark against the first mark from 09:35 next morning', () => {
  const report = nightVsOpen([
    mark('SPYx', '2026-09-23T15:50:00-04:00', 100), // the session that closed the night
    mark('SPYx', '2026-09-23T17:00:00-04:00', 101),
    mark('SPYx', '2026-09-23T22:00:00-04:00', 102),
    mark('SPYx', '2026-09-24T03:00:00-04:00', 99),
    mark('SPYx', '2026-09-24T09:31:00-04:00', 150), // open, but too early to be the reference
    mark('SPYx', '2026-09-24T09:35:30-04:00', 100), // the reference
    mark('SPYx', '2026-09-24T09:40:00-04:00', 105), // later the same morning, ignored
  ])
  assert.deepEqual(report.nights, ['2026-09-24'])
  assert.equal(report.unmatched, 0)
  const [spy] = report.bySymbol
  assert.equal(spy.symbol, 'SPYx')
  assert.equal(spy.nights, 1)
  assert.equal(spy.samples, 3)
  assert.ok(Math.abs(spy.medianBps - 100) < 1e-9)
  assert.ok(Math.abs(spy.worstBps - 200) < 1e-9)
  assert.equal(spy.paidMore, 2)
  assert.equal(spy.paidLess, 1)
})

test('Friday night runs to Monday, across the end of daylight saving', () => {
  // Clocks go back on Sunday 2026-11-01, so Friday is UTC-4 and Monday UTC-5.
  const report = nightVsOpen([
    mark('SPYx', '2026-10-30T19:00:00Z', 100), // Fri 15:00 EDT
    mark('SPYx', '2026-10-31T16:00:00Z', 110), // Sat noon
    // Mon 08:40 EST, pre-market: a night sample. With Friday's offset it would
    // read 09:40 and become the reference.
    mark('SPYx', '2026-11-02T13:40:00Z', 90),
    mark('SPYx', '2026-11-02T14:36:00Z', 100), // Mon 09:36 EST, the reference
  ])
  assert.deepEqual(report.nights, ['2026-11-02'])
  const [spy] = report.bySymbol
  assert.equal(spy.samples, 2)
  assert.ok(Math.abs(spy.medianBps - 0) < 1e-9) // +1000 and -1000
  assert.equal(spy.paidMore, 1)
  assert.equal(spy.paidLess, 1)
  assert.ok(Math.abs(Math.abs(spy.worstBps) - 1000) < 1e-9)
})

test('a weekday holiday is part of the night; the reference is the next trading morning', () => {
  const marks = [
    mark('PFE', '2026-09-04T15:00:00-04:00', 25), // Fri
    mark('PFE', '2026-09-07T09:40:00-04:00', 26), // Labor Day: no open, so a night sample
    mark('PFE', '2026-09-08T09:35:00-04:00', 25), // Tue, the reference
  ]
  const withHoliday = nightVsOpen(marks, new Set(['2026-09-07']))
  assert.deepEqual(withHoliday.nights, ['2026-09-08'])
  assert.equal(withHoliday.bySymbol[0].samples, 1)
  assert.ok(Math.abs(withHoliday.bySymbol[0].medianBps - 400) < 1e-9)

  // Without the calendar Monday reads as a trading day: its 09:40 mark becomes
  // the reference and Friday's night has nothing in it to compare.
  const without = nightVsOpen(marks)
  assert.deepEqual(without.bySymbol, [])
})

test('a night the log did not see both ends of is left out, not printed', () => {
  // The keeper started at 03:00: no mark from the session that closed the night.
  const lateStart = nightVsOpen([
    mark('SPYx', '2026-09-24T03:00:00-04:00', 101),
    mark('SPYx', '2026-09-24T09:36:00-04:00', 100),
  ])
  assert.deepEqual(lateStart, { nights: [], bySymbol: [], unmatched: 1 })

  // The keeper was down at the open: its first mark is after 10:00.
  const lateOpen = nightVsOpen([
    mark('SPYx', '2026-09-23T15:00:00-04:00', 100),
    mark('SPYx', '2026-09-23T20:00:00-04:00', 101),
    mark('SPYx', '2026-09-24T10:05:00-04:00', 100),
  ])
  assert.deepEqual(lateOpen, { nights: [], bySymbol: [], unmatched: 1 })

  assert.deepEqual(nightVsOpen([]), { nights: [], bySymbol: [], unmatched: 0 })
})

test('a holiday is read from the log only on evidence, never from silence', () => {
  const s = (iso: string, saidOpen: boolean, saidClosed: boolean) => ({ at: at(iso), saidOpen, saidClosed })
  const holidays = closedWeekdays([
    s('2026-09-07T11:00:00-04:00', false, true), // Labor Day: closed all day
    s('2026-09-07T14:00:00-04:00', false, true),
    s('2026-09-08T09:31:00-04:00', false, true), // a source lagging the bell...
    s('2026-09-08T11:00:00-04:00', true, false), // ...on a day that did open
    s('2026-09-12T11:00:00-04:00', false, true), // a Saturday is not a weekday holiday
  ])
  // 2026-09-09 has no ticks at all and stays a trading day.
  assert.deepEqual([...holidays], ['2026-09-07'])
})

test('a holiday the keeper watched only at the reference hour is still a holiday', () => {
  // The keeper saw Labor Day's 09:40 and then went down. Judged from 10:00 on,
  // the day read as trading, and Saturday's mark was compared with a
  // holiday-morning mark that was itself a night price: 0 bps instead of +400.
  const s = (iso: string, saidOpen: boolean) => ({ at: at(iso), saidOpen, saidClosed: !saidOpen })
  const holidays = closedWeekdays([
    s('2026-09-04T15:00:00-04:00', true),
    s('2026-09-05T12:00:00-04:00', false),
    s('2026-09-07T09:40:00-04:00', false),
    s('2026-09-08T09:36:00-04:00', true),
  ])
  assert.deepEqual([...holidays], ['2026-09-07'])

  const report = nightVsOpen(
    [
      mark('SPYx', '2026-09-04T15:00:00-04:00', 100),
      mark('SPYx', '2026-09-05T12:00:00-04:00', 104),
      mark('SPYx', '2026-09-07T09:40:00-04:00', 104),
      mark('SPYx', '2026-09-08T09:36:00-04:00', 100),
    ],
    holidays,
  )
  assert.deepEqual(report.nights, ['2026-09-08'])
  assert.equal(report.bySymbol[0].samples, 2)
  assert.ok(Math.abs(report.bySymbol[0].medianBps - 400) < 1e-9)
})

test('an even count takes the mean of the middle two, and an early close is left out', () => {
  const report = nightVsOpen(
    [
      mark('SPYx', '2026-11-25T15:00:00-05:00', 100), // Wed
      mark('SPYx', '2026-11-26T12:00:00-05:00', 101), // Thanksgiving, a night sample
      mark('SPYx', '2026-11-27T09:36:00-05:00', 100), // Fri, the reference
      mark('SPYx', '2026-11-27T14:00:00-05:00', 150), // after the 13:00 close: neither
      mark('SPYx', '2026-11-27T17:00:00-05:00', 97), // Friday night
      mark('SPYx', '2026-11-28T12:00:00-05:00', 106), // Saturday
      mark('SPYx', '2026-11-30T09:37:00-05:00', 100), // Mon, the reference
    ],
    new Set(['2026-11-26']),
  )
  assert.deepEqual(report.nights, ['2026-11-27', '2026-11-30'])
  const [spy] = report.bySymbol
  assert.equal(spy.nights, 2)
  assert.equal(spy.samples, 3)
  // +100, -300, +600: the 150 after the early close is in none of them.
  assert.ok(Math.abs(spy.medianBps - 100) < 1e-9)
  assert.ok(Math.abs(spy.worstBps - 600) < 1e-9)

  const even = nightVsOpen([
    mark('SPYx', '2026-09-23T15:00:00-04:00', 100),
    mark('SPYx', '2026-09-23T17:00:00-04:00', 101),
    mark('SPYx', '2026-09-23T18:00:00-04:00', 104),
    mark('SPYx', '2026-09-24T09:35:00-04:00', 100),
  ])
  assert.ok(Math.abs(even.bySymbol[0].medianBps - 250) < 1e-9)
})
