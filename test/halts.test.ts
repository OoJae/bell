import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { isActive, parseHalts, HaltKind } from '../src/sensor/halts.ts'

// Nasdaq's UTP halt feed as published on the evening of 2026-09-22, verbatim.
// Newest first: JAGX was paused eight times that day.
const feed = readFileSync(new URL('./fixtures/tradehalts-2026-09-22.xml', import.meta.url), 'utf8')
const et = (hms: string) => Date.parse(`2026-09-22T${hms}-04:00`) / 1000

test('a stock halted repeatedly is judged by its latest halt, not its first', () => {
  const halts = parseHalts(feed)
  const jagx = halts.get('JAGX')!
  assert.equal(jagx.haltedAt, et('14:54:49'))
  assert.equal(jagx.resumesAt, et('14:59:49'))
  assert.equal(jagx.kind, HaltKind.Luld)
  // Mid-way through the last pause it is halted. Keeping the first row of the
  // day — resumed at 12:41 — read this as trading.
  assert.equal(isActive(jagx, et('14:56:00')), true)
  assert.equal(isActive(jagx, et('15:00:00')), false)
})

test('every ticker in the feed resolves to exactly its newest row', () => {
  const halts = parseHalts(feed)
  const rows = [...feed.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(([, item]) => item)
  assert.equal(rows.length, 49)
  for (const [ticker, h] of halts) {
    const times = rows
      .filter((r) => r.includes(`<ndaq:IssueSymbol>${ticker}</ndaq:IssueSymbol>`))
      .map((r) => /<ndaq:HaltTime>([^<]*)</.exec(r)![1].split('.')[0])
    assert.ok(times.length >= 1, ticker)
    const newest = times.sort().at(-1)!
    assert.equal(new Date(h.haltedAt * 1000).toLocaleTimeString('en-GB', { timeZone: 'America/New_York' }), newest, ticker)
  }
})
