import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import test from 'node:test'
import { Keypair, PublicKey, type Connection } from '@solana/web3.js'
import {
  breakerTripped,
  BREAKER_CONF_BPS,
  decide,
  markFromQuote,
  ondoFeed,
  packInstructions,
  tick,
  TX_LIMIT,
  txBytes,
  type Observation,
} from '../src/chain/keeper.ts'
import { ixPushMark, ixPushSession, ixRefreshTokenRisk } from '../src/chain/client.ts'
import { MarkSource } from '../src/chain/codec.ts'
import { ALLOWLIST } from '../src/config.ts'
import mirrors from '../src/mirrors.json' with { type: 'json' }
import { LISTINGS, listingsFor, type Listing } from '../src/listings.ts'
import { OndoFeed, parseOndoAssets, type OndoAsset, type OndoSnapshot } from '../src/sensor/ondo.ts'
import type { PythSession } from '../src/sensor/pyth.ts'
import { HaltState } from '../src/policy/reconcile.ts'

// The five Ondo rows, and one row BELL does not list, as app.ondo.finance
// served them at 2026-09-24T16:44Z (regular session), trimmed to the fields
// the sensor reads plus two it ignores. The real body was 3.0 MB.
const LIVE = {
  lastUpdatedAt: '2026-09-24T16:43:49.419Z',
  assets: [
    ...['SPY', 'QQQ', 'AAPL', 'NVDA', 'TSLA'].map((t) => ({
      symbol: `${t}on`,
      ticker: t,
      isTradingPaused: false,
      isOffhoursTradable: true,
      assetTradingStatus: {
        isAssetTradeable: true,
        assetPauseReason: null,
        isMarketOpen: true,
        currentSession: 'regular',
        nextMarketOpen: '2026-09-24T20:01:00Z',
        isOffhoursTradable: true,
      },
    })),
    {
      symbol: 'USDY',
      ticker: null,
      isTradingPaused: false,
      assetTradingStatus: {
        isAssetTradeable: false,
        assetPauseReason: null,
        isMarketOpen: true,
        currentSession: 'regular',
        nextMarketOpen: '2026-09-24T20:01:00Z',
        isOffhoursTradable: false,
      },
    },
  ],
}
const RECEIVED = Date.parse('2026-09-24T16:44:25Z')
const ONDO = LISTINGS.filter((l) => l.issuer === 'ondo')
const WANT = new Set(ONDO.map((l) => l.symbol))

// ------------------------------------------------------------- the listings

test('five Ondo listings, pinned by the mainnet addresses the program tests read', () => {
  assert.deepEqual(
    ONDO.map((l) => [l.symbol, l.mint, l.underlying, l.exchangeMic]),
    [
      ['SPYon', 'k18WJUULWheRkSpSquYGdNNmtuE2Vbw1hpuUi92ondo', 'SPY', 'ARCX'],
      ['QQQon', 'HrYNm6jTQ71LoFphjVKBTdAE4uja7WsmLG8VxB8ondo', 'QQQ', 'XNAS'],
      ['AAPLon', '123mYEnRLM2LLYsJW3K6oyYh8uP1fngj732iG638ondo', 'AAPL', 'XNAS'],
      ['NVDAon', 'gEGtLTPNQ7jcg25zTetkbmF7teoDLcrfTnQfmn2ondo', 'NVDA', 'XNAS'],
      ['TSLAon', 'KeGv7bsfR4MheC1CkmnAVceoApjrkvBhHYjWb67ondo', 'TSLA', 'XNAS'],
    ],
  )
  // Each is the same security as a Backed listing, and names the same venue.
  for (const o of ONDO) {
    const backed = LISTINGS.find((l) => l.issuer === 'backed' && l.underlying === o.underlying)
    assert.equal(o.exchangeMic, backed?.exchangeMic, o.symbol)
    assert.equal(o.mainnetMint, o.mint)
    assert.match(o.note, /not offered to US persons/)
    assert.match(o.note, /Ondo's public web-app status/)
  }
})

test('devnet lists an Ondo name only once its mirror is recorded; the first nine stay strict', () => {
  const all = LISTINGS.map((l) => l.symbol)
  const nine = LISTINGS.filter((l) => l.issuer !== 'ondo').map((l) => l.symbol)
  assert.deepEqual(listingsFor('mainnet', {}).map((l) => l.symbol), all)
  assert.deepEqual(listingsFor('localnet', {}).map((l) => l.symbol), all)
  assert.deepEqual(listingsFor('devnet', {}).map((l) => l.symbol), nine)
  assert.deepEqual(listingsFor('devnet', { SPYon: 'x' }).map((l) => l.symbol), [...nine, 'SPYon'])
  // Only the flagged listings can be left out: an original name with no
  // mirror is still passed through, for config.ts to refuse.
  assert.ok(LISTINGS.filter((l) => l.devnetWhenMirrored).every((l) => l.issuer === 'ondo'))
})

/** This environment pointed at devnet. The page's variable wins over ours, so it goes, not blank. */
function devnetEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, BELL_CLUSTER: 'devnet' }
  delete env.NEXT_PUBLIC_BELL_CLUSTER
  return env
}

test('config.ts still starts on devnet with the committed mirrors, and lists the nine', () => {
  // A fresh process, because the cluster is read once at import.
  const out = execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      "const { ALLOWLIST } = await import('./src/config.ts'); console.log(ALLOWLIST.map((l) => l.symbol).join(','))",
    ],
    { env: devnetEnv(), encoding: 'utf8' },
  ).trim()
  const symbols = out.split(',')
  // Whatever mirrors.json holds when this runs: an Ondo name is listed exactly
  // when its mirror is, so the test holds before and after the lead adds them.
  for (const o of ONDO) assert.equal(symbols.includes(o.symbol), o.symbol in mirrors, o.symbol)
  assert.ok(['SPYx', 'NVDAx', 'QQQx', 'TSLAx', 'AAPLx', 'IWMx', 'JPSTx', 'PFE', 'LMT'].every((s) => symbols.includes(s)))
})

// ---------------------------------------------------------------- the sensor

test('the live list parses to the five wanted rows, keyed by Ondo symbol', () => {
  const s = parseOndoAssets(LIVE, RECEIVED, WANT)
  assert.deepEqual([...s.assets.keys()], ['SPYon', 'QQQon', 'AAPLon', 'NVDAon', 'TSLAon'])
  assert.deepEqual(s.assets.get('SPYon'), {
    symbol: 'SPYon',
    ticker: 'SPY',
    paused: false,
    pauseReason: null,
    tradeable: true,
    marketOpen: true,
    session: 'regular',
  } satisfies OndoAsset)
  assert.deepEqual(s.dropped, [])
  // Ondo's own stamp, 36s before it arrived, is what the reading is as of.
  assert.equal(s.asOf, Date.parse(LIVE.lastUpdatedAt))
})

test('a stamp ahead of our clock buys no extra life; a missing one means when it arrived', () => {
  assert.equal(parseOndoAssets({ ...LIVE, lastUpdatedAt: '2030-01-01T00:00:00Z' }, RECEIVED, WANT).asOf, RECEIVED)
  assert.equal(parseOndoAssets({ assets: LIVE.assets }, RECEIVED, WANT).asOf, RECEIVED)
  assert.equal(parseOndoAssets({ ...LIVE, lastUpdatedAt: 'yesterday' }, RECEIVED, WANT).asOf, RECEIVED)
})

test('a pause flag or any pause reason reads as paused, and the reason is kept on one line', () => {
  const rows = structuredClone(LIVE)
  rows.assets[0].isTradingPaused = true
  ;(rows.assets[1].assetTradingStatus as { assetPauseReason: unknown }).assetPauseReason = 'corporate\n  action'
  ;(rows.assets[2].assetTradingStatus as { assetPauseReason: unknown }).assetPauseReason = { code: 7 }
  ;(rows.assets[3].assetTradingStatus as { assetPauseReason: unknown }).assetPauseReason = '  '
  const s = parseOndoAssets(rows, RECEIVED, WANT)
  assert.equal(s.assets.get('SPYon')?.paused, true)
  assert.equal(s.assets.get('SPYon')?.pauseReason, null)
  assert.equal(s.assets.get('QQQon')?.paused, true)
  assert.equal(s.assets.get('QQQon')?.pauseReason, 'corporate action')
  assert.equal(s.assets.get('AAPLon')?.pauseReason, '{"code":7}')
  // Blank is not a reason.
  assert.equal(s.assets.get('NVDAon')?.paused, false)
})

test('a wanted row missing a flag is dropped, not read as unpaused; other rows are untouched', () => {
  const rows = structuredClone(LIVE) as { assets: Record<string, unknown>[] }
  delete rows.assets[0].isTradingPaused
  delete (rows.assets[4].assetTradingStatus as Record<string, unknown>).isAssetTradeable
  const s = parseOndoAssets(rows, RECEIVED, WANT)
  assert.deepEqual([...s.assets.keys()], ['QQQon', 'AAPLon', 'NVDAon'])
  assert.deepEqual(s.dropped, ['SPYon', 'TSLAon'])
})

test('a body that is not the list is an error, not an empty reading', () => {
  assert.throws(() => parseOndoAssets({ error: 'rate limited' }, RECEIVED, WANT))
  assert.throws(() => parseOndoAssets([], RECEIVED, WANT))
})

// ------------------------------------------------------------------ the cache

const snapshot = (asOf: number): OndoSnapshot => ({ ...parseOndoAssets(LIVE, asOf, WANT), asOf })

test('the cache answers at once, and a reading older than ten minutes is no reading', async () => {
  let now = RECEIVED
  const feed = new OndoFeed({ load: async () => snapshot(RECEIVED), now: () => now })
  assert.deepEqual(feed.reading(), { error: 'no reading yet' })
  await feed.refresh()
  assert.equal(feed.reading().assets?.size, 5)
  now = RECEIVED + 10 * 60_000
  assert.equal(feed.reading().assets?.size, 5, 'exactly ten minutes is still a reading')
  now += 1_000
  const r = feed.reading()
  assert.equal(r.assets, undefined)
  assert.match(r.error ?? '', /^last reading 601s old, limit 600s$/)
})

test('a failed read keeps the last one until it ages out, then says why', async (t) => {
  t.mock.method(console, 'warn', () => {})
  let now = RECEIVED
  let fail = false
  const feed = new OndoFeed({
    load: async () => {
      if (fail) throw new Error('ondo assets: HTTP 503')
      return snapshot(now)
    },
    now: () => now,
  })
  await feed.refresh()
  fail = true
  now += 5 * 60_000
  await feed.refresh()
  assert.equal(feed.reading().assets?.size, 5, 'five minutes old and still usable')
  now += 5 * 60_000 + 1
  assert.match(feed.reading().error ?? '', /old, limit 600s; ondo assets: HTTP 503$/)
  fail = false
  await feed.refresh()
  assert.equal(feed.reading().assets?.size, 5)
})

test('one read at a time, and start() never waits for it', async () => {
  let loads = 0
  let release: () => void = () => {}
  const gate = new Promise<void>((r) => (release = r))
  const feed = new OndoFeed({
    load: async () => {
      loads++
      await gate
      return snapshot(Date.now())
    },
  })
  feed.start()
  feed.start()
  assert.deepEqual(feed.reading(), { error: 'no reading yet' }, 'start returned before the read finished')
  const again = feed.refresh()
  assert.equal(loads, 1)
  release()
  await again
  assert.equal(feed.reading().assets?.size, 5)
  feed.stop()
})

// ------------------------------------------------------------ decide(): ondo

const IN_SESSION = new Date('2026-09-24T15:00:00Z') // Thu 11:00 EDT

function obs(ondo: Map<string, OndoAsset> | null, extra: Partial<Observation> = {}): Observation {
  return {
    at: IN_SESSION,
    xstocks: new Map(),
    pyth: new Map(
      LISTINGS.map((l): [string, PythSession] => [
        l.underlying,
        { ticker: l.underlying, feedId: 'f', isOpen: true, nextOpen: null, nextClose: 1_790_280_000, schedule: null } as PythSession,
      ]),
    ),
    halts: new Map(),
    backpack: null,
    backpackError: null,
    ondo,
    ondoError: ondo ? null : 'ondo assets: HTTP 503',
    ...extra,
  }
}
const live = () => new Map(parseOndoAssets(LIVE, RECEIVED, WANT).assets)
const only = (symbol: string, o: Observation) => decide(o, ONDO).find((d) => d.listing.symbol === symbol)!

test('in the session, a tradeable Ondo token opens on Pyth, the calendar and Ondo together', () => {
  for (const d of decide(obs(live()), ONDO)) {
    assert.equal(d.verdict.openNow, true, d.listing.symbol)
    assert.equal(d.verdict.halt, HaltState.None)
    assert.equal(d.verdict.confidence, 'confirmed')
    assert.deepEqual(d.sources, { pythOpen: true, issuerOpen: true, issuerHalted: false, exchangeHalt: null })
  }
})

test("an Ondo pause closes the token and is logged as Ondo's pause, not a withdrawal or an exchange halt", () => {
  const m = live()
  m.set('SPYon', { ...m.get('SPYon')!, paused: true, pauseReason: 'corporate action' })
  const d = only('SPYon', obs(m))
  assert.equal(d.verdict.openNow, false)
  assert.equal(d.verdict.halt, HaltState.Unspecified)
  assert.equal(d.verdict.detail, 'Ondo has paused this token (corporate action); the underlying is not exchange-halted')
  assert.equal(d.sources.issuerHalted, true)
})

test('not tradeable, or Ondo market closed, closes the token and says what Ondo said', () => {
  const m = live()
  m.set('NVDAon', { ...m.get('NVDAon')!, tradeable: false })
  m.set('TSLAon', { ...m.get('TSLAon')!, marketOpen: false, session: 'closed' })
  const n = only('NVDAon', obs(m))
  assert.equal(n.verdict.openNow, false)
  assert.equal(n.verdict.confidence, 'conflict')
  assert.match(n.verdict.detail, /issuer will not trade this security \(Ondo: not tradeable, its market open, session regular\)$/)
  const t = only('TSLAon', obs(m))
  assert.equal(t.verdict.openNow, false)
  assert.match(t.verdict.detail, /\(Ondo: tradeable, its market closed, session closed\)$/)
  assert.equal(only('SPYon', obs(m)).verdict.openNow, true, 'one token closing is not the others')
})

test('no reading, a row missing, or a row for another security: closed until one arrives', () => {
  const unread = only('AAPLon', obs(null))
  assert.equal(unread.verdict.openNow, false)
  assert.equal(unread.verdict.confidence, 'unavailable')
  assert.equal(unread.verdict.detail, 'no issuer reading; closed until one arrives (Ondo status unread: ondo assets: HTTP 503)')
  assert.equal(unread.sources.issuerOpen, null)

  const m = live()
  m.delete('QQQon')
  m.set('AAPLon', { ...m.get('AAPLon')!, ticker: 'AAPD' })
  assert.match(only('QQQon', obs(m)).verdict.detail, /\(Ondo's status list has no QQQon\)$/)
  const wrong = only('AAPLon', obs(m))
  assert.equal(wrong.verdict.openNow, false)
  assert.match(wrong.verdict.detail, /\(Ondo lists AAPLon as AAPD, not AAPL\)$/)
})

test("an Ondo token is never judged by Backpack's calendar, which is where the old else sent it", () => {
  // Backpack's lists fully read and saying the regular session is open for
  // every underlying: before the explicit branch, this opened the Ondo names.
  const backpack = {
    sessions: [
      { name: 'US_EQUITIES_REGULAR', startTime: '09:30:00', endTime: '16:00:00', startWeekday: 1, endWeekday: 5, timezone: 'America/New_York' },
    ],
    holidays: [],
    supported: new Map(LISTINGS.map((l) => [`${l.underlying}.US`, ['US_EQUITIES_REGULAR']])),
  } as unknown as Observation['backpack']
  const both = decide(obs(null, { backpack }), LISTINGS)
  for (const d of both.filter((d) => d.listing.issuer === 'ondo')) {
    assert.equal(d.verdict.openNow, false, d.listing.symbol)
    assert.equal(d.sources.issuerOpen, null, d.listing.symbol)
  }
  assert.equal(both.find((d) => d.listing.symbol === 'PFE')?.verdict.openNow, true, "Backpack's own names still read it")
})

test('an issuer with no sensor fails closed and says so', () => {
  const stray = { ...ONDO[0], symbol: 'ZZZ', issuer: 'mystery' } as unknown as Listing
  const [d] = decide(obs(live()), [stray])
  assert.equal(d.verdict.openNow, false)
  assert.equal(d.verdict.confidence, 'unavailable')
  assert.equal(d.verdict.detail, 'no issuer reading; closed until one arrives (no sensor reads issuer "mystery")')
})

// ----------------------------------------------------------------- the marks

test('a quote beyond the program ceiling is no mark; inside it, the mark is as before', () => {
  const q = (priceImpact: number) => ({ outAmount: 257_891_277n, priceImpact })
  const args = { symbol: 'SPYon', decimals: 9, multiplier: 1.0094730727840426 }
  // SPYon's measured quote: 75 bps.
  const m = markFromQuote({ ...args, q: q(0.0075484932673847883) })!
  assert.equal(m.confBps, 75)
  assert.equal(m.source, MarkSource.Jupiter)
  assert.equal(m.pxExpo, -6)
  // $200 over 0.2579 raw-units x the multiplier: about $768.25 a share.
  assert.ok(Math.abs(Number(m.pxNum) / 1e6 - 200 / (0.257891277 * args.multiplier)) < 1e-6)
  assert.equal(markFromQuote({ ...args, q: q(0.02) })?.confBps, 200, 'exactly the ceiling still marks')
  assert.equal(markFromQuote({ ...args, q: q(0.0201) }), null)
  // TSLAon's measured quote: 87% impact. Once clamped to 200 and attested.
  assert.equal(markFromQuote({ ...args, q: q(0.8663041997661916) }), null)
  assert.equal(markFromQuote({ ...args, q: q(-0.001) })?.confBps, 1, 'a price improvement is the floor, as before')
  assert.equal(markFromQuote({ ...args, q: { outAmount: 0n, priceImpact: 0 } }), null)
})

test('the breaker marker is the maximum with a real timestamp, never a mark nobody has priced', () => {
  assert.equal(BREAKER_CONF_BPS, 65_535)
  assert.equal(breakerTripped({ confBps: 65_535, observedAt: 1_790_000_000n }), true)
  // What open_mark writes: the same width, observed_at 0. Its first price must go through.
  assert.equal(breakerTripped({ confBps: 65_535, observedAt: 0n }), false)
  assert.equal(breakerTripped({ confBps: 200, observedAt: 1_790_000_000n }), false)
})

// ------------------------------------------------------- transaction packing

const payer = Keypair.generate().publicKey
const sessionIx = (l: Listing) =>
  ixPushSession({ attestor: payer, symbol: l.symbol, halt: 0, openNow: true, nextChangeAt: 1n, observedAt: 1n })
const refreshIx = (l: Listing) => ixRefreshTokenRisk(new PublicKey(l.mint))
const markIx = (l: Listing) =>
  ixPushMark({ attestor: payer, symbol: l.symbol, rateQ64: 1n << 64n, pxNum: 1n, pxExpo: -6, confBps: 50, source: MarkSource.Jupiter, observedAt: 1n })

test('fourteen names: every session, refresh and mark batch fits 1,232 bytes, in order, none lost', () => {
  assert.equal(LISTINGS.length, 14)
  const kinds = { sessions: sessionIx, refreshes: refreshIx, marks: markIx }
  const counts: Record<string, number> = {}
  for (const [kind, build] of Object.entries(kinds)) {
    const ixs = LISTINGS.map(build)
    const batches = packInstructions(ixs, payer)
    counts[kind] = batches.length
    assert.deepEqual(batches.flat(), ixs, `${kind}: every instruction once, in order`)
    for (const b of batches) assert.ok(txBytes(b, payer) <= TX_LIMIT, `${kind}: ${txBytes(b, payer)} bytes`)
  }
  // Measured: 1,216 bytes of sessions fit one; 1,244 of refreshes and 1,972 of marks do not.
  assert.deepEqual(counts, { sessions: 1, refreshes: 2, marks: 2 })
  assert.equal(txBytes(LISTINGS.map(sessionIx), payer), 1_216)
  assert.equal(txBytes(LISTINGS.map(refreshIx), payer), 1_244)
})

test('the original nine pack exactly as they were sent: one transaction each', () => {
  const nine = LISTINGS.filter((l) => l.issuer !== 'ondo')
  assert.equal(nine.length, 9)
  for (const build of [sessionIx, refreshIx]) {
    const ixs = nine.map(build)
    assert.deepEqual(packInstructions(ixs, payer), [ixs])
  }
  assert.equal(txBytes(nine.map(sessionIx), payer), 841)
  assert.equal(txBytes(nine.map(refreshIx), payer), 859)
  // Seven marks, what a tick prices today with two names withdrawn, are one
  // transaction as before. All nine are 1,327 bytes, which one could not carry.
  const seven = nine.filter((l) => !l.withdrawn).map(markIx)
  assert.deepEqual(packInstructions(seven, payer), [seven])
  assert.equal(packInstructions(nine.map(markIx), payer).length, 2)
  assert.deepEqual(packInstructions([], payer), [])
})

// ---------------------------------------------------------------- the tick

test('a name with no accounts on this cluster is left out of every push, not sent to fail the batch', async (t) => {
  t.mock.method(console, 'log', () => {})
  t.mock.method(console, 'warn', () => {})
  t.mock.method(globalThis, 'fetch', async (url: string | URL) => {
    // The halt feed is the one read a tick cannot do without; the rest fail.
    if (String(url).includes('nasdaqtrader.com')) return new Response('<rss><channel></channel></rss>', { status: 200 })
    return new Response('not in this test', { status: 503 })
  })
  t.after(() => ondoFeed.stop())
  // A cluster where nothing is registered: every account reads as absent.
  const conn = {
    getMultipleAccountsInfo: async (keys: PublicKey[]) => keys.map(() => null),
    getSlot: async () => 1,
    getBlockTime: async () => Math.floor(Date.now() / 1000),
  } as unknown as Connection
  const r = await tick({ conn, attestor: Keypair.generate(), dryRun: true, withMarks: false })
  assert.deepEqual(r.unregistered, ALLOWLIST.map((l) => l.symbol))
  assert.deepEqual(r.pushed, [], 'before, every one was pushed and the transaction failed on the first')
  assert.deepEqual(r.breaker, [])
  assert.deepEqual(r.signatures, [])
  // The Ondo names had no reading on this first tick, and say why.
  for (const d of r.decisions.filter((d) => d.listing.issuer === 'ondo')) {
    assert.equal(d.verdict.openNow, false)
    assert.match(d.verdict.detail, /\(Ondo status unread: /)
  }
})
