import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  EARLY_CLOSES,
  FIRST_YEAR,
  HOLIDAYS,
  LAST_YEAR,
  isRegularOpen,
  nextChange,
} from '../src/policy/calendar.ts'
import { reconcile, HaltState, type CalendarView, type IssuerView, type PythView } from '../src/policy/reconcile.ts'
import { decide, sense, type Observation } from '../src/chain/keeper.ts'
import { ALLOWLIST } from '../src/config.ts'
import type { XStock } from '../src/sensor/xstocks.ts'
import type { PythSession } from '../src/sensor/pyth.ts'

// Every expectation below is written as a UTC instant, worked out by hand from
// the US daylight-saving rule (EDT, UTC-4, from the second Sunday of March to
// the first Sunday of November; EST, UTC-5, otherwise). The calendar reads New
// York time through Intl; these do not, so they check it rather than repeat it.
const at = (iso: string) => new Date(iso)
const unix = (iso: string) => Date.parse(iso) / 1000
const open = (iso: string) => isRegularOpen(at(iso))

test('the tables are what NYSE published: ten closures a year, all on weekdays', () => {
  for (let year = FIRST_YEAR; year <= LAST_YEAR; year++) {
    const days = [...HOLIDAYS.keys()].filter((d) => d.startsWith(`${year}-`))
    assert.equal(days.length, 10, `${year}`)
  }
  assert.equal(HOLIDAYS.size, 10 * (LAST_YEAR - FIRST_YEAR + 1), 'no row outside the covered years')
  for (const d of [...HOLIDAYS.keys(), ...EARLY_CLOSES.keys()]) {
    const weekday = new Date(`${d}T12:00:00Z`).getUTCDay()
    assert.ok(weekday >= 1 && weekday <= 5, `${d} is a weekend: a typo, since NYSE never lists one`)
  }
  for (const d of EARLY_CLOSES.keys()) assert.equal(HOLIDAYS.has(d), false, `${d} is both`)
  assert.deepEqual([...EARLY_CLOSES.keys()], ['2026-11-27', '2026-12-24', '2027-11-26'])
})

test("the tables match Pyth's own schedule strings as read on 2026-09-24", () => {
  // Two independent readings of the same exchange calendar. The first is on
  // all nine allowlisted feeds and rolls a year forward from Labor Day 2026;
  // the second is on Equity.US.NTRA/USD and is all of 2026.
  const rolling =
    'America/New_York;0930-1600,0930-1600,0930-1600,0930-1600,0930-1600,C,C;' +
    '0907/C,1126/C,1127/0930-1300,1224/0930-1300,1225/C,0101/C,0118/C,0215/C,0326/C,0531/C,0618/C,0705/C'
  const all2026 =
    'America/New_York;0930-1600,0930-1600,0930-1600,0930-1600,0930-1600,C,C;' +
    '0101/C,0119/C,0216/C,0403/C,0525/C,0619/C,0703/C,0907/C,1126/C,1127/0930-1300,1224/0930-1300,1225/C'

  const overrides = (schedule: string, yearOf: (mmdd: string) => number) =>
    schedule
      .split(';')[2]
      .split(',')
      .map((o) => {
        const [mmdd, hours] = o.split('/')
        return { date: `${yearOf(mmdd)}-${mmdd.slice(0, 2)}-${mmdd.slice(2)}`, hours }
      })
  const check = (os: Array<{ date: string; hours: string }>) => {
    for (const o of os) {
      if (o.hours === 'C') assert.ok(HOLIDAYS.has(o.date), `Pyth closes ${o.date}`)
      else {
        assert.equal(o.hours, '0930-1300')
        assert.ok(EARLY_CLOSES.has(o.date), `Pyth closes ${o.date} early`)
      }
    }
    return new Set(os.map((o) => o.date))
  }

  const rolled = check(overrides(rolling, (mmdd) => (mmdd >= '0907' ? 2026 : 2027)))
  const whole = check(overrides(all2026, () => 2026))
  // And the other way: every row of ours inside each window is in Pyth's.
  for (const d of [...HOLIDAYS.keys(), ...EARLY_CLOSES.keys()]) {
    if (d >= '2026-09-07' && d <= '2027-07-05') assert.ok(rolled.has(d), `${d} missing from Pyth's rolling list`)
    if (d.startsWith('2026-')) assert.ok(whole.has(d), `${d} missing from Pyth's 2026 list`)
  }
})

test('09:29:59 is closed, 09:30:00 open, 15:59:59 open, 16:00:00 closed (EDT)', () => {
  // Thursday 24 September 2026, the morning the film records the bell.
  assert.equal(open('2026-09-24T13:29:59.999Z'), false)
  assert.equal(open('2026-09-24T13:30:00.000Z'), true)
  assert.equal(open('2026-09-24T19:59:59.999Z'), true)
  assert.equal(open('2026-09-24T20:00:00.000Z'), false)
})

test('the same four seconds in standard time are an hour later in UTC', () => {
  // Tuesday 1 December 2026, EST.
  assert.equal(open('2026-12-01T13:30:00Z'), false, '08:30 EST is not the open')
  assert.equal(open('2026-12-01T14:29:59Z'), false)
  assert.equal(open('2026-12-01T14:30:00Z'), true)
  assert.equal(open('2026-12-01T20:59:59Z'), true)
  assert.equal(open('2026-12-01T21:00:00Z'), false)
})

test("agrees with Pyth's next open as read on the night of 23 September 2026", () => {
  // Hermes, 02:30 UTC on 24 September: every allowlisted feed had
  // is_open false, next_open 1790256600, next_close 1790280000.
  const night = at('2026-09-24T02:30:00Z')
  assert.equal(isRegularOpen(night), false)
  assert.equal(nextChange(night), 1790256600)
  assert.equal(nextChange(at('2026-09-24T13:30:00Z')), 1790280000)
})

test('DST ends on Sunday 1 November 2026: Friday opens 13:30Z, Monday 14:30Z', () => {
  assert.equal(open('2026-10-30T13:30:00Z'), true, 'Fri 09:30 EDT')
  assert.equal(open('2026-10-30T19:59:59Z'), true)
  assert.equal(open('2026-10-30T20:00:00Z'), false, 'Fri 16:00 EDT')
  assert.equal(nextChange(at('2026-10-30T20:00:00Z')), unix('2026-11-02T14:30:00Z'), 'the next open is Monday, in EST')
  // The small hours of the change itself, both readings of 01:30.
  assert.equal(open('2026-11-01T05:30:00Z'), false)
  assert.equal(open('2026-11-01T06:30:00Z'), false)
  assert.equal(open('2026-11-01T15:00:00Z'), false, 'Sunday')
  assert.equal(open('2026-11-02T13:30:00Z'), false, '08:30 EST: a fixed EDT offset would open here')
  assert.equal(open('2026-11-02T14:29:59Z'), false)
  assert.equal(open('2026-11-02T14:30:00Z'), true)
  assert.equal(open('2026-11-02T20:59:59Z'), true)
  assert.equal(open('2026-11-02T21:00:00Z'), false)
  assert.equal(nextChange(at('2026-11-02T14:30:00Z')), unix('2026-11-02T21:00:00Z'))
})

test('DST starts on Sunday 14 March 2027: Friday opens 14:30Z, Monday 13:30Z', () => {
  assert.equal(open('2027-03-12T14:29:59Z'), false)
  assert.equal(open('2027-03-12T14:30:00Z'), true, 'Fri 09:30 EST')
  assert.equal(open('2027-03-12T20:59:59Z'), true)
  assert.equal(open('2027-03-12T21:00:00Z'), false)
  assert.equal(nextChange(at('2027-03-12T21:00:00Z')), unix('2027-03-15T13:30:00Z'), 'the next open is Monday, in EDT')
  assert.equal(open('2027-03-14T15:00:00Z'), false, 'Sunday')
  assert.equal(open('2027-03-15T13:29:59Z'), false)
  assert.equal(open('2027-03-15T13:30:00Z'), true, 'Mon 09:30 EDT: a fixed EST offset would still be shut')
  assert.equal(open('2027-03-15T19:59:59Z'), true)
  assert.equal(open('2027-03-15T20:00:00Z'), false, 'Mon 16:00 EDT')
  assert.equal(open('2027-03-15T20:30:00Z'), false, '16:30 EDT: a fixed EST offset would still be open')
})

test('a holiday is closed all day, and the next open skips it', () => {
  // Thanksgiving, Thursday 26 November 2026.
  for (const iso of ['2026-11-26T14:30:00Z', '2026-11-26T17:00:00Z', '2026-11-26T20:59:59Z']) {
    assert.equal(open(iso), false, iso)
  }
  assert.equal(nextChange(at('2026-11-25T21:00:00Z')), unix('2026-11-27T14:30:00Z'), 'Wednesday close to Friday open')
  // Independence Day observed on Friday 3 July 2026: Thursday's close runs to Monday.
  assert.equal(open('2026-07-03T15:00:00Z'), false)
  assert.equal(nextChange(at('2026-07-02T20:00:00Z')), unix('2026-07-06T13:30:00Z'))
  // Good Friday 2027 and the observed Juneteenth of 2027.
  assert.equal(open('2027-03-26T15:00:00Z'), false)
  assert.equal(open('2027-06-18T15:00:00Z'), false)
  assert.equal(open('2027-06-17T15:00:00Z'), true, 'the day before is a full session')
})

test('an early close ends at 13:00:00, and 12:59:59 is still open', () => {
  // Friday 27 November 2026, EST.
  assert.equal(open('2026-11-27T14:30:00Z'), true)
  assert.equal(open('2026-11-27T17:59:59Z'), true)
  assert.equal(open('2026-11-27T18:00:00Z'), false)
  assert.equal(open('2026-11-27T20:00:00Z'), false, '15:00 is after an early close')
  assert.equal(nextChange(at('2026-11-27T15:00:00Z')), unix('2026-11-27T18:00:00Z'))
  // Christmas Eve 2026 closes early, and the next open is after Christmas and the weekend.
  assert.equal(open('2026-12-24T17:59:59Z'), true)
  assert.equal(open('2026-12-24T18:00:00Z'), false)
  assert.equal(nextChange(at('2026-12-24T18:00:00Z')), unix('2026-12-28T14:30:00Z'))
  assert.equal(open('2027-11-26T18:00:00Z'), false)
  assert.equal(open('2027-11-26T17:59:59Z'), true)
  // The day before an observed holiday is a full session, not an early close.
  assert.equal(open('2026-07-02T19:59:59Z'), true)
  assert.equal(open('2027-12-23T20:59:59Z'), true)
})

test('weekends are closed around the clock, and Friday runs to Monday', () => {
  for (const iso of ['2026-09-26T13:30:00Z', '2026-09-26T17:00:00Z', '2026-09-27T15:00:00Z', '2026-09-27T23:59:59Z']) {
    assert.equal(open(iso), false, iso)
  }
  assert.equal(nextChange(at('2026-09-25T20:00:00Z')), unix('2026-09-28T13:30:00Z'))
  assert.equal(nextChange(at('2026-09-27T23:00:00Z')), unix('2026-09-28T13:30:00Z'))
})

test('outside 2026 and 2027 the calendar has no opinion, and says so with null', () => {
  // By the New York date: 03:00Z on 1 January 2026 is still 2025 in New York.
  assert.equal(open('2026-01-01T03:00:00Z'), null)
  assert.equal(open('2028-01-03T15:00:00Z'), null)
  assert.equal(nextChange(at('2028-01-03T15:00:00Z')), null)
  // 31 December 2027 is covered, but the open after its close is not.
  assert.equal(open('2027-12-31T15:00:00Z'), true)
  assert.equal(nextChange(at('2027-12-31T15:00:00Z')), unix('2027-12-31T21:00:00Z'))
  assert.equal(nextChange(at('2027-12-31T21:00:00Z')), null)
  // 1 January 2026 itself is covered, and a holiday.
  assert.equal(open('2026-01-01T15:00:00Z'), false)
  assert.equal(nextChange(at('2026-01-01T15:00:00Z')), unix('2026-01-02T14:30:00Z'))
})

test('the answer flips exactly at nextChange, every three hours across both years', () => {
  // The two exports share their session bounds; this proves it from outside,
  // over every daylight-saving change, holiday and early close in the table.
  let sessions = 0
  for (let t = Date.parse('2026-01-01T05:07:00Z'); t < Date.parse('2027-12-31T12:00:00Z'); t += 3 * 3_600_000) {
    const now = new Date(t)
    const state = isRegularOpen(now)
    const change = nextChange(now)
    assert.notEqual(state, null)
    assert.ok(change !== null && change * 1000 > t, now.toISOString())
    assert.equal(isRegularOpen(new Date(change * 1000 - 1)), state, `just before ${change}`)
    assert.equal(isRegularOpen(new Date(change * 1000)), !state, `at ${change}`)
    if (state) sessions++
  }
  assert.ok(sessions > 0)
})

test('2026 and 2027 each have 251 sessions', () => {
  for (const year of [2026, 2027]) {
    let n = 0
    for (let d = Date.UTC(year, 0, 1); d < Date.UTC(year + 1, 0, 1); d += 86_400_000) {
      // Noon in New York is always inside the session on a trading day.
      if (isRegularOpen(new Date(d + 17 * 3_600_000))) n++
    }
    assert.equal(n, 251, `${year}`)
  }
})

// ——— the calendar as reconcile's second opinion ———

const pythOpen: PythView = { isOpen: true, nextOpen: 2_000, nextClose: 1_000 }
const pythShut: PythView = { isOpen: false, nextOpen: 1_000, nextClose: 2_000 }
const calOpen: CalendarView = { isOpen: true, nextChangeAt: 3_000 }
const calShut: CalendarView = { isOpen: false, nextChangeAt: 4_000 }
const trading: IssuerView = { openNow: true, issuerHalted: false, nextChangeAt: null }

test('Pyth open and the calendar shut is closed, a conflict, and the detail says which said what', () => {
  const v = reconcile({ pyth: pythOpen, issuer: trading, calendar: calShut })
  assert.equal(v.openNow, false)
  assert.equal(v.halt, HaltState.None, 'a disagreement about the hours is not a halt')
  assert.equal(v.confidence, 'conflict')
  assert.equal(v.nextChangeAt, 4_000, "the calendar is the one saying closed, so its next open")
  assert.match(v.detail, /Pyth says the session is open but the NYSE calendar says closed/)
})

test('Pyth shut and the calendar open is closed too; the calendar never opens a symbol', () => {
  const v = reconcile({ pyth: pythShut, issuer: trading, calendar: calOpen })
  assert.equal(v.openNow, false)
  assert.equal(v.confidence, 'conflict')
  assert.equal(v.nextChangeAt, 1_000, "Pyth's next open, as before")
  assert.match(v.detail, /Pyth says the session is closed but the NYSE calendar says open/)
  assert.match(v.detail, /issuer is open 24\/5/, 'and keeps the reason it had')
})

test('when Pyth and the calendar agree, the verdict is exactly what Pyth alone gives', () => {
  const issuers: IssuerView[] = [trading, { ...trading, openNow: false }, { ...trading, issuerHalted: true }]
  for (const issuer of issuers) {
    assert.deepEqual(reconcile({ pyth: pythOpen, issuer, calendar: calOpen }), reconcile({ pyth: pythOpen, issuer }))
    assert.deepEqual(reconcile({ pyth: pythShut, issuer, calendar: calShut }), reconcile({ pyth: pythShut, issuer }))
  }
})

test('a disagreement keeps a halt it did not cause', () => {
  // Session open on Pyth's word and the issuer refusing is read as a halt; the
  // calendar disagreeing on top must not soften it to a plain close.
  const v = reconcile({ pyth: pythOpen, issuer: { ...trading, openNow: false }, calendar: calShut })
  assert.equal(v.halt, HaltState.Unspecified)
  assert.equal(v.openNow, false)
})

test('no Pyth feed and the calendar open: the calendar stands in, degraded', () => {
  const v = reconcile({ pyth: null, issuer: trading, calendar: calOpen })
  assert.equal(v.openNow, true)
  assert.equal(v.halt, HaltState.None)
  assert.equal(v.confidence, 'degraded')
  assert.equal(v.nextChangeAt, 3_000, "the calendar's close")
  assert.match(v.detail, /no Pyth feed, NYSE calendar standing in/)
})

test('no Pyth feed and the calendar open still reads a refusing issuer as a stop', () => {
  const v = reconcile({ pyth: null, issuer: { ...trading, openNow: false }, calendar: calOpen })
  assert.equal(v.openNow, false)
  assert.equal(v.halt, HaltState.Unspecified)
  assert.equal(v.confidence, 'degraded')
})

// ——— decide(), with the real calendar and the instant of the observation ———

const backed = ALLOWLIST.filter((l) => l.issuer === 'backed')

/** Every Backed name trading on the issuer's word, as its 24/5 wrapper does. */
function observation(atIso: string, pyth: Map<string, PythSession>, pythError: string | null = null): Observation {
  return {
    at: at(atIso),
    xstocks: new Map(
      backed.map((l) => [
        l.mainnetMint,
        { mint: l.mainnetMint, openNow: !l.withdrawn, halted: Boolean(l.withdrawn), nextChangeAt: null } as XStock,
      ]),
    ),
    pyth,
    pythError,
    halts: new Map(),
    backpack: null,
    backpackError: 'not read in this test',
  }
}

const allFeeds = (isOpen: boolean) =>
  new Map(
    ALLOWLIST.map((l) => [
      l.underlying,
      { ticker: l.underlying, feedId: 'f', isOpen, nextOpen: null, nextClose: null, schedule: null },
    ]),
  )

test('with Pyth gone, Backed names trade in the session and close at night, weekends and holidays', () => {
  const tradeable = backed.filter((l) => !l.withdrawn)
  assert.ok(tradeable.length > 0)
  const cases: Array<[string, boolean]> = [
    ['2026-09-24T15:00:00Z', true], // Thu 11:00 EDT
    ['2026-09-24T07:00:00Z', false], // Thu 03:00 EDT: the case the missing-feed fix exists for
    ['2026-09-24T13:29:59Z', false], // one second before the bell
    ['2026-09-24T13:30:00Z', true], // the bell
    ['2026-09-26T15:00:00Z', false], // Saturday
    ['2026-11-26T16:00:00Z', false], // Thanksgiving
    ['2026-11-27T18:30:00Z', false], // 13:30 on an early close
  ]
  for (const [iso, expectOpen] of cases) {
    for (const d of decide(observation(iso, new Map(), 'pyth price_feeds: HTTP 503'))) {
      if (d.listing.issuer !== 'backed' || d.listing.withdrawn) continue
      assert.equal(d.verdict.openNow, expectOpen, `${d.listing.symbol} at ${iso}`)
      assert.equal(d.verdict.confidence, 'degraded', `${d.listing.symbol} at ${iso}`)
      assert.match(d.verdict.detail, /NYSE calendar standing in/)
      assert.match(d.verdict.detail, /Pyth feed list unread: pyth price_feeds: HTTP 503/)
      assert.equal(d.sources.pythOpen, null)
    }
  }
})

test('with Pyth present, the calendar changes nothing at this hour and closes a holiday Pyth has open', () => {
  // 22:30 EDT on Wednesday 23 September 2026: Pyth and the calendar both closed.
  const night = observation('2026-09-24T02:30:00Z', allFeeds(false))
  for (const d of decide(night)) {
    const alone = reconcile({
      pyth: { isOpen: false, nextOpen: null, nextClose: null },
      issuer: d.sources.issuerOpen === null ? null : { openNow: d.sources.issuerOpen, issuerHalted: Boolean(d.sources.issuerHalted), nextChangeAt: null },
    })
    assert.deepEqual(d.verdict, alone, d.listing.symbol)
  }
  // Pyth wrongly open on Thanksgiving: everything closes, and says why.
  for (const d of decide(observation('2026-11-26T16:00:00Z', allFeeds(true)))) {
    assert.equal(d.verdict.openNow, false, d.listing.symbol)
    if (d.listing.issuer === 'backed' && !d.listing.withdrawn) {
      assert.equal(d.verdict.confidence, 'conflict')
      assert.match(d.verdict.detail, /NYSE calendar says closed/)
    }
  }
})

test("a failed Pyth fetch no longer fails sense(): it comes back as an error beside an empty feed list", async (t) => {
  t.mock.method(console, 'warn', () => {})
  t.mock.method(globalThis, 'fetch', async (url: string | URL) => {
    const u = String(url)
    if (u.includes('hermes.pyth.network')) return new Response('upstream unavailable', { status: 503 })
    if (u.includes('nasdaqtrader.com')) return new Response('<rss><channel></channel></rss>', { status: 200 })
    if (u.includes('api.xstocks.fi')) {
      const symbol = decodeURIComponent(u.split('/assets/')[1].split('?')[0])
      const l = ALLOWLIST.find((x) => x.symbol === symbol)
      if (!l) return new Response('not found', { status: 404 })
      return new Response(
        JSON.stringify({
          id: symbol,
          symbol,
          name: symbol,
          deployments: [{ address: l.mainnetMint, network: 'Solana' }],
          trading: { openNow: true, isTradingHalted: false, nextChangeAt: null },
        }),
        { status: 200 },
      )
    }
    return new Response('not in this test', { status: 500 })
  })

  const obs = await sense()
  assert.equal(obs.pyth.size, 0)
  assert.equal(obs.pythError, 'pyth price_feeds: HTTP 503')
  assert.equal(obs.xstocks.size, backed.length)

  const inSession = decide({ ...obs, at: at('2026-09-24T15:00:00Z') })
  const spy = inSession.find((d) => d.listing.symbol === 'SPYx')
  assert.equal(spy?.verdict.openNow, true, 'the calendar stands in during the session')
  const overnight = decide({ ...obs, at: at('2026-09-24T07:00:00Z') })
  assert.ok(overnight.every((d) => !d.verdict.openNow), 'and nothing opens at 03:00')
})

test("a Pyth body that is not a list is named on one line, since the reason lands in all nine details", async (t) => {
  t.mock.method(console, 'warn', () => {})
  t.mock.method(globalThis, 'fetch', async (url: string | URL) => {
    const u = String(url)
    // zod's message for this is pretty-printed JSON, several lines long.
    if (u.includes('hermes.pyth.network')) return new Response(JSON.stringify({ moved: true }), { status: 200 })
    if (u.includes('nasdaqtrader.com')) return new Response('<rss><channel></channel></rss>', { status: 200 })
    return new Response('not in this test', { status: 500 })
  })

  const obs = await sense()
  assert.equal(obs.pyth.size, 0)
  assert.ok(obs.pythError, 'the failure is kept')
  assert.doesNotMatch(obs.pythError!, /\n/)
  assert.ok(obs.pythError!.length <= 200)
  for (const d of decide({ ...obs, at: at('2026-09-24T07:00:00Z') })) {
    assert.doesNotMatch(d.verdict.detail, /\n/, d.listing.symbol)
    assert.equal(d.verdict.openNow, false, d.listing.symbol)
  }
})

// ——— the calendar can only make BELL more careful, proved over the whole space ———

test('over every pyth × calendar × issuer × halt × listing state, the calendar never loosens a verdict', () => {
  // Three claims, each against a reference that has no calendar in it:
  //
  // 1. Where Pyth has a feed, the calendar is a second opinion that can only
  //    take away. It never opens what Pyth alone would close, never changes a
  //    halt, and never lets a symbol open while it says the session is shut.
  // 2. Where a US listing has no feed, a calendar that is shut or silent
  //    closes it, exactly as the missing feed did before the calendar existed.
  // 3. Where the calendar stands in for a missing feed, it is never looser
  //    than Pyth agreeing with it would be: the same open/closed answer and the
  //    same halt, so every other rule (exchange halt, withdrawn token, refusing
  //    issuer) still applies in full.
  const pyths: Array<PythView | null> = [pythOpen, pythShut, null]
  const calendars: Array<CalendarView | null> = [calOpen, calShut, null]
  const issuers: Array<IssuerView | null> = [
    trading,
    { ...trading, openNow: false },
    { ...trading, issuerHalted: true },
    { openNow: false, issuerHalted: true, nextChangeAt: null },
    null,
  ]
  const halts = [null, { kind: HaltState.Luld, resumesAt: 0 }]
  let cases = 0
  for (const pyth of pyths) {
    for (const calendar of calendars) {
      for (const issuer of issuers) {
        for (const exchangeHalt of halts) {
          for (const nonUsListing of [false, true]) {
            const label = JSON.stringify({ pyth, calendar, issuer, exchangeHalt, nonUsListing })
            const v = reconcile({ pyth, issuer, exchangeHalt, nonUsListing, calendar })
            const before = reconcile({ pyth, issuer, exchangeHalt, nonUsListing })
            cases++
            if (v.openNow) assert.equal(v.halt, HaltState.None, `open and halted: ${label}`)
            if (exchangeHalt) {
              assert.equal(v.openNow, false, label)
              // A missing issuer is step 1 and outranks it, as it did before.
              if (issuer) assert.equal(v.halt, exchangeHalt.kind, `an exchange halt is reported as itself: ${label}`)
            }
            if (!issuer || issuer.issuerHalted || !issuer.openNow) assert.equal(v.openNow, false, label)

            if (pyth) {
              if (v.openNow) assert.equal(before.openNow, true, `calendar opened it: ${label}`)
              assert.equal(v.halt, before.halt, `calendar changed the halt: ${label}`)
              if (calendar && !calendar.isOpen) assert.equal(v.openNow, false, `open while the calendar is shut: ${label}`)
            } else if (!nonUsListing) {
              if (!calendar || !calendar.isOpen) assert.equal(v.openNow, false, `opened without a session: ${label}`)
              if (!calendar) assert.deepEqual(v, before, `no opinion changed something: ${label}`)
              if (calendar) {
                const agreeing: PythView = calendar.isOpen
                  ? { isOpen: true, nextOpen: null, nextClose: calendar.nextChangeAt }
                  : { isOpen: false, nextOpen: calendar.nextChangeAt, nextClose: null }
                const withPyth = reconcile({ pyth: agreeing, issuer, exchangeHalt, calendar })
                assert.equal(v.openNow, withPyth.openNow, `standing in is looser than Pyth: ${label}`)
                assert.equal(v.halt, withPyth.halt, `standing in changed the halt: ${label}`)
                if (issuer && !exchangeHalt && !issuer.issuerHalted) assert.equal(v.confidence, 'degraded', label)
              }
            } else {
              // A non-US listing has never had a feed; the calendar is not asked.
              assert.deepEqual(v, before, `the calendar touched a non-US listing: ${label}`)
            }
          }
        }
      }
    }
  }
  assert.equal(cases, 3 * 3 * 5 * 2 * 2)
})

test('with Pyth unread, decide() opens nothing outside the calendar session, every half hour of 2026 and 2027', () => {
  // Half-hour steps from midnight land exactly on 09:30:00, 13:00:00 and
  // 16:00:00 New York time in both daylight and standard time, so every open,
  // close and early close in the table is hit on its boundary second. Each
  // Backed name reads open on the issuer's word, as the 24/5 wrapper does all
  // night, so the calendar is the only thing that can close it.
  const tradeable = new Set(backed.filter((l) => !l.withdrawn).map((l) => l.symbol))
  let inSession = 0
  for (let t = Date.parse('2026-01-01T05:00:00Z'); t < Date.parse('2028-01-01T05:00:00Z'); t += 1_800_000) {
    const iso = new Date(t).toISOString()
    const session = isRegularOpen(new Date(t))
    assert.notEqual(session, null, iso)
    if (session) inSession++
    for (const d of decide(observation(iso, new Map(), 'pyth price_feeds: HTTP 503'))) {
      if (d.verdict.openNow) assert.equal(session, true, `${d.listing.symbol} open outside the session at ${iso}`)
      if (tradeable.has(d.listing.symbol)) assert.equal(d.verdict.openNow, session, `${d.listing.symbol} at ${iso}`)
      else assert.equal(d.verdict.openNow, false, `${d.listing.symbol} at ${iso}`)
    }
  }
  // 499 full sessions of 13 half hours and 3 early closes of 7, both years.
  assert.equal(inSession, 499 * 13 + 3 * 7)
})

test('with Pyth unread in the session, an exchange halt still closes its name and is reported as itself', () => {
  const obs = observation('2026-09-24T15:00:00Z', new Map(), 'pyth price_feeds: HTTP 503')
  const spy = ALLOWLIST.find((l) => l.symbol === 'SPYx')
  assert.ok(spy)
  obs.halts.set(spy.underlying, {
    ticker: spy.underlying,
    issueName: 'SPDR S&P 500',
    market: 'NYSE Arca',
    reasonCode: 'LUDP',
    kind: HaltState.Luld,
    haltedAt: unix('2026-09-24T14:55:00Z'),
    resumesAt: 0,
  })
  for (const d of decide(obs)) {
    if (d.listing.symbol === 'SPYx') {
      assert.equal(d.verdict.openNow, false)
      assert.equal(d.verdict.halt, HaltState.Luld)
    } else if (d.listing.issuer === 'backed' && !d.listing.withdrawn) {
      assert.equal(d.verdict.openNow, true, `${d.listing.symbol}: one name's halt is not the market's`)
    }
  }
})

test('with Pyth wrongly open around the clock, decide() still opens nothing outside the calendar session', () => {
  // A stuck or wrong is_open flag. Before the calendar this opened every Backed
  // name at night; now the calendar closes it, as a conflict.
  for (let t = Date.parse('2026-09-21T04:00:00Z'); t < Date.parse('2026-12-29T04:00:00Z'); t += 1_800_000) {
    const iso = new Date(t).toISOString()
    const session = isRegularOpen(new Date(t))
    for (const d of decide(observation(iso, allFeeds(true)))) {
      if (d.verdict.openNow) assert.equal(session, true, `${d.listing.symbol} at ${iso}`)
      if (!session && d.sources.issuerOpen) assert.equal(d.verdict.confidence, 'conflict', `${d.listing.symbol} at ${iso}`)
    }
  }
})
