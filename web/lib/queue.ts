/**
 * Placing and cancelling a bell order from a browser wallet, buying or selling.
 *
 * Builds the identical instructions `scripts/queue.ts` sends — same builders,
 * same SPL encoders, same PDAs — so a judge who places an order on the site and
 * one who places it from the CLI are exercising one code path, not two.
 *
 * A buy and a sell are funded from different accounts and must never share an
 * approval. A buy delegates the wallet's quote account; a sell delegates the
 * wallet's stock account, under Token-2022. Each account has one delegate slot
 * and `Approve` assigns rather than adds, so a sell built with the buy side's
 * approval would silently defund every buy the wallet has.
 *
 * Nothing here talks to a server. The browser signs and submits to RPC itself,
 * which is what makes the fail-closed property observable: when our keeper is
 * down the page shows everything closed, because the *chain* says so.
 */
import { PublicKey, Transaction, type Connection, type TransactionInstruction } from '@solana/web3.js'
import {
  authPda,
  ixCancelOrder,
  ixCancelSellOrder,
  ixPlaceOrder,
  ixPlaceSellOrder,
  ixRefreshTokenRisk,
} from '../../src/chain/client.ts'
import { errorName, LIMITS } from '../../src/chain/codec.ts'
import { orderExpiry } from '../../src/policy/expiry.ts'
import { committedOf, confCap, orderFloor, sellOrderFloor, sharesToRaw, type MarkPrice } from '../../src/policy/order.ts'
import { ataFor, ixApproveChecked, ixCreateAtaIdempotent, ixRevoke, TOKEN_2022 } from '../../src/chain/spl.ts'
import type { BellOrder, SellOrder } from '../../src/chain/codec.ts'
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
/**
 * The same ceiling in raw quote. A sell is sized in stock, so the program
 * compares the sale's value at the mark, rounded down, against this.
 */
export const MAX_ORDER_IN_RAW = BigInt(MAX_ORDER_USD) * 10n ** BigInt(QUOTE_DECIMALS)
/**
 * What the "max" button offers to sell, in dollars at the price now. Under the
 * program's $1,000 on purpose: `place_sell_order` values the sale against the
 * mark in force when the transaction lands, and the mark is re-attested every
 * minute, so a max worked out to the dollar from this read would be refused as
 * `AmountTooLarge` by any tick up before the wallet signs. One percent of room
 * covers an ordinary minute.
 */
export const SELL_MAX_USD = 990

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
  /** The price that rate stands for, so a limit in dollars can be converted to it. */
  markPx?: MarkPrice | null
  /** "Don't pay more than this a share" — tightens the floor, never loosens it. */
  limitUsd?: number | null
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
  const { ixs, amountIn, approved } = placeInstructions(a, [
    { nonce: a.nonce, notBefore: 0, expiresAt: orderExpiry(a.now, a.nextOpen ?? null) },
  ])
  return { tx: new Transaction().add(...ixs), amountIn, approved }
}

/** One order's schedule: when it may first fill, and when it lapses. */
export interface OrderSlot {
  nonce: bigint
  /** Unix seconds; 0 means as soon as the gate allows. */
  notBefore: number
  expiresAt: number
}

/**
 * The instructions for one approval and any number of orders of the same size.
 * The approval comes first and covers the whole book plus every new order,
 * because each `place_order` checks the delegation covers it.
 */
export function placeInstructions(
  a: PlaceArgs,
  slots: readonly OrderSlot[],
): { ixs: TransactionInstruction[]; amountIn: bigint; approved: bigint } {
  const mint = new PublicKey(a.listing.mint)
  const amountIn = BigInt(Math.round(a.usd * 10 ** QUOTE_DECIMALS))
  const approved = (a.committed ?? 0n) + amountIn * BigInt(slots.length)
  const payerIn = ataFor(a.owner, QUOTE_MINT)
  const payeeOut = ataFor(a.owner, mint, TOKEN_2022)
  // Market-on-open by default: the price is the band against a fill-time mark,
  // and the floor is only a loss cap at three quarters of what the mark says
  // now, so a forged mark cannot fill this order for dust. A limit the user
  // sets tightens that floor to their own price. See `orderFloor`.
  const floorRateQ64 = orderFloor(a.markRateQ64, a.markPx, a.limitUsd)

  const ixs = [
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
    ...slots.map((slot) =>
      ixPlaceOrder({
        owner: a.owner,
        symbol: a.listing.symbol,
        mint,
        nonce: slot.nonce,
        amountIn,
        minFillIn: amountIn,
        maxSlipBps: a.maxSlipBps ?? DEFAULT_SLIP_BPS,
        maxConfBps: confCap(a.listing),
        floorRateQ64,
        notBefore: BigInt(slot.notBefore),
        expiresAt: BigInt(slot.expiresAt),
        payerIn,
        payeeOut,
      }),
    ),
  ]
  return { ixs, amountIn, approved }
}

/**
 * A recurring buy: one bell order per upcoming open, each held back by
 * `not_before` until its own open and lapsing six hours after it, under one
 * approval. An order that cannot fill on its day lapses rather than filling
 * alongside the next day's, so a missed day is skipped, never doubled.
 */
export function recurringSlots(now: number, nonce: bigint, opens: readonly number[]): OrderSlot[] {
  // An hour inside the program's lifetime cap, as `orderExpiry` does, so clock
  // skew can never push an order over it and get it refused.
  const ceiling = now + (LIMITS.MAX_ORDER_LIFETIME_SECONDS ?? 7 * 86_400) - 3_600
  return opens.map((open, i) => ({
    nonce: nonce + BigInt(i),
    notBefore: open,
    expiresAt: Math.min(open + 6 * 3_600, ceiling),
  }))
}

export interface SellArgs {
  owner: PublicKey
  listing: Listing
  /** Stock raw units to sell. */
  amountIn: bigint
  /** The stock mint's decimals, which `approve_checked` has to name. */
  decimals: number
  /** Passed in rather than read from the clock so the caller owns the nonce. */
  nonce: bigint
  now: number
  maxSlipBps?: number
  /**
   * Stock raw still owed on this owner's other live sells from the same stock
   * account. The trap `PlaceArgs.committed` describes, on the other account:
   * approving only this sale would silently defund every earlier sale of the
   * same stock, and a defunded order is one a stranger may close.
   */
  committed?: bigint
  /** The next opening bell, when the market is shut and it is known. */
  nextOpen?: number | null
  /** The symbol's attested rate; `place_sell_order` refuses a sale without one. */
  markRateQ64: bigint
  /** The price that rate stands for, so a minimum in dollars can be converted to it. */
  markPx?: MarkPrice | null
  /** "Don't sell for less than this a share": tightens the floor, never loosens it. */
  minLimitUsd?: number | null
}

/**
 * The instructions for one sale: re-read the mint, make sure the proceeds have
 * somewhere to land, approve the stock, then place.
 *
 * One transaction and one signature, for the reason `placeOrderTx` gives: an
 * approval without its order is a delegation nobody asked for, and an order
 * without its approval cannot fill.
 */
export function placeSellInstructions(a: SellArgs): {
  ixs: TransactionInstruction[]
  amountIn: bigint
  approved: bigint
  floorRateQ64: bigint
} {
  const mint = new PublicKey(a.listing.mint)
  const payerIn = ataFor(a.owner, mint, TOKEN_2022)
  const payeeOut = ataFor(a.owner, QUOTE_MINT)
  const approved = (a.committed ?? 0n) + a.amountIn
  // The loss cap at three quarters of the price now, or the user's own minimum
  // when that is higher: the same protection a buy has, from below.
  const floorRateQ64 = sellOrderFloor(a.markRateQ64, a.markPx, a.minLimitUsd)
  const ixs = [
    // The order snapshots the multiplier, as a buy does, so the record it is
    // snapshotted from is refreshed in the same transaction.
    ixRefreshTokenRisk(mint),
    // The proceeds land in the wallet's quote account, which a holder who has
    // never held demo-USDC does not have yet, and the program checks it before
    // it will park the order. Idempotent, so an existing one costs nothing.
    ixCreateAtaIdempotent({ payer: a.owner, owner: a.owner, mint: QUOTE_MINT }),
    // The stock account, under Token-2022, at the stock's own decimals. Never
    // the quote account: that approval funds the wallet's buys.
    ixApproveChecked({
      source: payerIn,
      mint,
      delegate: authPda(a.owner),
      owner: a.owner,
      amount: approved,
      decimals: a.decimals,
      tokenProgram: TOKEN_2022,
    }),
    ixPlaceSellOrder({
      owner: a.owner,
      symbol: a.listing.symbol,
      mint,
      nonce: a.nonce,
      amountIn: a.amountIn,
      minFillIn: a.amountIn,
      maxSlipBps: a.maxSlipBps ?? DEFAULT_SLIP_BPS,
      maxConfBps: confCap(a.listing),
      floorRateQ64,
      notBefore: 0n,
      expiresAt: BigInt(orderExpiry(a.now, a.nextOpen ?? null)),
      payerIn,
      payeeOut,
    }),
  ]
  return { ixs, amountIn: a.amountIn, approved, floorRateQ64 }
}

/** `placeSellInstructions` as one transaction, for one signature. */
export function placeSellOrderTx(a: SellArgs): { tx: Transaction; amountIn: bigint; approved: bigint } {
  const { ixs, amountIn, approved } = placeSellInstructions(a)
  return { tx: new Transaction().add(...ixs), amountIn, approved }
}

/**
 * A sale's floor as the least it can be paid a share, in dollars rounded down
 * to the cent: the figure the page may promise for it.
 *
 * Worked back from the floor the order carries, not from the dollar price it
 * was built from, so the promise is the program's own number. The floor is
 * quote raw per stock raw in Q64.64 and the mark's rate is the inverse
 * direction, so floor × rate ÷ 2^128 is the floor as a fraction of the mark's
 * price, and times the price it is dollars a share. Rounded down twice, to the
 * mark's units and then to the cent, because a minimum shown a fraction of a
 * cent above the one enforced is a promise the program does not keep: three
 * quarters of $223.022379 is $167.266784, and "$167.27" would be over it.
 */
export function sellFloorUsd(floorRateQ64: bigint, markRateQ64: bigint, markPx: MarkPrice): number {
  if (floorRateQ64 <= 0n || markRateQ64 <= 0n || markPx.num <= 0n) return 0
  // In the mark's own units of 10^expo dollars a share, rounded down.
  const units = (floorRateQ64 * markRateQ64 * markPx.num) >> 128n
  const toCents = markPx.expo + 2
  const cents = toCents >= 0 ? units * 10n ** BigInt(toCents) : units / 10n ** BigInt(-toCents)
  return Number(cents) / 100
}

/**
 * The most the "max" button fills in, in stock raw: what the wallet holds less
 * what its other sales already offer, and no more than `capUsd` of value at
 * the mark. Rounded down, so the sale it proposes is one the program accepts.
 */
export function maxSellRaw(args: {
  held: bigint
  owed: bigint
  rateQ64: bigint | null
  capUsd?: number
}): bigint {
  const free = args.held > args.owed ? args.held - args.owed : 0n
  if (!args.rateQ64 || args.rateQ64 <= 0n) return 0n
  // `value = (raw << 64) / rate`, so the largest raw worth at most the cap is
  // `cap × rate >> 64`: shifting that back up can only land at or under it.
  const capRaw = BigInt(Math.round((args.capUsd ?? SELL_MAX_USD) * 10 ** QUOTE_DECIMALS))
  const byValue = (capRaw * args.rateQ64) >> 64n
  return free < byValue ? free : byValue
}

/**
 * Raw stock as the share count a person types: raw × the multiplier, at the
 * stock's decimals, trailing zeros dropped.
 *
 * Chosen so that `sharesToRaw` reads it back as exactly `raw` wherever some
 * count does, so the figure "max" fills in, the figure in the box above the
 * wallet and the figure in the order list are one number. A scaled mint's
 * share count is not a whole number of units, and flooring it would read back
 * one raw unit short and print a different last digit in each place. Where no
 * count reads back exactly (a multiplier under one can skip a raw amount), the
 * count below it, which reads back short and never over.
 */
export function rawToShares(raw: bigint, decimals: number, multiplier: number): string {
  // Units of 10^-decimals shares. Exact when the multiplier is one. Otherwise
  // the smallest count whose raw value, floored as `sharesToRaw` floors it with
  // the same float division, is `raw`, which is the product rounded up when
  // that reads back; else the product rounded down.
  let units = raw
  if (multiplier !== 1) {
    const x = Number(raw) * multiplier
    const up = Math.ceil(x)
    units = BigInt(Math.floor(up / multiplier) === Number(raw) ? up : Math.floor(x))
  }
  const s = units.toString().padStart(decimals + 1, '0')
  const whole = s.slice(0, s.length - decimals)
  const frac = s.slice(s.length - decimals).replace(/0+$/, '')
  return frac ? `${whole}.${frac}` : whole
}

/**
 * The share count to say back for a sale: as it was typed, tidied, when that
 * is exactly what the order will carry; otherwise the count the order carries.
 * On a scaled mint two typed counts can land on one raw amount, and echoing
 * "1.29999999" to someone who typed 1.3 would be a correct and useless answer.
 */
export function sharesShown(typed: string, raw: bigint, decimals: number, multiplier: number): string {
  const t = typed
    .trim()
    .replace(/^0+(?=\d)/, '')
    .replace(/\.(\d*?)0*$/, (_, f: string) => (f ? `.${f}` : ''))
  try {
    if ((t.split('.')[1] ?? '').length <= decimals && sharesToRaw(t, decimals, multiplier) === raw) return t
  } catch {
    // Not a count sharesToRaw reads; say the order's own figure instead.
  }
  return rawToShares(raw, decimals, multiplier)
}

/** A legacy transaction's hard size limit, in bytes. */
const TX_LIMIT = 1_232

/**
 * Split instructions into as few transactions as fit, keeping their order.
 * The first transaction always carries the leading setup instructions (the
 * re-read, the account, the approval), so every order after it is funded.
 */
export function packTransactions(ixs: readonly TransactionInstruction[], payer: PublicKey): Transaction[] {
  const size = (t: Transaction) => {
    t.feePayer = payer
    t.recentBlockhash = PublicKey.default.toBase58()
    // Message plus one signature and its compact-array length byte.
    return t.serializeMessage().length + 1 + 64
  }
  const txs: Transaction[] = []
  let cur = new Transaction()
  for (const ix of ixs) {
    const trial = new Transaction().add(...cur.instructions, ix)
    if (cur.instructions.length > 0 && size(trial) > TX_LIMIT) {
      txs.push(cur)
      cur = new Transaction().add(ix)
    } else {
      cur = trial
    }
  }
  if (cur.instructions.length) txs.push(cur)
  return txs
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

/**
 * Cancel one sale, in the order `cancelOrderTxs` cancels a buy and for the same
 * reasons, on the stock account instead of the quote account:
 *
 * 1. `revoke` on the stock account, under Token-2022, alone in its
 *    transaction. Once it lands no filler can take a share, whatever BELL does.
 * 2. `cancel_sell_order` closes the order and returns its rent.
 * 3. If other sales from the same stock account can still fill (`rest`),
 *    approve them again: the revoke cleared the one delegate slot they shared.
 *    Only after the close, so the cancelled sale is never funded again.
 *
 * `stockDelegated` false means the stock account is not delegated to BELL, so
 * the order is already unfunded and only the close runs. `decimals` is the
 * stock's, which `approve_checked` names; without it there is no re-approval,
 * and the caller says so.
 */
export function cancelSellOrderTxs(
  owner: PublicKey,
  order: SellOrder,
  rest: bigint,
  stockDelegated: boolean,
  decimals: number | null,
): Transaction[] {
  const close = new Transaction().add(
    ixCancelSellOrder({ signer: owner, owner, nonce: order.nonce, payerIn: order.payerIn }),
  )
  if (!stockDelegated) return [close]
  const txs = [new Transaction().add(ixRevoke(order.payerIn, owner, TOKEN_2022)), close]
  if (rest > 0n && decimals !== null) {
    txs.push(
      new Transaction().add(
        ixApproveChecked({
          source: order.payerIn,
          mint: order.mint,
          delegate: authPda(owner),
          owner,
          amount: rest,
          decimals,
          tokenProgram: TOKEN_2022,
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
 *
 * In this order, each step its own transaction or transactions:
 * 1. the quote account's revoke, alone, exactly as before sells existed, so it
 *    lands first and on its own whatever else fails;
 * 2. a revoke on each stock account delegated to BELL, under Token-2022;
 * 3. every buy and sell closed for its rent.
 * Every revoke comes before any close, so by the time BELL's own instructions
 * run nothing of the wallet's can move. `revokes` is how many transactions
 * steps 1 and 2 take, so the caller can tell "the funding is gone" from "the
 * rent is back". `quote` null leaves the quote account alone: it is missing, or
 * its approval belongs to someone other than BELL.
 */
export function revokeAllTxs(
  owner: PublicKey,
  quote: PublicKey | null,
  book: readonly BellOrder[],
  stock: readonly PublicKey[] = [],
  sells: readonly SellOrder[] = [],
): { txs: Transaction[]; revokes: number } {
  const txs = quote ? [new Transaction().add(ixRevoke(quote, owner))] : []
  txs.push(...packTransactions(stock.map((s) => ixRevoke(s, owner, TOKEN_2022)), owner))
  const revokes = txs.length
  const closes = [
    ...book.map((o) => ixCancelOrder({ signer: owner, owner, nonce: o.nonce, payerIn: o.payerIn })),
    ...sells.map((o) => ixCancelSellOrder({ signer: owner, owner, nonce: o.nonce, payerIn: o.payerIn })),
  ]
  // Six to a transaction rather than as many as fit: a close that meets an
  // order filled a moment ago fails its whole transaction, and a small batch
  // keeps that from stranding many others.
  for (let i = 0; i < closes.length; i += CLOSES_PER_TX) {
    txs.push(new Transaction().add(...closes.slice(i, i + CLOSES_PER_TX)))
  }
  return { txs, revokes }
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
/**
 * Anchor's InstructionFallbackNotFound: the deployed program has no handler
 * for the instruction. The page can meet it only when it is newer than the
 * program it talks to, as a page with sell orders is before the upgrade that
 * adds them lands.
 */
const ANCHOR_INSTRUCTION_NOT_FOUND = 101

export function refusalFrom(e: unknown): string | null {
  const text = [(e as Error)?.message ?? '', ...(((e as { logs?: string[] })?.logs) ?? [])].join('\n')
  const m = /custom program error: 0x([0-9a-f]+)/i.exec(text)
  if (!m) return null
  const code = parseInt(m[1], 16)
  // Anchor's AccountNotInitialized: the order account is gone — filled, or
  // closed by someone tidying the book after its funding was revoked.
  if (code === ANCHOR_ACCOUNT_NOT_INITIALIZED) return 'AlreadyClosed'
  if (code === ANCHOR_INSTRUCTION_NOT_FOUND) return 'InstructionFallbackNotFound'
  return errorName(code)
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
