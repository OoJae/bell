/**
 * A reference model of the trade gates. Nothing runs it.
 *
 * Written off-chain alongside the program's first scaffold, to pin down the
 * design, and kept because its tests (`test/reference-session.test.ts`) state
 * that intent in executable form. The keeper, the crank and the page do not
 * import it, and no decision anywhere in the running system comes from
 * `evaluate`.
 *
 * The program is the authority: `check_tradeable` in
 * `programs/bell-session/src/instructions/assert_tradeable.rs`, which
 * `assert_tradeable` and `fill_order` both run. Where the two disagree, the
 * program is right — and they do disagree. This model has no token-risk age
 * check (gate 2b) and no multiplier-moved check (gate 5), and it adds oracle,
 * basis and price-impact checks that the gate does not make; the queue's fill
 * path checks its own mark age and spread instead.
 *
 * It lives outside `src/` so that it cannot be mistaken for code that decides
 * anything.
 *
 * Pure functions, no I/O, no clock of their own: every decision is a function
 * of (market state, order, now). The rule it models is the program's: FAIL
 * CLOSED. Anything unknown, stale, or unclassified is a refusal, never a fill.
 */

/** How much off-hours risk the caller is willing to take. */
export type Mode = 'strict' | 'guarded'

export type Reason =
  | 'ok'
  | 'halted'
  | 'market_closed'
  | 'primary_closed'
  | 'state_stale'
  | 'rebase_pending'
  | 'rebase_unclassified'
  | 'issuer_paused'
  | 'hook_changed'
  | 'oracle_stale'
  | 'oracle_uncertain'
  | 'basis_too_wide'
  | 'impact_too_high'

export interface MarketState {
  symbol: string
  /** Primary listing exchange has halted or suspended the underlying. */
  halted: boolean
  /** Issuer reports the primary market is open for this asset right now. */
  openNow: boolean
  /** When this session state was observed (ms since epoch). */
  observedAt: number
}

export interface TokenRisk {
  /** Token-2022 `pausableConfig` — issuer can freeze all transfers. */
  paused: boolean
  /** Current scaledUiAmount multiplier. Raw balances are not share units. */
  multiplier: number
  /** A scheduled multiplier change, if one is pending. */
  pending: null | {
    next: number
    activatesAtMs: number
    /**
     * A split leaves value-per-raw-unit invariant; a dividend steps it up at a
     * known instant and leaves the pool stale-low. They are indistinguishable
     * from the multiplier alone, so an unclassified event is never tradeable.
     */
    kind: 'split' | 'dividend' | 'unknown'
  }
  /** Transfer-hook program, or null when the slot is armed but empty. */
  hook: string | null
}

export interface OracleReading {
  priceUsd: number
  /** Pyth confidence interval, same units as price. */
  confUsd: number
  publishedAt: number
}

export interface Order {
  /** Venue price the swap would execute at. */
  venuePriceUsd: number
  /** Fractional price impact from the router, e.g. 0.954 = 95.4%. */
  priceImpact: number
}

export interface Limits {
  /** Session/halt state older than this is treated as a halt. */
  maxStateAgeMs: number
  maxOracleAgeMs: number
  /** Reject when conf/price exceeds this. */
  maxConfBps: number
  /** Max |venue - oracle| deviation. */
  maxBasisBps: number
  maxImpactBps: number
  /** No fills within this window either side of a rebase activation. */
  rebaseGuardMs: number
}

export const DEFAULT_LIMITS: Limits = {
  maxStateAgeMs: 120_000,
  maxOracleAgeMs: 60_000,
  maxConfBps: 50,
  maxBasisBps: 100,
  maxImpactBps: 100,
  rebaseGuardMs: 15 * 60_000, // the issuer's own recommended pause window
}

/** Widen the bands off-hours: no primary market means no arbitrage to trust. */
function effective(limits: Limits, openNow: boolean): Limits {
  if (openNow) return limits
  return {
    ...limits,
    maxConfBps: limits.maxConfBps * 4,
    maxBasisBps: limits.maxBasisBps * 3,
    maxOracleAgeMs: limits.maxOracleAgeMs * 10,
  }
}

export interface Decision {
  allow: boolean
  reason: Reason
  /** Human-facing detail. Never used for control flow. */
  detail?: string
}

const deny = (reason: Reason, detail?: string): Decision => ({ allow: false, reason, detail })
const bps = (a: number, b: number) => Math.abs(a - b) / b * 10_000

/**
 * The gate. Order matters: cheapest and most categorical checks first, so a
 * refusal names the most fundamental reason rather than an incidental one.
 */
export function evaluate(args: {
  mode: Mode
  now: number
  state: MarketState
  risk: TokenRisk
  oracle: OracleReading | null
  order: Order
  limits?: Limits
}): Decision {
  const { mode, now, state, risk, order } = args
  const base = args.limits ?? DEFAULT_LIMITS

  // 1. Session state we cannot vouch for is not a green light.
  if (now - state.observedAt > base.maxStateAgeMs) {
    return deny('state_stale', `session state ${Math.round((now - state.observedAt) / 1000)}s old`)
  }

  // 2. SEC Order 34-106402 §II.H: stop concurrently with the primary exchange.
  if (state.halted) return deny('halted', `${state.symbol} is halted on its primary listing exchange`)

  // 3. Issuer-level freeze (Token-2022 pausable).
  if (risk.paused) return deny('issuer_paused', 'issuer has paused this mint')

  // 4. A scheduled rebase re-denominates every balance at a known instant.
  if (risk.pending) {
    const dt = risk.pending.activatesAtMs - now
    if (Math.abs(dt) <= base.rebaseGuardMs) {
      return deny('rebase_pending', `multiplier changes in ${Math.round(dt / 1000)}s`)
    }
    if (risk.pending.kind === 'unknown') {
      return deny('rebase_unclassified', 'pending corporate action is neither split nor dividend')
    }
  }

  // 5. An armed transfer hook changes settlement semantics mid-flight.
  if (risk.hook !== null) return deny('hook_changed', `transfer hook armed: ${risk.hook}`)

  // 6. Strict mode simply will not trade without a live primary market.
  if (mode === 'strict' && !state.openNow) {
    return deny('primary_closed', 'primary market is closed — queued for the opening bell')
  }

  const limits = effective(base, state.openNow)

  // 7. No trustworthy mark, no fill.
  if (!args.oracle) return deny('oracle_stale', 'no oracle reading')
  if (now - args.oracle.publishedAt > limits.maxOracleAgeMs) {
    return deny('oracle_stale', `oracle ${Math.round((now - args.oracle.publishedAt) / 1000)}s old`)
  }
  const confBps = (args.oracle.confUsd / args.oracle.priceUsd) * 10_000
  if (confBps > limits.maxConfBps) {
    return deny('oracle_uncertain', `confidence ${confBps.toFixed(0)}bps > ${limits.maxConfBps}bps`)
  }

  // 8. Execution quality: the gate that stops a 95% fill.
  const basis = bps(order.venuePriceUsd, args.oracle.priceUsd)
  if (basis > limits.maxBasisBps) {
    return deny('basis_too_wide', `venue is ${basis.toFixed(0)}bps from oracle`)
  }
  const impactBps = order.priceImpact * 10_000
  if (impactBps > limits.maxImpactBps) {
    return deny('impact_too_high', `price impact ${(impactBps / 100).toFixed(2)}%`)
  }

  return { allow: true, reason: 'ok' }
}
