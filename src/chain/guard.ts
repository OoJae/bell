/**
 * Composing the gate with a trade.
 *
 * `assert_tradeable` needs no wrapper program to protect a swap. Solana
 * transactions are atomic, so putting the gate first in the same transaction
 * means a refusal aborts everything after it — the swap never executes, and the
 * failure is visible on chain as a real reverted transaction rather than a
 * warning some front-end chose to show.
 *
 * The practical consequence is that any wallet, router or aggregator can adopt
 * this today by prepending one instruction to a transaction it already builds.
 * A program that wants the same protection CPIs into `assert_tradeable`
 * directly; the instruction is the same either way.
 */
import { Connection, PublicKey, Transaction, TransactionInstruction } from '@solana/web3.js'
import { ixAssertTradeable, readTokenRisk, BELL_ERRORS } from './client.ts'
import { Mode } from './codec.ts'

export interface GuardedPlan {
  transaction: Transaction
  /** Index of the gate within the transaction. Always 0 — it runs first. */
  gateIndex: number
}

/**
 * Prepend the gate to instructions that would otherwise execute unguarded.
 *
 * `expectedMultiplierBits` is read from chain at build time, so an order built
 * before a rebase and submitted after one is invalidated rather than silently
 * re-denominated.
 */
export async function guarded(args: {
  conn: Connection
  payer: PublicKey
  symbol: string
  mint: PublicKey
  mode?: Mode
  instructions: TransactionInstruction[]
}): Promise<GuardedPlan> {
  const risk = await readTokenRisk(args.conn, args.mint)
  if (!risk) throw new Error(`${args.symbol}: no token risk record; run scripts/register.ts`)

  const tx = new Transaction().add(
    ixAssertTradeable({
      symbol: args.symbol,
      mint: args.mint,
      mode: args.mode ?? Mode.Strict,
      expectedMultiplierBits: risk.multiplierBits,
    }),
    ...args.instructions,
  )
  tx.feePayer = args.payer
  tx.recentBlockhash = (await args.conn.getLatestBlockhash()).blockhash
  return { transaction: tx, gateIndex: 0 }
}

export interface Outcome {
  executed: boolean
  /** `BellError` variant when the gate refused, null when it allowed. */
  refusedBecause: string | null
  /** True when the failure came from the gate rather than from the trade. */
  refusedByGate: boolean
}

/** Read a simulation result without pretending a trade failure was a refusal. */
export function interpret(err: unknown, gateIndex: number): Outcome {
  if (!err) return { executed: true, refusedBecause: null, refusedByGate: false }

  const e = err as { InstructionError?: [number, { Custom?: number }] }
  const [index, detail] = e.InstructionError ?? []
  const code = detail?.Custom

  if (index === gateIndex && code !== undefined && code >= 6000) {
    const name = BELL_ERRORS[code - 6000] ?? `custom ${code}`
    return { executed: false, refusedBecause: name, refusedByGate: true }
  }
  // Something downstream failed. Not our refusal, and not ours to relabel.
  return { executed: false, refusedBecause: JSON.stringify(err), refusedByGate: false }
}
