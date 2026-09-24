/**
 * The checker armed: what it pushes, when it pushes nothing, and that its
 * reference is in the mark's convention, so the program's `|mark - ref|` is a
 * comparison of like with like.
 *
 * The accounts are decoded from bytes laid out from the IDL (test/idl-bytes.ts),
 * so a check the program would not recognise fails here too.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { Keypair, PublicKey } from '@solana/web3.js'
import { gapCheck, planCheck, referenceRate, type PushArgs } from '../scripts/checker.ts'
import { ixPushCheck, type SymbolAccounts } from '../src/chain/client.ts'
import {
  MAX_SESSION_REF_AGE_SECONDS,
  MarkSource,
  decodeSymbolCheck,
  decodeSymbolMark,
  decodeSymbolState,
  decodeTokenRisk,
  encodePushCheck,
  rateQ64,
} from '../src/chain/codec.ts'
import { TX_LIMIT, markFromQuote, packInstructions, txBytes } from '../src/chain/keeper.ts'
import { LISTINGS } from '../src/listings.ts'
import { symbolSeed } from '../src/config.ts'
import { judge, type MarketInfo, type Quote } from '../src/sensor/nasdaq.ts'
import { accountBytes, multiplierBits, symbolBytes } from './idl-bytes.ts'

const CHECKER = Keypair.generate().publicKey
const ATTESTOR = Keypair.generate().publicKey
const MINT = Keypair.generate().publicKey
const QUOTE_MINT = Keypair.generate().publicKey
/** SPYon's measured multiplier and its nine decimals: the case where getting either wrong shows. */
const MULTIPLIER = 1.0094730727840426
const DECIMALS = 9

/** 12:35 New York time on Thursday 24 September 2026: the regular session. */
const AT = new Date(Date.UTC(2026, 8, 24, 16, 35, 20))
const AT_S = Math.floor(AT.getTime() / 1000)

function accounts(over: { check?: Partial<Record<string, unknown>> | null; state?: boolean; attestor?: PublicKey; risk?: boolean; mark?: boolean } = {}): SymbolAccounts {
  const state = decodeSymbolState(
    accountBytes('SymbolState', {
      symbol: symbolBytes('SPYon'),
      mint: MINT,
      exchange_mic: Uint8Array.from([65, 82, 67, 88]),
      hours_mode: 0,
      halt: 0,
      open_now: true,
      next_change_at: 0n,
      observed_at: BigInt(AT_S - 20),
      attestor: over.attestor ?? ATTESTOR,
      bump: 255,
    }),
  )
  const risk = decodeTokenRisk(
    accountBytes('TokenRisk', {
      mint: MINT,
      paused: false,
      multiplier_bits: multiplierBits(MULTIPLIER),
      pending_multiplier_bits: 0n,
      activates_at: 0n,
      rebase_kind: 0,
      hook: null,
      permanent_delegate: null,
      verified_at: BigInt(AT_S - 20),
      attestor: ATTESTOR,
      bump: 254,
    }),
  )
  const mark = decodeSymbolMark(
    accountBytes('SymbolMark', {
      symbol: symbolBytes('SPYon'),
      mint: MINT,
      quote_mint: QUOTE_MINT,
      rate_q64: rateQ64({ pricePerShare: 767.5, multiplier: MULTIPLIER, quoteDecimals: 6, stockDecimals: DECIMALS }),
      px_num: 767_500_000n,
      px_expo: -6,
      conf_bps: 58,
      source: MarkSource.Jupiter,
      observed_at: BigInt(AT_S - 15),
      bump: 253,
    }),
  )
  const check =
    over.check === null
      ? null
      : decodeSymbolCheck(
          accountBytes('SymbolCheck', {
            symbol: symbolBytes('SPYon'),
            mint: MINT,
            checker: CHECKER,
            open_now: false,
            ref_rate_q64: 0n,
            ref_px_num: 0n,
            ref_px_expo: 0,
            ref_at: 0n,
            observed_at: 0n,
            bump: 252,
            ...over.check,
          }),
        )
  return {
    state: over.state === false ? null : state,
    risk: over.risk === false ? null : risk,
    mark: over.mark === false ? null : mark,
    check,
  }
}

const REGULAR: MarketInfo = { session: 'regular', label: 'Market Open' }
const quote = (last: number, ageS: number, source: Quote['source'] = 'nasdaq'): Quote => ({
  underlying: 'SPY',
  source,
  last,
  lastAt: AT.getTime() - ageS * 1000,
  session: 'regular',
  realTime: true,
})
const reading = (over: { calendarOpen?: boolean | null; market?: MarketInfo | null; q?: Quote | null; errors?: string[] } = {}) =>
  judge({
    underlying: 'SPY',
    calendarOpen: over.calendarOpen === undefined ? true : over.calendarOpen,
    market: over.market === undefined ? REGULAR : over.market,
    nasdaq: over.q === undefined ? quote(766.7494, 80) : over.q,
    yahoo: null,
    errors: over.errors,
  })

const plan = (over: Partial<Parameters<typeof planCheck>[0]> = {}) =>
  planCheck({
    symbol: 'SPYon',
    reading: reading(),
    accounts: accounts(),
    stockDecimals: DECIMALS,
    quoteDecimals: 6,
    checker: CHECKER,
    observedAt: AT_S,
    at: AT,
    ...over,
  })

test('armed, a usable reading becomes the push the program expects, in the mark convention', () => {
  const p = plan()
  assert.equal(p.skip, null)
  assert.deepEqual(p.push, {
    symbol: 'SPYon',
    openNow: true,
    refRateQ64: rateQ64({ pricePerShare: 766.7494, multiplier: MULTIPLIER, quoteDecimals: 6, stockDecimals: DECIMALS }),
    refPxNum: 766_749_400n,
    refPxExpo: -6,
    // Nasdaq's minute, never later than the observation.
    refAt: BigInt(Math.floor(AT.getTime() / 1000) - 80),
    observedAt: BigInt(AT_S),
  })
  // The instruction carries exactly those values, after the discriminator.
  const ix = ixPushCheck({ checker: CHECKER, ...p.push! })
  assert.deepEqual(ix.data, encodePushCheck({ ...p.push!, symbol: symbolSeed('SPYon') }))
  assert.ok(ix.keys[0].pubkey.equals(CHECKER) && ix.keys[0].isSigner)
})

test("the checker converts a price exactly as the keeper's mark does, so the two compare as like with like", () => {
  // SPYon's quote as measured on 2026-09-24: 257,891,277 raw for $200.
  const m = markFromQuote({ symbol: 'SPYon', q: { outAmount: 257_891_277n, priceImpact: 0.0075 }, decimals: DECIMALS, multiplier: MULTIPLIER })!
  const px = 200 / ((257_891_277 / 10 ** DECIMALS) * MULTIPLIER)
  assert.equal(referenceRate(px, MULTIPLIER, DECIMALS, 6), m.rateQ64)

  // Measured both ways against a mark 10 bps over the reference.
  const ref = 766.7494
  const markPx = ref * 1.001
  const mark = { rateQ64: referenceRate(markPx, MULTIPLIER, DECIMALS, 6), pxNum: BigInt(Math.round(markPx * 1e6)), pxExpo: -6 }
  const push = { refRateQ64: referenceRate(ref, MULTIPLIER, DECIMALS, 6), refPxNum: BigInt(Math.round(ref * 1e6)), refPxExpo: -6 }
  const g = gapCheck(push, mark, MULTIPLIER, DECIMALS, 6)!
  assert.ok(Math.abs(g.byPrice - 10) < 0.001, `${g.byPrice}`)
  // Rate is price inverted: the gap against the reference rate is the gap
  // against the mark's price, 10 / 1.001 bps.
  assert.ok(Math.abs(g.byRate - 10 / 1.001) < 0.001, `${g.byRate}`)
  assert.ok(Math.abs(g.byRate - g.expected) < 0.001)
  assert.ok(g.convention < 0.001)
  // A checker that left the multiplier out would be off by the whole of it,
  // about 95 bps for SPYon, and the convention column says so.
  const wrong = gapCheck(push, mark, 1, DECIMALS, 6)!
  assert.ok(Math.abs(wrong.convention - (MULTIPLIER - 1) * 10_000) < 0.01, `${wrong.convention}`)
})

test('nothing is pushed without a reading the checker can stand behind', () => {
  const cases: [string, Parameters<typeof reading>[0] | 'none', RegExp][] = [
    ['no reading', 'none', /^no reading$/],
    ['calendar without an opinion', { calendarOpen: null }, /calendar has no opinion/],
    ['no source named the session', { market: null, q: { ...quote(766.7, 10), session: null } }, /no source said which session/],
    ['its own sources disagree', { calendarOpen: false }, /calendar says closed but nasdaq market-info says regular session/],
    ['no last sale', { q: null, errors: ['nasdaq SPY: no reading (unknown shape, price or timestamp)'] }, /^no last sale \(nasdaq SPY: no reading/],
    ['a stale sale in session', { q: quote(766.7, MAX_SESSION_REF_AGE_SECONDS + 1) }, /last sale is 301s old in session, over 300s/],
  ]
  for (const [what, r, why] of cases) {
    const p = plan({ reading: r === 'none' ? undefined : reading(r) })
    assert.equal(p.push, null, what)
    assert.match(p.skip!, why, what)
  }
  // Exactly the limit is still a reference.
  assert.equal(plan({ reading: reading({ q: quote(766.7, MAX_SESSION_REF_AGE_SECONDS) }) }).skip, null)
})

test('out of session the checker says closed, with the close as its reference, however old', () => {
  // After the close on a Friday evening, read on Saturday: the program, not
  // the checker, decides that a twenty-hour-old reference is too old for a
  // night fill (CheckStale at 12 hours).
  const p = plan({ reading: reading({ calendarOpen: false, market: { session: 'closed', label: 'Market Closed' }, q: quote(766.7, 20 * 3600, 'yahoo') }) })
  assert.equal(p.skip, null)
  assert.equal(p.push!.openNow, false)
  assert.equal(p.push!.refAt, BigInt(AT_S - 20 * 3600))
  // Calendar open while the market says pre-market is closed: the market's own word.
  const pre = plan({ reading: reading({ market: { session: 'pre', label: 'Pre-Market' }, q: quote(766.7, 2 * 3600) }) })
  assert.equal(pre.skip, null)
  assert.equal(pre.push!.openNow, false)
})

test('the chain decides whether this key may push: registered, opened, naming it, and not the attestor', () => {
  assert.deepEqual(plan({ accounts: accounts({ state: false }) }), { symbol: 'SPYon', push: null, skip: 'not registered on this cluster', quote: null })
  // No check yet: the values are still worked out, for the dry run to show.
  const none = plan({ accounts: accounts({ check: null }) })
  assert.ok(none.push)
  assert.equal(none.skip, 'no checker yet (open_check has not run for this symbol)')
  // A dry run has no key and asks no more than that.
  assert.equal(plan({ checker: null }).skip, null)

  const other = Keypair.generate().publicKey
  assert.match(plan({ accounts: accounts({ check: { checker: other } }) }).skip!, /^the check names .* as its checker, not this key$/)
  assert.match(plan({ accounts: accounts({ attestor: CHECKER }) }).skip!, /this key is the symbol's attestor/)
  // The program ignores an observation older than the one on record.
  assert.match(plan({ accounts: accounts({ check: { observed_at: BigInt(AT_S + 1) } }) }).skip!, /newer than this observation/)
  // What the conversion needs.
  assert.match(plan({ accounts: accounts({ risk: false }) }).skip!, /no TokenRisk/)
  assert.match(plan({ stockDecimals: undefined }).skip!, /mint could not be read/)
  assert.match(plan({ accounts: accounts({ mark: false }) }).skip!, /no mark, so no quote asset/)
  assert.match(plan({ quoteDecimals: undefined }).skip!, /quote mint could not be read/)
  // A sale dated after the observation would be refused (BadParameters) and
  // fail its whole batch.
  const late = plan({ observedAt: AT_S - 100 })
  assert.equal(late.push, null)
  assert.match(late.skip!, /dated 20s after this observation/)
})

test('fourteen checks pack into transactions that each fit 1,232 bytes, none lost', () => {
  assert.equal(LISTINGS.length, 14)
  const push = (symbol: string): PushArgs => ({
    symbol,
    openNow: true,
    refRateQ64: (1n << 127n) - 1n,
    refPxNum: 766_749_400n,
    refPxExpo: -6,
    refAt: BigInt(AT_S),
    observedAt: BigInt(AT_S),
  })
  const ixs = LISTINGS.map((l) => ixPushCheck({ checker: CHECKER, ...push(l.symbol) }))
  const batches = packInstructions(ixs, CHECKER)
  assert.deepEqual(batches.flat(), ixs)
  for (const b of batches) assert.ok(txBytes(b, CHECKER) <= TX_LIMIT, `${txBytes(b, CHECKER)} bytes`)
  // Measured: one check alone is 268 bytes, and each more adds 102 (65 of
  // data, 32 for its account, 5 of indices and lengths). So ten fit one
  // transaction (1,186 bytes; eleven would be 1,288) and fourteen take two.
  assert.equal(txBytes(ixs.slice(0, 1), CHECKER), 268)
  assert.equal(txBytes(ixs.slice(0, 2), CHECKER) - txBytes(ixs.slice(0, 1), CHECKER), 102)
  assert.deepEqual(batches.map((b) => b.length), [10, 4])
  assert.deepEqual(batches.map((b) => txBytes(b, CHECKER)), [1_186, 574])
})

test('armed with no key, the checker refuses to start rather than run dry', () => {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    BELL_CHECKER_ARM: '1',
    BELL_CHECKER_KEYPAIR: '/nonexistent/checker.json',
    // Nothing listens here, so a checker that went on would fail rather than reach a real node.
    BELL_RPC_URL: 'http://127.0.0.1:1',
  }
  delete env.BELL_KEY_CHECKER
  const r = spawnSync(process.execPath, ['scripts/checker.ts', '--once'], { env, encoding: 'utf8', timeout: 30_000 })
  assert.equal(r.status, 1)
  assert.match(r.stderr, /BELL_CHECKER_ARM=1 but no checker key: no keypair at \/nonexistent\/checker\.json and BELL_KEY_CHECKER is unset/)
  assert.match(r.stderr, /Refusing\./)
  assert.doesNotMatch(r.stdout, /ARMED as/)
})
