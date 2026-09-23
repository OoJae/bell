/**
 * Turn the tick log into EVIDENCE.md.
 *
 *   node scripts/evidence.ts
 *
 * Everything here is counted from the database rather than written by hand, so
 * the document cannot drift from what actually happened. Where a number is
 * unflattering it still gets printed — a measured figure that undercuts the
 * pitch is worth more than a claim nobody checked.
 */
import Database from 'better-sqlite3'
import { writeFileSync } from 'node:fs'
import { closedWeekdays, nightVsOpen, type MarkSample, type SessionSample } from '../src/record.ts'

const db = new Database(process.env.BELL_DB ?? 'data/bell.db', { readonly: true })
const HALTS = ['None', 'Luld', 'NewsPending', 'MarketWide', 'Suspension', 'Unspecified']

const one = <T>(sql: string, ...a: unknown[]) => db.prepare(sql).get(...a) as T
const many = <T>(sql: string, ...a: unknown[]) => db.prepare(sql).all(...a) as T[]

// A tick writes one row per symbol, so rows and ticks are different counts:
// the first version of this report called 567 ticks of nine symbols "5103
// ticks". Every row of a tick carries the same `at`.
const span = one<{ lo: number; hi: number; n: number; ticks: number }>(
  'SELECT MIN(at) lo, MAX(at) hi, COUNT(*) n, COUNT(DISTINCT at) ticks FROM ticks',
)
if (!span.n) {
  console.error('no ticks recorded yet — run scripts/keeper.ts first')
  process.exit(1)
}

const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`
const iso = (t: number) => new Date(t * 1000).toISOString().replace('T', ' ').slice(0, 19)
const hours = ((span.hi - span.lo) / 3600).toFixed(1)

const perSymbol = many<{
  symbol: string
  issuer: string
  n: number
  open: number
  pushes: number
}>(`SELECT symbol, issuer, COUNT(*) n, SUM(open_now) open, SUM(pushed) pushes
    FROM ticks GROUP BY symbol ORDER BY symbol`)

const byConfidence = many<{ confidence: string; n: number }>(
  'SELECT confidence, COUNT(*) n FROM ticks GROUP BY confidence ORDER BY n DESC',
)

const transitions = many<{
  at: number
  symbol: string
  from_open: number
  to_open: number
  from_halt: number
  to_halt: number
  detail: string
}>('SELECT * FROM transitions ORDER BY at')

/**
 * Ticks where the two session sources disagreed, split by direction. The two
 * directions are different facts and cannot share one caption: an issuer that
 * will not trade while the market does is what a halt looks like, while an
 * issuer trading while the market is shut is a 24/5 wrapper at night, which
 * Backed's tokens are on every weeknight. Counted together, the first
 * version of this report put every overnight tick of five symbols under a
 * caption about halts.
 */
const disagreements = many<{ symbol: string; issuer_out: number; issuer_on: number }>(
  `SELECT symbol,
     SUM(CASE WHEN pyth_open = 1 AND issuer_open = 0 THEN 1 ELSE 0 END) issuer_out,
     SUM(CASE WHEN pyth_open = 0 AND issuer_open = 1 THEN 1 ELSE 0 END) issuer_on
   FROM ticks
   WHERE pyth_open IS NOT NULL AND issuer_open IS NOT NULL AND pyth_open != issuer_open
   GROUP BY symbol ORDER BY issuer_out DESC, issuer_on DESC, symbol`,
)

const refused = one<{ n: number }>('SELECT COUNT(*) n FROM ticks WHERE open_now = 0')

const lines: string[] = []
const w = (s = '') => lines.push(s)

w('# Evidence')
w()
// Say where the log came from. The same generator runs against a local
// validator's log and the hosted keeper's, and those are different claims — a
// header that named the wrong one would be the evidence file lying about itself.
const dbPath = process.env.BELL_DB ?? 'data/bell.db'
const cluster = process.env.BELL_CLUSTER ?? 'localnet'
const where = process.env.RAILWAY_SERVICE_NAME
  ? `the hosted keeper's tick log on ${cluster} (Railway service \`${process.env.RAILWAY_SERVICE_NAME}\`, \`${dbPath}\`)`
  : `\`${dbPath}\` (${cluster})`
w(`Generated from ${where} by \`scripts/evidence.ts\`. Every number below is`)
w('counted from the tick log, not written by hand.')
w()
w(
  `**Observation window:** ${iso(span.lo)} → ${iso(span.hi)} UTC ` +
    `(${hours}h, ${plural(span.ticks, 'tick')}, ${plural(span.n, 'symbol-observation')})`,
)
w()

w('## Per symbol')
w()
w('| symbol | issuer | ticks | tradeable | refused | session pushes |')
w('|---|---|---|---|---|---|')
for (const r of perSymbol) {
  const pct = ((r.open / r.n) * 100).toFixed(0)
  w(`| ${r.symbol} | ${r.issuer} | ${r.n} | ${r.open} (${pct}%) | ${r.n - r.open} | ${r.pushes} |`)
}
w()
w(`Across the window, **${refused.n} of ${span.n}** symbol-observations were not tradeable.`)
w()

w('## Confidence')
w()
w('How much corroboration each verdict had. `degraded` means a single source —')
w('for a non-US listing no `Equity.US.*` Pyth feed exists, so there is nothing to')
w('confirm against and the log says so rather than implying agreement.')
w()
w('| confidence | symbol-observations |')
w('|---|---|')
for (const c of byConfidence) w(`| ${c.confidence} | ${c.n} |`)
w()

w('## Source disagreement')
w()
if (disagreements.length === 0) {
  w('No tick had Pyth and the issuer disagreeing about the session.')
} else {
  w('Ticks where Pyth and the issuer disagreed about whether the session was open,')
  w('in each direction.')
  w()
  w('- **Market open, issuer not trading.** Not noise to be smoothed over: this is')
  w('  how a halt shows up when nobody publishes a reason code. It is not only that,')
  w('  since anything that stops the issuer\'s token during the session reads the')
  w('  same way; the transitions below give the verdict each time it changed.')
  w('- **Market closed, issuer trading.** An issuer whose token trades around the')
  w('  clock while the primary market is shut. Expected every weeknight for a 24/5')
  w('  wrapper, and not a halt; the gate refuses those ticks because the market is')
  w('  closed.')
  w()
  w('| symbol | market open, issuer not trading | market closed, issuer trading |')
  w('|---|---|---|')
  for (const d of disagreements) w(`| ${d.symbol} | ${d.issuer_out} | ${d.issuer_on} |`)
}
w()

w('## Transitions')
w()
if (transitions.length === 0) {
  w('No state change observed in this window.')
} else {
  w('| when (UTC) | symbol | change | reason |')
  w('|---|---|---|---|')
  for (const t of transitions) {
    const open = `${t.from_open ? 'open' : 'closed'} → ${t.to_open ? 'open' : 'closed'}`
    const halt =
      t.from_halt !== t.to_halt ? `, halt ${HALTS[t.from_halt]} → ${HALTS[t.to_halt]}` : ''
    w(`| ${iso(t.at)} | ${t.symbol} | ${open}${halt} | ${t.detail} |`)
  }
}
w()

w('## What a night buyer would have paid')
w()
const signed = (bps: number) => `${bps > 0 ? '+' : ''}${bps.toFixed(1)} bps`
const hasMarks = one<{ n: number }>(
  "SELECT COUNT(*) n FROM sqlite_master WHERE type = 'table' AND name = 'marks'",
).n
const marks = hasMarks
  ? many<MarkSample>('SELECT symbol, observed_at observedAt, price FROM marks ORDER BY observed_at, id')
  : []
if (!hasMarks) {
  w('No overnight data yet: this log predates mark recording.')
} else if (marks.length === 0) {
  w('No overnight data yet: no marks recorded. Only marks that landed on chain')
  w('are recorded, so a dry run adds none.')
} else {
  // One row per tick, saying whether any source had the regular session open
  // or closed. Backed's own flag is left out: its wrapper trades 24/5, so it
  // says open on a holiday. Backpack's flag is its holiday-aware calendar.
  const sessions = many<{ at: number; said_open: number; said_closed: number }>(
    `SELECT at,
       MAX(CASE WHEN pyth_open = 1 OR (issuer = 'backpack' AND issuer_open = 1) THEN 1 ELSE 0 END) said_open,
       MAX(CASE WHEN pyth_open = 0 OR (issuer = 'backpack' AND issuer_open = 0) THEN 1 ELSE 0 END) said_closed
     FROM ticks GROUP BY at`,
  ).map((r): SessionSample => ({ at: r.at, saidOpen: r.said_open === 1, saidClosed: r.said_closed === 1 }))
  const holidays = closedWeekdays(sessions)
  const night = nightVsOpen(marks, holidays)
  const sources = many<{ source: string }>('SELECT DISTINCT source FROM marks ORDER BY source').map((r) => r.source)

  w('Every mark the keeper saw confirmed on chain while the US regular session was')
  w('closed, from 16:00 ET until 09:30 ET on the next trading day, is compared with')
  w("the same symbol's first mark from 09:35 to 10:00 ET that trading morning, five")
  w('minutes in so that the pool has had time to be arbitraged against a market')
  w('that is trading again. A weekend or a holiday is part of the night it falls')
  w('in. On an early-close day the hours from the early close to 16:00 ET are')
  w('left out, counted as neither night nor open. Positive means the night buyer')
  w('would have paid more per share: +50 bps is 0.5% more, so the same dollars')
  w('would have bought about 0.5% fewer shares. The median and the worst are taken')
  w('over every sample, not per night, so a weekend, being longer, weighs more than')
  w('a weeknight.')
  w()
  w('What this measures is what the same dollars would have bought at night against')
  w('at the open: the gap a buyer who traded the pool overnight saw against one who')
  w('waited, which is what BELL makes them do. It includes genuine overnight news')
  w('as well as pool staleness, and nothing here can tell the two apart, so it is')
  w('not a measure of mispricing alone. A mark is an executable quote at a fixed')
  w('reference size, not a fill, and a larger order moves the pool further at any')
  w(`hour. Marks came from: ${sources.join(', ')}.`)
  w()
  w('A night counts for a symbol only when the log covers both ends of it: a mark')
  w('during the regular session before it, and one from 09:35 to 10:00 ET the next')
  w('trading morning. A weekday counts as a holiday only when some tick between')
  w('09:35 and 15:30 ET that day saw the session closed and none saw it open.')
  w()
  if (night.bySymbol.length === 0) {
    w('No complete overnight window in the log yet, so there is no number to print:')
    w(`the ${marks.length} marks recorded so far do not cover any night at both ends.`)
  } else {
    const first = night.nights[0]
    const last = night.nights[night.nights.length - 1]
    w(
      `${plural(night.nights.length, 'night')}, ending at the opens of ` +
        `${first}${first === last ? '' : ` through ${last}`} (ET).`,
    )
    if (holidays.size) w(`Weekday holidays seen in the log: ${[...holidays].sort().join(', ')}.`)
    w()
    w('| symbol | nights | samples | median | worst | direction |')
    w('|---|---|---|---|---|---|')
    for (const r of night.bySymbol) {
      const direction =
        r.medianBps > 0
          ? `dearer at night (${r.paidMore} of ${r.samples})`
          : r.medianBps < 0
            ? `cheaper at night (${r.paidLess} of ${r.samples})`
            : `even (${r.paidMore} dearer, ${r.paidLess} cheaper)`
      w(`| ${r.symbol} | ${r.nights} | ${r.samples} | ${signed(r.medianBps)} | ${signed(r.worstBps)} | ${direction} |`)
    }
  }
  if (night.unmatched > 0) {
    w()
    w(`${plural(night.unmatched, 'overnight mark')} left out because the log did not cover that night at both ends.`)
  }
}
w()

writeFileSync('EVIDENCE.md', lines.join('\n') + '\n')
console.log(
  `EVIDENCE.md written — ${plural(span.ticks, 'tick')} (${plural(span.n, 'symbol-observation')}), ` +
    `${plural(transitions.length, 'transition')}, ${plural(marks.length, 'mark')}`,
)
