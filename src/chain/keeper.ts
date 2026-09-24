/**
 * The keeper: sense → reconcile → diff → push.
 *
 * This is the only component that writes to `bell-session`, and it writes one
 * thing: what the market is doing. Everything the program can prove for itself
 * — issuer pauses, rebases, transfer hooks — it reads from the mint instead.
 *
 * Fail-closed is structural rather than a policy choice. `MAX_STATE_AGE_SECONDS`
 * is 120, so if this process dies every symbol becomes untradeable two minutes
 * later without anyone doing anything. Silence closes the venue.
 */
import { Connection, Keypair, PublicKey } from '@solana/web3.js'
import { ALLOWLIST, type Listing } from '../config.ts'
import { fetchAsset, type XStock } from '../sensor/xstocks.ts'
import { fetchEquitySessions, type PythSession } from '../sensor/pyth.ts'
import { fetchHalts, isActive, type Halt } from '../sensor/halts.ts'
import { fetchSessions, fetchHolidays, fetchSecurities } from '../sensor/backpack.ts'
import { resolveSession, type SessionWindow, type HolidayWindow } from '../policy/sessions.ts'
import { reconcile, HaltState, type CalendarView, type Verdict } from '../policy/reconcile.ts'
import { isRegularOpen, nextChange } from '../policy/calendar.ts'
import {
  ixPushMark,
  ixPushSession,
  ixRefreshTokenRisk,
  readMark,
  readAllSymbols,
  send,
} from './client.ts'
import { MarkSource, fairOut, rateQ64 } from './codec.ts'
import { quote, usdc, fetchTokens, USDC } from '../sensor/jupiter.ts'
import { multiplierOf } from './codec.ts'
import { readTokenRisk } from './client.ts'
import { PublicKey as Web3PublicKey } from '@solana/web3.js'

/**
 * Notional the reference quote is taken at.
 *
 * The mark is an *executable* quote rather than a mid, because a mid is not
 * what a filler can source. Measured on this universe: Backpack's tickers are
 * mostly perpetuals trading 38-275bps below spot, and a low mark is the unsafe
 * direction — it lowers min_out, so the fill still happens and the user quietly
 * receives less. Jupiter's usdPrice has the opposite bias (a mid, 2-76bps below
 * executable), which is safe but blocks most fills. An executable quote makes
 * `fair` what a filler can actually get, so max_slip_bps is their whole margin.
 */
const MARK_NOTIONAL_USD = 200

/**
 * The cluster's idea of the current time, which is what the program compares
 * an attestation against.
 */
export async function clusterTime(conn: Connection): Promise<number> {
  const slot = await conn.getSlot()
  const t = await conn.getBlockTime(slot)
  return t ?? Math.floor(Date.now() / 1000)
}

/** A price for one symbol, ready to attest. */
export interface MarkReading {
  symbol: string
  rateQ64: bigint
  /**
   * The price as `pxNum × 10^pxExpo`, in quote units (USDC) per share. The
   * scaled-UI multiplier is already applied, so this is per share, not per
   * raw token.
   */
  pxNum: bigint
  pxExpo: number
  confBps: number
  source: MarkSource
}

/** A mark as a tick sent it: the reading, and the instant it attested to. */
export interface PushedMark extends MarkReading {
  /** The `observed_at` in the instruction, in unix seconds on the cluster's clock. */
  observedAt: number
}

/** Everything the loop needs, gathered once per tick. */
export interface Observation {
  at: Date
  xstocks: Map<string, XStock>
  /** Empty when Pyth's feed list could not be read this tick; see `pythError`. */
  pyth: Map<string, PythSession>
  /**
   * Why Pyth's feed list could not be read, when it could not. Every US
   * listing then reads as having no feed, and the NYSE calendar stands in.
   * Optional so an observation built before the calendar existed still types.
   */
  pythError?: string | null
  halts: Map<string, Halt>
  /** Null when Backpack's lists could not be read in full this tick. */
  backpack: {
    sessions: SessionWindow[]
    holidays: HolidayWindow[]
    /** Asset -> that security's own session names. */
    supported: Map<string, string[]>
  } | null
  /** Why `backpack` is null, when it is. */
  backpackError: string | null
}

export async function sense(): Promise<Observation> {
  // Only the allowlisted Backed names, not all 928: nine small reads instead of
  // thirteen pages, which keeps a tick well clear of the refresh threshold.
  const backedSymbols = ALLOWLIST.filter((l) => l.issuer === 'backed').map((l) => l.symbol)
  let backpackError: string | null = null
  let pythError: string | null = null
  const [assets, pyth, halts, backpack] = await Promise.all([
    // Each asset on its own: one withdrawn token answering 404 used to fail
    // the whole tick, and a tick that pushes nothing closes all nine symbols
    // two minutes later. A missing reading closes only its own symbol —
    // `reconcile` treats an absent issuer as closed.
    Promise.all(backedSymbols.map((s) => fetchAsset(s).catch(() => null))),
    // Pyth's free metadata used to be tick-fatal: without it every listing
    // closed anyway, so failing the tick cost nothing. The NYSE calendar
    // changed that. A missing feed list now reads as every ticker having no
    // feed, and `reconcile` lets the calendar stand in: closed overnight, at
    // weekends and on holidays exactly as before, open in the regular session
    // on the calendar's word and the issuer's. Every verdict names the failure,
    // and one the calendar decided is marked degraded.
    //
    // On one line, and short: the reason is appended to all nine details every
    // tick, and a body that is not a list fails with zod's message, which is
    // pretty-printed JSON. A newline in a detail breaks the keeper's one line
    // per symbol and the evidence report's transition table.
    fetchEquitySessions().catch((e: unknown) => {
      pythError = String((e as Error)?.message ?? e).replace(/\s+/g, ' ').trim().slice(0, 200)
      return new Map<string, PythSession>()
    }),
    fetchHalts(),
    // Backpack's three lists stand or fall together, and only for Backpack's
    // own listings. Nothing a Backed token's verdict reads comes from them, yet
    // an outage there, or a holiday row that will not parse, used to fail the
    // whole tick and close all nine symbols. Without them a Backpack listing
    // has no issuer reading, which `reconcile` closes.
    //
    // The halt feed stays tick-fatal on purpose. A missing halt feed reads as
    // "no halts", which is fail-open.
    Promise.all([fetchSessions(), fetchHolidays(), fetchSecurities()]).then(
      ([sessions, holidays, securities]) => ({
        sessions,
        holidays,
        supported: new Map(
          securities.map((s) => [s.asset, (s.sessions ?? []).map((x) => x.name)]),
        ),
      }),
      (e: unknown) => {
        backpackError = (e as Error).message
        return null
      },
    ),
  ])
  return {
    at: new Date(),
    xstocks: new Map(
      assets.filter((x): x is XStock => x !== null).map((x) => [x.mint, x]),
    ),
    pyth,
    pythError,
    halts,
    backpack,
    backpackError,
  }
}

export interface Decision {
  listing: Listing
  verdict: Verdict
  /**
   * What each source actually said. Kept alongside the verdict so the evidence
   * log can reconstruct a decision later, rather than storing a conclusion with
   * no way to audit how it was reached.
   */
  sources: {
    pythOpen: boolean | null
    issuerOpen: boolean | null
    issuerHalted: boolean | null
    exchangeHalt: number | null
  }
}

/**
 * Turn one observation into a verdict per listing.
 *
 * The two issuers are not symmetric and the code says so rather than pretending
 * otherwise: Backed publishes a per-security flag, Backpack publishes a session
 * calendar and no halt state at all. The Nasdaq feed is what covers the gap.
 */
export function decide(obs: Observation): Decision[] {
  const nowSeconds = Math.floor(obs.at.getTime() / 1000)

  // The NYSE calendar at the instant of the observation, once for every
  // listing: the regular session belongs to the market, not to a security.
  // Its reading is not stored beside the other sources because it is a pure
  // function of the tick's time, which is stored, and of `calendar.ts`; a
  // disagreement with Pyth is also written into the verdict's detail.
  const calendarOpen = isRegularOpen(obs.at)
  const calendar: CalendarView | null =
    calendarOpen === null ? null : { isOpen: calendarOpen, nextChangeAt: nextChange(obs.at) }

  return ALLOWLIST.map((listing) => {
    const feed = obs.pyth.get(listing.underlying)
    const halt = obs.halts.get(listing.underlying)
    const exchangeHalt =
      halt && isActive(halt, nowSeconds)
        ? { kind: halt.kind as HaltState, resumesAt: halt.resumesAt }
        : null

    let issuer = null
    if (listing.issuer === 'backed') {
      const x = obs.xstocks.get(listing.mainnetMint)
      if (x) {
        issuer = {
          openNow: x.openNow,
          issuerHalted: x.halted,
          nextChangeAt: x.nextChangeAt,
        }
      }
    } else if (obs.backpack) {
      const supported = obs.backpack.supported.get(`${listing.underlying}.US`)
      if (supported) {
        const s = resolveSession({
          sessions: obs.backpack.sessions,
          holidays: obs.backpack.holidays,
          supported,
          now: obs.at,
        })
        // Backpack publishes no halt flag; halts for its names arrive only via
        // the exchange feed above.
        issuer = { openNow: s.regularOpen, issuerHalted: false, nextChangeAt: null }
      }
    }

    const verdict = reconcile({
      pyth: feed
        ? { isOpen: feed.isOpen, nextOpen: feed.nextOpen, nextClose: feed.nextClose }
        : null,
      issuer,
      exchangeHalt,
      calendar,
    })
    // A feed missing because the whole list could not be read is a different
    // fault from one Pyth has stopped publishing, and the fix is different, so
    // the verdict names it.
    if (!feed && obs.pythError) verdict.detail += ` (Pyth feed list unread: ${obs.pythError})`

    return {
      listing,
      verdict,
      sources: {
        pythOpen: feed ? feed.isOpen : null,
        issuerOpen: issuer ? issuer.openNow : null,
        issuerHalted: issuer ? issuer.issuerHalted : null,
        exchangeHalt: exchangeHalt ? exchangeHalt.kind : null,
      },
    }
  })
}

/**
 * Push when the state changed, or when the existing attestation is close enough
 * to expiry that letting it lapse would close a symbol that is in fact open.
 */
export function needsPush(
  onChain: { halt: number; openNow: boolean; observedAt: bigint } | null,
  verdict: Verdict,
  nowSeconds: number,
  refreshBefore: number,
): boolean {
  if (!onChain) return true
  if (onChain.halt !== verdict.halt) return true
  if (onChain.openNow !== verdict.openNow) return true
  return nowSeconds - Number(onChain.observedAt) >= refreshBefore
}

/**
 * Price every allowlisted symbol from an executable quote.
 *
 * Symbols with no route get no mark, and therefore cannot fill — the honest
 * coverage limit rather than a guess. The scaled-UI multiplier is folded in
 * here because raw balances are not share units.
 */
export async function readMarks(
  conn: Connection,
  decimalsByMint: Map<string, number>,
): Promise<MarkReading[]> {
  const out: MarkReading[] = []
  for (const listing of ALLOWLIST) {
    const mint = new Web3PublicKey(listing.mint)
    // Decimals are a property of the security, and the devnet mirror is created
    // to match, so the real address is the right key for both.
    const decimals = decimalsByMint.get(listing.mainnetMint)
    if (decimals === undefined) continue

    // Priced against the real mint: Jupiter only knows mainnet, and what SPY is
    // worth is a fact about SPY rather than about the cluster we deployed to.
    const q = await quote(USDC, listing.mainnetMint, usdc(MARK_NOTIONAL_USD))
    if (!q || q.outAmount === 0n) continue

    const risk = await readTokenRisk(conn, mint)
    if (!risk) continue
    const multiplier = multiplierOf(risk.multiplierBits)

    // Executable price per share, with the multiplier applied.
    const shares = (Number(q.outAmount) / 10 ** decimals) * multiplier
    const pricePerShare = MARK_NOTIONAL_USD / shares

    out.push({
      symbol: listing.symbol,
      rateQ64: rateQ64({ pricePerShare, multiplier, quoteDecimals: 6, stockDecimals: decimals }),
      pxNum: BigInt(Math.round(pricePerShare * 1e6)),
      pxExpo: -6,
      // The quote's own price impact is the uncertainty we can actually see.
      confBps: Math.min(200, Math.max(1, Math.round(q.priceImpact * 10_000))),
      source: MarkSource.Jupiter,
    })
  }
  return out
}

export interface TickResult {
  at: Date
  decisions: Decision[]
  /** Symbols whose session was pushed, or would have been in a dry run. */
  pushed: string[]
  /** Symbols whose mark was pushed, or would have been in a dry run. */
  marked: string[]
  /**
   * The marks behind `marked`, with the values sent. Returned so the caller can
   * log the price that was actually attested rather than re-deriving it.
   * Empty when pricing or the mark transaction failed, since then nothing
   * landed. In a dry run it holds what would have been sent and nothing
   * landed either, so a caller recording what was on chain must check `dryRun`
   * (or `markSignature`) as well.
   */
  marks: PushedMark[]
  signature: string | null
  /** The transaction that carried `marks`; null in a dry run or when none landed. */
  markSignature: string | null
  dryRun: boolean
  /**
   * Why Backpack's lists could not be read this tick, if they could not. Its
   * listings are closed for the tick; everything else is unaffected.
   */
  backpackError: string | null
  /**
   * Why pricing failed this tick, if it did. Null on success.
   *
   * Surfaced rather than swallowed: no fresh mark means nothing can fill, which
   * is a real degradation even though the venue stays open. An operator should
   * see it, and a run of them means the quote source needs attention.
   */
  markError: string | null
  /** How many TokenRisk records were re-read from their mints this tick. */
  refreshed: number
  /**
   * Why the re-read failed, if it did. Surfaced every tick: a record that stops
   * refreshing is the silent failure this field exists to make loud.
   */
  riskError: string | null
}

/**
 * One pass. All pushes go in a single transaction — nine instructions is 841
 * bytes against the 1,232 limit, so this is one signature regardless of how
 * many symbols moved.
 */
export async function tick(args: {
  conn: Connection
  attestor: Keypair
  refreshBefore?: number
  dryRun?: boolean
  withMarks?: boolean
}): Promise<TickResult> {
  const { conn, attestor } = args
  // 30, not 60. Measured on the hosted keeper: a tick really takes ~57s (45s of
  // sleep plus ~12s of sensing and sending), so a 60s threshold re-pushed only
  // every *other* tick and attestations landed 110-112s old against a 120s
  // limit — eight seconds from the whole venue reading StateStale. At 30 every
  // tick pushes, and the worst-case age is one tick.
  const refreshBefore = args.refreshBefore ?? 30
  const dryRun = args.dryRun ?? true

  const obs = await sense()
  const decisions = decide(obs)

  // Attest in the cluster's time frame, not ours.
  //
  // The program rejects an `observed_at` in the future, and it judges that
  // against the on-chain Clock. Our wall clock only has to be a second ahead —
  // which it routinely is — for an otherwise-valid attestation to be refused.
  // Taking the minimum means we never claim to have observed something after
  // the chain's now, nor after our own.
  const nowSeconds = Math.min(
    Math.floor(obs.at.getTime() / 1000),
    await clusterTime(conn),
  )

  // Sessions and marks go in separate transactions. Nine session pushes is 841
  // bytes against the 1,232 limit, but adding marks took the combined message
  // to 1,520 — a mark carries a u128 rate plus price fields, so it is a much
  // fatter instruction. Two signatures a tick instead of one is a fee rounding
  // error next to getting this wrong at the open.
  const sessionIxs = []
  const markIxs = []
  const pushed: string[] = []

  // Every symbol's on-chain state in one read: one consistent snapshot, and
  // one request instead of nine against an endpoint that rate-limits.
  const onChain = await readAllSymbols(
    conn,
    decisions.map((d) => d.listing),
  )
  for (const d of decisions) {
    const state = onChain.get(d.listing.symbol)?.state ?? null
    if (!needsPush(state, d.verdict, nowSeconds, refreshBefore)) continue
    sessionIxs.push(
      ixPushSession({
        attestor: attestor.publicKey,
        symbol: d.listing.symbol,
        halt: d.verdict.halt,
        openNow: d.verdict.openNow,
        nextChangeAt: BigInt(d.verdict.nextChangeAt),
        observedAt: BigInt(nowSeconds),
      }),
    )
    pushed.push(d.listing.symbol)
  }

  // Marks refresh far more often than sessions: MAX_MARK_AGE_SECONDS is 60, so
  // a price older than a minute cannot settle anything.
  //
  // Isolated from the session push on purpose. Pricing needs nine Jupiter
  // quotes a tick, roughly two thousand times a day, against an endpoint that
  // rate-limits and times out — and every one of those failures used to throw
  // out of `tick()` before the session attestation was ever sent, so a routine
  // sensor hiccup closed the entire venue 120 seconds later. That is
  // fail-closed working exactly as designed, on the wrong input.
  //
  // The two are not equally critical: a stale session is a safety question, a
  // stale mark only means nothing can fill. Degrading to "no fresh price" is
  // the honest outcome, and the gate still refuses those fills by itself.
  const marks: PushedMark[] = []
  let markError: string | null = null
  if (args.withMarks !== false) {
    try {
      const decimals = new Map(
        [...(await fetchTokens(ALLOWLIST.map((l) => l.mainnetMint)))].map(([m, t]) => [m, t.decimals]),
      )
      for (const m of await readMarks(conn, decimals)) {
        const existing = await readMark(conn, m.symbol)
        if (!existing) continue // not opened yet
        markIxs.push(
          ixPushMark({
            attestor: attestor.publicKey,
            symbol: m.symbol,
            rateQ64: m.rateQ64,
            pxNum: m.pxNum,
            pxExpo: m.pxExpo,
            confBps: m.confBps,
            source: m.source,
            observedAt: BigInt(nowSeconds),
          }),
        )
        marks.push({ ...m, observedAt: nowSeconds })
      }
    } catch (e) {
      markError = (e as Error).message
      markIxs.length = 0
      marks.length = 0
    }
  }

  let signature: string | null = null
  let markSignature: string | null = null
  let refreshed = 0
  let riskError: string | null = null
  if (!dryRun) {
    // Sessions first, and in their own transaction. If a later push fails, the
    // attestation that keeps the venue open has already landed.
    if (sessionIxs.length > 0) signature = await send(conn, sessionIxs, [attestor])

    // Re-read every mint's Token-2022 extensions into its TokenRisk record.
    //
    // For the first day of the devnet deployment nothing did this. The
    // instruction is permissionless and its builder existed, but no script and
    // no keeper ever called it — so gates 3 (pause), 4 (rebase), 5 (multiplier
    // moved) and 6 (hook) were reading a snapshot from registration. A dividend
    // scheduled on the mint would never have been seen. "Anyone can refresh" is
    // a defence against someone blocking the refresh; it is no defence against
    // everyone skipping it, and the one party that profits from a stale record
    // is the one party that never will.
    //
    // Its own transaction (nine refreshes are 859 bytes; with sessions it would
    // not fit) and its own try/catch: a failed refresh must never cost the
    // session push above or the marks below.
    try {
      await send(
        conn,
        ALLOWLIST.map((l) => ixRefreshTokenRisk(new PublicKey(l.mint))),
        [attestor],
      )
      refreshed = ALLOWLIST.length
    } catch (e) {
      riskError = (e as Error).message
    }

    if (markIxs.length > 0) {
      try {
        markSignature = await send(conn, markIxs, [attestor])
        signature = signature ?? markSignature
      } catch (e) {
        markError = (e as Error).message
        marks.length = 0
      }
    }
  }

  return {
    at: obs.at,
    decisions,
    pushed,
    marked: marks.map((m) => m.symbol),
    marks,
    signature,
    markSignature,
    dryRun,
    backpackError: obs.backpackError,
    markError,
    refreshed,
    riskError,
  }
}

export { HaltState, fairOut }
export type { Verdict, PublicKey }
