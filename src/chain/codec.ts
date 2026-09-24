/**
 * Borsh encoding for `bell-session`, by hand.
 *
 * The IDL carries explicit 8-byte discriminators for every instruction and
 * account, and every argument is fixed-width — a `[u8; 12]`, a `u8` enum, a
 * `bool`, a couple of `i64`s. That makes this small enough to read in one
 * sitting, and it removes a dependency on the TypeScript Anchor client's
 * version lining up with anchor-lang 1.2. Pulling in a whole client library to
 * encode 38 bytes would add a large dependency tree and a version coupling on
 * the critical path, for no benefit.
 *
 * Discriminators are read from the generated IDL rather than hardcoded, so a
 * program change that alters one is caught here instead of on chain.
 */
import { PublicKey } from '@solana/web3.js'
// Imported rather than read from disk so this module runs unchanged in a
// browser. The front end and the keeper then share one encoder and one set of
// error names, which is the point: a UI that reimplements the rules is a UI
// that will eventually disagree with the chain about why a trade was refused.
//
// `src/chain/idl.json` is a copy of `target/idl/bell_session.json`; refresh it
// with `pnpm idl` whenever an instruction changes.
import idl from './idl.json' with { type: 'json' }

export const PROGRAM_ID = new PublicKey(idl.address)

/**
 * Custom error code -> name, read from the IDL rather than hardcoded.
 *
 * The program's errors are append-only by convention, but reading them means a
 * reordering would be caught here rather than silently mislabelling a refusal
 * as the wrong reason — which for a product whose whole output is *why* it said
 * no would be the worst kind of quiet bug.
 */
export const ERROR_NAMES: ReadonlyMap<number, string> = new Map(
  idl.errors.map((e) => [e.code, e.name]),
)

/**
 * The SPL token errors a fill can realistically hit, named.
 *
 * Anchor numbers custom errors from 6000, and the token program's are all
 * below 30, so the ranges cannot collide and one lookup can serve both.
 *
 * These are here because two of them are not failures at all — they are the
 * delegation design working. `OwnerMismatch` during a fill means the user
 * revoked, and `InsufficientFunds` means they spent the money elsewhere. Both
 * are how a non-custodial order is *supposed* to die, and reporting either as
 * `custom 4` would describe the system's best property as an unexplained
 * error.
 */
const SPL_TOKEN_ERRORS: ReadonlyMap<number, string> = new Map([
  [1, 'OwnerSpentTheFunds'],
  [3, 'MintMismatch'],
  [4, 'OwnerRevoked'],
  [6, 'AmountExceedsDelegation'],
])

/**
 * Program constants, read from the IDL rather than restated here.
 *
 * The front end explains *why* a gate refused, which means it has to know the
 * same bounds the program enforces. Restating them is how a panel ends up
 * confidently contradicting the chain it is describing — so they are read from
 * the same artefact the discriminators and error names come from.
 */
export const LIMITS: Readonly<Record<string, number>> = Object.freeze(
  Object.fromEntries(
    idl.constants
      .filter((c) => /^(MAX_|REBASE_)/.test(c.name))
      .map((c) => [c.name, Number(c.value)]),
  ),
)

export const MAX_STATE_AGE_SECONDS = LIMITS.MAX_STATE_AGE_SECONDS
export const MAX_MARK_AGE_SECONDS = LIMITS.MAX_MARK_AGE_SECONDS
export const REBASE_GUARD_SECONDS = LIMITS.REBASE_GUARD_SECONDS
/**
 * How old a TokenRisk read may be before the gate refuses it (gate 2b).
 * Falls back to "no bound" only so an IDL from before the bound cannot make
 * every row fail — the program, not this number, is what enforces it.
 */
export const MAX_RISK_AGE_SECONDS = LIMITS.MAX_RISK_AGE_SECONDS ?? Number.POSITIVE_INFINITY

export function errorName(code: number): string {
  return ERROR_NAMES.get(code) ?? SPL_TOKEN_ERRORS.get(code) ?? `custom ${code}`
}

/** Anchor account discriminator, for `getProgramAccounts` filters. */
export function accountDiscriminator(name: string): Buffer {
  return discriminator('accounts', name)
}

function discriminator(kind: 'instructions' | 'accounts', name: string): Buffer {
  const found = idl[kind].find((x) => x.name === name)
  if (!found) throw new Error(`${name} missing from IDL ${kind}`)
  return Buffer.from(found.discriminator)
}

/**
 * Minimal little-endian writer.
 *
 * Numeric fields go through `DataView` rather than Node's `Buffer.writeBigInt*`
 * helpers: this module also runs in the browser, where `Buffer` is a polyfill
 * that does not implement the BigInt methods. `DataView` is standard in both.
 */
class Writer {
  private parts: Uint8Array[] = []
  private push(bytes: number, fill: (v: DataView) => void) {
    const b = new Uint8Array(bytes)
    fill(new DataView(b.buffer))
    this.parts.push(b)
    return this
  }
  u8(v: number) { return this.push(1, (d) => d.setUint8(0, v & 0xff)) }
  bool(v: boolean) { return this.u8(v ? 1 : 0) }
  u16(v: number) { return this.push(2, (d) => d.setUint16(0, v, true)) }
  i32(v: number) { return this.push(4, (d) => d.setInt32(0, v, true)) }
  u64(v: bigint) { return this.push(8, (d) => d.setBigUint64(0, v, true)) }
  i64(v: bigint) { return this.push(8, (d) => d.setBigInt64(0, v, true)) }
  /** Borsh u128: two little-endian halves, low first. */
  u128(v: bigint) {
    return this.push(16, (d) => {
      d.setBigUint64(0, v & 0xffffffffffffffffn, true)
      d.setBigUint64(8, v >> 64n, true)
    })
  }
  bytes(v: Uint8Array) { this.parts.push(Uint8Array.from(v)); return this }
  key(v: PublicKey) { return this.bytes(v.toBytes()) }
  done(): Buffer {
    const total = this.parts.reduce((n, p) => n + p.length, 0)
    const out = new Uint8Array(total)
    let o = 0
    for (const p of this.parts) { out.set(p, o); o += p.length }
    return Buffer.from(out)
  }
}

/** The reading half, portable for the same reason. */
class Reader {
  private o = 0
  private readonly b: Uint8Array
  private readonly d: DataView
  // An explicit field rather than a parameter property: Node strips types
  // rather than compiling them, and parameter properties emit code.
  constructor(b: Uint8Array) {
    this.b = b
    this.d = new DataView(b.buffer, b.byteOffset, b.byteLength)
  }
  skip(n: number) { this.o += n; return this }
  u8() { return this.d.getUint8(this.o++) }
  bool() { return this.u8() === 1 }
  u16() { const v = this.d.getUint16(this.o, true); this.o += 2; return v }
  i32() { const v = this.d.getInt32(this.o, true); this.o += 4; return v }
  u64() { const v = this.d.getBigUint64(this.o, true); this.o += 8; return v }
  i64() { const v = this.d.getBigInt64(this.o, true); this.o += 8; return v }
  u128() {
    const lo = this.d.getBigUint64(this.o, true)
    const hi = this.d.getBigUint64(this.o + 8, true)
    this.o += 16
    return (hi << 64n) | lo
  }
  bytes(n: number) { const v = this.b.subarray(this.o, this.o + n); this.o += n; return v }
  key() { return new PublicKey(this.bytes(32)) }
  /** Borsh `Option<T>`: a one-byte tag, then the value only when present. */
  optionKey() { return this.bool() ? this.key() : null }
  text(n: number) { return new TextDecoder().decode(this.bytes(n)).trimEnd() }
}

// ---------------------------------------------------------------- instructions

export function encodeRegisterSymbol(args: {
  symbol: Uint8Array
  mint: PublicKey
  exchangeMic: string
  hoursMode: number
  attestor: PublicKey
}): Buffer {
  const mic = Buffer.alloc(4, 0x20)
  mic.write(args.exchangeMic.slice(0, 4))
  return Buffer.concat([
    discriminator('instructions', 'register_symbol'),
    new Writer()
      .bytes(args.symbol)
      .key(args.mint)
      .bytes(mic)
      .u8(args.hoursMode)
      .key(args.attestor)
      .done(),
  ])
}

export function encodePushSession(args: {
  symbol: Uint8Array
  halt: number
  openNow: boolean
  nextChangeAt: bigint
  observedAt: bigint
}): Buffer {
  return Buffer.concat([
    discriminator('instructions', 'push_session'),
    new Writer()
      .bytes(args.symbol)
      .u8(args.halt)
      .bool(args.openNow)
      .i64(args.nextChangeAt)
      .i64(args.observedAt)
      .done(),
  ])
}

export const encodeInitTokenRisk = (attestor: PublicKey): Buffer =>
  new Writer()
    .bytes(discriminator('instructions', 'init_token_risk'))
    .key(attestor)
    .done()
export const encodeRefreshTokenRisk = () => discriminator('instructions', 'refresh_token_risk')

/**
 * Mirrors the on-chain `RebaseKind` discriminants — `None, Split, Dividend,
 * Unknown`, in that order. `Unknown` is last because it was appended.
 *
 * The UI once held its own copy in a different order (`Unknown` second), which
 * made an unclassified rebase render as "pending Dividend" and tradeable while
 * the program refused it. Every enum mirror is now checked against the IDL's
 * variant order in `test/portability.test.ts`, so a copy that drifts fails a
 * test instead of contradicting the chain in front of someone.
 */
export const RebaseKind = { None: 0, Split: 1, Dividend: 2, Unknown: 3 } as const
export type RebaseKind = (typeof RebaseKind)[keyof typeof RebaseKind]

/** Name of a `RebaseKind` discriminant, for display. */
export const rebaseKindName = (k: number): string =>
  (Object.keys(RebaseKind) as (keyof typeof RebaseKind)[]).find((n) => RebaseKind[n] === k) ?? `kind ${k}`

export const encodeClassifyRebase = (kind: RebaseKind): Buffer =>
  new Writer().bytes(discriminator('instructions', 'classify_rebase')).u8(kind).done()

/** `Strict` refuses to trade without a live primary market; `Guarded` allows it. */
export const Mode = { Strict: 0, Guarded: 1 } as const
export type Mode = (typeof Mode)[keyof typeof Mode]

export function encodeAssertTradeable(args: {
  symbol: Uint8Array
  mode: Mode
  expectedMultiplierBits: bigint
}): Buffer {
  return Buffer.concat([
    discriminator('instructions', 'assert_tradeable'),
    new Writer().bytes(args.symbol).u8(args.mode).u64(args.expectedMultiplierBits).done(),
  ])
}

// ------------------------------------------------------------- queue & marks

/** Mirrors the on-chain `MarkSource` discriminants. */
export const MarkSource = { Backpack: 0, Jupiter: 1, Pyth: 2, XStocksNav: 3 } as const
export type MarkSource = (typeof MarkSource)[keyof typeof MarkSource]

export function encodeOpenMark(args: { symbol: Uint8Array; quoteMint: PublicKey }): Buffer {
  return Buffer.concat([
    discriminator('instructions', 'open_mark'),
    new Writer().bytes(args.symbol).key(args.quoteMint).done(),
  ])
}

export function encodePushMark(args: {
  symbol: Uint8Array
  rateQ64: bigint
  pxNum: bigint
  pxExpo: number
  confBps: number
  source: MarkSource
  observedAt: bigint
}): Buffer {
  return Buffer.concat([
    discriminator('instructions', 'push_mark'),
    new Writer()
      .bytes(args.symbol)
      .u128(args.rateQ64)
      .u64(args.pxNum)
      .i32(args.pxExpo)
      .u16(args.confBps)
      .u8(args.source)
      .i64(args.observedAt)
      .done(),
  ])
}

/**
 * The arguments `place_order` and `place_sell_order` share, in wire order.
 *
 * A sell takes the same nine arguments as a buy with its units swapped:
 * `amountIn` and `minFillIn` count stock raw units, and `floorRateQ64` is quote
 * raw per stock raw rather than stock per quote.
 */
export interface PlaceOrderArgs {
  symbol: Uint8Array
  nonce: bigint
  amountIn: bigint
  minFillIn: bigint
  maxSlipBps: number
  maxConfBps: number
  floorRateQ64: bigint
  notBefore: bigint
  expiresAt: bigint
}

function encodePlace(name: 'place_order' | 'place_sell_order', args: PlaceOrderArgs): Buffer {
  return Buffer.concat([
    discriminator('instructions', name),
    new Writer()
      .bytes(args.symbol)
      .u64(args.nonce)
      .u64(args.amountIn)
      .u64(args.minFillIn)
      .u16(args.maxSlipBps)
      .u16(args.maxConfBps)
      .u128(args.floorRateQ64)
      .i64(args.notBefore)
      .i64(args.expiresAt)
      .done(),
  ])
}

export const encodePlaceOrder = (args: PlaceOrderArgs): Buffer => encodePlace('place_order', args)

export const encodeCancelOrder = () => discriminator('instructions', 'cancel_order')

function encodeFill(name: 'fill_order' | 'fill_sell_order', args: { amountInLeg: bigint; amountOut: bigint }): Buffer {
  return Buffer.concat([
    discriminator('instructions', name),
    new Writer().u64(args.amountInLeg).u64(args.amountOut).done(),
  ])
}

export const encodeFillOrder = (args: { amountInLeg: bigint; amountOut: bigint }): Buffer => encodeFill('fill_order', args)

// ----------------------------------------------------------------- sell side
//
// The same three instructions with the legs swapped. Each is encoded by the
// buy side's own writer, so the only bytes that can differ are the eight the
// IDL names; a sell that drifted from its buy in argument order would have to
// drift here first, where the tests compare them.

export const encodePlaceSellOrder = (args: PlaceOrderArgs): Buffer => encodePlace('place_sell_order', args)

/** `amountInLeg` is stock raw taken from the seller, `amountOut` quote raw paid to them. */
export const encodeFillSellOrder = (args: { amountInLeg: bigint; amountOut: bigint }): Buffer =>
  encodeFill('fill_sell_order', args)

export const encodeCancelSellOrder = () => discriminator('instructions', 'cancel_sell_order')

export interface SymbolMark {
  symbol: string
  mint: PublicKey
  quoteMint: PublicKey
  rateQ64: bigint
  pxNum: bigint
  pxExpo: number
  confBps: number
  source: MarkSource
  observedAt: bigint
  bump: number
}

export function decodeSymbolMark(data: Uint8Array): SymbolMark {
  const r = new Reader(data).skip(8)
  return {
    symbol: r.text(12),
    mint: r.key(),
    quoteMint: r.key(),
    rateQ64: r.u128(),
    pxNum: r.u64(),
    pxExpo: r.i32(),
    confBps: r.u16(),
    source: r.u8() as MarkSource,
    observedAt: r.i64(),
    bump: r.u8(),
  }
}

export interface BellOrder {
  owner: PublicKey
  symbol: string
  mint: PublicKey
  quoteMint: PublicKey
  payerIn: PublicKey
  payeeOut: PublicKey
  amountIn: bigint
  filledIn: bigint
  minFillIn: bigint
  expectedMultiplierBits: bigint
  maxSlipBps: number
  maxConfBps: number
  floorRateQ64: bigint
  notBefore: bigint
  expiresAt: bigint
  nonce: bigint
  createdAt: bigint
  bump: number
  authBump: number
}

/**
 * A parked sell.
 *
 * The program declares `SellOrder` with the same fields as `BellOrder`, in the
 * same order, so the two share a layout and a decoder. What the fields hold is
 * swapped: `payerIn` is the seller's stock account, the one delegated to the
 * auth PDA; `payeeOut` is their quote account; `amountIn`, `filledIn` and
 * `minFillIn` count stock raw units; and `floorRateQ64` is quote raw per stock
 * raw, Q64.64.
 */
export type SellOrder = BellOrder

/**
 * Decode a `SellOrder`, refusing any other account.
 *
 * `decodeBellOrder` does not check its discriminator because until sells there
 * was nothing else it could be handed. Now there is, and past the first eight
 * bytes a buy and a sell are indistinguishable, so this is the only check that
 * stops a buy being priced as a sell: the one mistake that turns "never less
 * than the band" into "never more than it".
 */
export function decodeSellOrder(data: Uint8Array): SellOrder {
  const want = accountDiscriminator('SellOrder')
  if (data.length < 8 || want.some((b, i) => data[i] !== b)) throw new Error('not a SellOrder account')
  return decodeBellOrder(data)
}

export function decodeBellOrder(data: Uint8Array): BellOrder {
  const r = new Reader(data).skip(8)
  return {
    owner: r.key(),
    symbol: r.text(12),
    mint: r.key(),
    quoteMint: r.key(),
    payerIn: r.key(),
    payeeOut: r.key(),
    amountIn: r.u64(),
    filledIn: r.u64(),
    minFillIn: r.u64(),
    expectedMultiplierBits: r.u64(),
    maxSlipBps: r.u16(),
    maxConfBps: r.u16(),
    floorRateQ64: r.u128(),
    notBefore: r.i64(),
    expiresAt: r.i64(),
    nonce: r.u64(),
    createdAt: r.i64(),
    bump: r.u8(),
    authBump: r.u8(),
  }
}

/**
 * Stock raw units per quote raw unit, Q64.64.
 *
 * Raw-per-raw rather than a human price because the two legs have different
 * decimals — SPYx is 8, Backpack's PFE is 6 — and because it is the only form
 * the program can use without doing decimals arithmetic on chain.
 *
 * `multiplier` must be the *effective* scaled-UI multiplier: raw balances are
 * not share units, and for a post-split mint the gap is the entire split.
 */
export function rateQ64(args: {
  pricePerShare: number
  multiplier: number
  quoteDecimals: number
  stockDecimals: number
}): bigint {
  const SCALE = 10n ** 18n
  const denom = BigInt(Math.round(args.pricePerShare * args.multiplier * 1e18))
  if (denom <= 0n) throw new Error('rateQ64: non-positive price')
  return (
    ((1n << 64n) * 10n ** BigInt(args.stockDecimals) * SCALE) /
    (denom * 10n ** BigInt(args.quoteDecimals))
  )
}

/** `amountIn * rate >> 64` — the fair output the band is measured against. */
export function fairOut(amountIn: bigint, rate: bigint): bigint {
  return (amountIn * rate) >> 64n
}

// ------------------------------------------------------------- sell pricing
//
// Mirrors of `fill_sell_order`'s arithmetic in sell.rs, step for step. A buy
// multiplies by the mark's rate (stock per quote); a sell divides by it. Every
// result below is a minimum the seller is owed, so every step rounds *up*, the
// opposite of the buy side's `fairOut`. A filler that priced with the buy
// side's rounding would deliver one unit short and be refused on chain with
// PriceOutOfBand, so these are not approximations of the program's numbers but
// the numbers themselves.

const U128_MAX = (1n << 128n) - 1n
const U64_MASK = (1n << 64n) - 1n

/** The program's `checked_mul` on u128: refuse where the chain would, rather than carry on in unbounded BigInt. */
function checkedU128(v: bigint): bigint {
  if (v > U128_MAX) throw new RangeError('MathOverflow: the product does not fit in a u128')
  return v
}

/**
 * Quote raw units worth `a` stock raw units at `rate`, rounded up.
 *
 * Written as a quotient plus a remainder test, as sell.rs is, rather than
 * `(num + rate - 1) / rate`: in the program's u128 that addition overflows once
 * the rate passes 2^64, which happens whenever a raw unit of stock is worth
 * less than a raw unit of quote (an 8-decimal stock under $100, for one).
 * BigInt would not overflow, but a mirror written differently is one that can
 * quietly start to disagree.
 */
export function stockToQuoteCeil(a: bigint, rate: bigint): bigint {
  // A mark that has never been pushed carries a zero rate: no price to divide
  // by, which the program reports as MarkStale.
  if (rate <= 0n) throw new RangeError('MarkStale: the mark carries no rate')
  const num = a << 64n
  return num / rate + (num % rate !== 0n ? 1n : 0n)
}

/** `a * q >> 64`, rounded up. The ceiling counterpart of `fairOut`, for a sell's floor. */
export function mulShr64Ceil(a: bigint, q: bigint): bigint {
  const p = checkedU128(a * q)
  return (p >> 64n) + ((p & U64_MASK) !== 0n ? 1n : 0n)
}

/**
 * The least quote a fill of `leg` stock raw may pay under the band alone:
 * the fair value less `slipBps`, with both the fair value and the band edge
 * rounded up.
 */
export function sellBandOut(leg: bigint, rate: bigint, slipBps: number): bigint {
  const t = checkedU128(stockToQuoteCeil(leg, rate) * BigInt(10_000 - slipBps))
  return t / 10_000n + (t % 10_000n !== 0n ? 1n : 0n)
}

/** `fill_sell_order`'s `min_out`: the stricter of the band and the seller's floor. */
export function sellMinOut(leg: bigint, rate: bigint, slipBps: number, floorRateQ64: bigint): bigint {
  const band = sellBandOut(leg, rate, slipBps)
  const floor = mulShr64Ceil(leg, floorRateQ64)
  return floor > band ? floor : band
}

/**
 * What `place_sell_order` caps, in quote raw: `(amountIn << 64) / rate`,
 * rounded down as the program rounds it, so an order worth exactly the cap
 * passes. The cap itself is `MAX_ORDER_IN`, a quote amount, because a sell's
 * `amountIn` is stock and a raw count alone says nothing about value.
 */
export function sellOrderValue(amountIn: bigint, rate: bigint): bigint {
  if (rate <= 0n) throw new RangeError('MarkStale: the mark carries no rate')
  return (amountIn << 64n) / rate
}

/**
 * A sell's loss floor: three quarters of the mark's price, as quote raw per
 * stock raw in Q64.64.
 *
 * The mark's rate is stock per quote in Q64.64, so the price it stands for in
 * the other direction is 2^128 / rate, and three quarters of that is
 * `(3 << 128) / (4 × rate)`. The same three quarters as the buy side's
 * `LOSS_FLOOR` in policy/order.ts (a test holds the two together), and for the
 * same reason: a leaked attestor key could push a forged price, and a parked
 * sell must not fill for a quarter of what the stock was worth when the user
 * placed it. Zero, meaning no floor, when the mark carries no rate.
 */
export function sellLossFloor(rate: bigint): bigint {
  return rate > 0n ? (3n << 128n) / (4n * rate) : 0n
}

/**
 * `floor_rate_q64` for a seller's limit: "don't sell for less than `limitUsd`
 * a share".
 *
 * The mark carries both its rate (stock raw per quote raw) and the per-share
 * price that rate stands for (`num × 10^expo`, with the decimals and the
 * scaled-UI multiplier already folded in). Quote per stock at the mark is
 * 2^128 / rate; at the limit it is that scaled by limit / price. So the floor
 * is `limit × 2^128 / (pxNum × rate)` with the limit in the mark's own units,
 * which is exact integer arithmetic and needs no decimals of its own.
 *
 * Rounded up: a floor a hair above the exact limit asks for a hair more quote,
 * which can only keep the price at or above the limit. Zero, meaning no floor,
 * without a usable limit or mark. Throws for a limit so large its floor would
 * not fit the instruction's u128, which the encoder would otherwise truncate
 * into a smaller floor than the one asked for.
 */
export function sellLimitFloor(limitUsd: number, markPx: { num: bigint; expo: number }, rate: bigint): bigint {
  if (!(limitUsd > 0) || rate <= 0n || markPx.num <= 0n) return 0n
  const limit = BigInt(Math.round(limitUsd * 10 ** -markPx.expo))
  if (limit <= 0n) return 0n
  const num = limit << 128n
  const den = markPx.num * rate
  const floor = num / den + (num % den !== 0n ? 1n : 0n)
  if (floor > U128_MAX) throw new RangeError('limit too large to express as a floor')
  return floor
}

// ------------------------------------------------------------------- accounts

export interface SymbolState {
  symbol: string
  mint: PublicKey
  exchangeMic: string
  hoursMode: number
  halt: number
  openNow: boolean
  nextChangeAt: bigint
  observedAt: bigint
  attestor: PublicKey
  bump: number
}

export function decodeSymbolState(data: Uint8Array): SymbolState {
  const r = new Reader(data).skip(8)
  return {
    symbol: r.text(12),
    mint: r.key(),
    exchangeMic: r.text(4),
    hoursMode: r.u8(),
    halt: r.u8(),
    openNow: r.bool(),
    nextChangeAt: r.i64(),
    observedAt: r.i64(),
    attestor: r.key(),
    bump: r.u8(),
  }
}

export interface TokenRisk {
  mint: PublicKey
  paused: boolean
  multiplierBits: bigint
  pendingMultiplierBits: bigint
  activatesAt: bigint
  rebaseKind: number
  hook: PublicKey | null
  permanentDelegate: PublicKey | null
  verifiedAt: bigint
  /** The only key permitted to set `rebaseKind`. */
  attestor: PublicKey
  bump: number
}

export function decodeTokenRisk(data: Uint8Array): TokenRisk {
  const r = new Reader(data).skip(8)
  return {
    mint: r.key(),
    paused: r.bool(),
    multiplierBits: r.u64(),
    pendingMultiplierBits: r.u64(),
    activatesAt: r.i64(),
    rebaseKind: r.u8(),
    hook: r.optionKey(),
    permanentDelegate: r.optionKey(),
    verifiedAt: r.i64(),
    attestor: r.key(),
    bump: r.u8(),
  }
}

/** The stored multiplier is raw bits so the guard can compare it exactly. */
export const multiplierOf = (bits: bigint): number => {
  const d = new DataView(new ArrayBuffer(8))
  d.setBigUint64(0, bits, true)
  return d.getFloat64(0, true)
}
