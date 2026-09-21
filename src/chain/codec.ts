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
import { readFileSync } from 'node:fs'
import { PublicKey } from '@solana/web3.js'

interface Idl {
  address: string
  instructions: Array<{ name: string; discriminator: number[] }>
  accounts: Array<{ name: string; discriminator: number[] }>
}

const idl: Idl = JSON.parse(
  readFileSync(new URL('../../target/idl/bell_session.json', import.meta.url), 'utf8'),
)

export const PROGRAM_ID = new PublicKey(idl.address)

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
  u64(v: bigint) { const b = Buffer.alloc(8); b.writeBigUInt64LE(v); this.parts.push(b); return this }
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
  u64() { const v = this.b.readBigUInt64LE(this.o); this.o += 8; return v }
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
