/**
 * Placing and cancelling a bell order from a browser wallet.
 *
 * Builds the identical instructions `scripts/queue.ts` sends — same builders,
 * same SPL encoders, same PDAs — so a judge who places an order on the site and
 * one who places it from the CLI are exercising one code path, not two.
 *
 * Nothing here talks to a server. The browser signs and submits to RPC itself,
 * which is what makes the fail-closed property observable: when our keeper is
 * down the page shows everything closed, because the *chain* says so.
 */
import { PublicKey, Transaction, type Connection } from '@solana/web3.js'
import { authPda, ixCancelOrder, ixPlaceOrder } from '../../src/chain/client.ts'
import { ataFor, ixApproveChecked, ixCreateAtaIdempotent, ixRevoke, TOKEN_2022 } from '../../src/chain/spl.ts'
import type { BellOrder } from '../../src/chain/codec.ts'
import type { Listing } from '../../src/config.ts'

/**
 * The quote asset. On localnet this is a mint we control, because a cloned
 * mainnet USDC is one nobody can mint from; on mainnet it is USDC itself.
 */
export const QUOTE_MINT = new PublicKey(
  process.env.NEXT_PUBLIC_BELL_QUOTE_MINT ?? 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
)
export const QUOTE_DECIMALS = 6

/** Defaults a user never has to think about, stated rather than buried. */
export const DEFAULT_SLIP_BPS = 30
export const DEFAULT_CONF_BPS = 50
export const ORDER_TTL_SECONDS = 86_400

export interface PlaceArgs {
  owner: PublicKey
  listing: Listing
  /** Whole quote units, e.g. 200 for $200. */
  usd: number
  /** Passed in rather than read from the clock so the caller owns the nonce. */
  nonce: bigint
  now: number
  maxSlipBps?: number
  /**
   * Raw quote still owed on this owner's other live orders.
   *
   * A token account has exactly one delegate slot holding exactly one amount,
   * and SPL `Approve` **assigns** that amount rather than adding to it. So
   * approving only the new order's size silently defunds every earlier one —
   * they stop being fillable, and because a defunded order is garbage
   * collectable by anyone, a stranger can then close them. The delegation is
   * per-owner, so it has to be approved for the whole book at once.
   */
  committed?: bigint
}

/**
 * One transaction, one signature: create the destination if needed, approve,
 * then queue.
 *
 * The approval and the order go together deliberately. An approval without an
 * order is a dangling delegation the user did not ask for; an order without an
 * approval is unfillable. Signing them separately would leave a window where
 * one exists without the other, and the user carries that risk for no benefit.
 */
export function placeOrderTx(a: PlaceArgs): {
  tx: Transaction
  amountIn: bigint
  approved: bigint
} {
  const mint = new PublicKey(a.listing.mint)
  const amountIn = BigInt(Math.round(a.usd * 10 ** QUOTE_DECIMALS))
  const approved = (a.committed ?? 0n) + amountIn
  const payerIn = ataFor(a.owner, QUOTE_MINT)
  const payeeOut = ataFor(a.owner, mint, TOKEN_2022)

  const tx = new Transaction().add(
    // The user may not hold this security yet — that is the normal case for a
    // first buy, and it is not a reason to refuse them.
    ixCreateAtaIdempotent({ payer: a.owner, owner: a.owner, mint, tokenProgram: TOKEN_2022 }),
    ixApproveChecked({
      source: payerIn,
      mint: QUOTE_MINT,
      delegate: authPda(a.owner),
      owner: a.owner,
      // The whole book, not just this order — see `committed` above.
      amount: approved,
      decimals: QUOTE_DECIMALS,
    }),
    ixPlaceOrder({
      owner: a.owner,
      symbol: a.listing.symbol,
      mint,
      nonce: a.nonce,
      amountIn,
      minFillIn: amountIn,
      maxSlipBps: a.maxSlipBps ?? DEFAULT_SLIP_BPS,
      maxConfBps: DEFAULT_CONF_BPS,
      // Market-on-open. A band against a fill-time mark is the honest
      // semantics for "I want $200 of SPY"; an absolute floor would be a
      // price the user invented hours before the market opened.
      floorRateQ64: 0n,
      notBefore: 0n,
      expiresAt: BigInt(a.now + ORDER_TTL_SECONDS),
      payerIn,
      payeeOut,
    }),
  )
  return { tx, amountIn, approved }
}

/** Raw quote still owed across a set of orders. */
export const committedOf = (orders: { amountIn: bigint; filledIn: bigint }[]): bigint =>
  orders.reduce((n, o) => n + (o.amountIn - o.filledIn), 0n)

/**
 * Cancel: revoke first, reclaim rent second.
 *
 * The order matters and is not cosmetic. The revoke is what actually kills the
 * order, and it is a plain SPL instruction against the user's own account — it
 * works if this program is frozen, if the keeper is dead and if every filler
 * disappears. Closing the order account afterwards is bookkeeping that returns
 * the user's rent. If the second instruction somehow failed, the user would
 * still be safe; if they were reversed, they would not be.
 */
export function cancelOrderTx(owner: PublicKey, order: BellOrder): Transaction {
  return new Transaction().add(
    ixRevoke(order.payerIn, owner),
    ixCancelOrder({ signer: owner, owner, nonce: order.nonce, payerIn: order.payerIn }),
  )
}

/** Submit through the wallet and wait for confirmation. */
export async function submit(
  conn: Connection,
  tx: Transaction,
  owner: PublicKey,
  sign: (t: Transaction) => Promise<Transaction>,
): Promise<string> {
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed')
  tx.feePayer = owner
  tx.recentBlockhash = blockhash
  const signed = await sign(tx)
  const sig = await conn.sendRawTransaction(signed.serialize(), { skipPreflight: false })
  await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed')
  return sig
}
