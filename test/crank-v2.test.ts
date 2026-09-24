/**
 * The crank against the upgraded program: the opening cross, night fills, and
 * the words it uses for the refusals the checker and the breaker brought.
 *
 * The planning is held to the program's own rules. The cross amounts are
 * checked against a copy of cross.rs's arithmetic written here from the
 * source, not against the codec's mirror, so the two can disagree; every
 * minimum is checked against the formula the fill handler applies.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { Keypair, PublicKey } from '@solana/web3.js'
import {
  PAUSED_LINE,
  buyDeliver,
  checkBlocker,
  crossedFromLogs,
  explainRefusal,
  gapBps,
  nextCross,
  oldestFirst,
  orderKey,
  sellDeliver,
  whyNoCross,
} from '../scripts/crank.ts'
import {
  MAX_CHECK_AGE_SECONDS,
  MAX_NIGHT_GAP_BPS,
  MAX_NIGHT_REF_AGE_SECONDS,
  MAX_SESSION_GAP_BPS,
  MAX_SESSION_REF_AGE_SECONDS,
  MarkSource,
  buyMinOut,
  checkRefusal,
  errorName,
  rateQ64,
  sellMinOut,
  type BellOrder,
  type SymbolCheck,
} from '../src/chain/codec.ts'
import { eventBytes, symbolBytes } from './idl-bytes.ts'

const key = (b: number) => new PublicKey(new Uint8Array(32).fill(b))
const [ALICE, BOB, CAROL] = [key(1), key(2), key(3)]
const MINT = key(9)
const QUOTE = key(8)

/** $250 a share, 8-decimal stock, 6-decimal quote: the local end-to-end's numbers. */
const RATE = rateQ64({ pricePerShare: 250, multiplier: 1, quoteDecimals: 6, stockDecimals: 8 })
const SHARE = 100_000_000n

let nonce = 1n
function order(owner: PublicKey, over: Partial<BellOrder> = {}): BellOrder {
  const amountIn = over.amountIn ?? 200_000_000n
  return {
    owner,
    symbol: 'SPYx',
    mint: MINT,
    quoteMint: QUOTE,
    payerIn: Keypair.generate().publicKey,
    payeeOut: Keypair.generate().publicKey,
    amountIn,
    filledIn: 0n,
    minFillIn: amountIn,
    expectedMultiplierBits: 0x3ff0000000000000n,
    maxSlipBps: 30,
    maxConfBps: 50,
    floorRateQ64: 0n,
    notBefore: 0n,
    expiresAt: 2_000_000_000n,
    nonce: nonce++,
    createdAt: 1_790_000_000n,
    bump: 255,
    authBump: 255,
    ...over,
  }
}

/**
 * cross.rs, handle_cross_orders, from "let r = mark.rate_q64" to the
 * PriceOutOfBand pre-check, transcribed: u128 arithmetic, the ceiling written
 * as a quotient plus a remainder test as sell.rs writes it.
 */
function programCross(b: BellOrder, s: BellOrder, r: bigint): { q: bigint; x: bigint; refused: string | null } {
  const bRem = b.amountIn - b.filledIn
  const sRem = s.amountIn - s.filledIn
  const num = sRem << 64n
  const c = num / r + (num % r !== 0n ? 1n : 0n)
  const qS = (c * r) >> 64n > sRem ? c - 1n : c
  const q = bRem < qS ? bRem : qS
  const x = (q * r) >> 64n
  if (q === 0n || x === 0n) return { q, x, refused: 'FillTooSmall' }
  const min = (a: bigint, z: bigint) => (a < z ? a : z)
  if (q < min(b.minFillIn, bRem) || x < min(s.minFillIn, sRem)) return { q, x, refused: 'FillTooSmall' }
  const minStock = buyMinOut(q, r, b.maxSlipBps, b.floorRateQ64)
  const minQuote = sellMinOut(x, r, s.maxSlipBps, s.floorRateQ64)
  if (x < minStock || q < minQuote) return { q, x, refused: 'PriceOutOfBand' }
  return { q, x, refused: null }
}

// ------------------------------------------------------------------ the cross

test('the cross serves the oldest buy first, against the oldest sell of another owner', () => {
  const young = order(ALICE, { createdAt: 200n, minFillIn: 1n })
  const old = order(BOB, { createdAt: 100n, minFillIn: 1n })
  const bobsSell = order(BOB, { createdAt: 10n, amountIn: SHARE, minFillIn: 1n })
  const carolsSell = order(CAROL, { createdAt: 20n, amountIn: SHARE, minFillIn: 1n })
  const plan = nextCross([young, old], [carolsSell, bobsSell], RATE)!
  // Bob's buy is older, and Bob's own sell is older still, but a wallet never
  // crosses itself (SelfCross): Carol's sell is the one it meets.
  assert.equal(plan.buy, old)
  assert.equal(plan.sell, carolsSell)
  assert.deepEqual([...[young, old]].sort(oldestFirst), [old, young])
  // Tried pairs are skipped, so a refused simulation moves on to the next.
  const next = nextCross([young, old], [carolsSell, bobsSell], RATE, new Set([`${orderKey('buy', old)}|${orderKey('sell', carolsSell)}`]))!
  assert.equal(next.buy, young)
  assert.equal(next.sell, bobsSell)
  // Only one owner in the book: nothing to cross.
  assert.equal(nextCross([order(ALICE, { minFillIn: 1n })], [order(ALICE, { amountIn: SHARE, minFillIn: 1n })], RATE), null)
})

test('the plan is cross.rs arithmetic exactly, and leaves both owners at or above their own minimums', () => {
  // Rates below one (an 8-decimal $250 stock), at one, above one (a 9-decimal
  // $12 stock) and a six-decimal PFE-like name; sizes from a raw unit to $1,000.
  const rates = [
    RATE,
    1n << 64n,
    rateQ64({ pricePerShare: 12.34, multiplier: 1, quoteDecimals: 6, stockDecimals: 9 }),
    rateQ64({ pricePerShare: 28.41, multiplier: 1, quoteDecimals: 6, stockDecimals: 6 }),
    rateQ64({ pricePerShare: 766.7494, multiplier: 1.0094730727840426, quoteDecimals: 6, stockDecimals: 9 }),
  ]
  let seen = 0
  for (const r of rates) {
    for (const buyIn of [1n, 999_999n, 1_000_000n, 200_000_000n, 1_000_000_000n]) {
      for (const sellIn of [1n, 7n, 3_999_999n, SHARE / 2n, SHARE, 10n * SHARE, 1_000_000_000_000n]) {
        const b = order(ALICE, { amountIn: buyIn, minFillIn: 1n })
        const s = order(BOB, { amountIn: sellIn, minFillIn: 1n })
        const want = programCross(b, s, r)
        const plan = nextCross([b], [s], r)
        if (want.refused) {
          assert.equal(plan, null, `r=${r} buy=${buyIn} sell=${sellIn}: ${want.refused}`)
          continue
        }
        seen++
        assert.ok(plan, `r=${r} buy=${buyIn} sell=${sellIn} crosses`)
        assert.equal(plan.quote, want.q)
        assert.equal(plan.stock, want.x)
        // What cross.rs promises: the buyer gets exactly floor(q·r), neither
        // order is overfilled, and each clears the minimum its own fill would.
        assert.equal(plan.stock, (plan.quote * r) >> 64n)
        assert.ok(plan.quote <= buyIn && plan.stock <= sellIn)
        assert.ok(plan.stock >= buyMinOut(plan.quote, r, b.maxSlipBps, b.floorRateQ64))
        assert.ok(plan.quote >= sellMinOut(plan.stock, r, s.maxSlipBps, s.floorRateQ64))
      }
    }
  }
  assert.ok(seen > 60, `${seen} crossing cases`)
})

test('all-or-nothing orders cross only whole, so a smaller counterpart is no cross, and the log says why', () => {
  // $200 against half a share ($125): the buy would be part filled, and it
  // asked to fill whole.
  const buy = order(ALICE)
  const half = order(BOB, { amountIn: SHARE / 2n })
  assert.equal(programCross(buy, half, RATE).refused, 'FillTooSmall')
  assert.equal(nextCross([buy], [half], RATE), null)
  assert.match(whyNoCross([buy], [half], RATE), /1 pair under an order's minimum fill \(all-or-nothing orders cross only whole\)/)
  // $100 against a whole share: now the sell would be part filled.
  assert.equal(nextCross([order(ALICE, { amountIn: 100_000_000n })], [order(BOB, { amountIn: SHARE })], RATE), null)
  // A partial sell lets the whole buy cross against part of it.
  const partial = order(BOB, { amountIn: SHARE, minFillIn: 400_000n })
  const plan = nextCross([buy], [partial], RATE)!
  assert.equal(plan.quote, 200_000_000n)
  assert.equal(plan.stock, (200_000_000n * RATE) >> 64n)
  assert.equal(whyNoCross([buy], [order(ALICE, { amountIn: SHARE, minFillIn: 1n })], RATE), '1 pair same owner on both sides')
})

test('an owner limit the mark does not meet is no cross', () => {
  // A buyer whose limit is 1% under the mark: floor above fair at this rate.
  const limited = order(ALICE, { minFillIn: 1n, floorRateQ64: (RATE * 101n) / 100n })
  const s = order(BOB, { amountIn: SHARE, minFillIn: 1n })
  assert.equal(programCross(limited, s, RATE).refused, 'PriceOutOfBand')
  assert.equal(nextCross([limited], [s], RATE), null)
  assert.match(whyNoCross([limited], [s], RATE), /outside an owner's limit at the mark/)
})

test('after a cross the working copies carry the remainder to the next pair', () => {
  const s = order(CAROL, { amountIn: SHARE, minFillIn: 1n, createdAt: 1n })
  const b1 = order(ALICE, { createdAt: 2n })
  const b2 = order(BOB, { createdAt: 3n, amountIn: 500_000_000n, minFillIn: 1n })
  const buys = [{ ...b1 }, { ...b2 }]
  const sells = [{ ...s }]
  const first = nextCross(buys, sells, RATE)!
  assert.equal(first.buy.owner, ALICE)
  first.buy.filledIn += first.quote
  first.sell.filledIn += first.stock
  // Alice's $200 took 0.8 share; Bob's partial buy takes the other 0.2.
  const second = nextCross(buys, sells, RATE)!
  assert.equal(second.buy.owner, BOB)
  assert.equal(second.sell.amountIn - second.sell.filledIn, SHARE - first.stock)
  assert.equal(second.stock, programCross(second.buy, second.sell, RATE).x)
  second.buy.filledIn += second.quote
  second.sell.filledIn += second.stock
  assert.equal(nextCross(buys, sells, RATE), null, 'the sell is used up')
  // The book itself was never touched.
  assert.equal(s.filledIn, 0n)
})

// ------------------------------------------------------------------ the check

const NOW = 1_790_000_000
function check(over: Partial<SymbolCheck> = {}): SymbolCheck {
  return {
    symbol: 'SPYx',
    mint: MINT,
    checker: CAROL,
    openNow: true,
    refRateQ64: RATE,
    refPxNum: 250_000_000n,
    refPxExpo: -6,
    refAt: BigInt(NOW - 30),
    observedAt: BigInt(NOW - 10),
    bump: 254,
    ...over,
  }
}

test('each refusal the checker can give is named, in the program order, with the numbers behind it', () => {
  const ask = (c: SymbolCheck | null, over: { night?: boolean; mark?: bigint; now?: number } = {}) => {
    const args = { check: c, markRateQ64: over.mark ?? RATE, night: over.night ?? false, now: over.now ?? NOW }
    const said = checkBlocker(args)
    const name = checkRefusal({ ...args, now: BigInt(args.now) })
    // The words always end with the program's own name for it.
    if (name === null) assert.equal(said, null)
    else assert.ok(said?.endsWith(`(${name})`), `${said} names ${name}`)
    return said
  }
  assert.equal(ask(check()), null)
  assert.match(ask(null)!, /^no checker yet — open_check has not run/)
  assert.match(ask(check({ observedAt: 0n, refAt: 0n, refRateQ64: 0n }))!, /never pushed/)

  // The check's own age: exactly the limit passes, a second more does not.
  assert.equal(ask(check({ observedAt: BigInt(NOW - MAX_CHECK_AGE_SECONDS) })), null)
  assert.equal(
    ask(check({ observedAt: BigInt(NOW - MAX_CHECK_AGE_SECONDS - 1) })),
    "the checker's last push is 2m01s old, over the 120s limit; is the checker running? (CheckStale)",
  )

  // Session: the checker must say open. Night: closed.
  assert.equal(ask(check({ openNow: false })), 'the keeper says open but the checker says the market is closed (CheckerDisagrees)')
  assert.match(ask(check(), { night: true })!, /checker says the market is open, so no night fill \(CheckerDisagrees\)/)
  const shut = check({ openNow: false })
  assert.equal(ask(shut, { night: true }), null)

  // The sale behind the reference: five minutes in session, twelve hours at night.
  assert.equal(ask(check({ refAt: BigInt(NOW - MAX_SESSION_REF_AGE_SECONDS) })), null)
  assert.equal(
    ask(check({ refAt: BigInt(NOW - MAX_SESSION_REF_AGE_SECONDS - 1) })),
    "the sale behind the checker's reference is 5m01s old, over the 5m00s session limit (CheckStale)",
  )
  assert.equal(ask(check({ openNow: false, refAt: BigInt(NOW - MAX_NIGHT_REF_AGE_SECONDS) }), { night: true }), null)
  assert.match(ask(check({ openNow: false, refAt: BigInt(NOW - MAX_NIGHT_REF_AGE_SECONDS - 1) }), { night: true })!, /12h00m night limit/)

  // The band, measured as admit measures it: (ref / 10,000) × gap, in rate.
  const edge = (gap: number) => (RATE / 10_000n) * BigInt(gap)
  assert.equal(ask(check(), { mark: RATE + edge(MAX_SESSION_GAP_BPS) }), null)
  assert.match(ask(check(), { mark: RATE + edge(MAX_SESSION_GAP_BPS) + 1n })!, /is 300\.0 bps from the checker's reference \(\$250\.0000\), outside the 300 bps session band/)
  assert.equal(ask(shut, { night: true, mark: RATE - edge(MAX_NIGHT_GAP_BPS) }), null)
  assert.match(ask(shut, { night: true, mark: RATE - edge(MAX_NIGHT_GAP_BPS) - 1n })!, /outside the 150 bps night band \(MarkOffReference\)/)
  // The program's edge is (ref / 10,000) × gap, which truncates first, so it sits a hair under 300.
  assert.ok(Math.abs(gapBps(RATE + edge(300), RATE) - 300) < 0.02)
})

test('a refusal from a simulation says what it means for the new names, and prints the others as before', () => {
  assert.match(explainRefusal(errorName(6027)), /^MarkPaused — the price mark is held by the circuit breaker; it clears when a push lands within 5% a minute of the held price, or once that price is 300s old$/)
  assert.match(explainRefusal(errorName(6030)), /^CheckStale — /)
  assert.match(explainRefusal(errorName(6031)), /^CheckerDisagrees — /)
  assert.match(explainRefusal(errorName(6032)), /^MarkOffReference — /)
  assert.match(explainRefusal(errorName(6033)), /^SelfCross — /)
  assert.match(explainRefusal(errorName(3012)), /^AccountNotInitialized — no checker yet/)
  assert.match(explainRefusal(errorName(3005)), /update the client/)
  assert.equal(explainRefusal('MarketClosed'), 'MarketClosed')
  assert.equal(explainRefusal('PriceOutOfBand'), 'PriceOutOfBand')
  assert.match(PAUSED_LINE, /PAUSED \(circuit breaker\).*\(MarkPaused\).*5% a minute.*300s old/)
})

// ------------------------------------------------------------------ the fills

test('in session a fill delivers exactly the program minimum; at night the reference minimum as well', () => {
  const o = { maxSlipBps: 30, floorRateQ64: (RATE * 3n) / 4n }
  for (const leg of [1n, 1_000_000n, 200_000_000n, 1_000_000_000n]) {
    const b = buyDeliver(leg, RATE, o, null)
    assert.equal(b.deliver, buyMinOut(leg, RATE, o.maxSlipBps, o.floorRateQ64))
    const stock = leg * 400n
    const s = sellDeliver(stock, RATE, { maxSlipBps: 30, floorRateQ64: 0n }, null)
    assert.equal(s.deliver, sellMinOut(stock, RATE, 30, 0n))

    // At night: the larger of the session minimum and the reference's, the
    // band formula over the reference rate with the night gap (fill.rs, sell.rs).
    const ref = RATE + RATE / 200n
    const bn = buyDeliver(leg, RATE, o, ref)
    const byRef = buyMinOut(leg, ref, MAX_NIGHT_GAP_BPS, 0n)
    assert.equal(bn.deliver, b.deliver > byRef ? b.deliver : byRef)
    const sn = sellDeliver(stock, RATE, { maxSlipBps: 30, floorRateQ64: 0n }, ref)
    const sRef = sellMinOut(stock, ref, MAX_NIGHT_GAP_BPS, 0n)
    assert.equal(sn.deliver, s.deliver > sRef ? s.deliver : sRef)
  }
})

test("at night the reference minimum binds over a generous band, and never asks a buy for more than the mark's fair value", () => {
  // A 3% band with the mark at the far edge of the night gap: the band would
  // let the filler keep 3%, the reference only about 1.5% of the reference.
  const o = { maxSlipBps: 300, floorRateQ64: 0n }
  const ref = RATE
  const mark = ref - (ref / 10_000n) * BigInt(MAX_NIGHT_GAP_BPS) // the most stock-expensive mark admit allows
  const leg = 200_000_000n
  const d = buyDeliver(leg, mark, o, ref)
  const band = buyMinOut(leg, mark, 300, 0n)
  assert.ok(d.deliver > band, 'the reference binds')
  assert.ok(d.deliver <= d.fair, 'and stays within fair value at the mark')
  // Everywhere inside the night band: a buy never above fair, a sell at most
  // one quote raw above it (the ceiling steps, as sell.rs says).
  for (let bps = -150n; bps <= 150n; bps += 25n) {
    const m = ref + (ref / 10_000n) * bps
    for (const l of [1n, 999n, 1_000_000n, 777_777_777n]) {
      const b = buyDeliver(l, m, { maxSlipBps: 0, floorRateQ64: 0n }, ref)
      assert.ok(b.deliver <= b.fair, `buy at ${bps}bps leg ${l}`)
      const s = sellDeliver(l * 40n, m, { maxSlipBps: 0, floorRateQ64: 0n }, ref)
      assert.ok(s.deliver <= s.fair + 1n, `sell at ${bps}bps leg ${l}`)
    }
  }
})

// ---------------------------------------------------------- what a cross moved

test("a cross's amounts are read from its own event, whatever else the logs carry", () => {
  const payload = eventBytes('OrdersCrossed', {
    symbol: symbolBytes('SPYx'),
    buyer: ALICE,
    seller: BOB,
    quote: 200_000_000n,
    stock: 79_999_999n,
    px_num: 250_000_000n,
    px_expo: -6,
    source: MarkSource.Jupiter,
    mark_observed_at: BigInt(NOW),
  })
  const logs = [
    'Program 56AUPR1c1Tq5AgMvAa3PASax61YYo1KTdocwW6pR7Pdx invoke [1]',
    'Program log: Instruction: CrossOrders',
    `Program data: ${Buffer.from(eventBytes('OrderFilled', {
      symbol: symbolBytes('SPYx'), owner: ALICE, filler: BOB, amount_in: 1n, amount_out: 1n,
      px_num: 1n, px_expo: -6, source: 0, mark_observed_at: 0n, realized_bps: 0,
    })).toString('base64')}`,
    `Program data: ${Buffer.from(payload).toString('base64')}`,
    'Program data: not base64 at all!',
  ]
  const [e, ...rest] = crossedFromLogs(logs)
  assert.equal(rest.length, 0)
  assert.equal(e.symbol, 'SPYx')
  assert.ok(e.buyer.equals(ALICE) && e.seller.equals(BOB))
  assert.equal(e.quote, 200_000_000n)
  assert.equal(e.stock, 79_999_999n)
})
