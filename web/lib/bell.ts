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
  readMark,
  readOrders,
  readSymbolState,
  readTokenRisk,
} from '../../src/chain/client.ts'
import {
  MAX_MARK_AGE_SECONDS,
  MAX_STATE_AGE_SECONDS,
  Mode,
  multiplierOf,
  REBASE_GUARD_SECONDS,
  type BellOrder,
  type TokenRisk,
} from '../../src/chain/codec.ts'
import { ALLOWLIST, type Listing } from '../../src/config.ts'

export const RPC_URL = process.env.NEXT_PUBLIC_BELL_RPC ?? 'http://127.0.0.1:8899'
export const connection = () => new Connection(RPC_URL, 'confirmed')

/** Mirrors the on-chain `HaltState` discriminants. */
const HALT_NAMES = [
  'None',
  'LULD volatility pause',
  'news pending',
  'market-wide circuit breaker',
  'suspension',
  'halted',
]

/** One row of the gate panel: what this check saw, and whether it is happy. */
export interface GateRow {
  label: string
  ok: boolean
  detail: string
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
  priceUsd: number | null
  registered: boolean
}

const ago = (t: bigint, now: number) => (t > 0n ? now - Number(t) : null)

const RebaseKind = ['None', 'Unknown', 'Split', 'Dividend'] as const

const inGuardWindow = (r: TokenRisk, now: number) =>
  r.activatesAt !== 0n && Math.abs(Number(r.activatesAt) - now) <= REBASE_GUARD_SECONDS

const rebaseOk = (r: TokenRisk, now: number) =>
  !inGuardWindow(r, now) && !(r.pendingMultiplierBits !== 0n && r.rebaseKind === 1)

function rebaseDetail(r: TokenRisk, now: number): string {
  const at = new Date(Number(r.activatesAt) * 1000).toISOString()
  if (inGuardWindow(r, now)) {
    return Number(r.activatesAt) > now
      ? `a corporate action lands at ${at} — too close to trade through`
      : `a corporate action landed at ${at}; the pool is not yet arbitraged`
  }
  if (r.pendingMultiplierBits !== 0n && r.rebaseKind === 1) {
    return `a corporate action is scheduled for ${at} and is not yet identified as a split or a dividend`
  }
  const kind = r.pendingMultiplierBits !== 0n ? ` · pending ${RebaseKind[r.rebaseKind] ?? '?'}` : ''
  return `multiplier ${multiplierOf(r.multiplierBits)}${kind}`
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
): Promise<SymbolView> {
  const mint = new PublicKey(listing.mint)
  const [state, risk, mark] = await Promise.all([
    readSymbolState(conn, listing.symbol),
    readTokenRisk(conn, mint),
    readMark(conn, listing.symbol),
  ])
  const now = Math.floor(Date.now() / 1000)

  if (!state || !risk) {
    return {
      listing,
      allowed: false,
      reason: 'NotRegistered',
      gates: [{ label: 'registered', ok: false, detail: 'this symbol is not set up on chain' }],
      attestationAge: null,
      nextChangeAt: 0,
      priceUsd: null,
      registered: false,
    }
  }

  const age = ago(state.observedAt, now)
  const markAge = mark ? ago(mark.observedAt, now) : null

  const gates: GateRow[] = [
    {
      label: 'attestation fresh',
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
      ok: state.halt === 0,
      detail: state.halt === 0 ? `clear on ${state.exchangeMic}` : HALT_NAMES[state.halt] ?? 'halted',
    },
    {
      label: 'issuer has not paused the mint',
      ok: !risk.paused,
      detail: risk.paused ? 'issuer paused this mint' : 'not paused',
    },
    {
      // Mirrors check_tradeable gates 4 and 4b exactly. The guard window is
      // symmetric around the activation — before it, the order would settle in
      // a different denomination than it was built for; after it, the pool is
      // stale-low by the dividend until arbitrage catches up. A row that were
      // merely "activatesAt !== 0" would contradict the program's own verdict
      // for every mint that has ever rebased.
      label: 'no rebase pending',
      ok: rebaseOk(risk, now),
      detail: rebaseDetail(risk, now),
    },
    {
      label: 'no transfer hook armed',
      ok: risk.hook === null,
      detail: risk.hook ? `hook armed: ${risk.hook.toBase58()}` : 'slot empty',
    },
    {
      label: 'market open',
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
  try {
    // A simulated transaction still nominates a fee payer, and it has to be a
    // funded system account or the simulation fails for a reason that has
    // nothing to do with the gate. With no wallet connected, borrow the
    // attestor recorded in the symbol itself: discoverable from the chain,
    // guaranteed to exist, and never actually charged because nothing is sent.
    const verdict = await checkGate(conn, payer ?? state.attestor, {
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
    priceUsd: mark && mark.pxNum > 0n ? Number(mark.pxNum) / 1e6 : null,
    registered: true,
  }
}

export async function loadAll(
  conn: Connection,
  payer: PublicKey | null = null,
): Promise<SymbolView[]> {
  return Promise.all(ALLOWLIST.map((l) => loadSymbol(conn, l, payer)))
}

export async function loadOrders(conn: Connection, owner?: PublicKey): Promise<BellOrder[]> {
  const all = await readOrders(conn)
  return owner ? all.filter((o) => o.owner.equals(owner)) : all
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
    case 'NotRegistered':
      return 'This symbol is not set up on chain yet.'
    default:
      return reason ? `Refused: ${reason}` : ''
  }
}

export { Mode }
