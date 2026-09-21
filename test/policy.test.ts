import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  evaluate,
  DEFAULT_LIMITS,
  type MarketState,
  type TokenRisk,
  type OracleReading,
  type Order,
} from '../src/policy/session.ts'

const NOW = 1_800_000_000_000

const open: MarketState = { symbol: 'LMT', halted: false, openNow: true, observedAt: NOW - 1_000 }
const closed: MarketState = { ...open, openNow: false }

const clean: TokenRisk = { paused: false, multiplier: 1, pending: null, hook: null }
const fresh: OracleReading = { priceUsd: 100, confUsd: 0.02, publishedAt: NOW - 1_000 }
const good: Order = { venuePriceUsd: 100.1, priceImpact: 0.001 }

const run = (o: Partial<Parameters<typeof evaluate>[0]> = {}) =>
  evaluate({ mode: 'strict', now: NOW, state: open, risk: clean, oracle: fresh, order: good, ...o })

test('a clean order during regular hours fills', () => {
  const d = run()
  assert.equal(d.allow, true)
  assert.equal(d.reason, 'ok')
})

test('a halt on the primary exchange stops the trade (SEC 34-106402 II.H)', () => {
  const d = run({ state: { ...open, halted: true } })
  assert.equal(d.allow, false)
  assert.equal(d.reason, 'halted')
})

test('a halt outranks every other condition', () => {
  // Even with a perfect order and open market, halted wins.
  const d = run({ state: { ...open, halted: true }, order: { venuePriceUsd: 100, priceImpact: 0 } })
  assert.equal(d.reason, 'halted')
})

test('stale session state is treated as a halt, not as open', () => {
  const d = run({ state: { ...open, observedAt: NOW - DEFAULT_LIMITS.maxStateAgeMs - 1 } })
  assert.equal(d.allow, false)
  assert.equal(d.reason, 'state_stale')
})

test('strict mode refuses to trade while the primary market is closed', () => {
  const d = run({ state: closed })
  assert.equal(d.allow, false)
  assert.equal(d.reason, 'primary_closed')
})

test('guarded mode will trade off-hours when everything else is sound', () => {
  const d = run({ mode: 'guarded', state: closed })
  assert.equal(d.allow, true)
})

test('an issuer pause blocks the trade', () => {
  const d = run({ risk: { ...clean, paused: true } })
  assert.equal(d.reason, 'issuer_paused')
})

test('no fills inside the rebase activation window', () => {
  const d = run({
    risk: { ...clean, pending: { next: 1.004, activatesAtMs: NOW + 60_000, kind: 'dividend' } },
  })
  assert.equal(d.allow, false)
  assert.equal(d.reason, 'rebase_pending')
})

test('the rebase window is symmetric — just after activation is still guarded', () => {
  const d = run({
    risk: { ...clean, pending: { next: 1.004, activatesAtMs: NOW - 60_000, kind: 'dividend' } },
  })
  assert.equal(d.reason, 'rebase_pending')
})

test('a far-off classified rebase does not block trading', () => {
  const d = run({
    risk: { ...clean, pending: { next: 10, activatesAtMs: NOW + 86_400_000, kind: 'split' } },
  })
  assert.equal(d.allow, true)
})

test('an unclassified corporate action is never tradeable, however far away', () => {
  const d = run({
    risk: { ...clean, pending: { next: 1.004, activatesAtMs: NOW + 86_400_000, kind: 'unknown' } },
  })
  assert.equal(d.allow, false)
  assert.equal(d.reason, 'rebase_unclassified')
})

test('an armed transfer hook aborts', () => {
  const d = run({ risk: { ...clean, hook: 'HookPr0gram11111111111111111111111111111111' } })
  assert.equal(d.reason, 'hook_changed')
})

test('a missing oracle is a refusal, not a pass', () => {
  const d = run({ oracle: null })
  assert.equal(d.allow, false)
  assert.equal(d.reason, 'oracle_stale')
})

test('a stale oracle is a refusal', () => {
  const d = run({ oracle: { ...fresh, publishedAt: NOW - DEFAULT_LIMITS.maxOracleAgeMs - 1 } })
  assert.equal(d.reason, 'oracle_stale')
})

test('a wide confidence interval is a refusal', () => {
  const d = run({ oracle: { ...fresh, confUsd: 1 } }) // 100bps
  assert.equal(d.reason, 'oracle_uncertain')
})

test('the 95% fill is refused on price impact', () => {
  const d = run({ order: { venuePriceUsd: 100.1, priceImpact: 0.954 } })
  assert.equal(d.allow, false)
  assert.equal(d.reason, 'impact_too_high')
})

test('a venue price far from the oracle is refused before impact is considered', () => {
  const d = run({ order: { venuePriceUsd: 130, priceImpact: 0.001 } })
  assert.equal(d.reason, 'basis_too_wide')
})

test('off-hours bands are wider, but not infinite', () => {
  const drifted: Order = { venuePriceUsd: 102.5, priceImpact: 0.001 } // 250bps
  // Rejected during regular hours (100bps band)...
  assert.equal(run({ order: drifted }).reason, 'basis_too_wide')
  // ...accepted off-hours (300bps band), where no arbitrage is expected.
  assert.equal(run({ mode: 'guarded', state: closed, order: drifted }).allow, true)
  // But a genuinely dislocated price is still refused.
  const wild: Order = { venuePriceUsd: 140, priceImpact: 0.001 }
  assert.equal(run({ mode: 'guarded', state: closed, order: wild }).reason, 'basis_too_wide')
})
