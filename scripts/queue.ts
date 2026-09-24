/**
 * Place or cancel a bell order.
 *
 *   node scripts/queue.ts place SPYx 200
 *   node scripts/queue.ts cancel 1          # spl_token revoke, then reclaim rent
 *   node scripts/queue.ts sell AAPLx 0.5 [MIN_USD]
 *   node scripts/queue.ts cancel-sell 1     # revoke the stock approval, then reclaim rent
 *   node scripts/queue.ts list
 *
 * Builds the same order the page does: the mint re-read first, the approval in
 * the same transaction as `place_order` so the user signs once, a loss floor at
 * three quarters of the current mark, and the symbol's own confidence cap. The
 * approval is what funds the order — the USDC never leaves the wallet.
 *
 * A sell is the same with the legs swapped. The approval is on the wallet's
 * **stock** account, under Token-2022, and the shares never leave the wallet
 * until a filler has paid for them; the quote approval that funds buys is
 * never touched by a sell. `MIN_USD` is an optional minimum price per share,
 * which can only tighten the loss floor, never loosen it.
 */
import { PublicKey } from '@solana/web3.js'
import {
  authPda,
  connect,
  ixCancelOrder,
  ixCancelSellOrder,
  ixPlaceOrder,
  ixPlaceSellOrder,
  ixRefreshTokenRisk,
  readBoard,
  readOrder,
  readOrders,
  readSellOrder,
  readSellOrders,
  send,
} from '../src/chain/client.ts'
import {
  ataFor,
  decodeTokenAccount,
  ixApproveChecked,
  ixCreateAtaIdempotent,
  ixRevoke,
  TOKEN_2022,
} from '../src/chain/spl.ts'
import { loadKeypair } from '../src/chain/keys.ts'
import {
  fairOut,
  mulShr64Ceil,
  multiplierOf,
  sellOrderValue,
  stockToQuoteCeil,
  type BellOrder,
} from '../src/chain/codec.ts'
import { ALLOWLIST, bySymbol } from '../src/config.ts'
import { orderExpiry } from '../src/policy/expiry.ts'
import { confCap, lossFloor, sellOrderFloor, sharesToRaw, stillOwed } from '../src/policy/order.ts'

const PAYER_PATH = process.env.BELL_PAYER_KEYPAIR ?? `${process.env.HOME}/.config/solana/id.json`
const QUOTE_DECIMALS = 6

const conn = connect()
const user = loadKeypair(PAYER_PATH)
const [cmd, ...rest] = process.argv.slice(2)

const quoteMint = () => {
  const v = process.env.BELL_QUOTE_MINT
  if (!v) throw new Error('BELL_QUOTE_MINT unset — run with node --env-file=.demo.env (demo-setup.sh writes it)')
  return new PublicKey(v)
}
/** The wallet's quote account: BELL_USER_QUOTE if set, else its associated account, as the page uses. */
const quoteAccount = () =>
  process.env.BELL_USER_QUOTE ? new PublicKey(process.env.BELL_USER_QUOTE) : ataFor(user.publicKey, quoteMint())

/**
 * What this wallet's delegation must cover besides a given order: every other
 * order that can still fill. SPL `Approve` assigns rather than adds, so an
 * approval for one order alone silently defunds all the others — this script
 * did exactly that until it read the book first.
 */
async function owedElsewhere(except?: bigint): Promise<{ owed: bigint; board: Awaited<ReturnType<typeof readBoard>> }> {
  const book = (await readOrders(conn, user.publicKey)).filter((o: BellOrder) => o.nonce !== except)
  const board = await readBoard(conn, ALLOWLIST)
  const now = Math.floor(Date.now() / 1000)
  return { owed: stillOwed(book, now, (sym) => board.symbols.get(sym)?.risk?.multiplierBits), board }
}

const approve = (source: PublicKey, mint: PublicKey, amount: bigint) =>
  ixApproveChecked({
    source,
    mint,
    delegate: authPda(user.publicKey),
    owner: user.publicKey,
    amount,
    decimals: QUOTE_DECIMALS,
  })

/**
 * `MAX_ORDER_IN` in constants.rs: $1,000 of quote. Not in the IDL (it is not a
 * `#[constant]`), so restated here only to explain a refusal before signing;
 * the program is what enforces it.
 */
const MAX_ORDER_IN = 1_000_000_000n

/** Byte 44 of an SPL mint, Token-2022 included, is its decimals. */
const decimalsOf = (mintData: Uint8Array | undefined): number => {
  if (!mintData || mintData.length < 82) throw new Error('stock mint unreadable')
  return mintData[44]
}

/**
 * Stock raw the delegation on `stock` must cover besides a given sell: every
 * other sell pinned to that account that can still fill.
 *
 * The same trap as `owedElsewhere`, on a different account. Every sell of a
 * symbol draws on the one stock account, which has one delegate slot, and
 * `Approve` assigns rather than adds. Counted per account rather than per
 * symbol because the delegation lives on the account.
 */
async function sellsOwedOn(
  stock: PublicKey,
  board: Awaited<ReturnType<typeof readBoard>>,
  except?: bigint,
): Promise<bigint> {
  const book = (await readSellOrders(conn, user.publicKey)).filter(
    (o) => o.payerIn.equals(stock) && o.nonce !== except,
  )
  const now = Math.floor(Date.now() / 1000)
  return stillOwed(book, now, (sym) => board.symbols.get(sym)?.risk?.multiplierBits)
}

/** The stock approval, under Token-2022 at the stock's own decimals. Never the quote account. */
const approveStock = (source: PublicKey, mint: PublicKey, amount: bigint, decimals: number) =>
  ixApproveChecked({
    source,
    mint,
    delegate: authPda(user.publicKey),
    owner: user.publicKey,
    amount,
    decimals,
    tokenProgram: TOKEN_2022,
  })

if (cmd === 'place') {
  const [symbol, usdArg] = rest
  const listing = bySymbol.get(symbol)
  if (!listing) throw new Error(`unknown symbol ${symbol}`)
  // Where the stock lands: BELL_USER_STOCK_<SYMBOL> if set, else the wallet's
  // associated Token-2022 account, created in the same transaction if it does
  // not exist yet — a first buy is the normal case, not an error.
  const stockOverride = process.env[`BELL_USER_STOCK_${symbol}`]

  const amountIn = BigInt(Math.round(Number(usdArg) * 10 ** QUOTE_DECIMALS))
  const nonce = BigInt(Date.now())
  const mint = new PublicKey(listing.mint)
  const payeeOut = stockOverride ? new PublicKey(stockOverride) : ataFor(user.publicKey, mint, TOKEN_2022)
  const { owed, board } = await owedElsewhere()
  const mark = board.symbols.get(symbol)?.mark ?? null
  const floorRateQ64 = lossFloor(mark && mark.observedAt > 0n ? mark.rateQ64 : null)

  const payerIn = quoteAccount()
  // A fixed nonce makes `send()`'s re-signing retry safe: a second landing
  // would re-create an order account that already exists, and is refused.
  const sig = await send(
    conn,
    [
      // Re-read the mint first, so the order snapshots the multiplier in force
      // now rather than whatever the last refresh recorded.
      ixRefreshTokenRisk(mint),
      ...(stockOverride
        ? []
        : [ixCreateAtaIdempotent({ payer: user.publicKey, owner: user.publicKey, mint, tokenProgram: TOKEN_2022 })]),
      approve(payerIn, quoteMint(), owed + amountIn),
      ixPlaceOrder({
        owner: user.publicKey,
        symbol,
        mint,
        nonce,
        amountIn,
        minFillIn: amountIn,
        maxSlipBps: 30,
        maxConfBps: confCap(listing),
        floorRateQ64,
        notBefore: 0n,
        // Shared with the page: survives a weekend, capped inside the program's limit.
        expiresAt: BigInt(orderExpiry(Math.floor(Date.now() / 1000), null)),
        payerIn,
        payeeOut,
      }),
    ],
    [user],
  )

  console.log(`queued ${usdArg} of ${symbol}`)
  console.log(`  nonce     ${nonce}`)
  console.log(`  funded    by delegation — ${Number(owed + amountIn) / 1e6} approved across the book; the USDC never left your wallet`)
  if (mark && mark.observedAt > 0n) {
    console.log(`  at mark   $${(Number(mark.pxNum) / 1e6).toFixed(2)} you would receive about ${fairOut(amountIn, mark.rateQ64)} raw`)
    console.log(`  floor     never less than ${fairOut(amountIn, floorRateQ64)} raw (3/4 of that)`)
  }
  console.log(`  sig       ${sig}`)
} else if (cmd === 'cancel') {
  const nonce = BigInt(rest[0])
  const order = await readOrder(conn, user.publicKey, nonce)
  if (!order) throw new Error(`no order ${nonce}`)

  // The revoke is the cancel, and it goes alone: a plain SPL instruction that
  // works even if this program is frozen. In the same transaction as BELL's
  // instruction, a failure there would have rolled the revoke back with it.
  const revokeSig = await send(conn, [ixRevoke(order.payerIn, user.publicKey)], [user])
  console.log(`cancelled order ${nonce}`)
  console.log(`  revoked   ${revokeSig}  — nothing of yours can fill now`)
  const closeSig = await send(
    conn,
    [ixCancelOrder({ signer: user.publicKey, owner: user.publicKey, nonce, payerIn: order.payerIn })],
    [user],
  )
  console.log(`  closed    ${closeSig}  — rent returned`)
  // The account has one delegate slot, so the revoke unfunded every other
  // order too. Re-fund them only now that this one is closed.
  const { owed } = await owedElsewhere(nonce)
  if (owed > 0n) {
    const sig = await send(conn, [approve(order.payerIn, order.quoteMint, owed)], [user])
    console.log(`  re-funded ${sig}  — ${Number(owed) / 1e6} for your other orders`)
  }
} else if (cmd === 'sell') {
  const [symbol, sharesArg, minArg] = rest
  const listing = bySymbol.get(symbol)
  if (!listing) throw new Error(`unknown symbol ${symbol}`)
  if (!sharesArg) throw new Error('usage: sell SYMBOL SHARES [MIN_USD]')
  const mint = new PublicKey(listing.mint)
  // What is sold: BELL_USER_STOCK_<SYMBOL> if set, else the wallet's associated
  // Token-2022 account — the same account a buy delivers into. It is not
  // created here: a sell from an account that does not exist has nothing to sell.
  const stockOverride = process.env[`BELL_USER_STOCK_${symbol}`]
  const payerIn = stockOverride ? new PublicKey(stockOverride) : ataFor(user.publicKey, mint, TOKEN_2022)

  // One read for the board (mark and multiplier), the mint (decimals) and the
  // stock account (the balance being sold).
  const board = await readBoard(conn, ALLOWLIST, [mint, payerIn])
  const [mintInfo, stockInfo] = board.extras
  const risk = board.symbols.get(symbol)?.risk
  const mark = board.symbols.get(symbol)?.mark
  if (!risk) throw new Error(`${symbol} has no risk record on this cluster`)
  const decimals = decimalsOf(mintInfo?.data)
  // The program sizes a sell against the mark and refuses one without a price
  // (MarkStale), so refuse here first, with the reason.
  if (!mark || mark.rateQ64 <= 0n) throw new Error(`${symbol} has no price on chain yet, and a sell is sized against it`)

  // Where the proceeds land: BELL_USER_QUOTE if set, else the wallet's
  // associated account for the mark's own quote mint, created in the same
  // transaction, since a holder who has never held USDC is the ordinary case
  // for a first sale. The mint comes from the mark rather than from
  // BELL_QUOTE_MINT because place_sell_order requires exactly that mint
  // (QuoteMintMismatch): a stale or missing environment variable would
  // otherwise refuse the sale, or stop it before it was built.
  const proceedsMint = mark.quoteMint
  const payeeOut = process.env.BELL_USER_QUOTE
    ? new PublicKey(process.env.BELL_USER_QUOTE)
    : ataFor(user.publicKey, proceedsMint)

  // Shares are what a person means; raw units are what the program counts. The
  // multiplier in force converts one to the other, and the order snapshots it.
  const multiplier = multiplierOf(risk.multiplierBits)
  const amountIn = sharesToRaw(sharesArg, decimals, multiplier)
  if (amountIn <= 0n) throw new Error(`${sharesArg} ${symbol} is less than one raw unit`)
  const value = sellOrderValue(amountIn, mark.rateQ64)
  if (value > MAX_ORDER_IN) {
    throw new Error(`${sharesArg} ${symbol} is worth $${(Number(value) / 1e6).toFixed(2)} at the mark; orders are capped at $1,000`)
  }

  const owed = await sellsOwedOn(payerIn, board)
  const held = stockInfo ? decodeTokenAccount(stockInfo.data).amount : 0n
  // An order for stock the wallet does not hold would park and never fill.
  if (held < owed + amountIn) {
    throw new Error(
      `this wallet holds ${held} raw ${symbol}; with ${owed} already offered in other sells, ${amountIn} more is not there to sell`,
    )
  }

  const minLimitUsd = minArg === undefined ? null : Number(minArg)
  if (minLimitUsd !== null && !(minLimitUsd > 0)) throw new Error(`not a price: ${minArg}`)
  const floorRateQ64 = sellOrderFloor(mark.rateQ64, { num: mark.pxNum, expo: mark.pxExpo }, minLimitUsd)

  const nonce = BigInt(Date.now())
  // One transaction, as for a buy, and the same fixed nonce makes `send()`'s
  // re-signing retry safe: a second landing meets an account that exists.
  const sig = await send(
    conn,
    [
      ixRefreshTokenRisk(mint),
      ...(process.env.BELL_USER_QUOTE
        ? []
        : [ixCreateAtaIdempotent({ payer: user.publicKey, owner: user.publicKey, mint: proceedsMint })]),
      approveStock(payerIn, mint, owed + amountIn, decimals),
      ixPlaceSellOrder({
        owner: user.publicKey,
        symbol,
        mint,
        nonce,
        amountIn,
        minFillIn: amountIn,
        maxSlipBps: 30,
        maxConfBps: confCap(listing),
        floorRateQ64,
        notBefore: 0n,
        expiresAt: BigInt(orderExpiry(Math.floor(Date.now() / 1000), null)),
        payerIn,
        payeeOut,
      }),
    ],
    [user],
  )

  console.log(`queued a sale of ${sharesArg} ${symbol}`)
  console.log(`  nonce     ${nonce}`)
  console.log(`  selling   ${amountIn} raw (${decimals} decimals, multiplier ${multiplier})`)
  console.log(`  funded    by delegation — ${owed + amountIn} raw approved across this account's sells; the shares never left your wallet`)
  const quoteUsd = (raw: bigint) => (Number(raw) / 10 ** QUOTE_DECIMALS).toFixed(2)
  console.log(`  at mark   $${(Number(mark.pxNum) * 10 ** mark.pxExpo).toFixed(2)} a share you would receive about $${quoteUsd(stockToQuoteCeil(amountIn, mark.rateQ64))}`)
  console.log(`  floor     never less than $${quoteUsd(mulShr64Ceil(amountIn, floorRateQ64))}${minLimitUsd ? ` (the higher of your $${minLimitUsd} a share and 3/4 of the mark)` : ' (3/4 of that)'}`)
  console.log(`  sig       ${sig}`)
} else if (cmd === 'cancel-sell') {
  const nonce = BigInt(rest[0])
  const order = await readSellOrder(conn, user.publicKey, nonce)
  if (!order) throw new Error(`no sell order ${nonce}`)

  // The revoke is the cancel, alone in its transaction for the same reason as
  // a buy's — and on the stock account, under Token-2022, which is the only
  // approval a sell ever made.
  const revokeSig = await send(conn, [ixRevoke(order.payerIn, user.publicKey, TOKEN_2022)], [user])
  console.log(`cancelled sell order ${nonce}`)
  console.log(`  revoked   ${revokeSig}  — none of your shares can be sold now`)
  const closeSig = await send(
    conn,
    [ixCancelSellOrder({ signer: user.publicKey, owner: user.publicKey, nonce, payerIn: order.payerIn })],
    [user],
  )
  console.log(`  closed    ${closeSig}  — rent returned`)
  // The revoke unfunded every other sell on this account too; re-fund them
  // only now that this one is closed.
  const board = await readBoard(conn, ALLOWLIST, [order.mint])
  const owed = await sellsOwedOn(order.payerIn, board, nonce)
  if (owed > 0n) {
    const decimals = decimalsOf(board.extras[0]?.data)
    const sig = await send(conn, [approveStock(order.payerIn, order.mint, owed, decimals)], [user])
    console.log(`  re-funded ${sig}  — ${owed} raw for your other sells of ${order.symbol}`)
  }
} else {
  const orders = await readOrders(conn)
  console.log(`${orders.length} order(s) on chain\n`)
  for (const o of orders) {
    console.log(
      `  ${o.symbol.padEnd(7)} ${(Number(o.amountIn) / 1e6).toFixed(2)} quote  ` +
        `filled=${Number(o.filledIn) / 1e6}  slip<=${o.maxSlipBps}bps  nonce=${o.nonce}`,
    )
  }
  const sells = await readSellOrders(conn)
  if (sells.length > 0) {
    console.log(`${orders.length > 0 ? '\n' : ''}${sells.length} sell order(s) on chain\n`)
    for (const o of sells) {
      console.log(
        `  ${o.symbol.padEnd(7)} ${o.amountIn} raw  filled=${o.filledIn}  slip<=${o.maxSlipBps}bps  nonce=${o.nonce}`,
      )
    }
  }
}
