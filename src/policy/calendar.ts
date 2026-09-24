/**
 * The US regular session, from the exchange's own published calendar.
 *
 * BELL's session verdict leans on one input nobody here controls: the
 * `market_hours` block in Pyth's free `/v2/price_feeds` metadata. If that
 * metadata goes away, or a feed drops a ticker, the keeper has no idea whether
 * the market is open. This is the second opinion, and it is local: a table and
 * the rules around it, so it cannot go down, rate-limit or change its terms.
 *
 * It is the NYSE regular session, Monday to Friday 09:30 to 16:00 New York
 * time, less the full-day holidays and with the 13:00 early closes. NYSE's
 * table covers NYSE and NYSE Arca, where five of the nine allowlisted names
 * list. The other four list on Nasdaq, whose regular session is the same 09:30
 * to 16:00 and whose published 2026 closures are the same ten days and two
 * early closes. Nasdaq has not published 2027 on that page; Pyth's schedule for
 * the Nasdaq names carries the same 2027 dates as NYSE's through July.
 *
 * Sources, all read on 2026-09-24:
 *
 * - NYSE, "Holidays & Trading Hours", https://www.nyse.com/trade/hours-calendars
 *   (https://www.nyse.com/markets/hours-calendars now redirects there). "All
 *   NYSE markets observe U.S. holidays as listed below for 2026, 2027, and
 *   2028"; core trading session 9:30 a.m. to 4:00 p.m. ET; early closes at
 *   1:00 p.m. on 27 Nov 2026, 24 Dec 2026 and 26 Nov 2027. nyse.com answered
 *   this machine with a Cloudflare 403, so the table was read from the Internet
 *   Archive's capture of that page taken 2026-09-06 16:15:39 UTC:
 *   https://web.archive.org/web/20260906161539/https://www.nyse.com/trade/hours-calendars
 * - Nasdaq, https://www.nasdaq.com/market-activity/stock-market-holiday-schedule,
 *   read live: the same 2026 closures and early closes, and 9:30 am to 4:00 pm
 *   ET for The Nasdaq Stock Market. It showed 2026 only.
 * - Pyth's own `schedule` string, identical on all nine allowlisted feeds: its
 *   holiday overrides, which run from 7 Sep 2026 to 5 Jul 2027, match the
 *   tables below date for date.
 *
 * What it cannot know: a closure announced after the table was written (a
 * national day of mourning, say), and anything after 2027. Outside the years
 * below it returns null rather than guessing, and a caller must treat null as
 * no opinion at all.
 *
 * Pure: no I/O, and no clock of its own; the instant is always an argument.
 * Every New York wall-clock reading goes through `Intl` with the IANA zone, so
 * daylight saving is the tz database's business rather than a fixed offset.
 */

const ZONE = 'America/New_York'

/** Minutes after New York midnight. */
const OPEN = 9 * 60 + 30
const CLOSE = 16 * 60
const EARLY_CLOSE = 13 * 60

/** The first and last years the tables below are complete for. */
export const FIRST_YEAR = 2026
export const LAST_YEAR = 2027

/**
 * Full-day closures, by New York date. Every row is from the NYSE table cited
 * above; the names are NYSE's.
 */
export const HOLIDAYS: ReadonlyMap<string, string> = new Map([
  ['2026-01-01', "New Year's Day"],
  ['2026-01-19', 'Martin Luther King, Jr. Day'],
  ['2026-02-16', "Washington's Birthday"],
  ['2026-04-03', 'Good Friday'],
  ['2026-05-25', 'Memorial Day'],
  ['2026-06-19', 'Juneteenth National Independence Day'],
  ['2026-07-03', 'Independence Day (observed)'],
  ['2026-09-07', 'Labor Day'],
  ['2026-11-26', 'Thanksgiving Day'],
  ['2026-12-25', 'Christmas Day'],
  ['2027-01-01', "New Year's Day"],
  ['2027-01-18', 'Martin Luther King, Jr. Day'],
  ['2027-02-15', "Washington's Birthday"],
  ['2027-03-26', 'Good Friday'],
  ['2027-05-31', 'Memorial Day'],
  ['2027-06-18', 'Juneteenth National Independence Day (observed)'],
  ['2027-07-05', 'Independence Day (observed)'],
  ['2027-09-06', 'Labor Day'],
  ['2027-11-25', 'Thanksgiving Day'],
  ['2027-12-24', 'Christmas Day (observed)'],
])

/**
 * Days the regular session ends at 13:00 rather than 16:00. NYSE's footnotes
 * list these three for 2026 and 2027 and no others, so there is no early close
 * on 2 Jul 2026, 2 Jul 2027 or 23 Dec 2027, the days before observed holidays.
 */
export const EARLY_CLOSES: ReadonlyMap<string, string> = new Map([
  ['2026-11-27', 'the day after Thanksgiving'],
  ['2026-12-24', 'Christmas Eve'],
  ['2027-11-26', 'the day after Thanksgiving'],
])

// One formatter for the life of the process: building an `Intl.DateTimeFormat`
// is the expensive part, and the keeper asks at least twice a tick.
// `hourCycle: 'h23'` so midnight reads as 00, not 24. Built inside a try: a
// runtime without the zone throws a RangeError here, and at module load that
// would take the whole keeper down with it rather than just this opinion.
const NY = (() => {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: ZONE,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
  } catch {
    return null
  }
})()

interface Wall {
  year: number
  month: number
  day: number
  /** Seconds since New York midnight, whole seconds. */
  second: number
}

/** New York wall-clock fields for an instant, in unix milliseconds. */
function wallClock(ms: number): Wall {
  if (!NY) throw new Error(`this runtime has no time-zone data for ${ZONE}`)
  const parts = NY.formatToParts(new Date(ms))
  const get = (t: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === t)?.value)
  // Belt and braces for an ICU that ignores the hour cycle and says 24.
  const hour = get('hour') % 24
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    second: hour * 3_600 + get('minute') * 60 + get('second'),
  }
}

const isoDate = (y: number, m: number, d: number) =>
  `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`

/**
 * The unix milliseconds at which New York's wall clock reads `minutes` past
 * midnight on this date.
 *
 * Found by asking `Intl` rather than by adding an offset: guess as though New
 * York were UTC, read the wall clock at the guess, and move by the difference.
 * Session boundaries are never inside the 02:00 daylight-saving jump, so the
 * wall time exists and is unique, and one correction lands on it; the loop only
 * confirms it.
 */
function instantOf(y: number, m: number, d: number, minutes: number): number {
  const target = Date.UTC(y, m - 1, d, 0, minutes)
  let t = target
  for (let i = 0; i < 3; i++) {
    const w = wallClock(t)
    const seen = Date.UTC(w.year, w.month - 1, w.day, 0, 0, w.second)
    if (seen === target) return t
    t += target - seen
  }
  throw new Error(`no instant reads ${isoDate(y, m, d)} +${minutes}min in ${ZONE}`)
}

/**
 * The regular session on one New York date, as unix milliseconds; null when
 * there is none (a weekend or a holiday).
 */
function sessionOn(y: number, m: number, d: number): { open: number; close: number } | null {
  // A calendar date's weekday does not depend on the zone it is read in.
  const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay()
  if (weekday === 0 || weekday === 6) return null
  const date = isoDate(y, m, d)
  if (HOLIDAYS.has(date)) return null
  return {
    open: instantOf(y, m, d, OPEN),
    close: instantOf(y, m, d, EARLY_CLOSES.has(date) ? EARLY_CLOSE : CLOSE),
  }
}

const covered = (year: number) => year >= FIRST_YEAR && year <= LAST_YEAR

/**
 * Whether this runtime reads New York time correctly, checked once at load.
 *
 * Everything above trusts the runtime's tz database, and a wrong one would not
 * fail: it would put the open and close an hour out, and a calendar an hour
 * out closes the venue for an hour of every session by disagreeing with Pyth. So
 * the four session opens either side of 2026's two daylight-saving changes
 * (8 March and 1 November, the second Sunday of March and the first of
 * November) are checked against their known UTC instants, and if any is wrong
 * the calendar has no opinion at all, which leaves every verdict as it was
 * before the calendar existed.
 */
const ZONE_OK = (() => {
  try {
    return (
      instantOf(2026, 3, 6, OPEN) === Date.UTC(2026, 2, 6, 14, 30) &&
      instantOf(2026, 3, 9, OPEN) === Date.UTC(2026, 2, 9, 13, 30) &&
      instantOf(2026, 10, 30, OPEN) === Date.UTC(2026, 9, 30, 13, 30) &&
      instantOf(2026, 11, 2, OPEN) === Date.UTC(2026, 10, 2, 14, 30)
    )
  } catch {
    return false
  }
})()

/**
 * Is the US regular session open at this instant?
 *
 * Opens at 09:30:00 exactly and closes at 16:00:00 exactly (13:00:00 on an
 * early close): 09:29:59 is closed, 09:30:00 open, 15:59:59 open, 16:00:00
 * closed. Null when the New York date is outside the years the table covers,
 * or the runtime cannot read New York time: "no opinion", never "closed".
 */
export function isRegularOpen(now: Date): boolean | null {
  if (!ZONE_OK) return null
  const t = now.getTime()
  const w = wallClock(t)
  if (!covered(w.year)) return null
  // The same session bounds `nextChange` walks, so the two can never disagree
  // about when the answer flips.
  const s = sessionOn(w.year, w.month, w.day)
  return s !== null && t >= s.open && t < s.close
}

/**
 * When the answer to `isRegularOpen` next changes, in unix seconds: this
 * session's close while it is open, otherwise the next session's open.
 *
 * Null when that instant is not inside the years the table covers, since the
 * first session of an uncovered year could be a holiday this table has never
 * heard of.
 */
export function nextChange(now: Date): number | null {
  if (!ZONE_OK) return null
  const t = now.getTime()
  const w = wallClock(t)
  if (!covered(w.year)) return null
  // No run of closed days in these tables is longer than three (a Friday or
  // Monday holiday and its weekend), so a fortnight is far more than enough.
  for (let i = 0; i < 14; i++) {
    const day = new Date(Date.UTC(w.year, w.month - 1, w.day + i))
    const [y, m, d] = [day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate()]
    if (!covered(y)) return null
    const s = sessionOn(y, m, d)
    if (!s) continue
    if (t < s.open) return s.open / 1000
    if (t < s.close) return s.close / 1000
  }
  return null
}
