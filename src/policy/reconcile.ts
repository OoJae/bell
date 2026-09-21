/**
 * Reconcile two independent views of whether a security may trade.
 *
 * Pyth knows the **session**: is the US equity market open right now. The
 * issuer knows the **security**: is this particular name halted, and does its
 * own 24/5 wrapper consider itself tradeable.
 *
 * Measured live across the whole universe on 2026-09-21: 635 agree, 291 have
 * no Pyth feed, and exactly **2 disagree — JPSTx and IWMx, the two halted
 * securities**. Pyth said the session was open, because it was; the issuer said
 * the security was not tradeable, because it was halted.
 *
 * So the disagreement is not noise to be smoothed over. It *is* the halt.
 * Neither source alone is sufficient, which is the argument for the gate.
 *
 * Pure functions, no I/O, no clock of their own — same contract as
 * `policy/session.ts`, for the same reason.
 */

/**
 * Mirrors the on-chain `HaltState` discriminants exactly.
 *
 * A const object rather than a TS `enum` because Node strips types rather than
 * compiling them, and an enum is a runtime construct. `erasableSyntaxOnly` in
 * tsconfig keeps us honest about that.
 */
export const HaltState = {
  None: 0,
  Luld: 1,
  NewsPending: 2,
  MarketWide: 3,
  Suspension: 4,
  /** Halted, kind unknown — which is all a boolean issuer flag can tell us. */
  Unspecified: 5,
} as const

export type HaltState = (typeof HaltState)[keyof typeof HaltState]

/** What Pyth says about the session for this ticker. */
export interface PythView {
  isOpen: boolean
  nextOpen: number | null
  nextClose: number | null
}

/**
 * What the issuer says about its own token.
 *
 * Note carefully what `issuerHalted` is **not**. Backed's `isTradingHalted`
 * flag is the *issuer* withdrawing its own wrapper — it does not mean the
 * underlying security is halted on its listing exchange. Measured 2026-09-21:
 * Backed flagged IWMx and JPSTx as halted while IWM and JPST were absent from
 * Nasdaq's UTP halt feed, which does carry NYSE Arca halts. The Russell 2000
 * ETF was not halted; Backed had stopped trading its token.
 *
 * Both stop a trade, but they are different facts and SEC Order 34-106402 II.H
 * is about the exchange one. Conflating them would have BELL reporting an
 * exchange halt that never happened.
 */
export interface IssuerView {
  openNow: boolean
  /** The issuer has withdrawn its own token. Not an exchange halt. */
  issuerHalted: boolean
  /** ISO-8601 instant at which the issuer expects the session to change. */
  nextChangeAt: string | null
}

/**
 * A halt of the underlying security on its primary listing exchange, from
 * Nasdaq's UTP feed. This is the condition II.H names, and the only issuer-
 * independent halt source — Backpack publishes no halt state at all.
 */
export interface ExchangeHalt {
  kind: HaltState
  /** Unix seconds; 0 when no resumption time has been published. */
  resumesAt: number
}

export type Confidence =
  /** Sources present and consistent. */
  | 'confirmed'
  /** Both present and disagreeing — which is itself the signal. */
  | 'conflict'
  /** Only the issuer has an opinion; no US equity feed exists for this name. */
  | 'degraded'
  /** A source we expected is missing. Fail closed. */
  | 'unavailable'

export interface Verdict {
  halt: HaltState
  openNow: boolean
  /** Unix seconds; 0 when unknown. */
  nextChangeAt: number
  confidence: Confidence
  /** Human-facing, for logs and the UI. Never used for control flow. */
  detail: string
}

function toUnix(iso: string | null | undefined): number {
  if (!iso) return 0
  const t = Date.parse(iso)
  return Number.isFinite(t) ? Math.floor(t / 1000) : 0
}

/**
 * Merge the two views into the state that gets pushed on-chain.
 *
 * The ordering below is the policy. A halt beats everything, a conflict is
 * treated as a halt, and an absent source closes the symbol rather than
 * leaving it open — fail closed is the default here, never the fallback.
 */
export function reconcile(args: {
  pyth: PythView | null
  issuer: IssuerView | null
  /** An active exchange halt, if one is published for this ticker. */
  exchangeHalt?: ExchangeHalt | null
  /** True when this security's primary listing is outside the US, so no
   *  `Equity.US.*` feed can exist and Pyth's absence is expected, not a fault. */
  nonUsListing?: boolean
}): Verdict {
  const { pyth, issuer, exchangeHalt } = args

  // 1. Without the issuer we know nothing about this security specifically.
  if (!issuer) {
    return {
      halt: HaltState.Unspecified,
      openNow: false,
      nextChangeAt: 0,
      confidence: 'unavailable',
      detail: 'no issuer reading; closed until one arrives',
    }
  }

  const next = toUnix(issuer.nextChangeAt)

  // 2. An exchange halt outranks everything. This is the II.H condition, it
  //    arrives with a reason code, and it is true regardless of who tokenized
  //    the security — which is what makes it the only halt source that works
  //    for an issuer publishing no halt state of its own.
  if (exchangeHalt) {
    return {
      halt: exchangeHalt.kind,
      openNow: false,
      nextChangeAt: exchangeHalt.resumesAt || next,
      confidence: 'confirmed',
      detail: 'halted on the primary listing exchange',
    }
  }

  // 3. The issuer has withdrawn its own token. Stops the trade just as firmly,
  //    but it is not an exchange halt and must not be reported as one.
  if (issuer.issuerHalted) {
    return {
      halt: HaltState.Unspecified,
      openNow: false,
      nextChangeAt: next,
      confidence: pyth ? 'confirmed' : 'degraded',
      detail: 'issuer has withdrawn this token; the underlying is not exchange-halted',
    }
  }

  // 4. No Pyth feed. Expected for non-US listings, a gap otherwise — either
  //    way we are single-sourced and say so rather than implying confirmation.
  if (!pyth) {
    return {
      halt: HaltState.None,
      openNow: issuer.openNow,
      nextChangeAt: next,
      confidence: args.nonUsListing ? 'degraded' : 'unavailable',
      detail: args.nonUsListing
        ? 'non-US listing: no Equity.US feed exists, issuer is the only source'
        : 'expected a Pyth feed for this ticker and found none',
    }
  }

  // 5. The interesting case. The session is open but the issuer will not trade
  //    this name — that gap is how a halt shows up when nobody publishes a
  //    reason code.
  if (pyth.isOpen && !issuer.openNow) {
    return {
      halt: HaltState.Unspecified,
      openNow: false,
      nextChangeAt: next || (pyth.nextClose ?? 0),
      confidence: 'conflict',
      detail: 'session is open but the issuer will not trade this security',
    }
  }

  // 6. The issuer is willing but the session is shut. Its 24/5 wrapper keeps
  //    trading; the underlying market does not. Not a halt — just closed.
  if (!pyth.isOpen && issuer.openNow) {
    return {
      halt: HaltState.None,
      openNow: false,
      nextChangeAt: pyth.nextOpen ?? next,
      confidence: 'conflict',
      detail: 'issuer is open 24/5 but the primary market is closed',
    }
  }

  // 7. Agreement.
  return {
    halt: HaltState.None,
    openNow: pyth.isOpen && issuer.openNow,
    nextChangeAt: pyth.isOpen ? (pyth.nextClose ?? next) : (pyth.nextOpen ?? next),
    confidence: 'confirmed',
    detail: pyth.isOpen ? 'session open, issuer trading' : 'session closed',
  }
}
