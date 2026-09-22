/**
 * The browser's view of BELL.
 *
 * Deliberately thin. Everything here imports the keeper's own modules from
 * `../../src`, so the page cannot drift from what the chain enforces — the
 * panel explains *why* by reading accounts, and the program itself answers
 * *whether* by simulating `assert_tradeable`. If those two ever disagree, the
 * disagreement is the bug, and it is visible rather than hidden.
 */
import { Connection, PublicKey } from '@solana/web3.js'
import {
  checkGate,
  readAllSymbols,
  readBoard,
  readOrders,
  type SymbolAccounts,
} from '../../src/chain/client.ts'
import { ataFor, decodeTokenAccount } from '../../src/chain/spl.ts'
import {
  MAX_MARK_AGE_SECONDS,
  MAX_STATE_AGE_SECONDS,
  Mode,
  multiplierOf,
  REBASE_GUARD_SECONDS,
  RebaseKind,
  rebaseKindName,
  type BellOrder,
  type TokenRisk,
} from '../../src/chain/codec.ts'
import { ALLOWLIST, type Listing } from '../../src/config.ts'
import { HaltState } from '../../src/policy/reconcile.ts'

export const RPC_URL = process.env.NEXT_PUBLIC_BELL_RPC ?? 'http://127.0.0.1:8899'
export const connection = () => new Connection(RPC_URL, 'confirmed')

/**
 * Display names keyed by the named `HaltState` constants, not by position. A
 * positional copy is how the rebase enum drifted; the named constants are
 * checked against the IDL's variant order in `test/portability.test.ts`.
 */
const HALT_NAMES: Record<number, string> = {
  [HaltState.None]: 'None',
  [HaltState.Luld]: 'LULD volatility pause',
  [HaltState.NewsPending]: 'news pending',
  [HaltState.MarketWide]: 'market-wide circuit breaker',
  [HaltState.Suspension]: 'suspension',
  [HaltState.Unspecified]: 'halted',
}

/** One row of the gate panel: what this check saw, and whether it is happy. */
export interface GateRow {
  label: string
  ok: boolean
  detail: string
  /**
   * The `BellError` this row stands for in `check_tradeable`, or absent when the
   * row is informational. Only rows with a code decide the board's verdict:
   * "price fresh" gates a *fill*, not `assert_tradeable`, and letting it vote
   * made the board say "closed" for a symbol the program calls tradeable.
   */
  refuses?: string
}

export interface SymbolView {
  listing: Listing
  /** The program's own answer. Null while loading. */
  allowed: boolean | null
  /** `BellError` variant when refused. */
  reason: string | null
  gates: GateRow[]
  /** Seconds since the attestation, or null if never attested. */
  attestationAge: number | null
  nextChangeAt: number
  /** The attested session state, so `nextChangeAt` can be read as the next open. */
  openNow: boolean
  priceUsd: number | null
  registered: boolean
}

const ago = (t: bigint, now: number) => (t > 0n ? now - Number(t) : null)

/** Gate 4: within REBASE_GUARD_SECONDS either side of an activation. */
const inGuardWindow = (r: TokenRisk, now: number) =>
  r.activatesAt !== 0n && Math.abs(Number(r.activatesAt) - now) <= REBASE_GUARD_SECONDS

/** Gate 4b: a change still pending, and nobody has said what kind it is. */
const unclassified = (r: TokenRisk) =>
  r.pendingMultiplierBits !== 0n && r.rebaseKind === RebaseKind.Unknown

function windowDetail(r: TokenRisk, now: number): string {
  const at = new Date(Number(r.activatesAt) * 1000).toISOString()
  if (inGuardWindow(r, now)) {
    return Number(r.activatesAt) > now
      ? `a corporate action lands at ${at} — too close to trade through`
      : `a corporate action landed at ${at}; the pool is not yet arbitraged`
  }
  const pending =
    r.pendingMultiplierBits !== 0n
      ? ` · ${multiplierOf(r.pendingMultiplierBits)} scheduled for ${at}`
      : ''
  return `multiplier ${multiplierOf(r.multiplierBits)}${pending}`
}

function classifiedDetail(r: TokenRisk): string {
  if (r.pendingMultiplierBits === 0n) return 'nothing pending'
  return unclassified(r)
    ? 'not yet identified as a split or a dividend — a split leaves a pool fair, a dividend drains it'
    : `identified as a ${rebaseKindName(r.rebaseKind).toLowerCase()}`
}

/**
 * Read one symbol and build its panel.
 *
 * The gate rows are derived from account state for display. The verdict comes
 * from simulating the real instruction, which is why `payer` is needed: a
 * simulation still wants a fee payer, though nothing is ever sent.
 */
export async function loadSymbol(
  conn: Connection,
  listing: Listing,
  payer: PublicKey | null,
  mode: Mode = Mode.Strict,
  prefetched?: SymbolAccounts,
  /**
   * Whether to ask the program itself. Off by default in a board view: each
   * answer costs a `simulateTransaction`, and nine of those every ten seconds
   * is what rate-limits a public RPC endpoint. The gate rows below are derived
   * from the same accounts the program reads, so the board stays honest; the
   * authoritative check is run for the one symbol actually being looked at.
   */
  simulate = true,
): Promise<SymbolView> {
  const mint = new PublicKey(listing.mint)
  const { state, risk, mark } =
    prefetched ?? (await readAllSymbols(conn, [listing])).get(listing.symbol)!
  const now = Math.floor(Date.now() / 1000)

  if (!state || !risk) {
    return {
      listing,
      allowed: false,
      reason: 'NotRegistered',
      gates: [{ label: 'registered', ok: false, detail: 'this symbol is not set up on chain' }],
      attestationAge: null,
      nextChangeAt: 0,
      openNow: false,
      priceUsd: null,
      registered: false,
    }
  }

  const age = ago(state.observedAt, now)
  const markAge = mark ? ago(mark.observedAt, now) : null

  const gates: GateRow[] = [
    {
      label: 'attestation fresh',
      refuses: 'StateStale',
      ok: age !== null && age <= MAX_STATE_AGE_SECONDS,
      detail:
        age === null
          ? 'never attested'
          : age <= MAX_STATE_AGE_SECONDS
            ? `${age}s old`
            : `${age}s old — stale, so treated as closed`,
    },
    {
      label: 'not halted',
      refuses: 'MarketClosed',
      ok: state.halt === HaltState.None,
      detail:
        state.halt === HaltState.None
          ? `clear on ${state.exchangeMic}`
          : (HALT_NAMES[state.halt] ?? 'halted'),
    },
    {
      label: 'issuer has not paused the mint',
      refuses: 'IssuerPaused',
      ok: !risk.paused,
      detail: risk.paused ? 'issuer paused this mint' : 'not paused',
    },
    {
      // Gate 4. Symmetric around the activation: before it, an order would
      // settle in a different denomination than it was built for; after it, a
      // dividend has stepped value-per-raw-unit up and the pool is stale-low by
      // exactly that until arbitrage catches up.
      label: 'outside a rebase window',
      refuses: 'RebasePending',
      ok: !inGuardWindow(risk, now),
      detail: windowDetail(risk, now),
    },
    {
      // Gate 4b. Its own row because it is its own refusal: an unclassified
      // change is refused as `RebaseUnclassified` whenever it is pending, not
      // only inside the window.
      label: 'pending change identified',
      refuses: 'RebaseUnclassified',
      ok: !unclassified(risk),
      detail: classifiedDetail(risk),
    },
    {
      label: 'no transfer hook armed',
      refuses: 'HookArmed',
      ok: risk.hook === null,
      detail: risk.hook ? `hook armed: ${risk.hook.toBase58()}` : 'slot empty',
    },
    {
      label: 'market open',
      refuses: 'MarketClosed',
      ok: state.openNow,
      detail: state.openNow
        ? 'primary market is trading'
        : 'primary market is closed — queue it for the bell',
    },
    {
      label: 'price fresh',
      ok: markAge !== null && markAge <= MAX_MARK_AGE_SECONDS,
      detail:
        markAge === null
          ? 'no price attested — cannot fill'
          : markAge <= MAX_MARK_AGE_SECONDS
            ? `${markAge}s old`
            : `${markAge}s old — stale`,
    },
  ]

  let allowed: boolean | null = null
  let reason: string | null = null
  // Derived from the accounts we already hold. `check_tradeable` refuses on the
  // first failing gate in its own order, and the rows above are in that order,
  // so the first failing *gate* row reproduces both the verdict and the reason
  // without another round trip. Informational rows do not vote.
  const firstFail = gates.find((g) => g.refuses && !g.ok)
  allowed = !firstFail
  reason = firstFail?.refuses ?? null

  if (!simulate) {
    return {
      listing,
      allowed,
      reason,
      gates,
      attestationAge: age,
      nextChangeAt: Number(state.nextChangeAt),
      openNow: state.openNow,
      priceUsd: mark && mark.pxNum > 0n ? Number(mark.pxNum) / 1e6 : null,
      registered: true,
    }
  }

  try {
    // A simulated transaction still nominates a fee payer, and it has to be a
    // funded system account or the simulation fails for a reason that has
    // nothing to do with the gate. Always the attestor recorded in the symbol:
    // discoverable from the chain, guaranteed funded, and never charged because
    // nothing is sent. It used to be the connected wallet when there was one —
    // and a judge's fresh devnet wallet holds 0 SOL, so the first tile they
    // clicked read "AccountNotFound" during market hours.
    void payer
    const verdict = await checkGate(conn, state.attestor, {
      symbol: listing.symbol,
      mint,
      mode,
      expectedMultiplierBits: risk.multiplierBits,
    })
    allowed = verdict.allowed
    reason = verdict.reason
  } catch {
    // A simulation that cannot run is not permission to trade.
    allowed = false
    reason = 'unavailable'
  }

  return {
    listing,
    allowed,
    reason,
    gates,
    attestationAge: age,
    nextChangeAt: Number(state.nextChangeAt),
    openNow: state.openNow,
    priceUsd: mark && mark.pxNum > 0n ? Number(mark.pxNum) / 1e6 : null,
    registered: true,
  }
}

/**
 * The whole board, in one RPC round trip plus one simulation.
 *
 * `focus` is the symbol whose verdict is checked against the program itself.
 * Everything else is derived from the same account data the program reads, so
 * the board cannot disagree with the chain about *why* — and if it ever did,
 * the focused row would show it, which is the disagreement worth surfacing.
 */
export async function loadAll(
  conn: Connection,
  payer: PublicKey | null = null,
  focus?: string,
): Promise<SymbolView[]> {
  const accounts = await readAllSymbols(conn, ALLOWLIST)
  return Promise.all(
    ALLOWLIST.map((l) =>
      loadSymbol(conn, l, payer, Mode.Strict, accounts.get(l.symbol), l.symbol === focus),
    ),
  )
}

/**
 * One owner's orders. Throws on failure — deliberately.
 *
 * It used to swallow errors into `[]`, which turned a rate-limited read into
 * "you have no orders". The page then approved only the new order's amount,
 * and because SPL `Approve` replaces rather than adds, that silently defunded
 * every order the user already had. Not knowing must stay distinguishable
 * from knowing there are none.
 */
export async function loadOrders(conn: Connection, owner: PublicKey): Promise<BellOrder[]> {
  return readOrders(conn, owner)
}

/** What the connected wallet holds, read in the same round trip as the board. */
export interface WalletView {
  sol: number
  /** Demo-USDC in raw units; null when the wallet has no quote account yet. */
  quote: bigint | null
  delegate: PublicKey | null
  delegatedAmount: bigint
}

/**
 * The board and, when a wallet is connected, its balances — one request.
 */
export async function loadBoard(
  conn: Connection,
  quoteMint: PublicKey,
  focus?: string,
  wallet?: PublicKey | null,
): Promise<{ views: SymbolView[]; wallet: WalletView | null }> {
  const extra = wallet ? [wallet, ataFor(wallet, quoteMint)] : []
  const { symbols, extras } = await readBoard(conn, ALLOWLIST, extra)
  const views = await Promise.all(
    ALLOWLIST.map((l) =>
      loadSymbol(conn, l, null, Mode.Strict, symbols.get(l.symbol), l.symbol === focus),
    ),
  )
  if (!wallet) return { views, wallet: null }
  const [sys, ata] = extras
  const token = ata ? decodeTokenAccount(ata.data) : null
  return {
    views,
    wallet: {
      sol: (sys?.lamports ?? 0) / 1e9,
      quote: token ? token.amount : null,
      delegate: token?.delegate ?? null,
      delegatedAmount: token?.delegatedAmount ?? 0n,
    },
  }
}

/** Plain-English rendering of a refusal. The reason is the product. */
export function explain(reason: string | null): string {
  switch (reason) {
    case 'MarketClosed':
      return 'The market for this security is closed or halted.'
    case 'StateStale':
      return 'Nobody has confirmed this market is open recently enough to trust.'
    case 'IssuerPaused':
      return 'The issuer has frozen this token.'
    case 'RebasePending':
      return 'A dividend or split lands imminently and would change what you receive.'
    case 'RebaseUnclassified':
      return 'A corporate action is pending and has not been identified yet.'
    case 'MultiplierMoved':
      return 'A corporate action changed the size of this order. Place it again.'
    case 'HookArmed':
      return 'The issuer armed a transfer hook, which changes how settlement works.'
    case 'MarkStale':
      return 'The price is older than a minute. Nothing fills on a stale price.'
    case 'OwnerRevoked':
      return 'You revoked the funding for this order, so it can no longer fill. That is the cancel working.'
    case 'OwnerSpentTheFunds':
      return 'The funds this order was to spend are no longer in the account, so it cannot fill.'
    case 'AmountExceedsDelegation':
      return 'This order asks for more than you approved.'
    case 'AmountTooLarge':
      return 'Orders are capped at $1,000 while the program still has an upgrade authority.'
    case 'DelegationMissing':
      return 'The order is not funded — the approval did not cover it.'
    case 'NotRegistered':
      return 'This symbol is not set up on chain yet.'
    default:
      return reason ? `Refused: ${reason}` : ''
  }
}

export { Mode }
