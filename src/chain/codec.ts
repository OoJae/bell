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

export function errorName(code: number): string {
  return ERROR_NAMES.get(code) ?? `custom ${code}`
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

/** Minimal little-endian writer. Grows as needed; no length guessing. */
class Writer {
  private parts: Buffer[] = []
  u8(v: number) { this.parts.push(Buffer.from([v & 0xff])); return this }
  bool(v: boolean) { return this.u8(v ? 1 : 0) }
  u16(v: number) { const b = Buffer.alloc(2); b.writeUInt16LE(v); this.parts.push(b); return this }
  i32(v: number) { const b = Buffer.alloc(4); b.writeInt32LE(v); this.parts.push(b); return this }
  u64(v: bigint) { const b = Buffer.alloc(8); b.writeBigUInt64LE(v); this.parts.push(b); return this }
  /** Borsh u128: little-endian, 16 bytes. Node has no writeBigUInt128LE. */
  u128(v: bigint) {
    const b = Buffer.alloc(16)
    b.writeBigUInt64LE(v & 0xffffffffffffffffn, 0)
    b.writeBigUInt64LE(v >> 64n, 8)
    this.parts.push(b)
    return this
  }
  i64(v: bigint) { const b = Buffer.alloc(8); b.writeBigInt64LE(v); this.parts.push(b); return this }
  bytes(v: Uint8Array) { this.parts.push(Buffer.from(v)); return this }
  key(v: PublicKey) { return this.bytes(v.toBytes()) }
  done() { return Buffer.concat(this.parts) }
}

class Reader {
  private o = 0
  private readonly b: Buffer
  // An explicit field rather than a parameter property: Node strips types
  // rather than compiling them, and parameter properties emit code.
  constructor(b: Buffer) {
    this.b = b
  }
  skip(n: number) { this.o += n; return this }
  u8() { return this.b.readUInt8(this.o++) }
  bool() { return this.u8() === 1 }
  u16() { const v = this.b.readUInt16LE(this.o); this.o += 2; return v }
  i32() { const v = this.b.readInt32LE(this.o); this.o += 4; return v }
  u64() { const v = this.b.readBigUInt64LE(this.o); this.o += 8; return v }
  u128() {
    const lo = this.b.readBigUInt64LE(this.o)
    const hi = this.b.readBigUInt64LE(this.o + 8)
    this.o += 16
    return (hi << 64n) | lo
  }
  i64() { const v = this.b.readBigInt64LE(this.o); this.o += 8; return v }
  bytes(n: number) { const v = this.b.subarray(this.o, this.o + n); this.o += n; return v }
  key() { return new PublicKey(this.bytes(32)) }
  /** Borsh `Option<T>`: a one-byte tag, then the value only when present. */
  optionKey() { return this.bool() ? this.key() : null }
  text(n: number) { return this.bytes(n).toString('utf8').trimEnd() }
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

export const encodeInitTokenRisk = () => discriminator('instructions', 'init_token_risk')
export const encodeRefreshTokenRisk = () => discriminator('instructions', 'refresh_token_risk')

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

export function encodePlaceOrder(args: {
  symbol: Uint8Array
  nonce: bigint
  amountIn: bigint
  minFillIn: bigint
  maxSlipBps: number
  maxConfBps: number
  floorRateQ64: bigint
  notBefore: bigint
  expiresAt: bigint
}): Buffer {
  return Buffer.concat([
    discriminator('instructions', 'place_order'),
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

export const encodeCancelOrder = () => discriminator('instructions', 'cancel_order')

export function encodeFillOrder(args: { amountInLeg: bigint; amountOut: bigint }): Buffer {
  return Buffer.concat([
    discriminator('instructions', 'fill_order'),
    new Writer().u64(args.amountInLeg).u64(args.amountOut).done(),
  ])
}

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

export function decodeSymbolMark(data: Buffer): SymbolMark {
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

export function decodeBellOrder(data: Buffer): BellOrder {
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

export function decodeSymbolState(data: Buffer): SymbolState {
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
  bump: number
}

export function decodeTokenRisk(data: Buffer): TokenRisk {
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
    bump: r.u8(),
  }
}

/** The stored multiplier is raw bits so the guard can compare it exactly. */
export const multiplierOf = (bits: bigint): number => {
  const b = Buffer.alloc(8)
  b.writeBigUInt64LE(bits)
  return b.readDoubleLE(0)
}
