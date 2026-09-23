/**
 * The liquidity census.
 *
 * Establishes, from primary sources only, the claim BELL is built on: tokenized
 * equities on Solana are an asset class with ~900 listings and ~20 markets.
 * Writes a timestamped snapshot so every number in the pitch is reproducible.
 *
 *   node scripts/measure.ts
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { fetchUniverse } from '../src/sensor/xstocks.ts'
import { fetchTokens, quote, usdc, USDC, type JupToken } from '../src/sensor/jupiter.ts'

const PROBE_USD = 1000

const n = (x: number) => x.toLocaleString('en-US')
const usd = (x: number) => `$${n(Math.round(x))}`
const pct = (x: number) => `${(x * 100).toFixed(1)}%`

async function main() {
  const at = new Date().toISOString()
  console.log(`BELL liquidity census — ${at}\n`)

  const universe = await fetchUniverse()
  const jup = await fetchTokens(universe.map((x) => x.mint))
  const rows = universe.map((x) => ({ ...x, jup: jup.get(x.mint) }))

  const liq = (t?: JupToken) => t?.liquidity ?? 0
  const buyers = (t?: JupToken) => t?.stats24h?.numOrganicBuyers ?? 0

  const totalLiq = rows.reduce((a, r) => a + liq(r.jup), 0)
  const byLiq = [...rows].sort((a, b) => liq(b.jup) - liq(a.jup))
  const top20 = byLiq.slice(0, 20).reduce((a, r) => a + liq(r.jup), 0)
  const totalBuyers = rows.reduce((a, r) => a + buyers(r.jup), 0)
  const reported = rows.reduce((a, r) => a + (r.jup?.stats24h?.buyVolume ?? 0), 0)
  const organic = rows.reduce((a, r) => a + (r.jup?.stats24h?.buyOrganicVolume ?? 0), 0)

  console.log('## The asset class')
  console.log(`  listings on Solana            ${n(rows.length)}`)
  console.log(`  total on-chain liquidity      ${usd(totalLiq)}`)
  console.log(`  held by the top 20 names      ${pct(top20 / totalLiq)}`)
  console.log(`  listings under $1,000 depth   ${n(rows.filter((r) => liq(r.jup) < 1_000).length)}`)
  console.log(`  zero organic buyers in 24h    ${n(rows.filter((r) => buyers(r.jup) === 0).length)}`)
  console.log(`  organic buyers, entire class  ${n(totalBuyers)}`)
  console.log(`  reported volume that's real   ${pct(organic / reported)}`)

  console.log('\n## Market state right now (the input no Solana app reads)')
  // Backed's `isTradingHalted` is Backed stopping its own token, not a report
  // of a halt on the primary exchange: IWMx and JPSTx carried it when neither
  // IWM nor JPST was halted on its exchange. The label names the source, not a
  // cause the flag does not state. The JSON keys below stay `halted` so
  // snapshots from before this label still line up.
  const halted = rows.filter((r) => r.halted)
  const modes = new Map<string, number>()
  for (const r of rows) modes.set(r.hoursMode ?? 'unknown', (modes.get(r.hoursMode ?? 'unknown') ?? 0) + 1)
  console.log(`  stopped by the issuer (isTradingHalted)   ${halted.length}` +
    (halted.length ? `  → ${halted.map((h) => h.symbol).join(', ')}` : ''))
  console.log(`  session modes in use                      ${[...modes].map(([k, v]) => `${k}=${v}`).join('  ')}`)
  console.log(`  issuance/redemption open now              ${rows.filter((r) => (r.maxOrderUsdNow ?? 0) > 0).length} of ${rows.length}`)

  // What a $1,000 order actually costs, across the liquidity spectrum.
  console.log(`\n## Executable cost of a ${usd(PROBE_USD)} buy`)
  const probes = [...byLiq.slice(0, 6), ...byLiq.slice(20, 24), ...byLiq.slice(60, 66)]
  const results: Array<{ symbol: string; depth: number; impact: number | null }> = []
  for (const p of probes) {
    const q = await quote(USDC, p.mint, usdc(PROBE_USD))
    results.push({ symbol: p.symbol, depth: liq(p.jup), impact: q ? q.priceImpact : null })
    const verdict = q === null ? 'NO ROUTE' : `${(q.priceImpact * 100).toFixed(2)}% impact`
    console.log(`  ${p.symbol.padEnd(10)} depth ${usd(liq(p.jup)).padStart(12)}   ${verdict}`)
  }

  mkdirSync('data/snapshots', { recursive: true })
  const file = `data/snapshots/census-${at.replace(/[:.]/g, '-')}.json`
  writeFileSync(
    file,
    JSON.stringify(
      {
        at,
        totals: { listings: rows.length, liquidityUsd: totalLiq, organicBuyers24h: totalBuyers },
        halted: halted.map((h) => ({ symbol: h.symbol, mint: h.mint, exchange: h.exchangeMic })),
        probes: results,
        rows: rows.map((r) => ({
          symbol: r.symbol,
          mint: r.mint,
          underlying: r.underlyingSymbol,
          halted: r.halted,
          period: r.period,
          hoursMode: r.hoursMode,
          exchangeMic: r.exchangeMic,
          minOrderUsd: r.minOrderUsd,
          maxOrderUsdNow: r.maxOrderUsdNow,
          liquidityUsd: liq(r.jup),
          holders: r.jup?.holderCount ?? 0,
          organicBuyers24h: buyers(r.jup),
        })),
      },
      null,
      1,
    ),
  )
  console.log(`\nsnapshot → ${file}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
