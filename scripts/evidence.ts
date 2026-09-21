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

const db = new Database(process.env.BELL_DB ?? 'data/bell.db', { readonly: true })
const HALTS = ['None', 'Luld', 'NewsPending', 'MarketWide', 'Suspension', 'Unspecified']

const one = <T>(sql: string, ...a: unknown[]) => db.prepare(sql).get(...a) as T
const many = <T>(sql: string, ...a: unknown[]) => db.prepare(sql).all(...a) as T[]

const span = one<{ lo: number; hi: number; n: number }>(
  'SELECT MIN(at) lo, MAX(at) hi, COUNT(*) n FROM ticks',
)
if (!span.n) {
  console.error('no ticks recorded yet — run scripts/keeper.ts first')
  process.exit(1)
}

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

/** Ticks where the two session sources disagreed, whatever the verdict was. */
const disagreements = many<{ symbol: string; n: number }>(
  `SELECT symbol, COUNT(*) n FROM ticks
   WHERE pyth_open IS NOT NULL AND issuer_open IS NOT NULL AND pyth_open != issuer_open
   GROUP BY symbol ORDER BY n DESC`,
)

const refused = one<{ n: number }>('SELECT COUNT(*) n FROM ticks WHERE open_now = 0')

const lines: string[] = []
const w = (s = '') => lines.push(s)

w('# Evidence')
w()
w(`Generated from \`data/bell.db\` by \`scripts/evidence.ts\`. Every number below is`)
w('counted from the tick log, not written by hand.')
w()
w(`**Observation window:** ${iso(span.lo)} → ${iso(span.hi)} UTC (${hours}h, ${span.n} ticks)`)
w()

w('## Per symbol')
w()
w('| symbol | issuer | ticks | tradeable | refused | pushes |')
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
w('| confidence | ticks |')
w('|---|---|')
for (const c of byConfidence) w(`| ${c.confidence} | ${c.n} |`)
w()

w('## Source disagreement')
w()
if (disagreements.length === 0) {
  w('No tick had Pyth and the issuer disagreeing about the session.')
} else {
  w('Ticks where Pyth and the issuer disagreed about whether the session was open.')
  w('This is not noise to be smoothed over — it is how a halt shows up when nobody')
  w('publishes a reason code.')
  w()
  w('| symbol | ticks |')
  w('|---|---|')
  for (const d of disagreements) w(`| ${d.symbol} | ${d.n} |`)
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

writeFileSync('EVIDENCE.md', lines.join('\n') + '\n')
console.log(`EVIDENCE.md written — ${span.n} ticks, ${transitions.length} transitions`)
