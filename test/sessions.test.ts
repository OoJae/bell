import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  isSessionActive,
  resolveSession,
  holidayClosure,
  type SessionWindow,
  type HolidayWindow,
} from '../src/policy/sessions.ts'

// Verbatim from Backpack's /api/v1/market-sessions.
const TZ = 'America/New_York'
const PRE: SessionWindow = { name: 'US_EQUITIES_PRE_MARKET', startTime: '04:00:00', endTime: '09:30:00', startWeekday: 1, endWeekday: 5, timezone: TZ }
const REG: SessionWindow = { name: 'US_EQUITIES_REGULAR', startTime: '09:30:00', endTime: '16:00:00', startWeekday: 1, endWeekday: 5, timezone: TZ }
const POST: SessionWindow = { name: 'US_EQUITIES_POST_MARKET', startTime: '16:00:00', endTime: '20:00:00', startWeekday: 1, endWeekday: 5, timezone: TZ }
const NIGHT: SessionWindow = { name: 'US_EQUITIES_OVERNIGHT', startTime: '20:00:00', endTime: '04:00:00', startWeekday: 7, endWeekday: 4, timezone: TZ }
const ALL = [PRE, REG, POST, NIGHT]
const EVERY = ALL.map((s) => s.name)

/** Build an instant from an Eastern wall-clock time. EDT is UTC-4 in September. */
const et = (iso: string) => new Date(`${iso}-04:00`)

test('the regular session is active mid-morning on a weekday', () => {
  assert.equal(isSessionActive(REG, et('2026-09-21T10:00:00')), true)
  assert.equal(isSessionActive(PRE, et('2026-09-21T10:00:00')), false)
})

test('the regular session ends exactly at 16:00, not a minute after', () => {
  assert.equal(isSessionActive(REG, et('2026-09-21T15:59:00')), true)
  assert.equal(isSessionActive(REG, et('2026-09-21T16:00:00')), false)
  assert.equal(isSessionActive(POST, et('2026-09-21T16:00:00')), true)
})

test('the overnight session wraps past midnight', () => {
  // Monday 21:00 and the small hours of Tuesday are the same session.
  assert.equal(isSessionActive(NIGHT, et('2026-09-21T21:00:00')), true)
  assert.equal(isSessionActive(NIGHT, et('2026-09-22T02:00:00')), true)
  assert.equal(isSessionActive(NIGHT, et('2026-09-22T04:00:00')), false, 'hands over to pre-market')
})

test('the overnight session wraps the week as well as the day', () => {
  // It starts Sunday evening and last runs into Friday morning.
  assert.equal(isSessionActive(NIGHT, et('2026-09-20T21:00:00')), true, 'Sunday evening opens the week')
  assert.equal(isSessionActive(NIGHT, et('2026-09-25T02:00:00')), true, 'Friday small hours belong to Thursday')
  assert.equal(isSessionActive(NIGHT, et('2026-09-25T21:00:00')), false, 'Friday evening is the weekend')
  assert.equal(isSessionActive(NIGHT, et('2026-09-26T21:00:00')), false, 'Saturday evening too')
})

test('nothing trades on a Saturday afternoon', () => {
  const v = resolveSession({ sessions: ALL, holidays: [], supported: EVERY, now: et('2026-09-26T13:00:00') })
  assert.equal(v.current, null)
  assert.equal(v.regularOpen, false)
})

test('a security that cannot trade overnight is closed overnight', () => {
  // 28 of Backpack's 1,166 securities are exactly this case.
  const at = et('2026-09-21T22:00:00')
  assert.equal(resolveSession({ sessions: ALL, holidays: [], supported: EVERY, now: at }).current, NIGHT.name)
  const limited = [PRE.name, REG.name, POST.name]
  assert.equal(resolveSession({ sessions: ALL, holidays: [], supported: limited, now: at }).current, null)
})

test('regularOpen is true only during the regular session', () => {
  const r = (iso: string) => resolveSession({ sessions: ALL, holidays: [], supported: EVERY, now: et(iso) }).regularOpen
  assert.equal(r('2026-09-21T08:00:00'), false, 'pre-market')
  assert.equal(r('2026-09-21T12:00:00'), true)
  assert.equal(r('2026-09-21T17:00:00'), false, 'post-market')
  assert.equal(r('2026-09-21T23:00:00'), false, 'overnight')
})

test('a holiday closes the market even during regular hours', () => {
  const thanksgiving: HolidayWindow[] = [
    { date: '2026-11-26', name: 'Thanksgiving Day', market: 'US_EQUITIES', startTime: '00:00:00', endTime: '20:00:00' },
  ]
  // EST in November, so -05:00.
  const noon = new Date('2026-11-26T12:00:00-05:00')
  const v = resolveSession({ sessions: ALL, holidays: thanksgiving, supported: EVERY, now: noon })
  assert.equal(v.current, null)
  assert.equal(v.regularOpen, false)
  assert.equal(v.holiday, 'Thanksgiving Day')
})

test('an early close is a holiday window, not a full day', () => {
  const blackFriday: HolidayWindow[] = [
    { date: '2026-11-27', name: 'Day after Thanksgiving (early close)', market: 'US_EQUITIES', startTime: '13:00:00', endTime: '23:59:59' },
  ]
  const args = { sessions: ALL, holidays: blackFriday, supported: EVERY }
  assert.equal(resolveSession({ ...args, now: new Date('2026-11-27T11:00:00-05:00') }).regularOpen, true, 'morning trades')
  assert.equal(holidayClosure(blackFriday, new Date('2026-11-27T14:00:00-05:00')), blackFriday[0], 'afternoon shut')
})
