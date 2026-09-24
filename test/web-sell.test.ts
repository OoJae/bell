/**
 * The page's sell side: what `web/lib/queue.ts` asks a wallet to sign.
 *
 * The rule these tests hold is that a sale and a buy never share an approval.
 * A buy is funded by the wallet's quote account and a sale by its stock
 * account; each has one delegate slot, and `Approve` assigns rather than adds,
 * so a sale that approved the quote account would silently defund every buy.
 * The rest is the cancel order (revoke alone first, then close, then re-fund),
 * the emergency exit's order, and the "max" button's arithmetic.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { Keypair, PublicKey, Transaction, type TransactionInstruction } from '@solana/web3.js'
import {
  authPda,
  ixCancelOrder,
  ixCancelSellOrder,
  ixPlaceSellOrder,
  sellOrderPda,
} from '../src/chain/client.ts'
import { encodePlaceSellOrder, mulShr64Ceil, sellOrderValue, type BellOrder, type SellOrder } from '../src/chain/codec.ts'
import { ASSOCIATED_TOKEN_PROGRAM, ataFor, ixRevoke, TOKEN_2022, TOKEN_PROGRAM } from '../src/chain/spl.ts'
import { ALLOWLIST, symbolSeed } from '../src/config.ts'
import { orderExpiry } from '../src/policy/expiry.ts'
import { sellOrderFloor, sharesToRaw } from '../src/policy/order.ts'
import { explain } from '../web/lib/bell.ts'
import {
  cancelOrderTxs,
  cancelSellOrderTxs,
  MAX_ORDER_IN_RAW,
  maxSellRaw,
  packTransactions,
  placeSellInstructions,
  placeSellOrderTx,
  QUOTE_MINT,
  rawToShares,
  refusalFrom,
  revokeAllTxs,
  SELL_MAX_USD,
  sellFloorUsd,
  sharesShown,
} from '../web/lib/queue.ts'

const listing = ALLOWLIST.find((l) => l.symbol === 'AAPLx')!
const mint = new PublicKey(listing.mint)
/** 299,401 stock raw per 1,000,000 quote raw: about $334 a share at eight decimals, as in test_sell.rs. */
const RATE = (299_401n << 64n) / 1_000_000n
const PX = { num: 334_000_000n, expo: -6 }
const NOW = 1_790_000_000

const same = (a: TransactionInstruction, b: TransactionInstruction) =>
  a.programId.equals(b.programId) &&
  a.data.equals(b.data) &&
  a.keys.length === b.keys.length &&
  a.keys.every(
    (k, i) =>
      k.pubkey.equals(b.keys[i]!.pubkey) && k.isSigner === b.keys[i]!.isSigner && k.isWritable === b.keys[i]!.isWritable,
  )

/** A token instruction's discriminant: the first byte of its data. */
const op = (ix: TransactionInstruction) => ix.data[0]
const APPROVE_CHECKED = 13
const REVOKE = 5

function order(owner: PublicKey, nonce: bigint, over: Partial<SellOrder> = {}): SellOrder {
  return {
    owner,
    symbol: listing.symbol,
    mint,
    quoteMint: QUOTE_MINT,
    payerIn: ataFor(owner, mint, TOKEN_2022),
    payeeOut: ataFor(owner, QUOTE_MINT),
    amountIn: 50_000_000n,
    filledIn: 0n,
    minFillIn: 50_000_000n,
    expectedMultiplierBits: 0n,
    maxSlipBps: 30,
    maxConfBps: 50,
    floorRateQ64: 0n,
    notBefore: 0n,
    expiresAt: BigInt(NOW + 86_400),
    nonce,
    createdAt: BigInt(NOW),
    bump: 255,
    authBump: 255,
    ...over,
  }
}

// ------------------------------------------------------------------ placing

test('a sale approves the stock account under Token-2022, never the quote account', () => {
  const owner = Keypair.generate().publicKey
  const { ixs, approved, amountIn, floorRateQ64 } = placeSellInstructions({
    owner,
    listing,
    amountIn: 50_000_000n,
    decimals: 8,
    nonce: 7n,
    now: NOW,
    committed: 25_000_000n,
    markRateQ64: RATE,
    markPx: PX,
  })
  assert.equal(amountIn, 50_000_000n)
  assert.equal(approved, 75_000_000n, 'the approval covers the other live sales plus this one')

  const approvals = ixs.filter((ix) => (ix.programId.equals(TOKEN_PROGRAM) || ix.programId.equals(TOKEN_2022)) && op(ix) === APPROVE_CHECKED)
  assert.equal(approvals.length, 1, 'exactly one approval')
  const approve = approvals[0]!
  assert.ok(approve.programId.equals(TOKEN_2022), 'under Token-2022, where the stock lives')
  assert.ok(approve.keys[0]!.pubkey.equals(ataFor(owner, mint, TOKEN_2022)), 'on the stock account')
  assert.ok(approve.keys[1]!.pubkey.equals(mint), 'naming the stock mint')
  assert.ok(approve.keys[2]!.pubkey.equals(authPda(owner)), 'to the per-owner authority')
  const view = new DataView(approve.data.buffer, approve.data.byteOffset, approve.data.byteLength)
  assert.equal(view.getBigUint64(1, true), 75_000_000n)
  assert.equal(approve.data[9], 8, "at the stock's own decimals")

  // Nothing in the transaction may write to the quote account under the
  // token program: that account's approval is what funds the wallet's buys.
  const quote = ataFor(owner, QUOTE_MINT)
  for (const ix of ixs.filter((i) => i.programId.equals(TOKEN_PROGRAM) || i.programId.equals(TOKEN_2022))) {
    assert.ok(!ix.keys[0]!.pubkey.equals(quote), 'no token instruction touches the quote account')
  }

  // The proceeds have somewhere to land: the quote account, created
  // idempotently under plain SPL Token.
  const create = ixs.find((ix) => ix.programId.equals(ASSOCIATED_TOKEN_PROGRAM))!
  assert.ok(create.keys[1]!.pubkey.equals(quote))
  assert.ok(create.keys[3]!.pubkey.equals(QUOTE_MINT))
  assert.ok(create.keys[5]!.pubkey.equals(TOKEN_PROGRAM))
  assert.deepEqual([...create.data], [1], 'CreateIdempotent')

  // The approval comes before the order, which checks it.
  const place = ixs.at(-1)!
  assert.ok(ixs.indexOf(approve) < ixs.indexOf(place))
  assert.equal(floorRateQ64, sellOrderFloor(RATE, PX, null))
  const expected = ixPlaceSellOrder({
    owner,
    symbol: listing.symbol,
    mint,
    nonce: 7n,
    amountIn: 50_000_000n,
    minFillIn: 50_000_000n,
    maxSlipBps: 30,
    maxConfBps: 50,
    floorRateQ64,
    notBefore: 0n,
    expiresAt: BigInt(orderExpiry(NOW, null)),
    payerIn: ataFor(owner, mint, TOKEN_2022),
    payeeOut: quote,
  })
  assert.ok(same(place, expected), 'place_sell_order, as the CLI builds it')
  assert.ok(place.keys[4]!.pubkey.equals(sellOrderPda(owner, 7n)), "at the sale's own address")
})

test("a minimum price tightens the sale's floor, and the transaction fits", () => {
  const owner = Keypair.generate().publicKey
  const args = { owner, listing, amountIn: 100_000_000n, decimals: 8, nonce: 1n, now: NOW, markRateQ64: RATE, markPx: PX }
  const loose = placeSellInstructions(args).floorRateQ64
  const tight = placeSellInstructions({ ...args, minLimitUsd: 340 }).floorRateQ64
  assert.equal(tight, sellOrderFloor(RATE, PX, 340))
  assert.ok(tight > loose, 'a $340 minimum is above the loss cap at three quarters of $334')
  // A minimum under the loss cap cannot loosen it.
  assert.equal(placeSellInstructions({ ...args, minLimitUsd: 100 }).floorRateQ64, loose)
  // The data carries that floor exactly as the encoder writes it.
  const place = placeSellInstructions({ ...args, minLimitUsd: 340 }).ixs.at(-1)!
  assert.ok(
    place.data.equals(
      encodePlaceSellOrder({
        symbol: symbolSeed(listing.symbol),
        nonce: 1n,
        amountIn: 100_000_000n,
        minFillIn: 100_000_000n,
        maxSlipBps: 30,
        maxConfBps: 50,
        floorRateQ64: tight,
        notBefore: 0n,
        expiresAt: BigInt(orderExpiry(NOW, null)),
      }),
    ),
  )

  const { tx } = placeSellOrderTx({ ...args, minLimitUsd: 340 })
  tx.feePayer = owner
  tx.recentBlockhash = PublicKey.default.toBase58()
  assert.ok(tx.serializeMessage().length + 65 <= 1_232, `the sale is ${tx.serializeMessage().length + 65} bytes`)
})

test('the minimum the box promises is one the program enforces, rounded down to the cent', () => {
  // A price whose three quarters sits just under a cent boundary going up:
  // $223.022379 × 3/4 = $167.266784, which a rounded "$167.27" would overstate.
  const px = { num: 223_022_379n, expo: -6 }
  const rate = (10n ** 8n << 64n) / 223_022_379n
  const cases: [limit: number | null, shown: number][] = [
    [null, 167.26],
    [100, 167.26],
    [200, 200],
    [0.29 * 1000, 290],
    [223.02, 223.02],
  ]
  for (const [limit, shown] of cases) {
    const floor = sellOrderFloor(rate, px, limit)
    assert.equal(sellFloorUsd(floor, rate, px), shown, `limit ${limit}`)
    // The program's minimum for a leg, `mul_shr64_ceil(leg, floor)`, is never
    // under the promise a share, at any size of fill.
    for (const leg of [1n, 7n, 12_345n, 99_999_999n, 100_000_000n, 443_000_000n]) {
      const minOut = mulShr64Ceil(leg, floor)
      assert.ok(minOut * 100_000_000n * 100n >= BigInt(Math.round(shown * 100)) * 1_000_000n * leg, `limit ${limit}, leg ${leg}`)
    }
  }
  // And the order list agrees with the box for an order placed from it.
  assert.equal(sellFloorUsd(sellOrderFloor(RATE, PX, null), RATE, PX), 250.49)
  assert.equal(sellFloorUsd(0n, RATE, PX), 0)
})

// --------------------------------------------------------------- cancelling

test('cancelling a sale revokes the stock account alone, then closes, then re-approves the rest', () => {
  const owner = Keypair.generate().publicKey
  const o = order(owner, 9n)
  const txs = cancelSellOrderTxs(owner, o, 20_000_000n, true, 8)
  assert.equal(txs.length, 3)

  const [revoke, close, refund] = txs.map((t) => t.instructions)
  assert.equal(revoke!.length, 1, 'the revoke is alone, so nothing of BELL can roll it back')
  assert.ok(same(revoke![0]!, ixRevoke(o.payerIn, owner, TOKEN_2022)), 'on the stock account, under Token-2022')

  assert.equal(close!.length, 1)
  assert.ok(same(close![0]!, ixCancelSellOrder({ signer: owner, owner, nonce: 9n, payerIn: o.payerIn })))

  assert.equal(refund!.length, 1)
  const approve = refund![0]!
  assert.ok(approve.programId.equals(TOKEN_2022))
  assert.equal(op(approve), APPROVE_CHECKED)
  assert.ok(approve.keys[0]!.pubkey.equals(o.payerIn))
  assert.ok(approve.keys[1]!.pubkey.equals(mint))
  assert.ok(approve.keys[2]!.pubkey.equals(authPda(owner)))
  const view = new DataView(approve.data.buffer, approve.data.byteOffset, approve.data.byteLength)
  assert.equal(view.getBigUint64(1, true), 20_000_000n)
  assert.equal(approve.data[9], 8)
})

test('a sale that is already unfunded is only closed, and nothing is re-approved without decimals', () => {
  const owner = Keypair.generate().publicKey
  const o = order(owner, 9n)
  const onlyClose = cancelSellOrderTxs(owner, o, 20_000_000n, false, 8)
  assert.equal(onlyClose.length, 1)
  assert.ok(same(onlyClose[0]!.instructions[0]!, ixCancelSellOrder({ signer: owner, owner, nonce: 9n, payerIn: o.payerIn })))

  const noDecimals = cancelSellOrderTxs(owner, o, 20_000_000n, true, null)
  assert.equal(noDecimals.length, 2, 'revoke and close; a re-approval needs the decimals')
  assert.equal(cancelSellOrderTxs(owner, o, 0n, true, 8).length, 2, 'nothing left to re-approve')
})

test("a buy's cancel is untouched by sales: it still revokes the quote account under SPL Token", () => {
  const owner = Keypair.generate().publicKey
  const buy: BellOrder = { ...order(owner, 3n), payerIn: ataFor(owner, QUOTE_MINT), payeeOut: ataFor(owner, mint, TOKEN_2022) }
  const [revoke] = cancelOrderTxs(owner, buy, 0n, true)
  assert.ok(same(revoke!.instructions[0]!, ixRevoke(buy.payerIn, owner)))
  assert.ok(revoke!.instructions[0]!.programId.equals(TOKEN_PROGRAM))
})

// ------------------------------------------------------------ revoke all

/** `revokeAllTxs` as it was before sales existed, to hold the buy-only case to it byte for byte. */
function revokeAllBefore(owner: PublicKey, payerIn: PublicKey, book: readonly BellOrder[]): Transaction[] {
  const txs = [new Transaction().add(ixRevoke(payerIn, owner))]
  for (let i = 0; i < book.length; i += 6) {
    txs.push(
      new Transaction().add(
        ...book.slice(i, i + 6).map((o) => ixCancelOrder({ signer: owner, owner, nonce: o.nonce, payerIn: o.payerIn })),
      ),
    )
  }
  return txs
}

const bytes = (t: Transaction, payer: PublicKey) => {
  t.feePayer = payer
  t.recentBlockhash = PublicKey.default.toBase58()
  return t.serializeMessage()
}

test('with no sales, "revoke all" signs exactly what it signed before', () => {
  const owner = Keypair.generate().publicKey
  const quote = ataFor(owner, QUOTE_MINT)
  const book = Array.from({ length: 8 }, (_, i) => ({ ...order(owner, BigInt(i + 1)), payerIn: quote }))
  const { txs, revokes } = revokeAllTxs(owner, quote, book)
  const before = revokeAllBefore(owner, quote, book)
  assert.equal(revokes, 1)
  assert.equal(txs.length, before.length)
  txs.forEach((t, i) => assert.ok(bytes(t, owner).equals(bytes(before[i]!, owner)), `transaction ${i} changed`))
})

test('"revoke all" revokes the quote account alone first, then the stock accounts, then closes buys and sales', () => {
  const owner = Keypair.generate().publicKey
  const quote = ataFor(owner, QUOTE_MINT)
  const aapl = ataFor(owner, mint, TOKEN_2022)
  const spy = ataFor(owner, new PublicKey(ALLOWLIST[0]!.mint), TOKEN_2022)
  const buys = [1n, 2n].map((n) => ({ ...order(owner, n), payerIn: quote }))
  const sells = [1n, 5n].map((n) => order(owner, n))
  const { txs, revokes } = revokeAllTxs(owner, quote, buys, [aapl, spy], sells)

  assert.equal(revokes, 2)
  // The quote account's revoke is the first transaction, alone and unchanged.
  assert.equal(txs[0]!.instructions.length, 1)
  assert.ok(same(txs[0]!.instructions[0]!, ixRevoke(quote, owner)))
  // Then every stock account BELL may sell from, under Token-2022.
  const stock = txs[1]!.instructions
  assert.deepEqual(
    stock.map((ix) => [ix.programId.toBase58(), op(ix), ix.keys[0]!.pubkey.toBase58()]),
    [aapl, spy].map((a) => [TOKEN_2022.toBase58(), REVOKE, a.toBase58()]),
  )
  // Then every close, buys and sales alike, and nothing but closes.
  const closes = txs.slice(revokes).flatMap((t) => t.instructions)
  assert.equal(closes.length, 4)
  assert.ok(same(closes[0]!, ixCancelOrder({ signer: owner, owner, nonce: 1n, payerIn: quote })))
  assert.ok(same(closes[1]!, ixCancelOrder({ signer: owner, owner, nonce: 2n, payerIn: quote })))
  assert.ok(same(closes[2]!, ixCancelSellOrder({ signer: owner, owner, nonce: 1n, payerIn: aapl })))
  assert.ok(same(closes[3]!, ixCancelSellOrder({ signer: owner, owner, nonce: 5n, payerIn: aapl })))
  for (const t of txs) assert.ok(bytes(t, owner).length + 65 <= 1_232)
})

test('"revoke all" can leave the quote account alone and still revoke the stock first', () => {
  const owner = Keypair.generate().publicKey
  const aapl = ataFor(owner, mint, TOKEN_2022)
  const { txs, revokes } = revokeAllTxs(owner, null, [], [aapl], [order(owner, 4n)])
  assert.equal(revokes, 1)
  assert.ok(same(txs[0]!.instructions[0]!, ixRevoke(aapl, owner, TOKEN_2022)))
  assert.equal(txs.length, 2)
  assert.deepEqual(revokeAllTxs(owner, null, [], [], []), { txs: [], revokes: 0 })
})

// ------------------------------------------------------------------ max

test('"max" is what is held less what other sales offer, and never more than about $990', () => {
  // A small holding: everything not already offered.
  assert.equal(maxSellRaw({ held: 100_000_000n, owed: 40_000_000n, rateQ64: RATE }), 60_000_000n)
  assert.equal(maxSellRaw({ held: 100_000_000n, owed: 100_000_000n, rateQ64: RATE }), 0n)
  assert.equal(maxSellRaw({ held: 100_000_000n, owed: 150_000_000n, rateQ64: RATE }), 0n)
  assert.equal(maxSellRaw({ held: 100_000_000n, owed: 0n, rateQ64: null }), 0n, 'nothing to size against')

  // A large holding: capped by value, rounded down.
  const raw = maxSellRaw({ held: 10n ** 12n, owed: 0n, rateQ64: RATE })
  const cap = BigInt(SELL_MAX_USD) * 1_000_000n
  assert.ok(sellOrderValue(raw, RATE) <= cap, 'worth no more than the cap')
  assert.ok(sellOrderValue(raw + 1n, RATE) > cap || sellOrderValue(raw + 2n, RATE) > cap, 'and as much as fits under it')
  assert.ok(sellOrderValue(raw, RATE) < MAX_ORDER_IN_RAW, "under the program's $1,000")
  // About 2.96 shares of a $334 stock.
  assert.equal(rawToShares(raw, 8, 1).slice(0, 4), '2.96')

  // A rate above 2^64 (a stock under a dollar per raw quote unit) prices the same way.
  const cheap = 4n << 64n
  const r = maxSellRaw({ held: 10n ** 15n, owed: 0n, rateQ64: cheap })
  assert.equal(r, 3_960_000_000n)
  assert.equal(sellOrderValue(r, cheap), cap)
})

test('shares print so they read back as the same raw amount, and never as more', () => {
  assert.equal(rawToShares(0n, 8, 1), '0')
  assert.equal(rawToShares(1n, 8, 1), '0.00000001')
  assert.equal(rawToShares(100_000_000n, 8, 1), '1')
  assert.equal(rawToShares(150_000_000n, 8, 1), '1.5')
  assert.equal(rawToShares(29_000_000n, 8, 1), '0.29')
  assert.equal(rawToShares(12_345_678n, 6, 1), '12.345678')
  assert.equal(rawToShares(7n, 0, 1), '7')
  for (const raw of [1n, 3n, 29_000_000n, 299_401_000n, 123_456_789_012n]) {
    for (const [decimals, m] of [[8, 1], [8, 1.0187], [6, 0.9731], [8, 1.5], [6, 1]] as const) {
      const text = rawToShares(raw, decimals, m)
      const back = sharesToRaw(text, decimals, m)
      assert.ok(back <= raw, `${raw} at ${m} printed as ${text} reads back as ${back}`)
      assert.ok(raw - back <= 1n, `${raw} at ${m} lost ${raw - back} raw`)
      // At a multiplier of one or more every raw amount has a count of its own.
      if (m >= 1) assert.equal(back, raw, `${raw} at ${m} printed as ${text} reads back as ${back}`)
    }
  }
  // SPYx's devnet mirror, whose multiplier is 1.005714560286254: "max" there
  // printed 1.29618888 in the box and 1.29618887 in the order, a raw unit apart.
  const spyx = 1.005714560286254
  for (let raw = 128_882_000n; raw < 128_882_400n; raw++) {
    assert.equal(sharesToRaw(rawToShares(raw, 8, spyx), 8, spyx), raw)
  }
})

test('a typed share count is said back as typed, tidied, when the order carries exactly it', () => {
  const spyx = 1.005714560286254
  for (const typed of ['1.3', '0.5', '2', '0.29', '1.29618888']) {
    const raw = sharesToRaw(typed, 8, spyx)
    assert.equal(sharesShown(typed, raw, 8, spyx), typed)
  }
  assert.equal(sharesShown(' 1.500 ', sharesToRaw('1.5', 8, 1), 8, 1), '1.5')
  assert.equal(sharesShown('007', 700_000_000n, 8, 1), '7')
  assert.equal(sharesShown('3.', 300_000_000n, 8, 1), '3')
  // More places than the stock has: the order carries the truncated count, so that is what is said.
  assert.equal(sharesShown('0.123456789', 12_345_678n, 8, 1), '0.12345678')
  // A count that does not read back as the order's amount is replaced by the order's own figure.
  assert.equal(sharesShown('abc', 150_000_000n, 8, 1), '1.5')
})

// --------------------------------------------------------------- refusals

test('a program without sell orders is named, not shown as a bare code', () => {
  const err = new Error('Simulation failed. Message: Transaction simulation failed: Error processing Instruction 3: custom program error: 0x65.')
  assert.equal(refusalFrom(err), 'InstructionFallbackNotFound')
  assert.match(explain('InstructionFallbackNotFound'), /does not take sell orders yet/)
  // The codes the buy side relies on are unchanged.
  assert.equal(refusalFrom(new Error('custom program error: 0xbc4')), 'AlreadyClosed')
  assert.equal(refusalFrom(new Error('custom program error: 0x4')), 'OwnerRevoked')
})

test('a stock revoke batch packs into transactions that each fit', () => {
  const owner = Keypair.generate().publicKey
  const accounts = ALLOWLIST.map((l) => ataFor(owner, new PublicKey(l.mint), TOKEN_2022))
  const txs = packTransactions(accounts.map((a) => ixRevoke(a, owner, TOKEN_2022)), owner)
  assert.equal(txs.flatMap((t) => t.instructions).length, ALLOWLIST.length)
  for (const t of txs) assert.ok(bytes(t, owner).length + 65 <= 1_232)
})
