/**
 * Place or cancel a bell order.
 *
 *   node scripts/queue.ts place SPYx 200
 *   node scripts/queue.ts cancel 1          # spl_token revoke, then reclaim rent
 *   node scripts/queue.ts list
 *
 * Builds the same order the page does: the mint re-read first, the approval in
 * the same transaction as `place_order` so the user signs once, a loss floor at
 * three quarters of the current mark, and the symbol's own confidence cap. The
 * approval is what funds the order — the USDC never leaves the wallet.
 */
import { PublicKey } from '@solana/web3.js'
import {
  authPda,
  connect,
  ixCancelOrder,
  ixPlaceOrder,
  ixRefreshTokenRisk,
  readBoard,
  readOrder,
  readOrders,
  send,
} from '../src/chain/client.ts'
import { ixApproveChecked, ixRevoke } from '../src/chain/spl.ts'
import { loadKeypair } from '../src/chain/keys.ts'
import { fairOut, type BellOrder } from '../src/chain/codec.ts'
import { ALLOWLIST, bySymbol } from '../src/config.ts'
import { orderExpiry } from '../src/policy/expiry.ts'
import { confCap, lossFloor, stillOwed } from '../src/policy/order.ts'

const PAYER_PATH = process.env.BELL_PAYER_KEYPAIR ?? `${process.env.HOME}/.config/solana/id.json`
const QUOTE_DECIMALS = 6

const conn = connect()
const user = loadKeypair(PAYER_PATH)
const [cmd, ...rest] = process.argv.slice(2)

const quoteAccount = () => {
  const v = process.env.BELL_USER_QUOTE
  if (!v) throw new Error('BELL_USER_QUOTE unset')
  return new PublicKey(v)
}
const quoteMint = () => {
  const v = process.env.BELL_QUOTE_MINT
  if (!v) throw new Error('BELL_QUOTE_MINT unset')
  return new PublicKey(v)
}

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

if (cmd === 'place') {
  const [symbol, usdArg] = rest
  const listing = bySymbol.get(symbol)
  if (!listing) throw new Error(`unknown symbol ${symbol}`)
  const stockAccount = process.env[`BELL_USER_STOCK_${symbol}`]
  if (!stockAccount) throw new Error(`BELL_USER_STOCK_${symbol} unset`)

  const amountIn = BigInt(Math.round(Number(usdArg) * 10 ** QUOTE_DECIMALS))
  const nonce = BigInt(Date.now())
  const mint = new PublicKey(listing.mint)
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
        payeeOut: new PublicKey(stockAccount),
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
} else {
  const orders = await readOrders(conn)
  console.log(`${orders.length} order(s) on chain\n`)
  for (const o of orders) {
    console.log(
      `  ${o.symbol.padEnd(7)} ${(Number(o.amountIn) / 1e6).toFixed(2)} quote  ` +
        `filled=${Number(o.filledIn) / 1e6}  slip<=${o.maxSlipBps}bps  nonce=${o.nonce}`,
    )
  }
}
