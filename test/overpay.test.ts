/**
 * The overpay lookup: finding buys in a transaction, pricing them with the
 * mint's multiplier, placing them in the session, reading Nasdaq's history,
 * and the lookup end to end over a stand-in RPC and a stand-in Nasdaq.
 *
 * The transactions are synthetic, shaped as mainnet's `getTransaction` (json
 * encoding) returns them: a wallet's USDC and stock balances before and after,
 * each with its owner.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { PublicKey } from '@solana/web3.js'
import { LISTINGS } from '../src/listings.ts'
import {
  LookupError,
  OutOfTime,
  RateLimited,
  USDC,
  addDays,
  buysIn,
  createOpens,
  createOverpay,
  gapBps,
  historyUrl,
  httpRpc,
  isAddress,
  multiplierKnown,
  nyWall,
  parseHistory,
  priceBuy,
  quantile,
  readTransactions,
  sessionOf,
  summarize,
  withOpens,
  type MainnetTx,
  type Opens,
  type TokenBalance,
} from '../src/overpay.ts'
import { scaledUiOf, type Rpc } from '../web/lib/tape.ts'

const key = (n: number) => new PublicKey(Uint8Array.from({ length: 32 }, (_, i) => (i * 7 + n) % 256)).toBase58()
const WALLET = key(1)
const POOL = key(2)
const OTHER = key(3)
const BONK = key(4)
const SPYX = LISTINGS.find((l) => l.symbol === 'SPYx')!
const NVDAX = LISTINGS.find((l) => l.symbol === 'NVDAx')!
const STOCKS = new Set(LISTINGS.map((l) => l.mainnetMint))

/** Unix seconds for a New York wall-clock time in September 2026, when New York is UTC−4. */
const ny = (day: number, hour: number, minute = 0, second = 0) => Date.UTC(2026, 8, day, hour + 4, minute, second) / 1000

const bal = (accountIndex: number, mint: string, owner: string | undefined, amount: bigint, decimals: number): TokenBalance => ({
  accountIndex,
  mint,
  ...(owner ? { owner } : {}),
  uiTokenAmount: { amount: String(amount), decimals },
})

/**
 * A swap through a pool: `buyer` pays `usdc` raw USDC and receives `stock` raw
 * units of `mint`; the pool's vault moves the other way. `buyer` signs.
 */
function swap(opts: {
  sig?: string
  at: number
  buyer?: string
  signer?: string
  mint?: string
  usdc: bigint
  stock: bigint
  err?: unknown
  extraPre?: TokenBalance[]
  extraPost?: TokenBalance[]
  newAccount?: boolean
}): MainnetTx {
  const buyer = opts.buyer ?? WALLET
  const mint = opts.mint ?? SPYX.mainnetMint
  const pre = [
    bal(1, USDC, buyer, 500_000_000n, 6),
    ...(opts.newAccount ? [] : [bal(2, mint, buyer, 1_000_000n, 8)]),
    bal(3, USDC, POOL, 9_000_000_000n, 6),
    bal(4, mint, POOL, 900_000_000_000n, 8),
    ...(opts.extraPre ?? []),
  ]
  const post = [
    bal(1, USDC, buyer, 500_000_000n - opts.usdc, 6),
    bal(2, mint, buyer, (opts.newAccount ? 0n : 1_000_000n) + opts.stock, 8),
    bal(3, USDC, POOL, 9_000_000_000n + opts.usdc, 6),
    bal(4, mint, POOL, 900_000_000_000n - opts.stock, 8),
    ...(opts.extraPost ?? []),
  ]
  return {
    slot: 450_000_000,
    blockTime: opts.at,
    version: 0,
    meta: { err: opts.err ?? null, preTokenBalances: pre, postTokenBalances: post },
    transaction: {
      signatures: [opts.sig ?? 'sig-' + opts.at],
      message: {
        accountKeys: [opts.signer ?? buyer, OTHER, POOL, mint, USDC],
        header: { numRequiredSignatures: 1 },
      },
    },
  }
}

// -------------------------------------------------------------- buy detection

test('a wallet whose USDC fell while a listed stock rose bought it, even into a new account', () => {
  const tx = swap({ at: ny(23, 19, 42), usdc: 75_000_000n, stock: 10_000_000n, newAccount: true })
  const { buys, mixed } = buysIn(tx, STOCKS, WALLET)
  assert.equal(mixed, 0)
  assert.equal(buys.length, 1)
  assert.deepEqual(
    { ...buys[0] },
    {
      signature: `sig-${ny(23, 19, 42)}`,
      slot: 450_000_000,
      blockTime: ny(23, 19, 42),
      owner: WALLET,
      signed: true,
      maker: false,
      mint: SPYX.mainnetMint,
      stockRaw: 10_000_000n,
      stockDecimals: 8,
      usdcRaw: 75_000_000n,
      usdcDecimals: 6,
    },
  )
  // Asked about no wallet in particular, the same transaction has one buyer:
  // the pool sold, so it is not one.
  assert.deepEqual(
    buysIn(tx, STOCKS).buys.map((b) => b.owner),
    [WALLET],
  )
})

test('a pool taking the other side of a sale looks like a buyer, but never signs', () => {
  // The wallet sells stock into the pool: the pool's stock rises and its USDC falls.
  const sale = swap({ at: ny(23, 20), usdc: -75_000_000n, stock: -10_000_000n })
  const { buys } = buysIn(sale, STOCKS)
  assert.equal(buys.length, 1)
  assert.equal(buys[0].owner, POOL)
  assert.equal(buys[0].signed, false)
  // And the seller made no buy.
  assert.equal(buysIn(sale, STOCKS, WALLET).buys.length, 0)
})

test('a transaction that moved a third token is mixed and not priced; failures and own transfers are not buys', () => {
  const alsoBonk = swap({
    at: ny(23, 21),
    usdc: 100_000_000n,
    stock: 10_000_000n,
    extraPre: [bal(5, BONK, WALLET, 0n, 5)],
    extraPost: [bal(5, BONK, WALLET, 1_000n, 5)],
  })
  assert.deepEqual(buysIn(alsoBonk, STOCKS, WALLET), { buys: [], mixed: 1 })

  const failed = swap({ at: ny(23, 21), usdc: 100_000_000n, stock: 10_000_000n, err: { InstructionError: [0, 'Custom'] } })
  assert.deepEqual(buysIn(failed, STOCKS, WALLET), { buys: [], mixed: 0 })

  // Stock moved between two of the wallet's own accounts, while it paid a USDC fee.
  const own: MainnetTx = {
    ...swap({ at: ny(23, 21), usdc: 0n, stock: 0n }),
    meta: {
      err: null,
      preTokenBalances: [bal(1, USDC, WALLET, 10n, 6), bal(2, SPYX.mainnetMint, WALLET, 500n, 8), bal(6, SPYX.mainnetMint, WALLET, 0n, 8)],
      postTokenBalances: [bal(1, USDC, WALLET, 9n, 6), bal(2, SPYX.mainnetMint, WALLET, 0n, 8), bal(6, SPYX.mainnetMint, WALLET, 500n, 8)],
    },
  }
  assert.deepEqual(buysIn(own, STOCKS, WALLET), { buys: [], mixed: 0 })

  // A stock this list does not carry is not a buy of a listed stock.
  assert.equal(buysIn(swap({ at: ny(23, 21), mint: BONK, usdc: 1n, stock: 1n }), STOCKS, WALLET).buys.length, 0)

  // Balances without an owner (very old transactions) are skipped rather than guessed at.
  const ownerless = swap({ at: ny(23, 21), usdc: 5n, stock: 5n })
  for (const b of [...ownerless.meta!.preTokenBalances!, ...ownerless.meta!.postTokenBalances!]) delete b.owner
  assert.equal(buysIn(ownerless, STOCKS).buys.length, 0)
})

/**
 * A quoted fill, shaped as mainnet's 23 September 04:32 UTC SPYon trade
 * (3Qmqgb8Q…): two signers, the maker first and paying the fee, swapping stock
 * for USDC with each other directly, with no pool in between.
 */
function quoted(opts: { maker: string; customer: string; customerBuys: boolean; usdc: bigint; stock: bigint }): MainnetTx {
  const mint = SPYX.mainnetMint
  const buyer = opts.customerBuys ? opts.customer : opts.maker
  const seller = opts.customerBuys ? opts.maker : opts.customer
  return {
    slot: 450_000_000,
    blockTime: ny(23, 0, 32),
    version: 0,
    meta: {
      err: null,
      preTokenBalances: [
        bal(1, USDC, buyer, 500_000_000n, 6),
        bal(2, mint, buyer, 0n, 9),
        bal(3, USDC, seller, 1_000_000n, 6),
        bal(4, mint, seller, 10_000_000n, 9),
      ],
      postTokenBalances: [
        bal(1, USDC, buyer, 500_000_000n - opts.usdc, 6),
        bal(2, mint, buyer, opts.stock, 9),
        bal(3, USDC, seller, 1_000_000n + opts.usdc, 6),
        bal(4, mint, seller, 10_000_000n - opts.stock, 9),
      ],
    },
    transaction: {
      signatures: ['quoted'],
      message: { accountKeys: [opts.maker, opts.customer, mint, USDC], header: { numRequiredSignatures: 2 } },
    },
  }
}

test("a market maker's side of a quoted fill is its customer's sale, not a buy; the customer's buy still counts", () => {
  const MAKER = key(5)
  // The customer sells to the maker: the maker's stock rose and its USDC fell.
  const sale = buysIn(quoted({ maker: MAKER, customer: WALLET, customerBuys: false, usdc: 2_389_319n, stock: 3_069_828n }), STOCKS)
  assert.deepEqual(
    sale.buys.map((b) => [b.owner, b.signed, b.maker]),
    [[MAKER, true, true]],
  )
  // Asked about the maker's own wallet, it is still told apart.
  assert.equal(buysIn(quoted({ maker: MAKER, customer: WALLET, customerBuys: false, usdc: 1n, stock: 1n }), STOCKS, MAKER).buys[0].maker, true)
  // The customer buys from the maker: that is a buy, and the maker sold.
  const bought = buysIn(quoted({ maker: MAKER, customer: WALLET, customerBuys: true, usdc: 1_990_000n, stock: 7_466_734n }), STOCKS)
  assert.deepEqual(
    bought.buys.map((b) => [b.owner, b.signed, b.maker]),
    [[WALLET, true, false]],
  )
  // A plain swap through a pool has no maker: the fee payer bought from a vault that did not sign.
  assert.equal(buysIn(swap({ at: ny(23, 21), usdc: 5n, stock: 5n }), STOCKS, WALLET).buys[0].maker, false)
})

// ------------------------------------------------------------------ multiplier

/** Token-2022 mint bytes carrying a scaled-UI amount extension, as mainnet's xStocks do. */
function scaledMint(multiplier: number, newMultiplier: number, effectiveAt: number): Uint8Array {
  const b = new Uint8Array(166 + 4 + 56)
  const d = new DataView(b.buffer)
  b[44] = 8 // decimals
  b[165] = 1 // account type: mint
  d.setUint16(166, 25, true) // ScaledUiAmount
  d.setUint16(168, 56, true)
  d.setFloat64(170 + 32, multiplier, true)
  d.setBigInt64(170 + 40, BigInt(effectiveAt), true)
  d.setFloat64(170 + 48, newMultiplier, true)
  return b
}

test('shares are raw units times the multiplier in force at the block time, read from the mint', () => {
  const step = ny(19, 19) // a dividend step on Saturday evening
  const scaled = scaledUiOf(scaledMint(1.0027, 1.0035, step))
  assert.deepEqual(scaled, { multiplier: 1.0027, newMultiplier: 1.0035, effectiveAt: step })

  // 0.1 raw-scaled SPYx for $77.40, a second before and at the step.
  const [before] = buysIn(swap({ at: step - 1, usdc: 77_400_000n, stock: 10_000_000n }), STOCKS, WALLET).buys
  const [after] = buysIn(swap({ at: step, usdc: 77_400_000n, stock: 10_000_000n }), STOCKS, WALLET).buys
  const b = priceBuy(before, SPYX, scaled)
  const a = priceBuy(after, SPYX, scaled)
  assert.equal(b.multiplier, 1.0027)
  assert.equal(a.multiplier, 1.0035)
  assert.ok(Math.abs(b.shares! - 0.10027) < 1e-12)
  assert.ok(Math.abs(b.pricePerShare! - 77.4 / 0.10027) < 1e-9)
  assert.ok(Math.abs(a.pricePerShare! - 77.4 / 0.10035) < 1e-9)
  assert.equal(b.usdcPaid, 77.4)
  assert.equal(b.explorer, `https://explorer.solana.com/tx/${before.signature}`)

  // Backed schedules a step ahead, so the multiplier before it is still on the mint.
  assert.equal(b.multiplierExact, true)
  assert.equal(a.multiplierExact, true)
  // Ondo writes a step already in force: the value before it is gone, and a
  // buy from before it is priced with the one after, so it is marked.
  const ondo = { multiplier: 1.0095, newMultiplier: 1.0095, effectiveAt: step }
  assert.equal(priceBuy(before, SPYX, ondo).multiplierExact, false)
  assert.equal(priceBuy(after, SPYX, ondo).multiplierExact, true)
  assert.equal(multiplierKnown({ multiplier: 1, newMultiplier: 1, effectiveAt: 0 }, 5), true)
  // A rewrite that left it at exactly 1, as Ondo's did for TSLAon, was never a step.
  assert.equal(multiplierKnown({ multiplier: 1, newMultiplier: 1, effectiveAt: step }, step - 1), true)

  // A mint without the extension is already in shares; an unreadable one prices nothing.
  assert.equal(priceBuy(before, SPYX, scaledUiOf(new Uint8Array(82))).shares, 0.1)
  const blind = priceBuy(before, SPYX, null)
  assert.equal(blind.shares, null)
  assert.equal(blind.pricePerShare, null)
  assert.equal(blind.usdcPaid, 77.4)
})

// --------------------------------------------------------------------- session

test('each buy is placed in or outside the regular session, with the next open by the exchange calendar', () => {
  // Wednesday evening: after hours, the open is Thursday's.
  assert.deepEqual(sessionOf(ny(23, 19, 42)), {
    session: 'outside',
    window: 'after-hours',
    nextOpenAt: ny(24, 9, 30),
    nextOpenDate: '2026-09-24',
  })
  // Overnight and pre-market on Thursday wait for the same open.
  assert.equal(sessionOf(ny(24, 3)).window, 'overnight')
  assert.equal(sessionOf(ny(23, 22)).window, 'overnight')
  assert.equal(sessionOf(ny(24, 8)).window, 'pre-market')
  assert.equal(sessionOf(ny(24, 9, 29, 59)).nextOpenDate, '2026-09-24')
  // The bell itself is in session.
  assert.equal(sessionOf(ny(24, 9, 30)).session, 'regular')
  assert.equal(sessionOf(ny(22, 15, 59, 59)).session, 'regular')
  assert.equal(sessionOf(ny(22, 16)).session, 'outside')
  // A Saturday waits for Monday.
  assert.deepEqual(sessionOf(ny(19, 12)), {
    session: 'outside',
    window: 'closed day',
    nextOpenAt: ny(21, 9, 30),
    nextOpenDate: '2026-09-21',
  })
  // Friday before Labor Day waits for Tuesday; Labor Day itself is a closed day.
  assert.equal(sessionOf(ny(4, 17)).nextOpenDate, '2026-09-08')
  assert.equal(sessionOf(ny(7, 11)).window, 'closed day')
  // The day after Thanksgiving closes at 13:00, so 14:00 is after hours (November is UTC−5).
  const blackFriday2pm = Date.UTC(2026, 10, 27, 19) / 1000
  assert.deepEqual(
    [sessionOf(blackFriday2pm).session, sessionOf(blackFriday2pm).window, sessionOf(blackFriday2pm).nextOpenDate],
    ['outside', 'after-hours', '2026-11-30'],
  )
  // Before the calendar's first year it has no opinion, and neither does this.
  assert.deepEqual(sessionOf(Date.UTC(2025, 5, 2, 15) / 1000), {
    session: 'unknown',
    window: null,
    nextOpenAt: null,
    nextOpenDate: null,
  })
  assert.equal(nyWall(ny(23, 19, 42)).label, 'Wed 23 Sep 2026 19:42 ET')
  assert.equal(nyWall(ny(24, 0, 5)).label, 'Thu 24 Sep 2026 00:05 ET')
})

// ---------------------------------------------------------------------- Nasdaq

// Nasdaq's history JSON, trimmed from what it returned on 24 September 2026.
const SPY_HISTORY = {
  data: {
    symbol: 'SPY',
    totalRecords: 2,
    tradesTable: {
      asOf: null,
      rows: [
        { date: '09/23/2026', close: '767.81', volume: '54,931,690', open: '772.79', high: '773.05', low: '766.50' },
        { date: '09/22/2026', close: '773.38', volume: '34,802,340', open: '774.03', high: '775.14', low: '772.57' },
      ],
    },
  },
  status: { rCode: 200 },
}
const NVDA_HISTORY = {
  data: {
    symbol: 'NVDA',
    tradesTable: { rows: [{ date: '09/21/2026', close: '$227.38', volume: '109,806,100', open: '$222.935' }] },
  },
}
const EMPTY = { data: { symbol: 'PFE', totalRecords: 0, tradesTable: { asOf: null, headers: null, rows: null } } }
const WRONG_CLASS = { data: null, message: null, status: { rCode: 400, bCodeMessage: [{ code: 1001, errorMessage: 'Symbol not exists.' }] } }

test("Nasdaq's history becomes each day's open; an empty range is empty and a wrong class is nothing", () => {
  assert.deepEqual(
    parseHistory(SPY_HISTORY),
    new Map([
      ['2026-09-23', 772.79],
      ['2026-09-22', 774.03],
    ]),
  )
  assert.deepEqual(parseHistory(NVDA_HISTORY), new Map([['2026-09-21', 222.935]]))
  assert.deepEqual(parseHistory(EMPTY), new Map())
  assert.equal(parseHistory(WRONG_CLASS), null)
  assert.equal(parseHistory('garbage'), null)
  assert.equal(parseHistory(null), null)
  // A row it cannot read is skipped, not guessed at.
  assert.deepEqual(parseHistory({ data: { tradesTable: { rows: [{ date: '2026-09-21', open: '$1' }, { date: '09/21/2026', open: 'N/A' }] } } }), new Map())

  // `todate` must be after `fromdate`, so even one day asks through the next.
  assert.equal(
    historyUrl('SPY', 'etf', '2026-09-21', '2026-09-21'),
    'https://api.nasdaq.com/api/quote/SPY/historical?assetclass=etf&fromdate=2026-09-21&todate=2026-09-22&limit=2',
  )
  assert.equal(addDays('2026-12-31', 1), '2027-01-01')
})

test('opens: one request per underlying, the other asset class on a refusal, and today not yet recorded', async () => {
  const asked: string[] = []
  const answers: Record<string, unknown> = {
    'SPY etf': SPY_HISTORY,
    'NVDA stocks': WRONG_CLASS, // pretend Nasdaq filed it the other way
    'NVDA etf': NVDA_HISTORY,
  }
  const fetchJson = async (url: string) => {
    asked.push(url)
    const u = new URL(url)
    return answers[`${u.pathname.split('/')[3]} ${u.searchParams.get('assetclass')}`] ?? null
  }
  // Thursday 24 September, 12:40 in New York: the session is on, today's row is not out.
  const opens = createOpens({ fetchJson, clock: () => ny(24, 12, 40) * 1000 })

  const spy = await opens('SPY', ['2026-09-23', '2026-09-22', '2026-09-24', '2026-09-25', '2026-09-23'])
  assert.deepEqual(Object.fromEntries(spy), {
    '2026-09-22': { price: 774.03, status: 'recorded' },
    '2026-09-23': { price: 772.79, status: 'recorded' },
    '2026-09-24': { price: null, status: 'not yet recorded' },
    '2026-09-25': { price: null, status: 'not yet recorded' },
  })
  assert.equal(asked.length, 1)
  // Tomorrow is never asked for; today is, since the row appears after the close.
  assert.match(asked[0], /fromdate=2026-09-22&todate=2026-09-25/)

  // Recorded opens are kept, and today is not asked again within five minutes.
  await opens('SPY', ['2026-09-22', '2026-09-24'])
  assert.equal(asked.length, 1)

  const nvda = await opens('NVDA', ['2026-09-21', '2026-09-18'])
  assert.deepEqual(nvda.get('2026-09-21'), { price: 222.935, status: 'recorded' })
  // A past day Nasdaq has no row for is unavailable, not "not yet".
  assert.deepEqual(nvda.get('2026-09-18'), { price: null, status: 'unavailable' })
  assert.deepEqual(
    asked.slice(1).map((u) => new URL(u).searchParams.get('assetclass')),
    ['stocks', 'etf'],
  )
  // Past dates are still asked through today: a range ending in the past gets
  // only Nasdaq's last month or so of it.
  assert.match(asked[1], /fromdate=2026-09-18&todate=2026-09-25&limit=8$/)

  // A Nasdaq that does not answer leaves past days unavailable.
  const down = createOpens({ fetchJson: async () => null, clock: () => ny(24, 12, 40) * 1000 })
  assert.deepEqual((await down('PFE', ['2026-09-23'])).get('2026-09-23'), { price: null, status: 'unavailable' })
})

// ------------------------------------------------------------------ gap, summary

const stubOpens =
  (table: Record<string, number>): Opens =>
  async (underlying, dates) =>
    new Map(
      dates.map((d) => [
        d,
        table[`${underlying} ${d}`] !== undefined
          ? { price: table[`${underlying} ${d}`], status: 'recorded' as const }
          : { price: null, status: 'not yet recorded' as const },
      ]),
    )

test('the gap is positive when the buy paid more than the open, and the summary is over compared buys only', async () => {
  assert.ok(Math.abs(gapBps(101, 100) - 100) < 1e-9)
  assert.ok(gapBps(99, 100) < 0)
  assert.equal(quantile([], 0.5), null)
  assert.equal(quantile([1, 2, 3, 4], 0.5), 2.5)
  assert.equal(quantile([1, 2, 3, 4], 0.25), 1.75)

  const scaled = { multiplier: 1, newMultiplier: 1, effectiveAt: 0 }
  const legs = [
    // Wednesday 19:42, $780 a share against Thursday's (stubbed) $772.79 open.
    swap({ sig: 'evening', at: ny(23, 19, 42), usdc: 78_000_000n, stock: 10_000_000n }),
    // Tuesday pre-market, $770 a share against Tuesday's $774.03 open.
    swap({ sig: 'premarket', at: ny(22, 7), usdc: 77_000_000n, stock: 10_000_000n }),
    // Tuesday in session: no comparison.
    swap({ sig: 'session', at: ny(22, 11), usdc: 77_000_000n, stock: 10_000_000n }),
    // Thursday pre-market: its open is today's, not yet recorded.
    swap({ sig: 'today', at: ny(24, 8), usdc: 77_000_000n, stock: 10_000_000n }),
  ].map((tx) => priceBuy(buysIn(tx, STOCKS, WALLET).buys[0], SPYX, scaled))
  const buys = await withOpens(legs, stubOpens({ 'SPY 2026-09-24': 772.79, 'SPY 2026-09-22': 774.03 }))
  const by = Object.fromEntries(buys.map((b) => [b.signature, b]))

  assert.equal(by.evening.pricePerShare, 780)
  assert.equal(by.evening.gapBps, Math.round(gapBps(780, 772.79) * 10) / 10)
  assert.ok(by.evening.gapBps! > 0)
  assert.deepEqual(by.evening.nextOpen, { date: '2026-09-24', atEt: 'Thu 24 Sep 2026 09:30 ET', price: 772.79, status: 'recorded' })
  assert.ok(by.premarket.gapBps! < 0)
  assert.equal(by.session.nextOpen, null)
  assert.equal(by.session.gapBps, null)
  // The stub has 2026-09-24 recorded, so point "today" at a date it does not know.
  const today = (await withOpens([{ ...by.today, nextOpen: { ...by.today.nextOpen!, date: '2026-09-25' } }], stubOpens({})))[0]
  assert.equal(today.nextOpen!.status, 'not yet recorded')
  assert.equal(today.gapBps, null)

  const s = summarize([...buys.filter((b) => b.signature !== 'today'), today])
  assert.equal(s.buys, 4)
  assert.equal(s.regular, 1)
  assert.equal(s.outside, 3)
  assert.equal(s.compared, 2)
  assert.equal(s.notYetRecorded, 1)
  assert.equal(s.paidMore, 1)
  assert.equal(s.medianGapBps, Math.round(((by.evening.gapBps! + by.premarket.gapBps!) / 2) * 10) / 10)
  assert.equal(s.worst!.signature, 'evening')
  assert.equal(s.inexact, 0)
  // A buy whose multiplier cannot be vouched for is shown but not counted.
  const marked = summarize([{ ...by.evening, multiplierExact: false }, by.premarket])
  assert.deepEqual([marked.compared, marked.inexact, marked.medianGapBps], [1, 1, by.premarket.gapBps])
  assert.equal(summarize([]).medianGapBps, null)
  assert.equal(summarize([]).worst, null)
})

// ---------------------------------------------------------------- the lookup

const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'
const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64')

/**
 * A stand-in mainnet. `txs` are the wallet's own latest signatures (plus any
 * `failed`); `accounts` are its stock accounts, each with its own history,
 * which may hold transactions the wallet's own list does not.
 */
function fakeChain(
  txs: MainnetTx[],
  opts: { failed?: string[]; gate?: Promise<void>; accounts?: { account: string; mint: string; txs: MainnetTx[] }[] } = {},
) {
  const calls: { method: string; params: unknown[] }[] = []
  const all = [...txs, ...(opts.accounts ?? []).flatMap((a) => a.txs)]
  const sigsOf = (list: MainnetTx[]) =>
    list.map((t) => ({ signature: t.transaction.signatures[0], err: null, blockTime: t.blockTime }))
  const rpc: Rpc = async (method, params) => {
    calls.push({ method, params })
    if (opts.gate) await opts.gate
    if (method === 'getMultipleAccounts') {
      const keys = params[0] as string[]
      return {
        value: keys.map((k) => ({
          data: [b64(k === SPYX.mainnetMint ? scaledMint(1.0057, 1.0057, 0) : new Uint8Array(82)), 'base64'],
          owner: TOKEN_2022,
        })),
      }
    }
    if (method === 'getTokenAccountsByOwner') {
      assert.deepEqual(params[1], { programId: TOKEN_2022 })
      return {
        value: [
          // An account of a token this list does not carry is ignored.
          { pubkey: key(40), account: { data: [b64(new PublicKey(BONK).toBytes()), 'base64'] } },
          ...(opts.accounts ?? []).map((a) => ({
            pubkey: a.account,
            account: { data: [b64(new PublicKey(a.mint).toBytes()), 'base64'] },
          })),
        ],
      }
    }
    if (method === 'getSignaturesForAddress') {
      const account = opts.accounts?.find((a) => a.account === params[0])
      if (account) return sigsOf(account.txs)
      return [
        ...sigsOf(txs),
        ...(opts.failed ?? []).map((signature) => ({ signature, err: { InstructionError: [0, 'Custom'] } })),
      ]
    }
    if (method === 'getTransaction') {
      assert.equal((params[1] as { maxSupportedTransactionVersion: number }).maxSupportedTransactionVersion, 1)
      return all.find((t) => t.transaction.signatures[0] === params[0]) ?? null
    }
    throw new Error(`unexpected ${method}`)
  }
  return { rpc, calls }
}

test('a lookup reads the latest signatures, prices the buys and keeps the answer for five minutes', async () => {
  let now = ny(24, 12, 40) * 1000
  const txs = [
    swap({ sig: 'evening', at: ny(23, 19, 42), usdc: 78_000_000n, stock: 10_000_000n }),
    swap({ sig: 'nvda', at: ny(19, 12), mint: NVDAX.mainnetMint, usdc: 45_000_000n, stock: 20_000_000n }),
    swap({ sig: 'sale', at: ny(22, 20), usdc: -10_000_000n, stock: -1_000_000n }),
  ]
  const { rpc, calls } = fakeChain(txs, { failed: ['failed-one'] })
  const overpay = createOverpay({
    rpc,
    listings: LISTINGS,
    opens: stubOpens({ 'SPY 2026-09-24': 772.79, 'NVDA 2026-09-21': 222.935 }),
    clock: () => now,
    limits: {},
  })

  const r = await overpay(WALLET)
  assert.equal(r.cluster, 'mainnet')
  assert.deepEqual(
    r.buys.map((b) => [b.signature, b.symbol]),
    [
      ['evening', 'SPYx'],
      ['nvda', 'NVDAx'],
    ],
  )
  // SPYx's multiplier came from its mint: 0.1 raw-scaled units are 0.10057 shares.
  assert.ok(Math.abs(r.buys[0].shares! - 0.10057) < 1e-12)
  assert.equal(r.buys[1].pricePerShare, 225)
  assert.equal(r.buys[1].window, 'closed day')
  assert.equal(r.buys[1].nextOpen!.date, '2026-09-21')
  assert.equal(r.summary.compared, 2)
  assert.deepEqual(r.scanned, {
    stockAccounts: 0,
    fromStockAccounts: 0,
    perAccount: 50,
    signatures: 4,
    limit: 100,
    failed: 1,
    read: 3,
    cap: 100,
    unreadable: 0,
    mixed: 0,
    stopped: null,
    oldest: new Date(ny(19, 12) * 1000).toISOString().replace('.000Z', 'Z'),
  })
  // The latest hundred signatures, and a failed transaction is never fetched.
  const sigCall = calls.find((c) => c.method === 'getSignaturesForAddress')!
  assert.deepEqual(sigCall.params, [WALLET, { limit: 100, commitment: 'confirmed' }])
  assert.equal(calls.filter((c) => c.method === 'getTransaction').length, 3)
  assert.equal(calls.filter((c) => c.method === 'getMultipleAccounts').length, 1)

  const before = calls.length
  now += 4 * 60_000
  assert.equal(await overpay(WALLET), r)
  assert.equal(calls.length, before)
  now += 2 * 60_000
  await overpay(WALLET)
  assert.ok(calls.length > before)
  // The mints are read at most every ten minutes, not per wallet.
  assert.equal(calls.filter((c) => c.method === 'getMultipleAccounts').length, 1)
})

test("a buy the wallet's own latest hundred miss is found through its stock account, read first", async () => {
  // A busy wallet: its own list is all noise from today, while the buy that
  // matters is days older and appears only in its SPYx account's history.
  const noise = Array.from({ length: 3 }, (_, i) => swap({ sig: `noise-${i}`, at: ny(24, 11, i), usdc: -1n, stock: -1n }))
  const buy = swap({ sig: 'weekend-buy', at: ny(19, 12), usdc: 77_000_000n, stock: 10_000_000n })
  const { rpc, calls } = fakeChain(noise, { accounts: [{ account: key(41), mint: SPYX.mainnetMint, txs: [buy, noise[0]] }] })
  const overpay = createOverpay({
    rpc,
    listings: LISTINGS,
    opens: stubOpens({ 'SPY 2026-09-21': 766.251 }),
    clock: () => ny(24, 12, 40) * 1000,
    limits: { transactions: 3 },
  })
  const r = await overpay(WALLET)
  assert.deepEqual(
    r.buys.map((b) => [b.signature, b.window, b.nextOpen!.date]),
    [['weekend-buy', 'closed day', '2026-09-21']],
  )
  // The stock account's two, then the wallet's own not already listed, up to the cap of three.
  assert.deepEqual(
    calls.filter((c) => c.method === 'getTransaction').map((c) => c.params[0]),
    ['noise-0', 'weekend-buy', 'noise-1'],
  )
  assert.deepEqual(
    { stockAccounts: r.scanned.stockAccounts, fromStockAccounts: r.scanned.fromStockAccounts, read: r.scanned.read, cap: r.scanned.cap },
    { stockAccounts: 1, fromStockAccounts: 2, read: 3, cap: 3 },
  )
  // Only the mint is fetched from each token account.
  const accountsCall = calls.find((c) => c.method === 'getTokenAccountsByOwner')!
  assert.deepEqual((accountsCall.params[2] as { dataSlice: unknown }).dataSlice, { offset: 0, length: 32 })
})

test('a lookup refuses a non-address, and a burst of wallets rather than queueing it', async () => {
  assert.equal(isAddress(WALLET), true)
  assert.equal(isAddress('not a wallet'), false)
  assert.equal(isAddress('0OIl' + WALLET.slice(4)), false)
  assert.equal(isAddress(WALLET.slice(0, 20)), false)

  let open!: () => void
  const gate = new Promise<void>((r) => (open = r))
  const { rpc } = fakeChain([], { gate })
  const overpay = createOverpay({ rpc, listings: LISTINGS, opens: stubOpens({}), limits: { concurrent: 1 } })
  await assert.rejects(overpay('nope'), (e: unknown) => e instanceof LookupError && e.code === 'bad-wallet')
  const first = overpay(WALLET)
  // The same wallet again joins the lookup already running.
  const again = overpay(WALLET)
  await assert.rejects(overpay(OTHER), (e: unknown) => e instanceof LookupError && e.code === 'busy')
  open()
  assert.equal(await first, await again)
})

test('reading stops at a rate limit that outlasts its retries, and keeps what it read', async () => {
  const tx = swap({ sig: 'one', at: ny(23, 20), usdc: 1n, stock: 1n })
  let n = 0
  const rpc: Rpc = async () => {
    n++
    if (n > 2) throw new RateLimited('getTransaction: rate limited')
    return tx
  }
  const r = await readTransactions(rpc, ['a', 'b', 'c', 'd', 'e'], { workers: 2, deadline: Infinity, clock: Date.now })
  assert.equal(r.txs.length, 2)
  assert.match(r.stopped!, /rate limit/)

  const late = await readTransactions(rpc, ['a'], { workers: 1, deadline: 0, clock: () => 1 })
  assert.match(late.stopped!, /ran out of time with 1/)
})

test('the transport waits out a 429 and retries, and gives up with RateLimited', async () => {
  const real = globalThis.fetch
  let hits = 0
  globalThis.fetch = (async () => {
    hits++
    return hits === 1
      ? new Response('slow down', { status: 429, headers: { 'retry-after': '0.01' } })
      : Response.json({ jsonrpc: '2.0', id: 1, result: 42 })
  }) as typeof fetch
  try {
    assert.equal(await httpRpc('http://rpc.invalid', { retries: 2 })('getSlot', []), 42)
    assert.equal(hits, 2)

    globalThis.fetch = (async () =>
      new Response('slow down', { status: 429, headers: { 'retry-after': '0.01' } })) as typeof fetch
    await assert.rejects(httpRpc('http://rpc.invalid', { retries: 1 })('getSlot', []), RateLimited)

    // Paced per method: two getSlots per 100 ms, so the third waits for the
    // window, while another method is not held up by them.
    globalThis.fetch = (async () => Response.json({ jsonrpc: '2.0', id: 1, result: 1 })) as typeof fetch
    const paced = httpRpc('http://rpc.invalid', { perWindow: 2, windowMs: 100, concurrency: 4 })
    const t0 = Date.now()
    const other = paced('getBlockTime', []).then(() => Date.now() - t0)
    await Promise.all([paced('getSlot', []), paced('getSlot', []), paced('getSlot', [])])
    assert.ok(Date.now() - t0 >= 95, `three getSlots took ${Date.now() - t0}ms`)
    assert.ok((await other) < 50, `getBlockTime waited ${await other}ms`)

    globalThis.fetch = (async () => Response.json({ jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'bad params' } })) as typeof fetch
    await assert.rejects(httpRpc('http://secret.invalid/?api-key=xyz')('getSlot', []), (e: Error) => {
      // The method and the reason, never the URL, which may hold a key.
      assert.equal(e.message, 'getSlot: bad params')
      return true
    })
  } finally {
    globalThis.fetch = real
  }
})

test('a deadline drops a queued call, refuses to wait out a 429 past it, and stops the reading', async () => {
  const real = globalThis.fetch
  try {
    // One slot, held by a slow call: a second call with a near deadline is
    // taken out of the queue rather than run after it.
    let release!: () => void
    const slow = new Promise<void>((r) => (release = r))
    let started = 0
    globalThis.fetch = (async () => {
      started++
      await slow
      return Response.json({ jsonrpc: '2.0', id: 1, result: 7 })
    }) as typeof fetch
    const rpc = httpRpc('http://rpc.invalid', { concurrency: 1 })
    const first = rpc('getSlot', [])
    await assert.rejects(rpc.until(Date.now() + 30)('getSlot', []), OutOfTime)
    release()
    assert.equal(await first, 7)
    assert.equal(started, 1)
    // The dropped call gave its place back: the next one runs.
    assert.equal(await rpc('getSlot', []), 7)

    // A 429 asking for ten seconds is not waited out with one second left.
    globalThis.fetch = (async () => new Response('slow down', { status: 429, headers: { 'retry-after': '10' } })) as typeof fetch
    const t0 = Date.now()
    await assert.rejects(httpRpc('http://rpc.invalid').until(Date.now() + 1_000)('getSlot', []), OutOfTime)
    assert.ok(Date.now() - t0 < 500)
    // Nor is the pace: a method whose window is full refuses a call it could only start too late.
    globalThis.fetch = (async () => Response.json({ jsonrpc: '2.0', id: 1, result: 1 })) as typeof fetch
    const paced = httpRpc('http://rpc.invalid', { perWindow: 1, windowMs: 10_000 })
    await paced('getSlot', [])
    await assert.rejects(paced.until(Date.now() + 200)('getSlot', []), OutOfTime)
  } finally {
    globalThis.fetch = real
  }

  // Reading treats running out of time as a stop, and counts what it left.
  let n = 0
  const tx = swap({ sig: 'one', at: ny(23, 20), usdc: 1n, stock: 1n })
  const late: Rpc = async () => {
    if (++n > 1) throw new OutOfTime('getTransaction: out of time')
    return tx
  }
  const r = await readTransactions(late, ['a', 'b', 'c'], { workers: 1, deadline: Infinity, clock: Date.now })
  assert.deepEqual([r.txs.length, r.unreadable, r.stopped], [1, 0, 'ran out of time with 2 transactions unread'])
})

test('the budget covers listing the stock accounts too: one that cannot be listed in time is counted, not fatal', async () => {
  let now = ny(24, 12, 40) * 1000
  const buy = swap({ sig: 'weekend-buy', at: ny(19, 12), usdc: 77_000_000n, stock: 10_000_000n })
  const { rpc: base } = fakeChain([buy], {
    accounts: [
      { account: key(41), mint: SPYX.mainnetMint, txs: [buy] },
      { account: key(42), mint: NVDAX.mainnetMint, txs: [] },
    ],
  })
  // The second account's history is the call that takes the clock past the budget.
  const rpc: Rpc = async (method, params) => {
    if (method === 'getSignaturesForAddress' && params[0] === key(42)) {
      now += 60_000
      throw new OutOfTime('getSignaturesForAddress: out of time')
    }
    return base(method, params)
  }
  const overpay = createOverpay({ rpc, listings: LISTINGS, opens: stubOpens({ 'SPY 2026-09-21': 766.251 }), clock: () => now })
  const r = await overpay(WALLET)
  // Past the deadline no transaction is fetched, and the report says why.
  assert.equal(r.scanned.read, 0)
  assert.equal(r.scanned.stockAccounts, 2)
  assert.match(r.scanned.stopped!, /^1 of 2 stock accounts' histories could not be listed; ran out of time with 1 transactions unread$/)
})

test('the route validates the wallet and never passes an internal error to the visitor', async () => {
  const real = globalThis.fetch
  const realError = console.error
  const logged: unknown[] = []
  console.error = (...a: unknown[]) => void logged.push(a)
  globalThis.fetch = (async () =>
    Response.json({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'node 10.0.0.7 panicked at src/rpc.rs:42' } })) as typeof fetch
  try {
    const { GET } = await import('../web/app/api/overpay/route.ts')
    const bad = await GET(new Request('http://x/api/overpay?wallet=' + 'x'.repeat(5000)))
    assert.equal(bad.status, 400)
    assert.deepEqual(await bad.json(), { ok: false, message: 'That is not a Solana address.' })

    const res = await GET(new Request(`http://x/api/overpay?wallet=${WALLET}`))
    assert.equal(res.status, 503)
    const body = (await res.json()) as { message: string }
    assert.doesNotMatch(body.message, /panicked|10\.0\.0\.7|getMultipleAccounts/)
    assert.equal(logged.length, 1)
  } finally {
    globalThis.fetch = real
    console.error = realError
  }
})
