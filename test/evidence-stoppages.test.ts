import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Recorder, type TickRow } from '../src/record.ts'
import {
  duration,
  renderStoppages,
  stoppages,
  type SymbolSpan,
  type TransitionIn,
} from '../scripts/evidence.ts'

const at = (iso: string) => Date.parse(`${iso}Z`) / 1000

const WITHDRAWN = 'issuer has withdrawn this token; the underlying is not exchange-halted'
const CONFLICT = 'session is open but the issuer will not trade this security'
const EXCHANGE = 'halted on the primary listing exchange'
const OPEN = 'session open, issuer trading'
const NIGHT = 'issuer is open 24/5 but the primary market is closed'

// Monday 21 September 2026, in UTC: the bell at 13:30 and 20:00.
const spans: SymbolSpan[] = [
  { symbol: 'SPYx', firstAt: at('2026-09-21T13:30:00'), firstHalt: 0, firstDetail: OPEN, firstSignature: null, lastAt: at('2026-09-22T14:00:00') },
  { symbol: 'IWMx', firstAt: at('2026-09-21T13:30:00'), firstHalt: 5, firstDetail: WITHDRAWN, firstSignature: 'IwmFirstSig111', lastAt: at('2026-09-22T14:00:00') },
  { symbol: 'NVDAx', firstAt: at('2026-09-21T13:30:00'), firstHalt: 0, firstDetail: OPEN, firstSignature: null, lastAt: at('2026-09-22T14:00:00') },
]

const move = (
  symbol: string,
  when: string,
  prev: string,
  from: [boolean, number],
  to: [boolean, number],
  detail: string,
  signature: string | null = null,
): TransitionIn => ({
  at: at(when),
  symbol,
  fromOpen: from[0],
  fromHalt: from[1],
  toOpen: to[0],
  toHalt: to[1],
  detail,
  prevAt: at(prev),
  signature,
})

const transitions: TransitionIn[] = [
  // An exchange volatility pause mid-session, and the resume.
  move('NVDAx', '2026-09-21T15:00:45', '2026-09-21T15:00:00', [true, 0], [false, 1], EXCHANGE, 'NvdaHaltSig111'),
  move('NVDAx', '2026-09-21T15:05:30', '2026-09-21T15:04:45', [false, 1], [true, 0], OPEN, 'NvdaResumeSig1'),
  // The close of 21 September as the README tells it: the issuer stops before
  // the bell while Pyth still says open, then Pyth closes and the issuer's 24/5
  // wrapper reopens — the stop lifts into a closed market.
  move('SPYx', '2026-09-21T19:55:38', '2026-09-21T19:54:51', [true, 0], [false, 5], CONFLICT, 'SpyStopSig1111'),
  move('SPYx', '2026-09-21T20:00:17', '2026-09-21T19:59:31', [false, 5], [false, 0], NIGHT, 'SpyLiftSig1111'),
  // NVDAx simply closes at the bell: an ordinary close, not a stoppage.
  move('NVDAx', '2026-09-21T20:00:17', '2026-09-21T19:59:31', [true, 0], [false, 0], NIGHT),
  // And both reopen the next morning.
  move('SPYx', '2026-09-22T13:30:12', '2026-09-22T13:29:27', [false, 0], [true, 0], OPEN),
  move('NVDAx', '2026-09-22T13:30:12', '2026-09-22T13:29:27', [false, 0], [true, 0], OPEN),
]

test('every halt interval is a stoppage, including one in force before the first tick; closes are not', () => {
  const r = stoppages(spans, transitions)
  assert.deepEqual(
    r.stoppages.map((s) => [s.symbol, s.kinds, s.start, s.end]),
    [
      ['IWMx', [5], at('2026-09-21T13:30:00'), null],
      ['NVDAx', [1], at('2026-09-21T15:00:45'), at('2026-09-21T15:05:30')],
      ['SPYx', [5], at('2026-09-21T19:55:38'), at('2026-09-21T20:00:17')],
    ],
  )
  const [iwm, nvda, spy] = r.stoppages
  assert.equal(iwm.startAfter, null, 'in force at its first tick, so its true start is earlier')
  assert.deepEqual(iwm.reasons, [WITHDRAWN])
  assert.equal(iwm.lastSeen, at('2026-09-22T14:00:00'))

  assert.equal(nvda.startAfter, at('2026-09-21T15:00:00'))
  assert.equal(nvda.endAfter, at('2026-09-21T15:04:45'))
  assert.equal(nvda.resumedOpen, true)
  assert.equal(nvda.endReason, OPEN)
  assert.equal(nvda.startSignature, 'NvdaHaltSig111')
  assert.equal(nvda.endSignature, 'NvdaResumeSig1')

  assert.equal(spy.resumedOpen, false, 'lifted into a closed market, so trading did not resume')
  assert.deepEqual(spy.reasons, [CONFLICT])

  // The bell at 20:00 closed NVDAx without a halt: counted, and kept apart.
  assert.deepEqual([...r.ordinaryCloses], [['SPYx', 0], ['IWMx', 0], ['NVDAx', 1]])
})

test('a change of halt kind inside one stoppage stays one stoppage, with both kinds and reasons', () => {
  const r = stoppages(spans.slice(0, 1), [
    move('SPYx', '2026-09-21T15:00:45', '2026-09-21T15:00:00', [true, 0], [false, 5], CONFLICT),
    move('SPYx', '2026-09-21T15:01:30', '2026-09-21T15:00:45', [false, 5], [false, 1], EXCHANGE),
    move('SPYx', '2026-09-21T15:10:00', '2026-09-21T15:09:15', [false, 1], [true, 0], OPEN),
  ])
  assert.equal(r.stoppages.length, 1)
  assert.deepEqual(r.stoppages[0].kinds, [5, 1])
  assert.deepEqual(r.stoppages[0].reasons, [CONFLICT, EXCHANGE])
  assert.equal(r.stoppages[0].end, at('2026-09-21T15:10:00'))
})

test('the rendered record says when, why, how long, how it ended, and where it was attested', () => {
  const lines = renderStoppages(stoppages(spans, transitions), 'devnet')
  assert.equal(lines[0], '## Stoppages')
  // The record's rows have eight columns; the summary's four.
  const row = (sym: string) => lines.find((l) => l.startsWith(`| ${sym} | `) && l.split('|').length === 10)!
  assert.equal(
    row('NVDAx'),
    '| NVDAx | Luld | halted on the primary listing exchange | 2026-09-21 15:00:00 – 15:00:45 | ' +
      '2026-09-21 15:04:45 – 15:05:30 | 4m 45s | trading resumed: session open, issuer trading | ' +
      '[NvdaHalt…](https://explorer.solana.com/tx/NvdaHaltSig111?cluster=devnet) → ' +
      '[NvdaResu…](https://explorer.solana.com/tx/NvdaResumeSig1?cluster=devnet) |',
  )
  assert.ok(row('SPYx').includes('| 4m 39s | lifted with the market closed: issuer is open 24/5'))
  assert.ok(row('IWMx').includes('in force at its first tick, 2026-09-21 13:30:00'))
  assert.ok(row('IWMx').includes('not in the log; still in force at 2026-09-22 14:00:00'))
  assert.ok(row('IWMx').includes('| at least 1d 0h |'))

  // The summary keeps ordinary closes in their own column.
  assert.ok(lines.includes('| NVDAx | 1 | 4m 45s | 1 |'))
  assert.ok(lines.includes('| IWMx | 1 | at least 1d 0h | 0 |'))
  assert.ok(lines.includes('| SPYx | 1 | 4m 39s | 0 |'))
})

test('a quiet log says so, and still counts its closes', () => {
  const quiet = spans.filter((s) => s.symbol !== 'IWMx')
  const lines = renderStoppages(stoppages(quiet, transitions.filter((t) => t.symbol === 'NVDAx' && t.toHalt === 0 && t.fromHalt === 0)), 'devnet')
  assert.ok(lines.includes('No stoppage in this window: no tick attested a halt for any symbol.'))
  assert.ok(lines.includes('| NVDAx | 0 | — | 1 |'))
})

test('durations read at the scale that matters', () => {
  assert.equal(duration(42), '42s')
  assert.equal(duration(279), '4m 39s')
  assert.equal(duration(2 * 3600 + 5 * 60), '2h 05m')
  assert.equal(duration(3 * 86_400 + 4 * 3600 + 59), '3d 4h')
})

// --------------------------------------------------------------- end to end

test('the report prints the stoppage record between the transitions and the night buyer, and keeps the rest', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'bell-evidence-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const db = join(dir, 'bell.db')
  const rec = new Recorder(db)
  const row = (symbol: string, when: number, openNow: boolean, halt: number, detail: string, sig: string | null): TickRow => ({
    at: when,
    symbol,
    mint: `${symbol}-mint`,
    issuer: 'backed',
    openNow,
    halt,
    confidence: 'confirmed',
    detail,
    pythOpen: true,
    issuerOpen: openNow,
    issuerHalted: halt === 5 && detail === WITHDRAWN,
    exchangeHalt: null,
    pushed: sig !== null,
    signature: sig,
  })
  rec.record([row('SPYx', at('2026-09-21T19:54:51'), true, 0, OPEN, 'TickOneSig111'), row('IWMx', at('2026-09-21T19:54:51'), false, 5, WITHDRAWN, 'TickOneSig111')])
  rec.record([row('SPYx', at('2026-09-21T19:55:38'), false, 5, CONFLICT, 'TickTwoSig111'), row('IWMx', at('2026-09-21T19:55:38'), false, 5, WITHDRAWN, 'TickTwoSig111')])
  rec.record([row('SPYx', at('2026-09-21T20:00:17'), false, 0, NIGHT, 'TickThreeSig1'), row('IWMx', at('2026-09-21T20:00:17'), false, 5, WITHDRAWN, null)])
  rec.close()

  const out = execFileSync(process.execPath, [new URL('../scripts/evidence.ts', import.meta.url).pathname], {
    cwd: dir,
    env: { ...process.env, BELL_DB: db, BELL_CLUSTER: 'devnet', RAILWAY_SERVICE_NAME: '' },
    encoding: 'utf8',
  })
  assert.match(out, /3 ticks \(6 symbol-observations\), 2 transitions, 2 stoppages, 0 marks/)
  const md = readFileSync(join(dir, 'EVIDENCE.md'), 'utf8')
  const order = ['# Evidence', '## Per symbol', '## Confidence', '## Source disagreement', '## Transitions', '## Stoppages', '## What a night buyer would have paid']
  const positions = order.map((h) => md.indexOf(`${h}\n`))
  assert.ok(positions.every((p) => p >= 0), `every section present: ${positions}`)
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b), 'in that order')
  assert.ok(
    md.includes(
      '| SPYx | Unspecified | session is open but the issuer will not trade this security | ' +
        '2026-09-21 19:54:51 – 19:55:38 | 2026-09-21 19:55:38 – 20:00:17 | 4m 39s | ' +
        'lifted with the market closed: issuer is open 24/5 but the primary market is closed | ' +
        '[TickTwoS…](https://explorer.solana.com/tx/TickTwoSig111?cluster=devnet) → ' +
        '[TickThre…](https://explorer.solana.com/tx/TickThreeSig1?cluster=devnet) |',
    ),
  )
  assert.ok(md.includes('| IWMx | Unspecified | issuer has withdrawn this token; the underlying is not exchange-halted | in force at its first tick, 2026-09-21 19:54:51 |'))
})
