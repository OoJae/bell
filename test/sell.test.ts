/**
 * Sell orders, client side: the encoders, the account lists, and the pricing
 * that has to agree with `fill_sell_order` to the unit.
 *
 * The pricing numbers are the ones `programs/bell-session/tests/test_sell.rs`
 * pins against the program, worked through the TypeScript mirrors here. If a
 * mirror drifts from sell.rs, a filler built on it pays one unit short and is
 * refused on chain, so the two test files are meant to be read side by side.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { Keypair, PublicKey, type TransactionInstruction } from '@solana/web3.js'
import idl from '../src/chain/idl.json' with { type: 'json' }
import {
  PROGRAM_ID,
  accountDiscriminator,
  decodeSellOrder,
  encodeCancelSellOrder,
  encodeFillOrder,
  encodeFillSellOrder,
  encodePlaceOrder,
  encodePlaceSellOrder,
  mulShr64Ceil,
  rateQ64,
  sellBandOut,
  sellLimitFloor,
  sellLossFloor,
  sellMinOut,
  sellOrderValue,
  stockToQuoteCeil,
  type SellOrder,
} from '../src/chain/codec.ts'
import {
  authPda,
  ixCancelOrder,
  ixCancelSellOrder,
  ixFillOrder,
  ixFillSellOrder,
  ixPlaceOrder,
  ixPlaceSellOrder,
  markPda,
  orderPda,
  readSellOrders,
  riskPda,
  sellOrderPda,
  symbolPda,
  TOKEN_2022,
  TOKEN_PROGRAM,
} from '../src/chain/client.ts'
import { LOSS_FLOOR, minPricePerShare, sellOrderFloor, sharesToRaw } from '../src/policy/order.ts'
import { fromBase58 } from '../web/lib/tape.ts'

const Q64 = 1n << 64n
/** One share of an 8-decimal stock, in raw units. */
const SHARE = 100_000_000n
/** test_sell.rs's AAPLx mark: 299,401 stock raw per 1,000,000 quote raw, about $334 a share. */
const AAPL_RATE = (299_401n << 64n) / 1_000_000n

// ------------------------------------------------------------------- pricing

test('the fair value and the band round up, matching the numbers test_sell.rs works by hand', () => {
  // 1e8 × 1e6 / 299,401 = 334,000,220.4 quote raw; the ceiling owes the seller the fraction.
  assert.equal(stockToQuoteCeil(SHARE, AAPL_RATE), 334_000_221n)
  // 30bps under it is 332,998,220.37, rounded up.
  assert.equal(sellBandOut(SHARE, AAPL_RATE, 30), 332_998_221n)
  // A floor of exactly $334 a share: 3.34 quote raw per stock raw, in Q64.
  const floor334 = (334_000_000n << 64n) / SHARE
  assert.equal(mulShr64Ceil(SHARE, floor334), 334_000_000n)
  // With a 500bps band the floor binds, not the band.
  assert.equal(sellMinOut(SHARE, AAPL_RATE, 500, 0n), 317_300_210n)
  assert.equal(sellMinOut(SHARE, AAPL_RATE, 500, floor334), 334_000_000n)
})

test('a six-decimal stock and a rate above 2^64 price as the program prices them', () => {
  // Backpack's PFE at $25: the Q64 rate truncates a hair under 1/25, which makes
  // ten shares worth a hair over $250, and the ceiling owes the whole unit.
  const pfe = Q64 / 25n
  assert.equal(stockToQuoteCeil(10_000_000n, pfe), 250_000_001n)
  assert.equal(sellBandOut(10_000_000n, pfe, 30), 249_250_001n)
  // An 8-decimal stock at $25 is four stock raw per quote raw: a rate past 2^64,
  // where `(num + rate - 1) / rate` would overflow in the program's u128.
  const four = 4n << 64n
  assert.equal(stockToQuoteCeil(SHARE, four), 25_000_000n)
  assert.equal(sellBandOut(SHARE, four, 30), 24_925_000n)
})

test('rounding up never rounds a whole number, and never goes the buyer’s way', () => {
  // Exact quotients stay exact: the ceiling adds a unit only for a remainder.
  assert.equal(stockToQuoteCeil(3n, Q64), 3n)
  assert.equal(mulShr64Ceil(5n, Q64), 5n)
  assert.equal(mulShr64Ceil(1n, 1n), 1n, 'any fraction is a whole unit owed')
  assert.equal(mulShr64Ceil(0n, Q64 * 7n), 0n)
  // Against the plain quotient, the ceiling is never lower and at most one higher.
  for (const leg of [1n, 7n, 99_999_999n, SHARE, 299_401_000n]) {
    for (const rate of [AAPL_RATE, Q64 / 25n, 4n << 64n, 3n]) {
      const exactDown = (leg << 64n) / rate
      const up = stockToQuoteCeil(leg, rate)
      assert.ok(up === exactDown || up === exactDown + 1n, `${leg} at ${rate}`)
      assert.ok(sellBandOut(leg, rate, 30) <= up)
    }
  }
})

test('the mirrors refuse where the program refuses, instead of carrying on in BigInt', () => {
  // A never-pushed mark has a zero rate: MarkStale on chain.
  assert.throws(() => stockToQuoteCeil(SHARE, 0n), /MarkStale/)
  assert.throws(() => sellOrderValue(SHARE, 0n), /MarkStale/)
  // `checked_mul` on u128: one step past the edge overflows.
  const edge = (1n << 128n) / SHARE
  assert.doesNotThrow(() => mulShr64Ceil(SHARE, edge - 1n))
  assert.throws(() => mulShr64Ceil(SHARE, edge + 1n), /MathOverflow/)
})

test('partial fills can owe the seller one unit more than one fill, never less', () => {
  // test_sell.rs fills two fifths then three fifths of a share.
  const first = sellBandOut((SHARE * 2n) / 5n, AAPL_RATE, 30)
  const rest = sellBandOut((SHARE * 3n) / 5n, AAPL_RATE, 30)
  assert.equal(first + rest, 332_998_222n)
  assert.equal(sellBandOut(SHARE, AAPL_RATE, 30), 332_998_221n)
})

test('the value cap is a quote amount, rounded down, and binds at exactly $1,000', () => {
  // 299,401,000 raw AAPLx, 2.99401 shares, is worth exactly $1,000 at this mark.
  assert.equal(sellOrderValue(299_401_000n, AAPL_RATE), 1_000_000_000n)
  assert.equal(sellOrderValue(299_401_001n, AAPL_RATE), 1_000_000_003n)
  // The same raw count as a buy's cap is ten shares, well over it.
  assert.ok(sellOrderValue(1_000_000_000n, AAPL_RATE) > 1_000_000_000n)
})

// -------------------------------------------------------------------- floors

test('the sell loss floor is the buy side’s three quarters, from below', () => {
  // The same fraction as LOSS_FLOOR, so the two sides cannot disagree about it.
  assert.equal(sellLossFloor(AAPL_RATE), (LOSS_FLOOR.num << 128n) / (LOSS_FLOOR.den * AAPL_RATE))
  assert.equal(sellLossFloor(0n), 0n)
  // Three quarters of 334,000,220.4 is 250,500,165.3; the floor rounds the
  // rate down by under a unit in 2^64 and the fill rounds the product up.
  assert.equal(mulShr64Ceil(SHARE, sellLossFloor(AAPL_RATE)), 250_500_166n)
})

test('a forged near-zero price cannot sell below the loss floor', () => {
  // A leaked attestor could push a mark that says the stock is worth almost
  // nothing: stock per quote a thousand times too high. The band follows it
  // down to dust; the floor, fixed at placement, does not.
  const forged = AAPL_RATE * 1000n
  const band = sellBandOut(SHARE, forged, 30)
  const floor = mulShr64Ceil(SHARE, sellLossFloor(AAPL_RATE))
  assert.ok(floor > band * 700n)
  assert.equal(sellMinOut(SHARE, forged, 30, sellLossFloor(AAPL_RATE)), floor)
})

/** A mark as the keeper pushes one: the rate from `rateQ64`, the price in micro-dollars. */
const markAt = (price: number, multiplier: number, stockDecimals: number) => ({
  rate: rateQ64({ pricePerShare: price, multiplier, quoteDecimals: 6, stockDecimals }),
  px: { num: BigInt(Math.round(price * 1e6)), expo: -6 },
})

test('a minimum price becomes the floor that keeps the sale at or above it', () => {
  // The formula as the design states it, worked independently.
  const px = { num: 334_000_221n, expo: -6 }
  const den = px.num * AAPL_RATE
  const want = ((334_000_000n << 128n) + den - 1n) / den
  assert.equal(sellLimitFloor(334, px, AAPL_RATE), want)
  assert.equal(mulShr64Ceil(SHARE, want), 334_000_000n)

  // Across prices, multipliers, decimals and sizes, with marks built the way
  // the keeper builds them, the least a fill may pay per share is never under
  // the limit by more than the mark's own rounding.
  for (const [price, multiplier, decimals] of [
    [334, 1, 8],
    [772.617876, 1.005714560286254, 8],
    [25.13, 1, 6],
    [0.87, 1, 8],
  ] as const) {
    const { rate, px } = markAt(price, multiplier, decimals)
    for (const limit of [price, price * 0.9, price * 1.07, 1.01]) {
      const f = sellLimitFloor(limit, px, rate)
      for (const leg of [1n, 12_345n, 10n ** BigInt(decimals), 3n * 10n ** BigInt(decimals)]) {
        const paid = Number(mulShr64Ceil(leg, f)) / 1e6
        const shares = (Number(leg) / 10 ** decimals) * multiplier
        assert.ok(paid >= limit * shares * (1 - 1e-8), `${price} limit ${limit} leg ${leg}: ${paid} < ${limit * shares}`)
      }
    }
  }

  // No limit, or nonsense, means no limit floor.
  assert.equal(sellLimitFloor(0, px, AAPL_RATE), 0n)
  assert.equal(sellLimitFloor(Number.NaN, px, AAPL_RATE), 0n)
  assert.equal(sellLimitFloor(334, px, 0n), 0n)
  // A limit too large for a u128 floor is refused rather than truncated into a smaller one.
  assert.throws(() => sellLimitFloor(1e40, px, AAPL_RATE), /too large/)
})

test('the sell floor is the stricter of the loss cap and the minimum, never looser', () => {
  const { rate, px } = markAt(400, 1, 8)
  // A minimum under the loss cap's price ($300) cannot loosen it.
  assert.equal(sellOrderFloor(rate, px, 250), sellLossFloor(rate))
  assert.equal(sellOrderFloor(rate, px, null), sellLossFloor(rate))
  // A minimum above it tightens it.
  assert.equal(sellOrderFloor(rate, px, 390), sellLimitFloor(390, px, rate))
  assert.ok(sellOrderFloor(rate, px, 390) > sellLossFloor(rate))
  // Without a mark there is nothing to convert against.
  assert.equal(sellOrderFloor(null, null, 390), 0n)
  assert.equal(sellOrderFloor(0n, px, 390), 0n)
})

test('the least you can be paid per share is the higher of the minimum and the loss cap', () => {
  assert.equal(minPricePerShare(600, null), 450)
  assert.equal(minPricePerShare(600, 500), 500)
  assert.equal(minPricePerShare(600, 400), 450)
})

test('shares become raw units through the multiplier, rounded down, parsed as decimals', () => {
  assert.equal(sharesToRaw('1', 8, 1), SHARE)
  // As a float, 0.29 × 1e8 is 28,999,999.999999996; as text it is exact.
  assert.equal(sharesToRaw('0.29', 8, 1), 29_000_000n)
  assert.equal(sharesToRaw('1.123456789', 8, 1), 112_345_678n, 'past the mint’s decimals is truncated')
  assert.equal(sharesToRaw('10', 6, 1), 10_000_000n)
  // SPYx's dividend multiplier: half a share is fewer raw units than half of 1e8.
  assert.equal(sharesToRaw('0.5', 8, 1.005714560286254), 49_715_895n)
  for (const bad of ['', 'abc', '-1', '1e3', '.5']) assert.throws(() => sharesToRaw(bad, 8, 1), /share count/, bad)
  assert.throws(() => sharesToRaw('1', 8, 0), /multiplier/)
})

// ----------------------------------------------------------------- encoding

const sha8 = (preimage: string) => [...createHash('sha256').update(preimage).digest().subarray(0, 8)]
const ixIdl = (name: string) => {
  const found = idl.instructions.find((i) => i.name === name)
  assert.ok(found, `${name} missing from the IDL`)
  return found
}

test('the IDL copy carries the sell discriminators Anchor derives, not stale ones', () => {
  // Recomputed from Anchor's preimages, so a hand-edited or stale idl.json is caught.
  for (const name of ['place_sell_order', 'fill_sell_order', 'cancel_sell_order']) {
    assert.deepEqual(ixIdl(name).discriminator, sha8(`global:${name}`), name)
  }
  assert.deepEqual([...accountDiscriminator('SellOrder')], sha8('account:SellOrder'))
  assert.deepEqual(idl.events.find((e) => e.name === 'SellOrderFilled')?.discriminator, sha8('event:SellOrderFilled'))
})

const placeArgs = {
  symbol: new Uint8Array(12).fill(0x41),
  nonce: 42n,
  amountIn: 2n ** 64n - 1n,
  minFillIn: 12_345n,
  maxSlipBps: 30,
  maxConfBps: 50,
  floorRateQ64: 2n ** 128n - 1n,
  notBefore: -1n,
  expiresAt: 1_790_600_000n,
}

test('a sell encodes to its buy’s bytes under its own discriminator', () => {
  const sell = encodePlaceSellOrder(placeArgs)
  const buy = encodePlaceOrder(placeArgs)
  assert.deepEqual([...sell.subarray(0, 8)], ixIdl('place_sell_order').discriminator)
  assert.deepEqual(sell.subarray(8), buy.subarray(8))
  assert.equal(sell.length, 8 + 12 + 8 * 3 + 2 * 2 + 16 + 8 * 2)

  const fill = { amountInLeg: 2n ** 63n + 5n, amountOut: 332_998_221n }
  const sellFill = encodeFillSellOrder(fill)
  assert.deepEqual([...sellFill.subarray(0, 8)], ixIdl('fill_sell_order').discriminator)
  assert.deepEqual(sellFill.subarray(8), encodeFillOrder(fill).subarray(8))
  assert.deepEqual([...encodeCancelSellOrder()], ixIdl('cancel_sell_order').discriminator)
})

const OWNER = new PublicKey('9wNeE9MRMa8SwH6BAmYw9cDnvwReGUgnEcxNmpsCbeEJ')
const MINT = new PublicKey('Fpd6EgE5KJgN5UZgKtABNtgP3Be2RNktdFheJSwLTCHC')
const QUOTE = new PublicKey('8QhSxevJerJq8khpNsfW69bUPvcBjMRTXPKrxYQAtAaX')

/** A SellOrder account's bytes, field by field in the order state.rs declares them. */
function sellOrderBytes(disc: Iterable<number>, o: SellOrder): Uint8Array {
  const b = new Uint8Array(8 + 32 + 12 + 32 * 4 + 8 * 4 + 2 * 2 + 16 + 8 * 4 + 2)
  const d = new DataView(b.buffer)
  let at = 0
  const put = (bytes: Uint8Array) => { b.set(bytes, at); at += bytes.length }
  const u64 = (v: bigint) => { d.setBigUint64(at, v, true); at += 8 }
  const i64 = (v: bigint) => { d.setBigInt64(at, v, true); at += 8 }
  put(Uint8Array.from(disc))
  put(o.owner.toBytes())
  put(new TextEncoder().encode(o.symbol.padEnd(12, ' ')))
  put(o.mint.toBytes()); put(o.quoteMint.toBytes()); put(o.payerIn.toBytes()); put(o.payeeOut.toBytes())
  u64(o.amountIn); u64(o.filledIn); u64(o.minFillIn); u64(o.expectedMultiplierBits)
  d.setUint16(at, o.maxSlipBps, true); at += 2
  d.setUint16(at, o.maxConfBps, true); at += 2
  u64(o.floorRateQ64 & (Q64 - 1n)); u64(o.floorRateQ64 >> 64n)
  i64(o.notBefore); i64(o.expiresAt); u64(o.nonce); i64(o.createdAt)
  b[at++] = o.bump
  b[at++] = o.authBump
  assert.equal(at, b.length)
  return b
}

const stock = Keypair.generate().publicKey
const proceeds = Keypair.generate().publicKey
const order: SellOrder = {
  owner: OWNER,
  symbol: 'AAPLx',
  mint: MINT,
  quoteMint: QUOTE,
  payerIn: stock,
  payeeOut: proceeds,
  amountIn: SHARE,
  filledIn: SHARE / 4n,
  minFillIn: SHARE / 4n,
  expectedMultiplierBits: 4_607_208_154_891_593_168n,
  maxSlipBps: 30,
  maxConfBps: 50,
  floorRateQ64: sellLossFloor(AAPL_RATE),
  notBefore: 0n,
  expiresAt: 1_790_600_000n,
  nonce: 1_790_000_000_123n,
  createdAt: 1_790_000_000n,
  bump: 254,
  authBump: 253,
}

test('a SellOrder decodes field for field, and a BellOrder is refused rather than read as one', () => {
  assert.deepEqual(decodeSellOrder(sellOrderBytes(accountDiscriminator('SellOrder'), order)), order)
  // Past the discriminator the two layouts are identical, which is exactly why
  // the decoder has to look at it.
  assert.throws(() => decodeSellOrder(sellOrderBytes(accountDiscriminator('BellOrder'), order)), /not a SellOrder/)
  assert.throws(() => decodeSellOrder(new Uint8Array(4)), /not a SellOrder/)
})

// ------------------------------------------------------------------ accounts

test('a sell lives at its own address, so a buy and a sell can share a nonce', () => {
  const n = new Uint8Array(8)
  new DataView(n.buffer).setBigUint64(0, order.nonce, true)
  const [want] = PublicKey.findProgramAddressSync([Buffer.from('sell'), OWNER.toBytes(), n], PROGRAM_ID)
  assert.equal(sellOrderPda(OWNER, order.nonce).toBase58(), want.toBase58())
  assert.notEqual(sellOrderPda(OWNER, order.nonce).toBase58(), orderPda(OWNER, order.nonce).toBase58())
  // The seed is the IDL's constant, not a string this file happens to agree with.
  const seed = idl.constants.find((c) => c.name === 'SELL_SEED')
  assert.equal(Buffer.from(JSON.parse(seed!.value) as number[]).toString(), 'sell')
})

/**
 * Accounts a builder marks writable though the IDL does not ask it to. The
 * filler signs and pays the fee, so it is writable in any transaction it sends
 * whatever the flag says; `ixFillOrder` has always marked it so, and the sell
 * builder keeps that rather than differ from its buy for no effect.
 */
const WRITABLE_BY_CHOICE: Record<string, string[]> = { fill_sell_order: ['filler'] }

/** Each account's signer and writable flags, as the IDL declares them and as the builder emits them. */
function assertMatchesIdl(ix: TransactionInstruction, name: string) {
  const want = ixIdl(name).accounts
  assert.equal(ix.keys.length, want.length, `${name}: account count`)
  want.forEach((a, i) => {
    const got = ix.keys[i]!
    const writable = Boolean((a as { writable?: boolean }).writable) || (WRITABLE_BY_CHOICE[name] ?? []).includes(a.name)
    assert.equal(got.isSigner, Boolean((a as { signer?: boolean }).signer), `${name}.${a.name} signer`)
    assert.equal(got.isWritable, writable, `${name}.${a.name} writable`)
  })
  assert.ok(ix.programId.equals(PROGRAM_ID))
}

test('each sell instruction names the IDL’s accounts, in its order, with its flags', () => {
  const filler = Keypair.generate().publicKey
  const fillerStock = Keypair.generate().publicKey
  const fillerQuote = Keypair.generate().publicKey

  const place = ixPlaceSellOrder({ ...order, owner: OWNER, symbol: 'AAPLx', mint: MINT })
  assertMatchesIdl(place, 'place_sell_order')
  const at = (ix: TransactionInstruction, name: string, account: string) =>
    ix.keys[ixIdl(name).accounts.findIndex((a) => a.name === account)]!.pubkey.toBase58()
  assert.equal(at(place, 'place_sell_order', 'order'), sellOrderPda(OWNER, order.nonce).toBase58())
  assert.equal(at(place, 'place_sell_order', 'payer_in'), stock.toBase58(), 'the stock account is what pays')
  assert.equal(at(place, 'place_sell_order', 'payee_out'), proceeds.toBase58(), 'the quote account is what is paid')
  assert.equal(at(place, 'place_sell_order', 'symbol_state'), symbolPda('AAPLx').toBase58())
  assert.equal(at(place, 'place_sell_order', 'risk'), riskPda(MINT).toBase58())
  assert.equal(at(place, 'place_sell_order', 'mark'), markPda('AAPLx').toBase58())
  assert.deepEqual(place.data, encodePlaceSellOrder({ ...order, symbol: Buffer.from('AAPLx       ') }))

  const fill = ixFillSellOrder({ filler, order, fillerIn: fillerStock, fillerOut: fillerQuote, amountInLeg: SHARE, amountOut: 1n })
  assertMatchesIdl(fill, 'fill_sell_order')
  assert.equal(at(fill, 'fill_sell_order', 'order'), sellOrderPda(OWNER, order.nonce).toBase58())
  assert.equal(at(fill, 'fill_sell_order', 'auth'), authPda(OWNER).toBase58())
  assert.equal(at(fill, 'fill_sell_order', 'filler_in'), fillerStock.toBase58(), 'the filler receives stock')
  assert.equal(at(fill, 'fill_sell_order', 'filler_out'), fillerQuote.toBase58(), 'the filler pays quote')
  assert.equal(at(fill, 'fill_sell_order', 'quote_token_program'), TOKEN_PROGRAM.toBase58())
  assert.equal(at(fill, 'fill_sell_order', 'stock_token_program'), TOKEN_2022.toBase58())
  // Everything but the order's address is the buy builder's, key for key.
  const buyFill = ixFillOrder({ filler, order, fillerIn: fillerStock, fillerOut: fillerQuote, amountInLeg: SHARE, amountOut: 1n })
  const differs = fill.keys.flatMap((k, i) => (k.pubkey.equals(buyFill.keys[i]!.pubkey) ? [] : [i]))
  assert.deepEqual(differs, [ixIdl('fill_sell_order').accounts.findIndex((a) => a.name === 'order')])

  const cancel = ixCancelSellOrder({ signer: filler, owner: OWNER, nonce: order.nonce, payerIn: stock })
  assertMatchesIdl(cancel, 'cancel_sell_order')
  assert.equal(at(cancel, 'cancel_sell_order', 'order'), sellOrderPda(OWNER, order.nonce).toBase58())
  assert.deepEqual(
    cancel.keys.map((k) => k.pubkey.toBase58()),
    ixCancelOrder({ signer: filler, owner: OWNER, nonce: order.nonce, payerIn: stock }).keys.map((k, i) =>
      i === 2 ? sellOrderPda(OWNER, order.nonce).toBase58() : k.pubkey.toBase58(),
    ),
  )
  // The buy builders are untouched: same instruction, same bytes as before sells.
  assert.deepEqual([...ixPlaceOrder({ ...order, owner: OWNER, symbol: 'AAPLx', mint: MINT }).data.subarray(0, 8)], ixIdl('place_order').discriminator)
})

test('the sell book is read by its own discriminator, and narrowed by owner on the node', async () => {
  const seen: { offset: number; bytes: string }[][] = []
  const conn = {
    async getProgramAccounts(program: PublicKey, config: { filters: { memcmp: { offset: number; bytes: string } }[] }) {
      assert.ok(program.equals(PROGRAM_ID))
      seen.push(config.filters.map((f) => f.memcmp))
      return [{ pubkey: sellOrderPda(OWNER, order.nonce), account: { data: Buffer.from(sellOrderBytes(accountDiscriminator('SellOrder'), order)) } }]
    },
  } as unknown as Parameters<typeof readSellOrders>[0]

  const all = await readSellOrders(conn)
  assert.deepEqual(all, [order])
  const mine = await readSellOrders(conn, OWNER)
  assert.deepEqual(mine, [order])

  assert.equal(seen[0]!.length, 1)
  assert.equal(seen[0]![0]!.offset, 0)
  assert.deepEqual([...fromBase58(seen[0]![0]!.bytes)], [...accountDiscriminator('SellOrder')])
  assert.deepEqual(seen[1]![1], { offset: 8, bytes: OWNER.toBase58() })
})

test('boundary vectors from a verbatim Rust copy of sell.rs agree with the mirrors, overflows included', () => {
  // Each row was produced by compiling fill_sell_order's arithmetic, copied
  // character for character from sell.rs, and running it on these inputs, so a
  // mirror that drifts at an edge the hand-worked numbers above never reach
  // fails here. The edges: a leg of one raw unit, the largest u64 leg, a rate
  // of 1 and of u128::MAX, a rate past 2^64, and the $1,000 cap boundary.
  const U64 = (1n << 64n) - 1n
  const U128 = (1n << 128n) - 1n
  const rows: [leg: bigint, rate: bigint, slip: number, floor: bigint, fair: bigint | 'MathOverflow', minOut: bigint | 'MathOverflow', value: bigint][] = [
    [1n, AAPL_RATE, 30, 0n, 4n, 4n, 3n],
    [1n, AAPL_RATE, 500, 0n, 4n, 4n, 3n],
    [1n, U128, 0, 0n, 1n, 1n, 0n],
    [U64, 1n, 0, 0n, 'MathOverflow', 'MathOverflow', 340_282_366_920_938_463_444_927_863_358_058_659_840n],
    [U64, Q64, 30, U128, U64, 'MathOverflow', U64],
    [299_401_000n, AAPL_RATE, 30, 0n, 1_000_000_001n, 997_000_001n, 1_000_000_000n],
    [299_401_001n, AAPL_RATE, 30, 0n, 1_000_000_004n, 997_000_004n, 1_000_000_003n],
    [1n, 4n << 64n, 30, 0n, 1n, 1n, 0n],
    [3n, 4n << 64n, 30, 0n, 1n, 1n, 0n],
  ]
  const attempt = (f: () => bigint): bigint | 'MathOverflow' => {
    try {
      return f()
    } catch (e) {
      assert.match((e as Error).message, /MathOverflow/)
      return 'MathOverflow'
    }
  }
  for (const [leg, rate, slip, floor, fair, minOut, value] of rows) {
    // The fair value alone cannot overflow (a << 64 always fits a u128); it is
    // the band's multiplication by 10,000 - slip that the program refuses.
    const f = stockToQuoteCeil(leg, rate)
    if (fair !== 'MathOverflow') assert.equal(f, fair, `fair ${leg} @ ${rate}`)
    assert.equal(attempt(() => sellMinOut(leg, rate, slip, floor)), minOut, `min_out ${leg} @ ${rate}`)
    assert.equal(sellOrderValue(leg, rate), value, `value ${leg} @ ${rate}`)
  }
  // An unpriced mark is MarkStale on both paths, as it is on chain.
  assert.throws(() => sellMinOut(1n, 0n, 30, 0n), /MarkStale/)
  assert.throws(() => sellOrderValue(1n, 0n), /MarkStale/)
})
