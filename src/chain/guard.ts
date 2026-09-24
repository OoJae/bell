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
 *
 * `docs/INTEGRATE.md` is the integrator's guide to everything in this file.
 */
import {
  Connection,
  PublicKey,
  Transaction,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  type AddressLookupTableAccount,
} from '@solana/web3.js'
import {
  ixAssertTradeable,
  ixRefreshTokenRisk,
  readAccounts,
  readTokenRisk,
  riskPda,
  simulate,
  symbolPda,
} from './client.ts'
import { Mode, decodeSymbolState, decodeTokenRisk, errorName } from './codec.ts'
import { HaltState } from '../policy/reconcile.ts'
// The program's own sentence for each refusal, read from the same artefact as
// the error names, so a wallet's warning cannot drift from what the chain says.
import idl from './idl.json' with { type: 'json' }

export interface GuardedPlan {
  transaction: Transaction
  /** Index of the gate within the transaction. Always 0 — it runs first. */
  gateIndex: number
}

/**
 * BELL's instructions for one symbol: an optional re-read of the mint, then
 * the gate.
 *
 * The re-read exists because the gate refuses a mint record older than
 * `MAX_RISK_AGE_SECONDS` (`RiskStale`), and BELL's keeper is what normally
 * keeps it fresh. `refresh_token_risk` is permissionless, so a caller that does
 * not want to depend on our keeper for that can carry its own. It is off by
 * default because it write-locks the symbol's risk account, which serialises
 * every transaction that carries it for the same mint.
 */
export function gateInstructions(args: {
  symbol: string
  mint: PublicKey
  mode?: Mode
  expectedMultiplierBits: bigint
  refreshRisk?: boolean
}): TransactionInstruction[] {
  const gate = ixAssertTradeable({
    symbol: args.symbol,
    mint: args.mint,
    mode: args.mode ?? Mode.Strict,
    expectedMultiplierBits: args.expectedMultiplierBits,
  })
  return args.refreshRisk ? [ixRefreshTokenRisk(args.mint), gate] : [gate]
}

/**
 * Put BELL's instructions in front of the caller's.
 *
 * The caller's instructions follow unchanged and in their own order — the same
 * objects, not copies — because the whole promise of composing by prepending
 * is that the guarded transaction is the caller's transaction plus the gate and
 * nothing else. The gate is the last of BELL's instructions, so nothing of the
 * caller's runs before it has answered.
 */
export function composeGuarded(
  bell: readonly TransactionInstruction[],
  instructions: readonly TransactionInstruction[],
): { instructions: TransactionInstruction[]; gateIndex: number } {
  if (bell.length === 0) throw new Error('composeGuarded: no gate to put first')
  return { instructions: [...bell, ...instructions], gateIndex: bell.length - 1 }
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

  const plan = composeGuarded(
    gateInstructions({
      symbol: args.symbol,
      mint: args.mint,
      mode: args.mode,
      expectedMultiplierBits: risk.multiplierBits,
    }),
    args.instructions,
  )
  const tx = new Transaction().add(...plan.instructions)
  tx.feePayer = args.payer
  tx.recentBlockhash = (await args.conn.getLatestBlockhash()).blockhash
  return { transaction: tx, gateIndex: plan.gateIndex }
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
    return { executed: false, refusedBecause: errorName(code), refusedByGate: true }
  }
  // Something downstream failed. Not our refusal, and not ours to relabel.
  return { executed: false, refusedBecause: JSON.stringify(err), refusedByGate: false }
}

// ------------------------------------------------------------------ verdicts

const MESSAGES: ReadonlyMap<number, string> = new Map(idl.errors.map((e) => [e.code, e.msg]))

/**
 * The two Anchor framework errors the gate raises for accounts that are wrong
 * rather than refused, as measured against the devnet deployment: a symbol
 * nobody registered (`symbol_state` does not exist), and a risk account that is
 * not the one for the symbol's mint. Neither is a `BellError`, and both still
 * abort the transaction.
 */
const FRAMEWORK: ReadonlyMap<number, { name: string; msg: string }> = new Map([
  [2006, { name: 'ConstraintSeeds', msg: 'A seeds constraint was violated' }],
  [3012, { name: 'AccountNotInitialized', msg: 'The program expected this account to be already initialized' }],
])

export interface GateAnswer {
  /**
   * The gate passed. The only field to branch on before letting a trade
   * through, and it answers only for the gate: whether the caller's own
   * instructions would succeed is a separate question.
   */
  tradeable: boolean
  /**
   * Why not: a `BellError` name such as `MarketClosed`, an Anchor error name
   * when the accounts were wrong, or the raw failure when the gate never ran.
   * Null when tradeable.
   */
  reason: string | null
  /** The program's own sentence for `reason`, when it has one. */
  message: string | null
}

/**
 * What the gate said, from a transaction error.
 *
 * Works on a simulation of the gate alone and on one of the whole guarded
 * transaction. Anything that failed at or before `gateIndex` means the gate did
 * not pass — refused, or unable to run, which is the same answer for a trade.
 * A failure after it means the gate passed and one of the caller's own
 * instructions failed, which is not BELL's to report as a refusal. An error
 * with no instruction index (a fee payer with no SOL, a blockhash the node has
 * not seen) means nothing ran at all, and that is not permission either.
 */
export function readVerdict(err: unknown, gateIndex: number): GateAnswer {
  if (!err) return { tradeable: true, reason: null, message: null }

  const e = err as { InstructionError?: [number, { Custom?: number } | string] }
  if (!e.InstructionError) return { tradeable: false, reason: JSON.stringify(err), message: null }

  const [index, detail] = e.InstructionError
  if (index > gateIndex) return { tradeable: true, reason: null, message: null }

  const code = typeof detail === 'object' && detail !== null ? detail.Custom : undefined
  if (code === undefined) return { tradeable: false, reason: JSON.stringify(err), message: null }
  const framework = FRAMEWORK.get(code)
  if (framework) return { tradeable: false, reason: framework.name, message: framework.msg }
  return { tradeable: false, reason: errorName(code), message: MESSAGES.get(code) ?? null }
}

export interface Verdict extends GateAnswer {
  /**
   * Refused only because the attested session is shut, with no halt attested:
   * the case a bell order is for. False for a halt, an issuer's withdrawal, a
   * stale attestation or anything wrong with the token, where waiting for the
   * open would not help.
   */
  waitsForOpen: boolean
  /** The attested session, as read when the transaction was built. */
  session: {
    openNow: boolean
    /** `HaltState`: 0 none, 1 LULD, 2 news pending, 3 market-wide, 4 suspension, 5 unspecified. */
    halt: number
    /** Unix seconds of the next attested session change — the open, while closed. 0 when unknown. */
    nextChangeAt: number
    /** Unix seconds of the attestation. */
    observedAt: number
  }
  /** Compute units BELL's instructions used in the simulation, when the node reported them. */
  unitsConsumed: number | null
  logs: string[]
}

export interface GuardedTransaction {
  /**
   * Unsigned: BELL's instructions first, then the caller's, compiled into a v0
   * message with the caller's lookup tables. Sign and send it as you would the
   * transaction you started with.
   */
  transaction: VersionedTransaction
  /** The same instructions, for a caller that compiles its own message. */
  instructions: TransactionInstruction[]
  /** Index of the gate. 0, or 1 when `refreshRisk` put a mint re-read in front of it. */
  gateIndex: number
  /** The blockhash the transaction carries, and the height past which it cannot land. */
  blockhash: string
  lastValidBlockHeight: number
  /** The gate's answer right now, from a read-only simulation. Advisory: the gate decides again when the transaction executes. */
  verdict: Verdict
}

/**
 * Guard an arbitrary list of instructions, and say what the gate would answer.
 *
 * The symbol and the mint are both required, and must agree with each other on
 * chain, because the gate is keyed by symbol while a trade moves a mint: a
 * symbol pinned to one mint guarding a swap of another would protect nothing.
 * Pass `attestor` to pin the key whose attestations you are trusting —
 * `register_symbol` and `init_token_risk` are both first-come, so a record is
 * only as good as the key it names. The pin is checked against both records.
 *
 * Throws when the transaction cannot be built honestly: the symbol is not
 * registered, the mint has no risk record, the symbol names another mint,
 * either record names another attestor than the one pinned, or the chain
 * cannot be read. A caller that meant to guard a
 * trade should treat a throw as a refusal, not fall back to sending the trade
 * unguarded.
 *
 * Does not throw when only the simulation fails: the verdict then reads not
 * tradeable, and the transaction is still returned, because the gate inside it
 * is what decides at execution — the verdict only lets a wallet say so first.
 */
export async function guardInstructions(
  conn: Connection,
  args: {
    symbol: string
    mint: PublicKey
    /** The caller's instructions — a swap, a deposit, a borrow. Kept exactly as given. */
    instructions: readonly TransactionInstruction[]
    /** Fee payer of the returned transaction: normally the user's wallet. */
    payer: PublicKey
    /** `Mode.Strict` (the default) requires a live primary market; `Mode.Guarded` skips that gate only. */
    mode?: Mode
    /** Re-read the mint in the same transaction, so a stale record cannot refuse it. */
    refreshRisk?: boolean
    /** Address lookup tables for the caller's instructions, as a router returns them. */
    lookupTables?: readonly AddressLookupTableAccount[]
    /** The attestor you trust for this symbol and its mint's risk record. Unchecked when omitted. */
    attestor?: PublicKey
  },
): Promise<GuardedTransaction> {
  const { symbol, mint } = args
  // One round trip for both accounts, and the blockhash alongside it rather
  // than after it.
  const [[stateInfo, riskInfo], latest] = await Promise.all([
    readAccounts(conn, [symbolPda(symbol), riskPda(mint)]),
    conn.getLatestBlockhash('confirmed'),
  ])
  if (!stateInfo) throw new Error(`${symbol}: not registered with BELL on this cluster`)
  if (!riskInfo) throw new Error(`${symbol}: no risk record for mint ${mint.toBase58()}`)
  const state = decodeSymbolState(stateInfo.data)
  const risk = decodeTokenRisk(riskInfo.data)
  if (!state.mint.equals(mint)) {
    throw new Error(`${symbol} is bound to mint ${state.mint.toBase58()}, not ${mint.toBase58()}`)
  }
  if (args.attestor && !state.attestor.equals(args.attestor)) {
    throw new Error(
      `${symbol} is attested by ${state.attestor.toBase58()}, not the ${args.attestor.toBase58()} you pinned`,
    )
  }
  // The risk record carries an attestor of its own: the key that labels a
  // pending multiplier change a split or a dividend, which is what check 4b
  // trusts. It is set by whoever created the record, first-come per mint and
  // independently of `register_symbol`, so pinning only the symbol's attestor
  // would leave that label to a key nobody chose.
  if (args.attestor && !risk.attestor.equals(args.attestor)) {
    throw new Error(
      `${symbol}'s risk record is attested by ${risk.attestor.toBase58()}, not the ${args.attestor.toBase58()} you pinned`,
    )
  }

  // Built against the multiplier the mint record holds now. A rebase that
  // lands between this read and execution fails the gate as MultiplierMoved
  // instead of settling the trade in a denomination nobody quoted.
  const bell = gateInstructions({
    symbol,
    mint,
    mode: args.mode,
    expectedMultiplierBits: risk.multiplierBits,
    refreshRisk: args.refreshRisk,
  })
  const plan = composeGuarded(bell, args.instructions)
  const message = new TransactionMessage({
    payerKey: args.payer,
    recentBlockhash: latest.blockhash,
    instructions: plan.instructions,
  }).compileToV0Message(args.lookupTables ? [...args.lookupTables] : undefined)

  // BELL's instructions alone, not the whole transaction: the gate reads only
  // its two accounts and the clock, so nothing after it can change its answer,
  // and simulating it alone keeps that answer apart from the caller's own
  // failures. The fee payer is the attestor the record names — discoverable
  // from the chain and funded, where a user's fresh wallet holding 0 SOL would
  // fail the simulation with AccountNotFound before the gate ran. Nothing is
  // sent, so nobody is charged.
  let answer: GateAnswer
  let logs: string[] = []
  let unitsConsumed: number | null = null
  try {
    const sim = await simulate(conn, bell, state.attestor)
    answer = readVerdict(sim.value.err, bell.length - 1)
    logs = sim.value.logs ?? []
    unitsConsumed = sim.value.unitsConsumed ?? null
  } catch (e) {
    answer = { tradeable: false, reason: 'Unavailable', message: `the simulation could not run: ${(e as Error).message}` }
  }

  return {
    transaction: new VersionedTransaction(message),
    instructions: plan.instructions,
    gateIndex: plan.gateIndex,
    blockhash: latest.blockhash,
    lastValidBlockHeight: latest.lastValidBlockHeight,
    verdict: {
      ...answer,
      waitsForOpen: answer.reason === 'MarketClosed' && state.halt === HaltState.None,
      session: {
        openNow: state.openNow,
        halt: state.halt,
        nextChangeAt: Number(state.nextChangeAt),
        observedAt: Number(state.observedAt),
      },
      unitsConsumed,
      logs,
    },
  }
}
