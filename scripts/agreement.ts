/**
 * Do the issuer and Pyth agree on whether each listing can trade right now?
 *
 *   node scripts/agreement.ts        # run during US market hours
 *
 * Read-only. Every Backed xStock's issuer state against Pyth's free US-equity
 * session for its underlying, written to docs/agreement-<time>.json so the
 * number in the README has a file behind it. Run it mid-session: from about
 * 15:55 ET the issuer stops before the bell and Pyth stops after it, so the
 * two disagree across the board for a few minutes — which is its own finding
 * (README, "The close"), not this one.
 *
 * The disagreements are the point. Where Pyth says the session is open and
 * the issuer will not trade a name, the issuer has withdrawn that token.
 */
import { writeFileSync } from 'node:fs'
import { fetchUniverse } from '../src/sensor/xstocks.ts'
import { fetchEquitySessions } from '../src/sensor/pyth.ts'

const at = new Date().toISOString()
const [universe, pyth] = await Promise.all([fetchUniverse(), fetchEquitySessions()])

const rows = universe.map((x) => {
  const feed = pyth.get(x.underlyingSymbol ?? '')
  return {
    symbol: x.symbol,
    underlying: x.underlyingSymbol,
    exchange: x.exchangeMic,
    issuerOpen: x.openNow,
    issuerHalted: x.halted,
    pythOpen: feed ? feed.isOpen : null,
  }
})
// Non-US listings have no Equity.US feed at all; their absence is expected.
const withFeed = rows.filter((r) => r.pythOpen !== null)
const tradeable = (r: (typeof rows)[number]) => r.issuerOpen && !r.issuerHalted
const disagree = withFeed.filter((r) => r.pythOpen !== tradeable(r))

const out = {
  at,
  finishedAt: new Date().toISOString(),
  listings: rows.length,
  withPythFeed: withFeed.length,
  noPythFeed: rows.length - withFeed.length,
  agree: withFeed.length - disagree.length,
  disagree: disagree.length,
  disagreements: disagree,
  rows,
}
const path = `docs/agreement-${at.slice(0, 16).replace(':', '-')}Z.json`
writeFileSync(path, JSON.stringify(out, null, 1))
console.log(`${out.agree} of ${out.withPythFeed} agree; ${out.noPythFeed} have no US feed -> ${path}`)
for (const d of disagree) {
  console.log(`  ${d.symbol.padEnd(8)} pyth open=${d.pythOpen}  issuer open=${d.issuerOpen} withdrawn=${d.issuerHalted}`)
}
