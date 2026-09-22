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
import {
  authPda,
  ixCancelOrder,
  ixPlaceOrder,
  ixRefreshTokenRisk,
} from '../../src/chain/client.ts'
import { errorName } from '../../src/chain/codec.ts'
import { orderExpiry } from '../../src/policy/expiry.ts'

export { orderExpiry }
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
/**
 * The program's own ceiling on a single order, $1,000 of quote
 * (`MAX_ORDER_IN` in constants.rs — a blast-radius bound while the program
 * still has an upgrade authority). Checked here so an oversized order is
 * explained before signing instead of refused as `AmountTooLarge` after.
 */
export const MAX_ORDER_USD = 1_000


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
  /** The next opening bell, when the market is shut and it is known. */
  nextOpen?: number | null
}

/**
 * One transaction, one signature: re-read the mint, create the destination if
 * needed, approve, then queue.
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
    // Re-read the mint's extensions first, in the same transaction. The order
    // snapshots the scaled-UI multiplier it was built against, and a snapshot
    // taken from a stale record would make a perfectly good order refuse as
    // MultiplierMoved later. Permissionless, and every account it needs is
    // already in this transaction.
    ixRefreshTokenRisk(mint),
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
      expiresAt: BigInt(orderExpiry(a.now, a.nextOpen ?? null)),
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
/**
 * Pull a program error code out of whatever the RPC threw, and name it.
 *
 * Preflight failures arrive as prose with `custom program error: 0x1773` buried
 * in them. For a product whose whole output is *why* it said no, showing the
 * user a hex code is the refusal with the reason stripped off.
 */
export function refusalFrom(e: unknown): string | null {
  const text = [(e as Error)?.message ?? '', ...(((e as { logs?: string[] })?.logs) ?? [])].join('\n')
  const m = /custom program error: 0x([0-9a-f]+)/i.exec(text)
  return m ? errorName(parseInt(m[1], 16)) : null
}

/**
 * Sign once, submit, and confirm without false negatives.
 *
 * Public devnet's websocket drops confirmation notices often enough that
 * "confirmation failed" does not mean "did not land". Before reporting a
 * failure the signature's status is checked directly, and a transaction that
 * landed is reported as the success it was. The same signed bytes are never
 * re-signed: a second signature would be a second order.
 */
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
  try {
    const res = await conn.confirmTransaction(
      { signature: sig, blockhash, lastValidBlockHeight },
      'confirmed',
    )
    if (res.value.err) throw new Error(`transaction failed: ${JSON.stringify(res.value.err)}`)
  } catch (e) {
    const { value } = await conn.getSignatureStatuses([sig], { searchTransactionHistory: true })
    const st = value[0]
    const landed = st && !st.err && (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized')
    if (!landed) throw e
  }
  return sig
}
