import { test } from 'node:test'
import assert from 'node:assert/strict'
import { reconcile, HaltState, type CalendarView, type PythView, type IssuerView } from '../src/policy/reconcile.ts'

const openSession: PythView = { isOpen: true, nextOpen: 2_000, nextClose: 1_000 }
const shutSession: PythView = { isOpen: false, nextOpen: 1_000, nextClose: 2_000 }
const trading: IssuerView = { openNow: true, issuerHalted: false, nextChangeAt: null }
/** The NYSE calendar's reading, for the tests that need one. */
const calendarOpen: CalendarView = { isOpen: true, nextChangeAt: 3_000 }
const calendarShut: CalendarView = { isOpen: false, nextChangeAt: 4_000 }

test('agreement that the market is open is confirmed and tradeable', () => {
  const v = reconcile({ pyth: openSession, issuer: trading })
  assert.equal(v.openNow, true)
  assert.equal(v.halt, HaltState.None)
  assert.equal(v.confidence, 'confirmed')
})

test('agreement that the market is shut is closed, but not a halt', () => {
  const v = reconcile({ pyth: shutSession, issuer: { ...trading, openNow: false } })
  assert.equal(v.openNow, false)
  assert.equal(v.halt, HaltState.None, 'closed is not halted')
  assert.equal(v.confidence, 'confirmed')
})

test('a session that is open while the issuer refuses is read as a halt', () => {
  // The safety net for a halt that arrives without anyone flagging it.
  const v = reconcile({ pyth: openSession, issuer: { ...trading, openNow: false } })
  assert.equal(v.halt, HaltState.Unspecified)
  assert.equal(v.openNow, false)
  assert.equal(v.confidence, 'conflict')
})

test('an exchange halt outranks everything and keeps its reason code', () => {
  // II.H is about the exchange halting the security. A LULD pause must survive
  // as a LULD pause, because it carries a resumption time that a suspension
  // does not.
  const v = reconcile({
    pyth: openSession,
    issuer: trading,
    exchangeHalt: { kind: HaltState.Luld, resumesAt: 9_999 },
  })
  assert.equal(v.halt, HaltState.Luld)
  assert.equal(v.openNow, false)
  assert.equal(v.nextChangeAt, 9_999)
})

test('an issuer withdrawing its token is not reported as an exchange halt', () => {
  // Measured 2026-09-21: Backed flagged IWMx and JPSTx while IWM and JPST were
  // absent from Nasdaq's feed, which does carry Arca halts. The ETF was not
  // halted — Backed had pulled its own wrapper. Both stop the trade; only one
  // is the II.H condition, and saying the wrong one would be a false claim.
  const v = reconcile({ pyth: openSession, issuer: { ...trading, issuerHalted: true } })
  assert.equal(v.openNow, false)
  assert.equal(v.halt, HaltState.Unspecified)
  assert.match(v.detail, /issuer has withdrawn/)
  // Must not claim the primary exchange halted it — that is the false claim.
  assert.doesNotMatch(v.detail, /halted on the primary listing exchange/)
})

test('an issuer withdrawal is never downgraded by an agreeing session', () => {
  const v = reconcile({
    pyth: shutSession,
    issuer: { openNow: false, issuerHalted: true, nextChangeAt: null },
  })
  assert.equal(v.halt, HaltState.Unspecified)
})

test('a 24/5 wrapper trading into a shut market is closed, not halted', () => {
  // The issuer is willing and the token keeps trading on-chain; the underlying
  // market is not open. That is the ordinary overnight case, not a halt.
  const v = reconcile({ pyth: shutSession, issuer: trading })
  assert.equal(v.openNow, false)
  assert.equal(v.halt, HaltState.None)
  assert.equal(v.confidence, 'conflict')
  assert.equal(v.nextChangeAt, 1_000, 'should point at the next open')
})

test('a non-US listing is single-sourced and says so', () => {
  const v = reconcile({ pyth: null, issuer: trading, nonUsListing: true })
  assert.equal(v.confidence, 'degraded')
  assert.equal(v.openNow, true)
})

test('a missing Pyth feed for a US name is unavailable when the calendar cannot stand in', () => {
  // Expected absence and unexpected absence are different problems. With the
  // calendar standing in it is degraded instead: see test/calendar.test.ts.
  const v = reconcile({ pyth: null, issuer: trading })
  assert.equal(v.confidence, 'unavailable')
  assert.equal(reconcile({ pyth: null, issuer: trading, calendar: null }).confidence, 'unavailable')
})

test('a missing Pyth feed for a US name closes it whenever the calendar says closed, whatever the issuer says', () => {
  // Backed's 24/5 wrapper reads open overnight. Before this was fixed, a
  // dropped Pyth ticker opened SPYx at 3am on the issuer's word alone. The
  // calendar now stands in for the missing feed, and at 3am it says closed;
  // with no calendar reading at all the symbol is closed as before.
  for (const calendar of [calendarShut, null, undefined]) {
    for (const issuer of [trading, { ...trading, openNow: false }, { ...trading, issuerHalted: true }]) {
      for (const nonUsListing of [false, undefined]) {
        const v = reconcile({ pyth: null, issuer, nonUsListing, calendar })
        assert.equal(
          v.openNow,
          false,
          `calendar=${JSON.stringify(calendar)} issuer=${JSON.stringify(issuer)} nonUsListing=${nonUsListing}`,
        )
      }
    }
  }
  // Only the calendar saying open lets the issuer decide, and then only a
  // trading, unwithdrawn issuer opens it.
  assert.equal(reconcile({ pyth: null, issuer: trading, calendar: calendarOpen }).openNow, true)
  assert.equal(reconcile({ pyth: null, issuer: { ...trading, openNow: false }, calendar: calendarOpen }).openNow, false)
  assert.equal(reconcile({ pyth: null, issuer: { ...trading, issuerHalted: true }, calendar: calendarOpen }).openNow, false)
})

test('no issuer reading closes the symbol', () => {
  const v = reconcile({ pyth: openSession, issuer: null })
  assert.equal(v.openNow, false)
  assert.equal(v.halt, HaltState.Unspecified)
  assert.equal(v.confidence, 'unavailable')
})

test('every path that is not plainly open resolves to not-tradeable', () => {
  // Fail closed is the default, not the fallback. Enumerate the space, now
  // with the calendar's three answers and both kinds of listing.
  const pyths: Array<PythView | null> = [openSession, shutSession, null]
  const issuers: Array<IssuerView | null> = [
    trading,
    { ...trading, openNow: false },
    { ...trading, issuerHalted: true },
    null,
  ]
  const calendars: Array<CalendarView | null> = [calendarOpen, calendarShut, null]
  for (const pyth of pyths) {
    for (const issuer of issuers) {
      for (const calendar of calendars) {
        for (const nonUsListing of [true, false]) {
          const v = reconcile({ pyth, issuer, nonUsListing, calendar })
          // Which source answers for the session: Pyth, and the calendar must
          // not contradict it; the issuer alone for a listing no US feed can
          // cover; and for a US listing with no feed, the calendar or nothing.
          const sessionOpen =
            pyth !== null
              ? pyth.isOpen && (calendar === null || calendar.isOpen)
              : nonUsListing || (calendar !== null && calendar.isOpen)
          const plainlyOpen = issuer !== null && !issuer.issuerHalted && issuer.openNow && sessionOpen
          const label = `pyth=${JSON.stringify(pyth)} issuer=${JSON.stringify(issuer)} calendar=${JSON.stringify(calendar)} nonUs=${nonUsListing}`
          assert.equal(v.openNow, plainlyOpen, label)
          if (v.openNow) assert.equal(v.halt, HaltState.None, 'tradeable implies not halted')
          // Where Pyth has a feed, the calendar is a second opinion that can
          // only take away: never open what Pyth alone would close, never
          // change a halt.
          if (pyth !== null) {
            const alone = reconcile({ pyth, issuer, nonUsListing })
            if (v.openNow) assert.equal(alone.openNow, true, `calendar opened it: ${label}`)
            assert.equal(v.halt, alone.halt, `calendar changed the halt: ${label}`)
          }
        }
      }
    }
  }
})
