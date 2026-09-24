/**
 * Transport for `bell-session`: PDAs, transactions, and read-only gate checks.
 *
 * `@solana/web3.js` is used for transport only — the encoding lives in
 * `codec.ts`.
 */
import {
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
  VersionedTransaction,
  type Keypair,
} from '@solana/web3.js'
import {
  PROGRAM_ID,
  Mode,
  MarkSource,
  accountDiscriminator,
  decodeBellOrder,
  decodeNightOptIn,
  decodeSellOrder,
  decodeSymbolCheck,
  decodeSymbolMark,
  decodeSymbolState,
  decodeTokenRisk,
  encodeAssertTradeable,
  encodeCancelOrder,
  encodeCancelSellOrder,
  encodeClassifyRebase,
  encodeCrossOrders,
  encodeFillOrder,
  encodeFillSellOrder,
  encodeInitTokenRisk,
  encodeOpenCheck,
  encodeOpenMark,
  encodeOptInNight,
  encodeOptOutNight,
  encodePlaceOrder,
  encodePlaceSellOrder,
  encodePushCheck,
  encodePushMark,
  encodePushSession,
  encodeRefreshTokenRisk,
  encodeRegisterSymbol,
  nightConsent,
  type RebaseKind,
  errorName,
  type BellOrder,
  type NightOptIn,
  type SellOrder,
  type SymbolCheck,
  type SymbolMark,
  type SymbolState,
  type TokenRisk,
} from './codec.ts'
import { symbolSeed } from '../config.ts'

const TOKEN_2022 = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb')
const SYMBOL_SEED = Buffer.from('sym')
const RISK_SEED = Buffer.from('risk')
const MARK_SEED = Buffer.from('mark')
const ORDER_SEED = Buffer.from('ord')
const SELL_SEED = Buffer.from('sell')
const AUTH_SEED = Buffer.from('auth')
const CHECK_SEED = Buffer.from('check')
const NIGHT_SEED = Buffer.from('night')

/** Plain SPL Token, which is what the quote leg (USDC) lives under. */
export const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')

export const DEFAULT_RPC = 'http://127.0.0.1:8899'

/** Node reads the env; a browser passes the URL in. */
export const rpcUrl = () =>
  (typeof process !== 'undefined' ? process.env?.BELL_RPC_URL : undefined) ?? DEFAULT_RPC

export const connect = (url?: string) => new Connection(url ?? rpcUrl(), 'confirmed')

export const symbolPda = (symbol: string) =>
  PublicKey.findProgramAddressSync([SYMBOL_SEED, Buffer.from(symbolSeed(symbol))], PROGRAM_ID)[0]

export const riskPda = (mint: PublicKey) =>
  PublicKey.findProgramAddressSync([RISK_SEED, mint.toBytes()], PROGRAM_ID)[0]

export const markPda = (symbol: string) =>
  PublicKey.findProgramAddressSync([MARK_SEED, Buffer.from(symbolSeed(symbol))], PROGRAM_ID)[0]

/** A nonce as the little-endian u64 seed both order PDAs are derived from. */
const nonceSeed = (nonce: bigint): Uint8Array => {
  // DataView, not `Buffer.writeBigUInt64LE`: this runs in the browser too, and
  // the bundled Buffer polyfill has no BigInt methods. See FRICTION.md — this
  // is the second instance of that trap, and it hid here because the seed is
  // derived rather than encoded, so the codec sweep missed it.
  const n = new Uint8Array(8)
  new DataView(n.buffer).setBigUint64(0, nonce, true)
  return n
}

export const orderPda = (owner: PublicKey, nonce: bigint) =>
  PublicKey.findProgramAddressSync([ORDER_SEED, owner.toBytes(), nonceSeed(nonce)], PROGRAM_ID)[0]

/**
 * A sell order's address. Its own seed rather than the buy side's, so a buy
 * and a sell with the same nonce are two accounts, and neither side's client
 * has to know which nonces the other has used.
 */
export const sellOrderPda = (owner: PublicKey, nonce: bigint) =>
  PublicKey.findProgramAddressSync([SELL_SEED, owner.toBytes(), nonceSeed(nonce)], PROGRAM_ID)[0]

/**
 * The per-owner delegate authority.
 *
 * Per owner rather than per order, because an SPL token account has exactly one
 * delegate slot — a per-order PDA would mean placing a second order silently
 * un-authorises the first. One authority for all of a user's orders, and one
 * `revoke` cancels all of them.
 */
export const authPda = (owner: PublicKey) =>
  PublicKey.findProgramAddressSync([AUTH_SEED, owner.toBytes()], PROGRAM_ID)[0]

/** A symbol's check: the second signer's view of its session and last sale. One per symbol. */
export const checkPda = (symbol: string) =>
  PublicKey.findProgramAddressSync([CHECK_SEED, Buffer.from(symbolSeed(symbol))], PROGRAM_ID)[0]

/**
 * An owner's night opt-in. Per owner rather than per order, because consent
 * to fills while the market is shut is a decision about the owner's orders,
 * all of them, including those already placed.
 */
export const nightPda = (owner: PublicKey) =>
  PublicKey.findProgramAddressSync([NIGHT_SEED, owner.toBytes()], PROGRAM_ID)[0]

/** The upgradeable loader, which owns the account that names the program's upgrade authority. */
export const BPF_LOADER_UPGRADEABLE = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111')

/** The program's ProgramData account, which `open_check` reads the upgrade authority from. */
export const programDataPda = () =>
  PublicKey.findProgramAddressSync([PROGRAM_ID.toBytes()], BPF_LOADER_UPGRADEABLE)[0]

// ------------------------------------------------------------- instructions

export function ixRegisterSymbol(args: {
  payer: PublicKey
  symbol: string
  mint: PublicKey
  exchangeMic: string
  hoursMode: number
  attestor: PublicKey
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: args.payer, isSigner: true, isWritable: true },
      { pubkey: symbolPda(args.symbol), isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: encodeRegisterSymbol({
      symbol: symbolSeed(args.symbol),
      mint: args.mint,
      exchangeMic: args.exchangeMic,
      hoursMode: args.hoursMode,
      attestor: args.attestor,
    }),
  })
}

export function ixInitTokenRisk(
  payer: PublicKey,
  mint: PublicKey,
  attestor: PublicKey,
): TransactionInstruction {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: riskPda(mint), isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: encodeInitTokenRisk(attestor),
  })
}

export function ixRefreshTokenRisk(mint: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: riskPda(mint), isSigner: false, isWritable: true },
    ],
    data: encodeRefreshTokenRisk(),
  })
}

/**
 * Record whether a pending multiplier change is a split or a dividend.
 *
 * Signed by the key recorded in `TokenRisk.attestor` — the hot keeper key, not
 * the deploy key. It is the one attested field in an otherwise-proven account,
 * so it carries an authority of its own (see AUDIT.md, finding 1).
 */
export function ixClassifyRebase(args: {
  attestor: PublicKey
  mint: PublicKey
  kind: RebaseKind
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: args.attestor, isSigner: true, isWritable: false },
      { pubkey: riskPda(args.mint), isSigner: false, isWritable: true },
    ],
    data: encodeClassifyRebase(args.kind),
  })
}

export function ixPushSession(args: {
  attestor: PublicKey
  symbol: string
  halt: number
  openNow: boolean
  nextChangeAt: bigint
  observedAt: bigint
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: args.attestor, isSigner: true, isWritable: false },
      { pubkey: symbolPda(args.symbol), isSigner: false, isWritable: true },
    ],
    data: encodePushSession({ ...args, symbol: symbolSeed(args.symbol) }),
  })
}

export function ixAssertTradeable(args: {
  symbol: string
  mint: PublicKey
  mode: Mode
  expectedMultiplierBits: bigint
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: symbolPda(args.symbol), isSigner: false, isWritable: false },
      { pubkey: riskPda(args.mint), isSigner: false, isWritable: false },
    ],
    data: encodeAssertTradeable({ ...args, symbol: symbolSeed(args.symbol) }),
  })
}

export function ixOpenMark(payer: PublicKey, symbol: string, quoteMint: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: symbolPda(symbol), isSigner: false, isWritable: false },
      { pubkey: markPda(symbol), isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: encodeOpenMark({ symbol: symbolSeed(symbol), quoteMint }),
  })
}

export function ixPushMark(args: {
  attestor: PublicKey
  symbol: string
  rateQ64: bigint
  pxNum: bigint
  pxExpo: number
  confBps: number
  source: MarkSource
  observedAt: bigint
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: args.attestor, isSigner: true, isWritable: false },
      { pubkey: symbolPda(args.symbol), isSigner: false, isWritable: false },
      { pubkey: markPda(args.symbol), isSigner: false, isWritable: true },
    ],
    data: encodePushMark({ ...args, symbol: symbolSeed(args.symbol) }),
  })
}

export function ixPlaceOrder(args: {
  owner: PublicKey
  symbol: string
  mint: PublicKey
  nonce: bigint
  amountIn: bigint
  minFillIn: bigint
  maxSlipBps: number
  maxConfBps: number
  floorRateQ64: bigint
  notBefore: bigint
  expiresAt: bigint
  payerIn: PublicKey
  payeeOut: PublicKey
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: args.owner, isSigner: true, isWritable: true },
      { pubkey: symbolPda(args.symbol), isSigner: false, isWritable: false },
      { pubkey: riskPda(args.mint), isSigner: false, isWritable: false },
      { pubkey: markPda(args.symbol), isSigner: false, isWritable: false },
      { pubkey: orderPda(args.owner, args.nonce), isSigner: false, isWritable: true },
      { pubkey: args.payerIn, isSigner: false, isWritable: false },
      { pubkey: args.payeeOut, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: encodePlaceOrder({ ...args, symbol: symbolSeed(args.symbol) }),
  })
}

export function ixCancelOrder(args: {
  signer: PublicKey
  owner: PublicKey
  nonce: bigint
  payerIn: PublicKey
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: args.signer, isSigner: true, isWritable: false },
      { pubkey: args.owner, isSigner: false, isWritable: true },
      { pubkey: orderPda(args.owner, args.nonce), isSigner: false, isWritable: true },
      { pubkey: args.payerIn, isSigner: false, isWritable: false },
    ],
    data: encodeCancelOrder(),
  })
}

export function ixFillOrder(args: {
  filler: PublicKey
  order: BellOrder
  fillerIn: PublicKey
  fillerOut: PublicKey
  amountInLeg: bigint
  amountOut: bigint
  stockTokenProgram?: PublicKey
  quoteTokenProgram?: PublicKey
}): TransactionInstruction {
  const o = args.order
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: args.filler, isSigner: true, isWritable: true },
      { pubkey: orderPda(o.owner, o.nonce), isSigner: false, isWritable: true },
      { pubkey: symbolPda(o.symbol), isSigner: false, isWritable: false },
      { pubkey: riskPda(o.mint), isSigner: false, isWritable: false },
      { pubkey: markPda(o.symbol), isSigner: false, isWritable: false },
      { pubkey: authPda(o.owner), isSigner: false, isWritable: false },
      { pubkey: o.owner, isSigner: false, isWritable: true },
      { pubkey: o.payerIn, isSigner: false, isWritable: true },
      { pubkey: o.payeeOut, isSigner: false, isWritable: true },
      { pubkey: args.fillerIn, isSigner: false, isWritable: true },
      { pubkey: args.fillerOut, isSigner: false, isWritable: true },
      { pubkey: o.quoteMint, isSigner: false, isWritable: false },
      { pubkey: o.mint, isSigner: false, isWritable: false },
      { pubkey: args.quoteTokenProgram ?? TOKEN_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: args.stockTokenProgram ?? TOKEN_2022, isSigner: false, isWritable: false },
      ...checkedFillTail(o),
    ],
    data: encodeFillOrder({ amountInLeg: args.amountInLeg, amountOut: args.amountOut }),
  })
}

/**
 * The two accounts every fill has carried since the checker: the symbol's
 * check, and the owner's night opt-in.
 *
 * The opt-in's address is passed whether or not anything lives there. The
 * program reads it as consent only when it is this program's `NightOptIn`
 * naming the order's owner, so an empty address is simply "not opted in", and
 * a filler cannot choose to leave it out: the program counts accounts, and a
 * fill without these two fails with AccountNotEnoughKeys before it runs.
 */
const checkedFillTail = (o: Pick<BellOrder, 'symbol' | 'owner'>) => [
  { pubkey: checkPda(o.symbol), isSigner: false, isWritable: false },
  { pubkey: nightPda(o.owner), isSigner: false, isWritable: false },
]

// --------------------------------------------------------------- sell side
//
// The account lists below are the buy side's, name for name and flag for flag,
// because the program declares them that way; only the order's address and
// what each token account holds differ. `test/sell.test.ts` checks each list
// against the IDL.

/**
 * Park a sell. The caller puts `approve_checked` on the **stock** account, under
 * Token-2022, in front of this in the same transaction; the program verifies
 * that delegation rather than creating it.
 */
export function ixPlaceSellOrder(args: {
  owner: PublicKey
  symbol: string
  mint: PublicKey
  nonce: bigint
  /** Stock raw units to sell. */
  amountIn: bigint
  minFillIn: bigint
  maxSlipBps: number
  maxConfBps: number
  /** Quote raw per stock raw, Q64.64; 0 for none. */
  floorRateQ64: bigint
  notBefore: bigint
  expiresAt: bigint
  /** The seller's stock account, delegated to `authPda(owner)`. */
  payerIn: PublicKey
  /** The seller's quote account, which the filler pays. */
  payeeOut: PublicKey
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: args.owner, isSigner: true, isWritable: true },
      { pubkey: symbolPda(args.symbol), isSigner: false, isWritable: false },
      { pubkey: riskPda(args.mint), isSigner: false, isWritable: false },
      { pubkey: markPda(args.symbol), isSigner: false, isWritable: false },
      { pubkey: sellOrderPda(args.owner, args.nonce), isSigner: false, isWritable: true },
      { pubkey: args.payerIn, isSigner: false, isWritable: false },
      { pubkey: args.payeeOut, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: encodePlaceSellOrder({ ...args, symbol: symbolSeed(args.symbol) }),
  })
}

export function ixCancelSellOrder(args: {
  signer: PublicKey
  owner: PublicKey
  nonce: bigint
  /** The order's stock account, read by the program to tell a revoked order from a live one. */
  payerIn: PublicKey
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: args.signer, isSigner: true, isWritable: false },
      { pubkey: args.owner, isSigner: false, isWritable: true },
      { pubkey: sellOrderPda(args.owner, args.nonce), isSigner: false, isWritable: true },
      { pubkey: args.payerIn, isSigner: false, isWritable: false },
    ],
    data: encodeCancelSellOrder(),
  })
}

/**
 * Settle a sell: the filler pays quote from `fillerOut` first, and the program
 * then takes the stock into `fillerIn`.
 *
 * The same seventeen accounts as `ixFillOrder` in the same order, so here
 * `fillerIn` is the filler's **stock** account and `fillerOut` its **quote**
 * account: the reverse of a buy. The token programs default the same way,
 * quote under SPL Token and stock under Token-2022.
 */
export function ixFillSellOrder(args: {
  filler: PublicKey
  order: SellOrder
  fillerIn: PublicKey
  fillerOut: PublicKey
  /** Stock raw taken from the seller. */
  amountInLeg: bigint
  /** Quote raw paid to the seller. */
  amountOut: bigint
  stockTokenProgram?: PublicKey
  quoteTokenProgram?: PublicKey
}): TransactionInstruction {
  const o = args.order
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: args.filler, isSigner: true, isWritable: true },
      { pubkey: sellOrderPda(o.owner, o.nonce), isSigner: false, isWritable: true },
      { pubkey: symbolPda(o.symbol), isSigner: false, isWritable: false },
      { pubkey: riskPda(o.mint), isSigner: false, isWritable: false },
      { pubkey: markPda(o.symbol), isSigner: false, isWritable: false },
      { pubkey: authPda(o.owner), isSigner: false, isWritable: false },
      { pubkey: o.owner, isSigner: false, isWritable: true },
      { pubkey: o.payerIn, isSigner: false, isWritable: true },
      { pubkey: o.payeeOut, isSigner: false, isWritable: true },
      { pubkey: args.fillerIn, isSigner: false, isWritable: true },
      { pubkey: args.fillerOut, isSigner: false, isWritable: true },
      { pubkey: o.quoteMint, isSigner: false, isWritable: false },
      { pubkey: o.mint, isSigner: false, isWritable: false },
      { pubkey: args.quoteTokenProgram ?? TOKEN_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: args.stockTokenProgram ?? TOKEN_2022, isSigner: false, isWritable: false },
      ...checkedFillTail(o),
    ],
    data: encodeFillSellOrder({ amountInLeg: args.amountInLeg, amountOut: args.amountOut }),
  })
}

// ------------------------------------------------------------ opening cross

/**
 * Settle a due buy directly against a due sell of the same symbol, at the mark,
 * with no filler between them. Permissionless, session only.
 *
 * Every account is found from the two orders: the symbol's state, risk, mark
 * and check from the buy (the program requires the sell to be for the same
 * symbol, mint and quote asset), and each token account from the order that
 * pins it, so a cranker chooses only which two orders meet, never where
 * anything goes. What moves is decided on chain (see `crossAmounts` in
 * codec.ts for the same arithmetic), which is why this takes no amounts.
 * The token programs default as a fill's do, quote under SPL Token and stock
 * under Token-2022.
 */
export function ixCrossOrders(args: {
  cranker: PublicKey
  buy: BellOrder
  sell: SellOrder
  quoteTokenProgram?: PublicKey
  stockTokenProgram?: PublicKey
}): TransactionInstruction {
  const { buy: b, sell: s } = args
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: args.cranker, isSigner: true, isWritable: false },
      { pubkey: orderPda(b.owner, b.nonce), isSigner: false, isWritable: true },
      { pubkey: sellOrderPda(s.owner, s.nonce), isSigner: false, isWritable: true },
      { pubkey: symbolPda(b.symbol), isSigner: false, isWritable: false },
      { pubkey: riskPda(b.mint), isSigner: false, isWritable: false },
      { pubkey: markPda(b.symbol), isSigner: false, isWritable: false },
      { pubkey: checkPda(b.symbol), isSigner: false, isWritable: false },
      { pubkey: authPda(b.owner), isSigner: false, isWritable: false },
      { pubkey: authPda(s.owner), isSigner: false, isWritable: false },
      // Rent destinations when an order completes: each order's own owner.
      { pubkey: b.owner, isSigner: false, isWritable: true },
      { pubkey: s.owner, isSigner: false, isWritable: true },
      { pubkey: b.payerIn, isSigner: false, isWritable: true },
      { pubkey: b.payeeOut, isSigner: false, isWritable: true },
      { pubkey: s.payerIn, isSigner: false, isWritable: true },
      { pubkey: s.payeeOut, isSigner: false, isWritable: true },
      { pubkey: b.quoteMint, isSigner: false, isWritable: false },
      { pubkey: b.mint, isSigner: false, isWritable: false },
      { pubkey: args.quoteTokenProgram ?? TOKEN_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: args.stockTokenProgram ?? TOKEN_2022, isSigner: false, isWritable: false },
    ],
    data: encodeCrossOrders(),
  })
}

// ------------------------------------------------------------------ checker

/**
 * Open `symbol`'s check and name its checker. Signed by the program's upgrade
 * authority, which the program reads from its ProgramData account rather than
 * trusting a key it is handed, and only once per symbol. The checker must not
 * be the symbol's attestor: the point is two keys.
 */
export function ixOpenCheck(args: {
  payer: PublicKey
  authority: PublicKey
  symbol: string
  checker: PublicKey
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: args.payer, isSigner: true, isWritable: true },
      { pubkey: args.authority, isSigner: true, isWritable: false },
      { pubkey: programDataPda(), isSigner: false, isWritable: false },
      { pubkey: symbolPda(args.symbol), isSigner: false, isWritable: false },
      { pubkey: checkPda(args.symbol), isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: encodeOpenCheck({ symbol: symbolSeed(args.symbol), checker: args.checker }),
  })
}

/** The checker's push: its session verdict and its reference price for `symbol`. */
export function ixPushCheck(args: {
  checker: PublicKey
  symbol: string
  openNow: boolean
  refRateQ64: bigint
  refPxNum: bigint
  refPxExpo: number
  refAt: bigint
  observedAt: bigint
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: args.checker, isSigner: true, isWritable: false },
      { pubkey: checkPda(args.symbol), isSigner: false, isWritable: true },
    ],
    data: encodePushCheck({ ...args, symbol: symbolSeed(args.symbol) }),
  })
}

// -------------------------------------------------------------------- night

/**
 * Consent to fills while the primary market is shut, for every order the owner
 * has, including those already placed. The owner pays the opt-in's rent.
 */
export function ixOptInNight(owner: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: owner, isSigner: true, isWritable: true },
      { pubkey: nightPda(owner), isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: encodeOptInNight(),
  })
}

/** Withdraw that consent, for every order at once, and take the rent back. */
export function ixOptOutNight(owner: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: owner, isSigner: true, isWritable: true },
      { pubkey: nightPda(owner), isSigner: false, isWritable: true },
    ],
    data: encodeOptOutNight(),
  })
}

// ------------------------------------------------------------------ helpers

/**
 * Errors that mean "the network dropped this", not "this was wrong".
 *
 * Public devnet RPC rejects a meaningful fraction of sends with
 * `Blockhash not found` — the node that receives the transaction has not yet
 * seen the blockhash the node that issued it gave us. It is pure infrastructure
 * noise, and the keeper meets it every 45 seconds for as long as it runs.
 *
 * Retrying only these is the point. A transaction refused by the *gate* must
 * never be retried: refusal is the product, and a retry loop that cannot tell
 * the two apart would hammer away at a market that is legitimately shut.
 */
const TRANSIENT = /Blockhash not found|block height exceeded|Node is behind|429|timeout|fetch failed/i

export async function send(
  conn: Connection,
  ixs: TransactionInstruction[],
  signers: Keypair[],
  attempts = 4,
): Promise<string> {
  let last: unknown
  for (let i = 0; i < attempts; i++) {
    try {
      // A fresh Transaction each attempt: `sendAndConfirmTransaction` stamps
      // the blockhash onto the object, so reusing it would retry with the
      // very blockhash that was just rejected.
      const tx = new Transaction().add(...ixs)
      return await sendAndConfirmTransaction(conn, tx, signers, {
        commitment: 'confirmed',
        skipPreflight: false,
      })
    } catch (e) {
      last = e
      if (!TRANSIENT.test((e as Error).message ?? '')) throw e
      // Linear backoff. A blockhash the cluster has not caught up to yet is
      // fixed by waiting, not by trying harder.
      await new Promise((r) => setTimeout(r, 800 * (i + 1)))
    }
  }
  throw last
}

export async function readSymbolState(conn: Connection, symbol: string): Promise<SymbolState | null> {
  const acc = await conn.getAccountInfo(symbolPda(symbol))
  return acc ? decodeSymbolState(acc.data) : null
}

export async function readTokenRisk(conn: Connection, mint: PublicKey): Promise<TokenRisk | null> {
  const acc = await conn.getAccountInfo(riskPda(mint))
  return acc ? decodeTokenRisk(acc.data) : null
}

export async function readMark(conn: Connection, symbol: string): Promise<SymbolMark | null> {
  const acc = await conn.getAccountInfo(markPda(symbol))
  return acc ? decodeSymbolMark(acc.data) : null
}

/**
 * The check at a check address, or null when nothing there is one.
 *
 * Anyone can send lamports to an address, and a transfer to a check address
 * before `open_check` has run leaves an empty account owned by the system
 * program there. Decoding that would throw, and since the board reads every
 * symbol's check in one request, one such transfer would stop the keeper, the
 * crank, the checker and the page together. `open_check` still succeeds over
 * it (Anchor's `init` takes a funded address), so until then it reads as what
 * it is: no check.
 */
function checkAt(info: { owner: PublicKey; data: Uint8Array } | null | undefined): SymbolCheck | null {
  if (!info || !info.owner.equals(PROGRAM_ID)) return null
  const want = accountDiscriminator('SymbolCheck')
  if (info.data.length < 8 || want.some((b, i) => info.data[i] !== b)) return null
  return decodeSymbolCheck(info.data)
}

/** One symbol's check, or null before `open_check` (or on a program that has none). */
export async function readCheck(conn: Pick<Connection, 'getAccountInfo'>, symbol: string): Promise<SymbolCheck | null> {
  return checkAt(await conn.getAccountInfo(checkPda(symbol)))
}

/**
 * Every symbol's check, found by its account discriminator, keyed by symbol.
 * One `getProgramAccounts`, however many symbols have one.
 */
export async function readChecks(conn: Pick<Connection, 'getProgramAccounts'>): Promise<Map<string, SymbolCheck>> {
  const filters = [{ memcmp: { offset: 0, bytes: bs58Encode(accountDiscriminator('SymbolCheck')) } }]
  const accounts = await conn.getProgramAccounts(PROGRAM_ID, { filters })
  const out = new Map<string, SymbolCheck>()
  for (const a of accounts) {
    const c = decodeSymbolCheck(a.account.data)
    out.set(c.symbol, c)
  }
  return out
}

/**
 * Whether `owner` has opted in to night fills, read as the program reads it:
 * the account at their night address, judged by `nightConsent`. Null when it
 * is not there, or is there but would not count.
 */
export async function readNightOptIn(
  conn: Pick<Connection, 'getAccountInfo'>,
  owner: PublicKey,
): Promise<NightOptIn | null> {
  const acc = await conn.getAccountInfo(nightPda(owner))
  return acc && nightConsent(acc, owner) ? decodeNightOptIn(acc.data) : null
}

/**
 * The night opt-ins of `owners`, keyed by owner (base58), with anyone who has
 * not opted in left out; or, with no list, every opt-in there is.
 *
 * With a list it reads each owner's own night address, split under the node's
 * key limit as every batched read here is, and keeps only what the program
 * would count as consent. That is the crank's question: which of the book's
 * owners may fill tonight. Without one it asks the node for every account
 * with the `NightOptIn` discriminator, which only this program can have
 * written, and keeps each one whose recorded owner is the one at its address.
 */
export async function readNightOptIns(
  conn: Pick<Connection, 'getMultipleAccountsInfo' | 'getProgramAccounts'>,
  owners?: readonly PublicKey[],
): Promise<Map<string, NightOptIn>> {
  const out = new Map<string, NightOptIn>()
  if (owners) {
    const infos = await readAccounts(conn, owners.map(nightPda))
    owners.forEach((owner, i) => {
      const info = infos[i]
      if (info && nightConsent(info, owner)) out.set(owner.toBase58(), decodeNightOptIn(info.data))
    })
    return out
  }
  const filters = [{ memcmp: { offset: 0, bytes: bs58Encode(accountDiscriminator('NightOptIn')) } }]
  for (const a of await conn.getProgramAccounts(PROGRAM_ID, { filters })) {
    const n = decodeNightOptIn(a.account.data)
    if (a.pubkey.equals(nightPda(n.owner))) out.set(n.owner.toBase58(), n)
  }
  return out
}

/** One symbol's four accounts, however they were fetched. */
export interface SymbolAccounts {
  state: SymbolState | null
  risk: TokenRisk | null
  mark: SymbolMark | null
  /**
   * The second signer's check. Null before `open_check`, which on a program
   * with checks means every fill of the symbol is refused (AccountNotInitialized),
   * and on one without them is simply absent.
   */
  check: SymbolCheck | null
}

/**
 * Every symbol's state, risk, mark and check in a single RPC round trip.
 *
 * Read one at a time this was 27 `getAccountInfo` calls per refresh, which
 * public devnet RPC answers with HTTP 429 — and because an unreachable chain
 * correctly reads as *not tradeable*, being rate-limited rendered as "Cannot
 * reach the chain" across the whole board. Fail-closed is right, but a venue
 * that closes itself because it asked too many questions is not.
 *
 * `getMultipleAccounts` takes up to 100 keys, so four for each of fourteen
 * listings fits in one.
 */
export async function readAllSymbols(
  conn: Pick<Connection, 'getMultipleAccountsInfo'>,
  listings: readonly { symbol: string; mint: string }[],
): Promise<Map<string, SymbolAccounts>> {
  return (await readBoard(conn, listings)).symbols
}

/** `getMultipleAccounts` refuses more keys than this in one call. */
export const MAX_KEYS_PER_READ = 100

type AccountInfos = (import('@solana/web3.js').AccountInfo<Buffer> | null)[]

/**
 * `getMultipleAccountsInfo` over any number of keys, in order.
 *
 * The node refuses a request with more than 100 keys outright, so the caller
 * whose key list grows with the order book — the crank reads each order's
 * funding account — must never send one list. Unsplit, 37 orders were enough
 * to make every crank pass throw, and placing an order costs only refundable
 * rent: anyone could have stopped every fill. Chunks run one after another,
 * not in parallel, because a burst is what public RPC answers with 429.
 */
export async function readAccounts(
  conn: Pick<Connection, 'getMultipleAccountsInfo'>,
  keys: readonly PublicKey[],
): Promise<AccountInfos> {
  const out: AccountInfos = []
  for (let i = 0; i < keys.length; i += MAX_KEYS_PER_READ) {
    out.push(...(await conn.getMultipleAccountsInfo(keys.slice(i, i + MAX_KEYS_PER_READ))))
  }
  return out
}

/**
 * The board plus any extra accounts, in as few round trips as the node allows.
 *
 * `extra` is how the page reads the connected wallet's SOL and demo-USDC
 * without a second request per poll — the 429 that once closed the whole board
 * came from exactly that kind of per-thing read. The page's keys, four per
 * listing and its few extras, are one call; the crank's list grows with the
 * book and is split by `readAccounts`. The extras come back in the order they
 * were asked for, after the board, however many accounts each listing takes.
 */
export async function readBoard(
  conn: Pick<Connection, 'getMultipleAccountsInfo'>,
  listings: readonly { symbol: string; mint: string }[],
  extra: readonly PublicKey[] = [],
): Promise<{
  symbols: Map<string, SymbolAccounts>
  extras: AccountInfos
}> {
  // Four per symbol: the check rides in the same request as the other three,
  // so knowing whether the second signer agrees costs no extra round trip.
  const PER = 4
  const keys: PublicKey[] = []
  for (const l of listings) {
    keys.push(symbolPda(l.symbol), riskPda(new PublicKey(l.mint)), markPda(l.symbol), checkPda(l.symbol))
  }
  const infos = await readAccounts(conn, [...keys, ...extra])
  const out = new Map<string, SymbolAccounts>()
  listings.forEach((l, i) => {
    const [s, r, m, c] = infos.slice(i * PER, i * PER + PER)
    out.set(l.symbol, {
      state: s ? decodeSymbolState(s.data) : null,
      risk: r ? decodeTokenRisk(r.data) : null,
      mark: m ? decodeSymbolMark(m.data) : null,
      check: checkAt(c),
    })
  })
  return { symbols: out, extras: infos.slice(keys.length) }
}

export async function readOrder(
  conn: Connection,
  owner: PublicKey,
  nonce: bigint,
): Promise<BellOrder | null> {
  const acc = await conn.getAccountInfo(orderPda(owner, nonce))
  return acc ? decodeBellOrder(acc.data) : null
}

/**
 * Every live order, found by its account discriminator.
 *
 * This is what makes the crank permissionless in practice as well as in
 * principle: anyone can enumerate the book from the chain alone, with no index
 * to query and no server of ours to ask.
 */
/**
 * Every live order, or one owner's.
 *
 * The owner filter runs on the RPC node (a memcmp on the first field after the
 * discriminator) rather than by fetching the whole book and discarding most of
 * it — which is the difference between one small response and one that grows
 * with every judge who tries the site.
 */
export async function readOrders(conn: Connection, owner?: PublicKey): Promise<BellOrder[]> {
  const filters = [{ memcmp: { offset: 0, bytes: bs58Encode(accountDiscriminator('BellOrder')) } }]
  if (owner) filters.push({ memcmp: { offset: 8, bytes: owner.toBase58() } })
  const accounts = await conn.getProgramAccounts(PROGRAM_ID, { filters })
  return accounts.map((a) => decodeBellOrder(a.account.data))
}

export async function readSellOrder(
  conn: Connection,
  owner: PublicKey,
  nonce: bigint,
): Promise<SellOrder | null> {
  const acc = await conn.getAccountInfo(sellOrderPda(owner, nonce))
  return acc ? decodeSellOrder(acc.data) : null
}

/**
 * Every live sell, or one owner's: `readOrders` with the `SellOrder`
 * discriminator. The owner is the first field after it, as in a `BellOrder`,
 * so the same offset-8 filter narrows it on the node.
 */
export async function readSellOrders(
  conn: Pick<Connection, 'getProgramAccounts'>,
  owner?: PublicKey,
): Promise<SellOrder[]> {
  const filters = [{ memcmp: { offset: 0, bytes: bs58Encode(accountDiscriminator('SellOrder')) } }]
  if (owner) filters.push({ memcmp: { offset: 8, bytes: owner.toBase58() } })
  const accounts = await conn.getProgramAccounts(PROGRAM_ID, { filters })
  return accounts.map((a) => decodeSellOrder(a.account.data))
}

/** web3.js wants base58 for memcmp; this is the only place we need it. */
function bs58Encode(b: Buffer): string {
  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
  let n = 0n
  for (const byte of b) n = n * 256n + BigInt(byte)
  let out = ''
  while (n > 0n) {
    out = ALPHABET[Number(n % 58n)] + out
    n /= 58n
  }
  for (const byte of b) {
    if (byte !== 0) break
    out = '1' + out
  }
  return out
}

export interface GateResult {
  allowed: boolean
  /** `BellError` variant name, or null when the gate passed. */
  reason: string | null
  logs: string[]
}

/**
 * Ask the gate without paying for it.
 *
 * `assert_tradeable` either succeeds or fails, so simulation answers the
 * question exactly as execution would — which is what makes a read-only guard
 * API possible at all, and how a refusal is asserted in tests without a fee.
 */
/**
 * Simulate instructions with the node's own blockhash.
 *
 * Fetching a blockhash and then simulating against it is two requests, and
 * public devnet load-balances them across nodes: the second node regularly has
 * not seen the first node's blockhash, and the simulation fails with
 * BlockhashNotFound before the program runs at all. On the board that read as
 * "Refused" for a symbol the program would have allowed. A simulation never
 * needed a real blockhash — so ask the node to substitute its own, which is one
 * request instead of two and cannot fail that way.
 */
export async function simulate(
  conn: Connection,
  ixs: TransactionInstruction[],
  payer: PublicKey,
  accounts?: PublicKey[],
) {
  const tx = new Transaction().add(...ixs)
  tx.feePayer = payer
  tx.recentBlockhash = PublicKey.default.toBase58() // replaced by the node
  return conn.simulateTransaction(new VersionedTransaction(tx.compileMessage()), {
    replaceRecentBlockhash: true,
    sigVerify: false,
    commitment: 'confirmed',
    ...(accounts ? { accounts: { encoding: 'base64', addresses: accounts.map((a) => a.toBase58()) } } : {}),
  })
}

export async function checkGate(
  conn: Connection,
  payer: PublicKey,
  args: { symbol: string; mint: PublicKey; mode: Mode; expectedMultiplierBits: bigint },
): Promise<GateResult> {
  const sim = await simulate(conn, [ixAssertTradeable(args)], payer)
  const logs = sim.value.logs ?? []
  if (!sim.value.err) return { allowed: true, reason: null, logs }

  const err = sim.value.err as { InstructionError?: [number, { Custom?: number }] }
  const code = err.InstructionError?.[1]?.Custom
  const reason = code !== undefined ? errorName(code) : JSON.stringify(sim.value.err)
  return { allowed: false, reason, logs }
}

export { Mode, MarkSource, TOKEN_2022, errorName }
export type { BellOrder, NightOptIn, SellOrder, SymbolCheck, SymbolMark, SymbolState, TokenRisk }
