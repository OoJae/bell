/**
 * Which US equity session is running right now, from Backpack's published
 * calendar.
 *
 * Needed because Backpack exposes no per-security halt flag, so without this a
 * Backpack name would be single-sourced on Pyth and the reconciler would have
 * nothing to confirm it against. It *does* publish per-security session
 * eligibility — 1,138 securities trade overnight and 28 do not — which makes
 * this a genuine second opinion rather than a restatement.
 *
 * Pure: no I/O, no clock of its own.
 */

export interface SessionWindow {
  name: string
  /** `HH:MM:SS` in `timezone`. */
  startTime: string
  endTime: string
  /** ISO weekday, Monday = 1 … Sunday = 7. */
  startWeekday: number
  endWeekday: number
  timezone: string
}

export interface HolidayWindow {
  /** `YYYY-MM-DD`. */
  date: string
  name: string
  market: string
  startTime: string
  endTime: string
}

const REGULAR = 'US_EQUITIES_REGULAR'

/** Wall-clock fields for an instant in a named zone. */
function wallClock(at: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(at)
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? ''
  const weekdays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
  // `hour` can come back as "24" at midnight in some ICU versions.
  const hour = Number(get('hour')) % 24
  return {
    isoWeekday: weekdays.indexOf(get('weekday')) + 1,
    date: `${get('year')}-${get('month')}-${get('day')}`,
    minutes: hour * 60 + Number(get('minute')),
    seconds: Number(get('second')),
  }
}

const toMinutes = (hms: string) => {
  const [h, m] = hms.split(':').map(Number)
  return h * 60 + m
}

/** Does `weekday` fall in the inclusive range `from..to`, which may wrap? */
function inWeekdayRange(weekday: number, from: number, to: number): boolean {
  return from <= to ? weekday >= from && weekday <= to : weekday >= from || weekday <= to
}

/**
 * True when `now` is inside this session.
 *
 * A window whose end time is earlier than its start time wraps past midnight —
 * the overnight session runs 20:00 to 04:00, and starts on Sunday through
 * Thursday, so it wraps both the day and the week.
 */
export function isSessionActive(s: SessionWindow, now: Date): boolean {
  const { isoWeekday, minutes } = wallClock(now, s.timezone)
  const start = toMinutes(s.startTime)
  const end = toMinutes(s.endTime)

  if (start < end) {
    return inWeekdayRange(isoWeekday, s.startWeekday, s.endWeekday) && minutes >= start && minutes < end
  }
  // Wrapping window: either the evening leg on a starting weekday, or the
  // small-hours leg belonging to the previous day's session.
  const eveningLeg = minutes >= start && inWeekdayRange(isoWeekday, s.startWeekday, s.endWeekday)
  const previousDay = isoWeekday === 1 ? 7 : isoWeekday - 1
  const morningLeg = minutes < end && inWeekdayRange(previousDay, s.startWeekday, s.endWeekday)
  return eveningLeg || morningLeg
}

/** Is the whole market shut, or closing early, for a holiday? */
export function holidayClosure(
  holidays: HolidayWindow[],
  now: Date,
  timeZone = 'America/New_York',
): HolidayWindow | null {
  const { date, minutes } = wallClock(now, timeZone)
  for (const h of holidays) {
    if (h.date !== date) continue
    if (minutes >= toMinutes(h.startTime) && minutes < toMinutes(h.endTime)) return h
  }
  return null
}

export interface SessionVerdict {
  /** The active session, or null when the market is shut. */
  current: string | null
  /** True only during the regular session, which is when price discovery happens. */
  regularOpen: boolean
  /** Set when a holiday is suppressing an otherwise-active session. */
  holiday: string | null
}

/**
 * Resolve the current session for one security.
 *
 * `supported` is that security's own session list: a name that cannot trade
 * overnight is closed overnight even while the venue's overnight session runs.
 */
export function resolveSession(args: {
  sessions: SessionWindow[]
  holidays: HolidayWindow[]
  supported: string[]
  now: Date
}): SessionVerdict {
  const holiday = holidayClosure(args.holidays, args.now)
  if (holiday) return { current: null, regularOpen: false, holiday: holiday.name }

  const eligible = new Set(args.supported)
  const active = args.sessions.find((s) => eligible.has(s.name) && isSessionActive(s, args.now))
  return {
    current: active?.name ?? null,
    regularOpen: active?.name === REGULAR,
    holiday: null,
  }
}
