/**
 * Place or cancel a bell order.
 *
 *   node scripts/queue.ts place SPYx 200
 *   node scripts/queue.ts cancel 1          # spl_token revoke + reclaim rent
 *   node scripts/queue.ts list
 *
 * Placing puts `approve_checked` in the same transaction as `place_order`, so
 * the user signs once. The approval is what funds the order — their USDC never
 * leaves their wallet.
 */
import { PublicKey, Transaction, TransactionInstruction, sendAndConfirmTransaction } from '@solana/web3.js'
import {
  authPda,
  connect,
  ixCancelOrder,
  ixPlaceOrder,
  loadKeypair,
  readMark,
  readOrder,
  readOrders,
  TOKEN_PROGRAM,
} from '../src/chain/client.ts'
import { fairOut } from '../src/chain/codec.ts'
import { bySymbol } from '../src/config.ts'

const PAYER_PATH = process.env.BELL_PAYER_KEYPAIR ?? `${process.env.HOME}/.config/solana/id.json`
const QUOTE_DECIMALS = 6

/**
 * `ApproveChecked`, built directly.
 *
 * Same reasoning as the transfer in `fill_order`: a ten-byte payload with a
 * stable wire format is shorter to write than a dependency that would have to
 * agree with anchor about which `Pubkey` is which.
 */
function approveCheckedIx(args: {
  source: PublicKey
  mint: PublicKey
  delegate: PublicKey
  owner: PublicKey
  amount: bigint
  decimals: number
}): TransactionInstruction {
  const data = Buffer.alloc(10)
  data.writeUInt8(13, 0) // TokenInstruction::ApproveChecked
  data.writeBigUInt64LE(args.amount, 1)
  data.writeUInt8(args.decimals, 9)
  return new TransactionInstruction({
    programId: TOKEN_PROGRAM,
    keys: [
      { pubkey: args.source, isSigner: false, isWritable: true },
      { pubkey: args.mint, isSigner: false, isWritable: false },
      { pubkey: args.delegate, isSigner: false, isWritable: false },
      { pubkey: args.owner, isSigner: true, isWritable: false },
    ],
    data,
  })
}

function revokeIx(source: PublicKey, owner: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: TOKEN_PROGRAM,
    keys: [
      { pubkey: source, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    data: Buffer.from([5]), // TokenInstruction::Revoke
  })
}

const conn = connect()
const user = loadKeypair(PAYER_PATH)
const [cmd, ...rest] = process.argv.slice(2)

const quoteAccount = () => {
  const v = process.env.BELL_USER_QUOTE
  if (!v) throw new Error('BELL_USER_QUOTE unset')
  return new PublicKey(v)
}

if (cmd === 'place') {
  const [symbol, usdArg] = rest
  const listing = bySymbol.get(symbol)
  if (!listing) throw new Error(`unknown symbol ${symbol}`)
  const stockAccount = process.env[`BELL_USER_STOCK_${symbol}`]
  if (!stockAccount) throw new Error(`BELL_USER_STOCK_${symbol} unset`)

  const amountIn = BigInt(Math.round(Number(usdArg) * 10 ** QUOTE_DECIMALS))
  const nonce = BigInt(Date.now())
  const mark = await readMark(conn, symbol)

  const payerIn = quoteAccount()
  const tx = new Transaction().add(
    approveCheckedIx({
      source: payerIn,
      mint: new PublicKey(process.env.BELL_QUOTE_MINT!),
      delegate: authPda(user.publicKey),
      owner: user.publicKey,
      amount: amountIn,
      decimals: QUOTE_DECIMALS,
    }),
    ixPlaceOrder({
      owner: user.publicKey,
      symbol,
      mint: new PublicKey(listing.mint),
      nonce,
      amountIn,
      minFillIn: amountIn,
      maxSlipBps: 30,
      maxConfBps: 50,
      floorRateQ64: 0n, // market-on-open; no absolute bound stated
      notBefore: 0n,
      expiresAt: BigInt(Math.floor(Date.now() / 1000) + 86_400),
      payerIn,
      payeeOut: new PublicKey(stockAccount),
    }),
  )
  const sig = await sendAndConfirmTransaction(conn, tx, [user], { commitment: 'confirmed' })

  console.log(`queued ${usdArg} of ${symbol} for the opening bell`)
  console.log(`  nonce   ${nonce}`)
  console.log(`  funded  by delegation — the USDC never left your wallet`)
  if (mark && mark.observedAt > 0n) {
    console.log(`  at mark $${(Number(mark.pxNum) / 1e6).toFixed(2)} you would receive about ${fairOut(amountIn, mark.rateQ64)} raw`)
  }
  console.log(`  sig     ${sig}`)
} else if (cmd === 'cancel') {
  const nonce = BigInt(rest[0])
  const order = await readOrder(conn, user.publicKey, nonce)
  if (!order) throw new Error(`no order ${nonce}`)

  // The revoke is the cancel. Closing the account only reclaims rent, and it
  // is deliberately second: even if this program were frozen, the revoke alone
  // makes the order unfillable.
  const tx = new Transaction().add(
    revokeIx(order.payerIn, user.publicKey),
    ixCancelOrder({ signer: user.publicKey, owner: user.publicKey, nonce, payerIn: order.payerIn }),
  )
  const sig = await sendAndConfirmTransaction(conn, tx, [user], { commitment: 'confirmed' })
  console.log(`cancelled order ${nonce}`)
  console.log(`  revoked the delegation, then reclaimed rent`)
  console.log(`  sig ${sig}`)
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
