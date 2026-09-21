/**
 * Transport for `bell-session`: PDAs, transactions, and read-only gate checks.
 *
 * `@solana/web3.js` is used for transport only — the encoding lives in
 * `codec.ts`.
 */
import { readFileSync } from 'node:fs'
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from '@solana/web3.js'
import {
  PROGRAM_ID,
  Mode,
  decodeSymbolState,
  decodeTokenRisk,
  encodeAssertTradeable,
  encodeInitTokenRisk,
  encodePushSession,
  encodeRefreshTokenRisk,
  encodeRegisterSymbol,
  type SymbolState,
  type TokenRisk,
} from './codec.ts'
import { symbolSeed } from '../config.ts'

const TOKEN_2022 = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb')
const SYMBOL_SEED = Buffer.from('sym')
const RISK_SEED = Buffer.from('risk')

export const rpcUrl = () => process.env.BELL_RPC_URL ?? 'http://127.0.0.1:8899'
export const connect = () => new Connection(rpcUrl(), 'confirmed')

/** Solana CLI keypair format: a JSON array of 64 bytes. */
export function loadKeypair(path: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, 'utf8'))))
}

export const symbolPda = (symbol: string) =>
  PublicKey.findProgramAddressSync([SYMBOL_SEED, Buffer.from(symbolSeed(symbol))], PROGRAM_ID)[0]

export const riskPda = (mint: PublicKey) =>
  PublicKey.findProgramAddressSync([RISK_SEED, mint.toBytes()], PROGRAM_ID)[0]

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

export function ixInitTokenRisk(payer: PublicKey, mint: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: riskPda(mint), isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: encodeInitTokenRisk(),
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

// ------------------------------------------------------------------ helpers

export async function send(
  conn: Connection,
  ixs: TransactionInstruction[],
  signers: Keypair[],
): Promise<string> {
  const tx = new Transaction().add(...ixs)
  return sendAndConfirmTransaction(conn, tx, signers, {
    commitment: 'confirmed',
    skipPreflight: false,
  })
}

export async function readSymbolState(conn: Connection, symbol: string): Promise<SymbolState | null> {
  const acc = await conn.getAccountInfo(symbolPda(symbol))
  return acc ? decodeSymbolState(acc.data) : null
}

export async function readTokenRisk(conn: Connection, mint: PublicKey): Promise<TokenRisk | null> {
  const acc = await conn.getAccountInfo(riskPda(mint))
  return acc ? decodeTokenRisk(acc.data) : null
}

/** Anchor custom errors start at 6000; `BellError` is declared in that order. */
export const BELL_ERRORS = [
  'MarketClosed',
  'StateStale',
  'IssuerPaused',
  'RebasePending',
  'RebaseUnclassified',
  'MultiplierMoved',
  'HookArmed',
  'NotToken2022',
  'MintMismatch',
  'NotAttestor',
  'TimestampInFuture',
] as const

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
export async function checkGate(
  conn: Connection,
  payer: PublicKey,
  args: { symbol: string; mint: PublicKey; mode: Mode; expectedMultiplierBits: bigint },
): Promise<GateResult> {
  const tx = new Transaction().add(ixAssertTradeable(args))
  tx.feePayer = payer
  tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash

  const sim = await conn.simulateTransaction(tx)
  const logs = sim.value.logs ?? []
  if (!sim.value.err) return { allowed: true, reason: null, logs }

  const err = sim.value.err as { InstructionError?: [number, { Custom?: number }] }
  const code = err.InstructionError?.[1]?.Custom
  const reason =
    code !== undefined && code >= 6000 && code - 6000 < BELL_ERRORS.length
      ? BELL_ERRORS[code - 6000]
      : JSON.stringify(sim.value.err)
  return { allowed: false, reason, logs }
}

export { Mode, TOKEN_2022 }
