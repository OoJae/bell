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
import { committedOf, confCap, lossFloor } from '../../src/policy/order.ts'
import { ataFor, ixApproveChecked, ixCreateAtaIdempotent, ixRevoke, TOKEN_2022 } from '../../src/chain/spl.ts'
import type { BellOrder } from '../../src/chain/codec.ts'
import type { Listing } from '../../src/config.ts'

export { committedOf, orderExpiry }

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
  /** The symbol's attested rate when the order is placed; sets the loss floor. */
  markRateQ64?: bigint | null
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
      maxConfBps: confCap(a.listing),
      // Market-on-open: the price is the band against a fill-time mark. The
      // floor is not a limit price — it is a loss cap at three quarters of
      // what the mark says now, so a forged mark cannot fill this order for
      // dust. See `lossFloor`.
      floorRateQ64: lossFloor(a.markRateQ64),
      notBefore: 0n,
      expiresAt: BigInt(orderExpiry(a.now, a.nextOpen ?? null)),
      payerIn,
      payeeOut,
    }),
  )
  return { tx, amountIn, approved }
}

/**
 * Cancel one order: kill its funding first, reclaim its rent second — as
 * separate transactions, so the kill never depends on this program.
 *
 * 1. `revoke` — a plain SPL instruction on the user's own account. It works if
 *    this program is frozen, the keeper is dead and every filler has gone. It
 *    used to share a transaction with `cancel_order`, so a failure in BELL's
 *    own instruction rolled the revoke back with it: the one step that must
 *    never depend on BELL did.
 * 2. `cancel_order` — closes the order and returns its rent.
 * 3. Only if other live orders remain (`rest`): approve them again. The
 *    account has one delegate slot, so the revoke unfunded them too. This
 *    comes *after* the close on purpose — re-approving first would leave the
 *    cancelled order fundable, and fillable, until its close landed.
 *
 * `bellDelegated` false means the account's delegate is not BELL's (the user
 * approved someone else since): the order is already unfunded, and revoking
 * would cancel an approval that is none of our business. Only the close runs.
 */
export function cancelOrderTxs(
  owner: PublicKey,
  order: BellOrder,
  rest: bigint,
  bellDelegated: boolean,
): Transaction[] {
  const close = new Transaction().add(
    ixCancelOrder({ signer: owner, owner, nonce: order.nonce, payerIn: order.payerIn }),
  )
  if (!bellDelegated) return [close]
  const txs = [new Transaction().add(ixRevoke(order.payerIn, owner)), close]
  if (rest > 0n) {
    txs.push(
      new Transaction().add(
        ixApproveChecked({
          source: order.payerIn,
          mint: order.quoteMint,
          delegate: authPda(owner),
          owner,
          amount: rest,
          decimals: QUOTE_DECIMALS,
        }),
      ),
    )
  }
  return txs
}

/** Orders closed per transaction by "revoke all": four accounts each, well inside the size limit. */
const CLOSES_PER_TX = 6

/**
 * Revoke all funding, then close every order: the emergency exit, offered
 * whenever the wallet has any approval to BELL outstanding — including one no
 * order explains, such as an approval whose order never landed.
 */
export function revokeAllTxs(owner: PublicKey, payerIn: PublicKey, book: readonly BellOrder[]): Transaction[] {
  const txs = [new Transaction().add(ixRevoke(payerIn, owner))]
  for (let i = 0; i < book.length; i += CLOSES_PER_TX) {
    txs.push(
      new Transaction().add(
        ...book
          .slice(i, i + CLOSES_PER_TX)
          .map((o) => ixCancelOrder({ signer: owner, owner, nonce: o.nonce, payerIn: o.payerIn })),
      ),
    )
  }
  return txs
}

/**
 * Pull a program error code out of whatever the RPC threw, and name it.
 *
 * Preflight failures arrive as prose with `custom program error: 0x1773` buried
 * in them. For a product whose whole output is *why* it said no, showing the
 * user a hex code is the refusal with the reason stripped off.
 */
/** Anchor's AccountNotInitialized, which is what closing an already-closed order meets. */
const ANCHOR_ACCOUNT_NOT_INITIALIZED = 3012

export function refusalFrom(e: unknown): string | null {
  const text = [(e as Error)?.message ?? '', ...(((e as { logs?: string[] })?.logs) ?? [])].join('\n')
  const m = /custom program error: 0x([0-9a-f]+)/i.exec(text)
  if (!m) return null
  const code = parseInt(m[1], 16)
  // Anchor's AccountNotInitialized: the order account is gone — filled, or
  // closed by someone tidying the book after its funding was revoked.
  return code === ANCHOR_ACCOUNT_NOT_INITIALIZED ? 'AlreadyClosed' : errorName(code)
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
  return land(conn, await sign(tx), blockhash, lastValidBlockHeight)
}

async function land(conn: Connection, signed: Transaction, blockhash: string, lastValidBlockHeight: number) {
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

/**
 * Several transactions, landed strictly in order.
 *
 * One wallet prompt when the wallet can sign a batch (anything on the Wallet
 * Standard can); otherwise one prompt per transaction, each sent before the
 * next is asked for — so the first step lands even if the user declines the
 * second. Each is confirmed before the next goes out, and the first failure
 * stops the rest. Returns what landed and what stopped it, so the caller can
 * say exactly which step happened: for a cancel, "funding revoked" is the part
 * that matters and must be reported even if the rent reclaim fails.
 */
export async function submitInOrder(
  conn: Connection,
  txs: Transaction[],
  owner: PublicKey,
  sign: (t: Transaction) => Promise<Transaction>,
  signAll?: (t: Transaction[]) => Promise<Transaction[]>,
  /** Carry on past a failure at step `i` — e.g. closing an order that is already closed. */
  carryOn: (i: number, e: unknown) => boolean = () => false,
): Promise<{ sigs: (string | null)[]; error: unknown; failedAt: number | null }> {
  const sigs: (string | null)[] = []
  let error: unknown = null
  let failedAt: number | null = null
  let batch: Transaction[] | null = null
  try {
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed')
    for (const tx of txs) {
      tx.feePayer = owner
      tx.recentBlockhash = blockhash
    }
    batch = signAll ? await signAll(txs) : null
    for (const [i, tx] of txs.entries()) {
      try {
        sigs.push(await land(conn, batch ? batch[i]! : await sign(tx), blockhash, lastValidBlockHeight))
      } catch (e) {
        if (i === 0 || !carryOn(i, e)) {
          error = e
          failedAt = i
          break
        }
        sigs.push(null)
      }
    }
  } catch (e) {
    error = e
    failedAt = sigs.length
  }
  return { sigs, error, failedAt }
}
