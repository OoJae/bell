/**
 * Reconcile two independent views of whether a security may trade.
 *
 * Pyth knows the **session**: is the US equity market open right now. The
 * issuer knows the **security**: is this particular name halted, and does its
 * own 24/5 wrapper consider itself tradeable.
 *
 * Measured live across the whole universe on 2026-09-21: 635 agree, 291 have
 * no Pyth feed, and exactly **2 disagree — JPSTx and IWMx**. Re-measured by
 * `scripts/agreement.ts` on 2026-09-23 at 15:51 ET: 675 of 678 agree, and the
 * three that do not — JPSTx, IWMx, TQQQx — are the three the issuer has
 * stopped. Pyth said the session was open, because it was; the issuer said the
 * token was not tradeable, because it had withdrawn it (an issuer's stop, not
 * an exchange halt — see `IssuerView`).
 *
 * So the disagreement is not noise to be smoothed over. It *is* the stop.
 * Neither source alone is sufficient, which is the argument for the gate.
 *
 * A third, local opinion on the session sits beside Pyth: the NYSE calendar in
 * `calendar.ts`. It answers the same question from a published table, so it
 * cannot go down with Pyth's free metadata. Where Pyth has a feed the calendar
 * can only close a symbol, never open one; where a US listing has no Pyth feed
 * it stands in, so a Pyth outage costs confidence rather than the whole
 * regular session.
 *
 * Pure functions, no I/O, no clock of their own, so every verdict is a function
 * of its inputs and can be tested without a network or a calendar.
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
 * What the NYSE calendar (`calendar.ts`) says about the regular session at the
 * same instant. One reading serves every US listing: the session is the
 * market's, not any one security's.
 */
export interface CalendarView {
  isOpen: boolean
  /** Unix seconds of its next open or close; null when that is past the years it covers. */
  nextChangeAt: number | null
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
  /**
   * What the issuer's stop is, when "withdrawn" would be the wrong word. Ondo
   * publishes a pause flag, which is not a withdrawal, and the log should say
   * which one happened. Only the words change; the verdict is the same.
   */
  stopDetail?: string
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
  /** Present and disagreeing — which is itself the signal. Pyth against the
   *  issuer, or Pyth against the NYSE calendar. */
  | 'conflict'
  /** A session source is missing and something weaker is answering for it:
   *  the issuer alone, for a listing where no US equity feed can exist, or the
   *  NYSE calendar, for a US listing whose Pyth feed is missing. */
  | 'degraded'
  /** A source we expected is missing and nothing can stand in. Fail closed. */
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
 * Merge the views into the state that gets pushed on-chain.
 *
 * The ordering below is the policy. A halt beats everything, a conflict is
 * treated as a halt, and an absent source closes the symbol rather than
 * leaving it open — fail closed is the default here, never the fallback. The
 * one absence that does not close is a US listing's Pyth feed while the NYSE
 * calendar can stand in for it; and the calendar is consulted last, where it
 * can only close.
 */
export function reconcile(args: {
  pyth: PythView | null
  issuer: IssuerView | null
  /** An active exchange halt, if one is published for this ticker. */
  exchangeHalt?: ExchangeHalt | null
  /** True when this security's primary listing is outside the US, so no
   *  `Equity.US.*` feed can exist and Pyth's absence is expected, not a fault. */
  nonUsListing?: boolean
  /**
   * The NYSE calendar at the same instant. Null or absent when it has no
   * opinion — an instant outside the years its table covers — and then every
   * verdict is exactly what it would be without it.
   */
  calendar?: CalendarView | null
}): Verdict {
  const { pyth, issuer, exchangeHalt } = args
  const calendar = args.calendar ?? null

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
      detail: `${issuer.stopDetail ?? 'issuer has withdrawn this token'}; the underlying is not exchange-halted`,
    }
  }

  // 4. No Pyth feed. Expected for non-US listings, where the issuer is the only
  //    source there can be.
  if (!pyth && args.nonUsListing) {
    return {
      halt: HaltState.None,
      openNow: issuer.openNow,
      nextChangeAt: next,
      confidence: 'degraded',
      detail: 'non-US listing: no Equity.US feed exists, issuer is the only source',
    }
  }

  // 4b. For a US listing a missing feed is a missing source, and the issuer
  //     cannot answer for it: Backed's 24/5 wrapper reads open all night, so
  //     trusting it alone opened the venue whenever Pyth dropped a ticker — and
  //     would have filled orders parked for the bell in the small hours. The
  //     calendar can answer for it. It knows when the regular session runs, so
  //     overnight, at weekends and on holidays the symbol stays closed exactly
  //     as before, and in the session it trades on the calendar's word and the
  //     issuer's. Every such verdict is 'degraded', so the gap shows in the log.
  if (!pyth) {
    if (!calendar) {
      return {
        halt: HaltState.None,
        openNow: false,
        nextChangeAt: next,
        confidence: 'unavailable',
        detail: 'expected a Pyth feed for this ticker and found none, and the NYSE calendar has no opinion; closed until one arrives',
      }
    }
    const v = fromSession(
      {
        isOpen: calendar.isOpen,
        nextOpen: calendar.isOpen ? null : calendar.nextChangeAt,
        nextClose: calendar.isOpen ? calendar.nextChangeAt : null,
      },
      issuer,
      next,
    )
    return { ...v, confidence: 'degraded', detail: `no Pyth feed, NYSE calendar standing in: ${v.detail}` }
  }

  const v = fromSession(pyth, issuer, next)

  // 8. Pyth and the calendar disagree about whether the regular session is
  //    open. One of them is wrong and nothing here says which, so the symbol is
  //    closed until they agree. The calendar only ever takes away: a verdict
  //    that was already closed keeps its halt and its reason, and gains the
  //    disagreement. Steps 2 and 3 have already closed a halted or withdrawn
  //    symbol for a stronger reason, so their verdicts do not mention it.
  if (calendar && calendar.isOpen !== pyth.isOpen) {
    const said = (open: boolean) => (open ? 'open' : 'closed')
    const disagreement =
      `Pyth says the session is ${said(pyth.isOpen)} but the NYSE calendar says ${said(calendar.isOpen)}; ` +
      'closed until they agree'
    return {
      ...v,
      openNow: false,
      // Only an open verdict changes its meaning here: its next change was the
      // close, and it is now closed, so point at the calendar's next open — the
      // calendar is the one saying closed. A verdict that was already closed
      // keeps the next change it had.
      nextChangeAt: v.openNow ? (calendar.nextChangeAt ?? v.nextChangeAt) : v.nextChangeAt,
      confidence: 'conflict',
      detail: v.openNow ? disagreement : `${disagreement}. Also: ${v.detail}`,
    }
  }

  return v
}

/**
 * Steps 5 to 7: one view of the session against the issuer, once the halts
 * and the missing sources are out of the way. The session is Pyth's, or the
 * calendar's when it stands in for a missing feed.
 */
function fromSession(session: PythView, issuer: IssuerView, next: number): Verdict {
  // 5. The interesting case. The session is open but the issuer will not trade
  //    this name — that gap is how a halt shows up when nobody publishes a
  //    reason code.
  if (session.isOpen && !issuer.openNow) {
    return {
      halt: HaltState.Unspecified,
      openNow: false,
      nextChangeAt: next || (session.nextClose ?? 0),
      confidence: 'conflict',
      detail: 'session is open but the issuer will not trade this security',
    }
  }

  // 6. The issuer is willing but the session is shut. Its 24/5 wrapper keeps
  //    trading; the underlying market does not. Not a halt — just closed.
  if (!session.isOpen && issuer.openNow) {
    return {
      halt: HaltState.None,
      openNow: false,
      nextChangeAt: session.nextOpen ?? next,
      confidence: 'conflict',
      detail: 'issuer is open 24/5 but the primary market is closed',
    }
  }

  // 7. Agreement.
  return {
    halt: HaltState.None,
    openNow: session.isOpen && issuer.openNow,
    nextChangeAt: session.isOpen ? (session.nextClose ?? next) : (session.nextOpen ?? next),
    confidence: 'confirmed',
    detail: session.isOpen ? 'session open, issuer trading' : 'session closed',
  }
}
