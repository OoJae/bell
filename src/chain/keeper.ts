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
import { Connection, Keypair, PublicKey, Transaction, type TransactionInstruction } from '@solana/web3.js'
import { ALLOWLIST, type Listing } from '../config.ts'
import { fetchAsset, type XStock } from '../sensor/xstocks.ts'
import { fetchEquitySessions, type PythSession } from '../sensor/pyth.ts'
import { fetchHalts, isActive, type Halt } from '../sensor/halts.ts'
import { fetchSessions, fetchHolidays, fetchSecurities } from '../sensor/backpack.ts'
import { fetchOndoAssets, OndoFeed, type OndoAsset } from '../sensor/ondo.ts'
import { resolveSession, type SessionWindow, type HolidayWindow } from '../policy/sessions.ts'
import {
  reconcile,
  HaltState,
  type CalendarView,
  type IssuerView,
  type Verdict,
} from '../policy/reconcile.ts'
import { isRegularOpen, nextChange } from '../policy/calendar.ts'
import {
  ixPushMark,
  ixPushSession,
  ixRefreshTokenRisk,
  readMark,
  readAllSymbols,
  send,
} from './client.ts'
import {
  LIMITS,
  MARK_HELD_CONF_BPS,
  MAX_MARK_STEP_AGE_SECONDS,
  MAX_MARK_STEP_BPS,
  MarkSource,
  fairOut,
  markHeld,
  markPushOutcome,
  markStepAllowance,
  rateQ64,
  type SymbolMark,
} from './codec.ts'
import { quote, usdc, fetchTokens, USDC, type Quote } from '../sensor/jupiter.ts'
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

/** The program's ceiling on a mark's uncertainty, read from the IDL. */
const MAX_CONF_BPS = LIMITS.MAX_CONF_BPS ?? 200

/**
 * The value the circuit breaker leaves in a mark: `conf_bps` at its maximum.
 *
 * `push_mark` writes it itself. A push that moves the mark further than the
 * time since the last observation allows (`MAX_MARK_STEP_BPS` a minute) is
 * held rather than written: the rate, price and time stay as they were and
 * only this marker is set, so every fill refuses as MarkPaused. Nothing but a
 * later push clears it, one that lands within the step of the held rate or
 * after the held mark is `MAX_MARK_STEP_AGE_SECONDS` old. So the keeper keeps
 * pricing a held name every tick, exactly as it prices any other: a keeper
 * that stopped would hold the symbol shut for good. This version once did,
 * written before the program had a breaker, on the idea that a new price
 * would overwrite one; the program decides what a push does, and that idea
 * would have made every trip permanent.
 *
 * `open_mark` writes the same value into a mark nobody has priced, with
 * `observed_at` 0. That one is unpriced, not held, and the keeper gives it its
 * first price like any other. Kept as the keeper's names for the codec's
 * `MARK_HELD_CONF_BPS` and `markHeld`, which are the same test.
 */
export const BREAKER_CONF_BPS = MARK_HELD_CONF_BPS
export const breakerTripped = (m: Pick<SymbolMark, 'confBps' | 'observedAt'>): boolean => markHeld(m)

/** How far `to` is from `from`, in bps of `from`: the program's own measure of a step. For the log only. */
const stepBps = (from: bigint, to: bigint): number =>
  from > 0n ? Number(((from > to ? from - to : to - from) * 1_000_000n) / from) / 100 : 0

/**
 * Ondo's status list, read in the background (`sensor/ondo.ts`): three
 * megabytes and several seconds, so never inside a tick. Only the Ondo names
 * on this cluster's allowlist are kept, and with none it never starts.
 */
const ONDO_SYMBOLS: ReadonlySet<string> = new Set(
  ALLOWLIST.filter((l) => l.issuer === 'ondo').map((l) => l.symbol),
)
export const ondoFeed = new OndoFeed({ load: () => fetchOndoAssets(ONDO_SYMBOLS) })

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
  /**
   * What `push_mark` should do with this push, judged by `markPushOutcome`
   * against the mark read just before it was built: `written`, `held` when it
   * moves further than the step allows (the breaker trips, or stays tripped),
   * or `ignored` when it is older than the observation on record. A forecast,
   * not a receipt: a caller that records prices confirms it against the mark
   * as it reads after the push. Optional so a mark built before the breaker
   * still types; absent reads as `written`.
   */
  outcome?: 'written' | 'held' | 'ignored'
  /**
   * The transaction that carried this mark. Absent in a dry run. With more
   * marks than fit one transaction they land in several, so this, not the
   * tick's `markSignature`, is the one that names where this price went.
   */
  signature?: string
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
  /**
   * Ondo's status per token symbol, as the background cache held it when the
   * tick sensed. Null when there was no reading under ten minutes old; see
   * `ondoError`. Optional so an observation built before Ondo was listed still
   * types, and absent reads as no reading.
   */
  ondo?: Map<string, OndoAsset> | null
  /** Why `ondo` is null, when it is. */
  ondoError?: string | null
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
  // Ondo's list is taken from the cache as it stands, never awaited here: a
  // three-megabyte read would put the tick's attestation at risk for names the
  // tick can close instead. The first ticks after a start have no reading, and
  // their Ondo names are closed until one arrives.
  let ondo: Map<string, OndoAsset> | null = null
  let ondoError: string | null = null
  if (ONDO_SYMBOLS.size > 0) {
    ondoFeed.start()
    const r = ondoFeed.reading()
    if (r.assets) ondo = r.assets
    else ondoError = r.error
  }
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
    ondo,
    ondoError,
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

/** What a listing's issuer says, and anything the verdict's detail should add. */
interface IssuerReading {
  view: IssuerView | null
  /** Appended to the verdict's detail. One line; null adds nothing. */
  aside: string | null
}

/**
 * What this listing's issuer says, or nothing.
 *
 * One branch per issuer, each named. An issuer with no branch has no reading,
 * and `reconcile` closes it. This used to be an `else`: every issuer that was
 * not Backed took Backpack's path, so a third issuer would have been judged by
 * Backpack's calendar — open all session, with nobody reading its own state.
 */
function issuerReading(listing: Listing, obs: Observation): IssuerReading {
  switch (listing.issuer) {
    case 'backed': {
      const x = obs.xstocks.get(listing.mainnetMint)
      return {
        view: x ? { openNow: x.openNow, issuerHalted: x.halted, nextChangeAt: x.nextChangeAt } : null,
        aside: null,
      }
    }
    case 'backpack': {
      const supported = obs.backpack?.supported.get(`${listing.underlying}.US`)
      if (!obs.backpack || !supported) return { view: null, aside: null }
      const s = resolveSession({
        sessions: obs.backpack.sessions,
        holidays: obs.backpack.holidays,
        supported,
        now: obs.at,
      })
      // Backpack publishes no halt flag; halts for its names arrive only via
      // the exchange feed above.
      return { view: { openNow: s.regularOpen, issuerHalted: false, nextChangeAt: null }, aside: null }
    }
    case 'ondo':
      return ondoReading(listing, obs)
    default: {
      const unknown: never = listing.issuer
      return { view: null, aside: `no sensor reads issuer ${JSON.stringify(unknown)}` }
    }
  }
}

/**
 * Ondo's word on one token, from the cached status list.
 *
 * The list is keyed by Ondo's symbol and carries no addresses, so the row's
 * underlying ticker is checked as well: a row that names another security is
 * not this token, whatever it is called, and counts as no reading.
 *
 * Open means Ondo would trade it now: not paused, tradeable, and Ondo's market
 * open. That is the issuer's side only. Whether the regular session is open is
 * still Pyth's question and the calendar's, as for every other issuer.
 */
function ondoReading(listing: Listing, obs: Observation): IssuerReading {
  if (!obs.ondo) {
    return { view: null, aside: obs.ondoError ? `Ondo status unread: ${obs.ondoError}` : null }
  }
  const o = obs.ondo.get(listing.symbol)
  if (!o) return { view: null, aside: `Ondo's status list has no ${listing.symbol}` }
  if (o.ticker !== listing.underlying) {
    return { view: null, aside: `Ondo lists ${listing.symbol} as ${o.ticker ?? 'no ticker'}, not ${listing.underlying}` }
  }
  const openNow = !o.paused && o.tradeable && o.marketOpen
  return {
    view: {
      openNow,
      issuerHalted: o.paused,
      // Ondo publishes a `nextMarketOpen`, but read during the regular session
      // on 2026-09-24 it pointed at 16:01 ET: its next session, not the close.
      // The session's times come from Pyth and the calendar instead.
      nextChangeAt: null,
      ...(o.paused ? { stopDetail: `Ondo has paused this token${o.pauseReason ? ` (${o.pauseReason})` : ''}` } : {}),
    },
    aside:
      !openNow && !o.paused
        ? `Ondo: ${o.tradeable ? 'tradeable' : 'not tradeable'}, its market ${o.marketOpen ? 'open' : 'closed'}, session ${o.session}`
        : null,
  }
}

/**
 * Turn one observation into a verdict per listing.
 *
 * The issuers are not symmetric and the code says so rather than pretending
 * otherwise: Backed publishes a per-security flag, Backpack publishes a session
 * calendar and no halt state at all, Ondo a pause flag and a tradeable flag in
 * a list its web app reads. The Nasdaq feed is what covers the gap.
 *
 * `listings` is the allowlist unless a test says otherwise.
 */
export function decide(obs: Observation, listings: readonly Listing[] = ALLOWLIST): Decision[] {
  const nowSeconds = Math.floor(obs.at.getTime() / 1000)

  // The NYSE calendar at the instant of the observation, once for every
  // listing: the regular session belongs to the market, not to a security.
  // Its reading is not stored beside the other sources because it is a pure
  // function of the tick's time, which is stored, and of `calendar.ts`; a
  // disagreement with Pyth is also written into the verdict's detail.
  const calendarOpen = isRegularOpen(obs.at)
  const calendar: CalendarView | null =
    calendarOpen === null ? null : { isOpen: calendarOpen, nextChangeAt: nextChange(obs.at) }

  return listings.map((listing) => {
    const feed = obs.pyth.get(listing.underlying)
    const halt = obs.halts.get(listing.underlying)
    const exchangeHalt =
      halt && isActive(halt, nowSeconds)
        ? { kind: halt.kind as HaltState, resumesAt: halt.resumesAt }
        : null

    const { view: issuer, aside } = issuerReading(listing, obs)

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
    if (aside) verdict.detail += ` (${aside})`

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
 * The mark one executable quote supports, or null when it supports none.
 *
 * The quote's own price impact is the uncertainty we can actually see, so it
 * is the mark's `conf_bps`. Past the program's ceiling (200 bps) the quote
 * supports no mark at all. It used to be clamped to 200 and attested anyway,
 * which claims a precision the quote does not have, while the price it carries
 * is the impacted one. On 2026-09-24 a $200 quote moved TSLAon 87%: attested,
 * that is a price about seven times Tesla's, labelled as good to 2%. No mark
 * means no fill, which is the honest outcome. The nine earlier names were far
 * inside it the same day (PFE 56 bps, LMT 74, TSLAx 2), and below the ceiling
 * nothing changes.
 */
export function markFromQuote(args: {
  symbol: string
  q: Pick<Quote, 'outAmount' | 'priceImpact'>
  decimals: number
  multiplier: number
}): MarkReading | null {
  const { q, decimals, multiplier } = args
  if (q.outAmount === 0n) return null
  const confBps = Math.max(1, Math.round(q.priceImpact * 10_000))
  if (!(confBps <= MAX_CONF_BPS)) return null

  // Executable price per share, with the multiplier applied.
  const shares = (Number(q.outAmount) / 10 ** decimals) * multiplier
  const pricePerShare = MARK_NOTIONAL_USD / shares
  return {
    symbol: args.symbol,
    rateQ64: rateQ64({ pricePerShare, multiplier, quoteDecimals: 6, stockDecimals: decimals }),
    pxNum: BigInt(Math.round(pricePerShare * 1e6)),
    pxExpo: -6,
    confBps,
    source: MarkSource.Jupiter,
  }
}

/**
 * Price the allowlisted symbols from an executable quote.
 *
 * Symbols with no route get no mark, and therefore cannot fill — the honest
 * coverage limit rather than a guess. So does a route too thin to state a
 * price within the program's ceiling (see `markFromQuote`). The scaled-UI
 * multiplier is folded in here because raw balances are not share units.
 *
 * `listings` defaults to the whole allowlist; the tick passes only the names
 * registered on this cluster, so an unregistered one costs no quote.
 */
export async function readMarks(
  conn: Connection,
  decimalsByMint: Map<string, number>,
  listings: readonly Listing[] = ALLOWLIST,
): Promise<MarkReading[]> {
  const out: MarkReading[] = []
  for (const listing of listings) {
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

    const m = markFromQuote({ symbol: listing.symbol, q, decimals, multiplier: multiplierOf(risk.multiplierBits) })
    if (m) out.push(m)
  }
  return out
}

/** A legacy transaction's hard size limit, in bytes. */
export const TX_LIMIT = 1_232

/**
 * The serialized size of one transaction carrying `ixs`, paid for and signed
 * by `payer` alone: the message, one signature, and its length byte. Every
 * transaction the keeper sends has exactly that one signer, the attestor.
 */
export function txBytes(ixs: readonly TransactionInstruction[], payer: PublicKey): number {
  const tx = new Transaction().add(...ixs)
  tx.feePayer = payer
  tx.recentBlockhash = PublicKey.default.toBase58()
  return tx.serializeMessage().length + 1 + 64
}

/**
 * Split instructions, in order, into as few transactions as fit `TX_LIMIT`.
 *
 * Measured, not counted: the sizes are fixed per instruction kind but differ
 * between kinds, and a count per transaction would be wrong for one of them.
 * Measured on 2026-09-24, one session push adds 75 bytes, one TokenRisk
 * refresh 77 and one mark 129. So nine sessions are 841 bytes and fourteen
 * 1,216, one transaction either way; nine refreshes are 859 and fourteen 1,244,
 * which is two; seven marks are 1,069 but nine are 1,327, so marks already
 * needed two once more than eight names priced. With nine names each batch
 * packs exactly as it was sent before. An instruction too big to share still
 * goes alone, so the node refuses it by name rather than this dropping it.
 */
export function packInstructions(
  ixs: readonly TransactionInstruction[],
  payer: PublicKey,
): TransactionInstruction[][] {
  const out: TransactionInstruction[][] = []
  let cur: TransactionInstruction[] = []
  for (const ix of ixs) {
    if (cur.length > 0 && txBytes([...cur, ix], payer) > TX_LIMIT) {
      out.push(cur)
      cur = []
    }
    cur.push(ix)
  }
  if (cur.length > 0) out.push(cur)
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
  /**
   * Every transaction this tick landed, in the order sent: sessions, then
   * refreshes, then marks. With fourteen names a batch can take two, and
   * `signature` and `markSignature` name only the first of theirs.
   */
  signatures: string[]
  /**
   * Allowlisted names with no `SymbolState` or `TokenRisk` on this cluster yet,
   * left out of every push. A name reaches the allowlist before
   * `scripts/register.ts` has run for it — on devnet, the moment its mirror is
   * committed — and one push for an account that does not exist fails the
   * whole transaction it is in, closing every name beside it.
   */
  unregistered: string[]
  /**
   * Names whose on-chain mark carries the circuit-breaker marker
   * (`BREAKER_CONF_BPS`) when the tick read it. They are priced and pushed
   * like every other name, because only a push can release them; each is
   * logged as PAUSED (circuit breaker) every tick it stays held.
   */
  breaker: string[]
}

/** What the log last said about unregistered names, so it is said on change. */
let lastUnregistered = ''

/**
 * One pass. Each kind of push goes in as few transactions as fit the 1,232
 * byte limit (`packInstructions`): with nine names, one each, exactly as
 * before; with fourteen, the refreshes and the marks can take two.
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
  const sessionIxs: TransactionInstruction[] = []
  const markIxs: TransactionInstruction[] = []
  const pushed: string[] = []

  // Every symbol's on-chain state in one read: one consistent snapshot, and
  // one request instead of nine against an endpoint that rate-limits.
  const onChain = await readAllSymbols(
    conn,
    decisions.map((d) => d.listing),
  )

  // A name with no accounts here yet is left out of every batch below: one
  // push for an account that does not exist fails its whole transaction.
  const unregistered = decisions
    .filter((d) => {
      const a = onChain.get(d.listing.symbol)
      return !a?.state || !a.risk
    })
    .map((d) => d.listing.symbol)
  if (unregistered.join(',') !== lastUnregistered) {
    if (unregistered.length > 0) {
      console.log(`  not registered on this cluster, left out of every push: ${unregistered.join(', ')} (run scripts/register.ts)`)
    }
    lastUnregistered = unregistered.join(',')
  }

  for (const d of decisions) {
    const state = onChain.get(d.listing.symbol)?.state ?? null
    if (!state) continue
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
  // Isolated from the session push on purpose. Pricing needs a Jupiter quote
  // per name every tick, thousands a day, against an endpoint that
  // rate-limits and times out — and every one of those failures used to throw
  // out of `tick()` before the session attestation was ever sent, so a routine
  // sensor hiccup closed the entire venue 120 seconds later. That is
  // fail-closed working exactly as designed, on the wrong input.
  //
  // The two are not equally critical: a stale session is a safety question, a
  // stale mark only means nothing can fill. Degrading to "no fresh price" is
  // the honest outcome, and the gate still refuses those fills by itself.
  let marks: PushedMark[] = []
  let markError: string | null = null

  // A held mark is read from the snapshot, and again just before its push is
  // built, so one tripped mid-tick is named too. Both are only for the log:
  // a held name is priced and pushed like any other, because the program
  // releases a hold only when a push lands within the step or after the reset
  // window. Leaving it out, as this keeper once did, would hold it for good.
  const breaker = decisions
    .filter((d) => {
      const m = onChain.get(d.listing.symbol)?.mark
      return m ? breakerTripped(m) : false
    })
    .map((d) => d.listing.symbol)
  /** Per held name, what this tick's push is expected to do about it, for the PAUSED line. */
  const heldNotes = new Map<string, string>()

  if (args.withMarks !== false) {
    try {
      const decimals = new Map(
        [...(await fetchTokens(ALLOWLIST.map((l) => l.mainnetMint)))].map(([m, t]) => [m, t.decimals]),
      )
      const priced = decisions
        .map((d) => d.listing)
        .filter((l) => !unregistered.includes(l.symbol))
      for (const m of await readMarks(conn, decimals, priced)) {
        const existing = await readMark(conn, m.symbol)
        if (!existing) continue // not opened yet
        const held = breakerTripped(existing)
        if (held && !breaker.includes(m.symbol)) breaker.push(m.symbol)
        // A forecast of what push_mark will do, by its own rules, against the
        // mark as it stands. Judged at the observation's own time; the chain's
        // clock at execution is a few seconds later, which matters only within
        // seconds of the reset window.
        const push = { rateQ64: m.rateQ64, observedAt: BigInt(nowSeconds) }
        const outcome = markPushOutcome(existing, push, BigInt(nowSeconds))
        if (held || outcome === 'held') {
          const moved = stepBps(existing.rateQ64, m.rateQ64)
          const allowed = existing.rateQ64 > 0n ? Number((markStepAllowance(existing, push.observedAt) * 1_000_000n) / existing.rateQ64) / 100 : 0
          const why =
            outcome === 'written'
              ? held
                ? `this push (${moved.toFixed(1)} bps from the held rate) should release it`
                : ''
              : outcome === 'held'
                ? `this push moves ${moved.toFixed(1)} bps against the ${allowed.toFixed(1)} bps the time allows, so the program holds it`
                : 'this push is older than the mark on record and is ignored'
          if (held) heldNotes.set(m.symbol, why)
          else console.log(`  ${m.symbol} ${why} (circuit breaker trips)`)
        }
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
        marks.push({ ...m, observedAt: nowSeconds, outcome })
      }
    } catch (e) {
      markError = (e as Error).message
      markIxs.length = 0
      marks.length = 0
    }
  }
  for (const symbol of breaker) {
    const note = heldNotes.get(symbol) ?? 'no price this tick, so nothing can release it yet'
    console.log(
      `  ${symbol} PAUSED (circuit breaker): its mark reads conf_bps ${BREAKER_CONF_BPS} and fills refuse as MarkPaused; ` +
        `the keeper keeps pushing, and a push within ${MAX_MARK_STEP_BPS / 100}% a minute of the held rate, ` +
        `or any push once it is ${MAX_MARK_STEP_AGE_SECONDS}s old, releases it (${note})`,
    )
  }

  let signature: string | null = null
  let markSignature: string | null = null
  let refreshed = 0
  let riskError: string | null = null
  const signatures: string[] = []
  if (!dryRun) {
    // Sessions first, and in their own transactions. If a later push fails,
    // the attestation that keeps the venue open has already landed. Every
    // batch is sent even when an earlier one failed, so one bad batch closes
    // only its own names; the tick then fails as it always has, and the
    // refreshes and marks wait for the next.
    let sessionFailure: unknown = null
    for (const batch of packInstructions(sessionIxs, attestor.publicKey)) {
      try {
        const sig = await send(conn, batch, [attestor])
        signature = signature ?? sig
        signatures.push(sig)
      } catch (e) {
        sessionFailure = sessionFailure ?? e
      }
    }
    if (sessionFailure) throw sessionFailure

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
    // Its own transactions (nine refreshes are 859 bytes; with sessions they
    // would not fit, and fourteen take two) and its own try/catch: a failed
    // refresh must never cost the session push above or the marks below.
    // Only records that exist: a refresh of one that does not fails the batch.
    const refreshIxs = decisions
      .map((d) => d.listing)
      .filter((l) => onChain.get(l.symbol)?.risk)
      .map((l) => ixRefreshTokenRisk(new PublicKey(l.mint)))
    for (const batch of packInstructions(refreshIxs, attestor.publicKey)) {
      try {
        signatures.push(await send(conn, batch, [attestor]))
        refreshed += batch.length
      } catch (e) {
        riskError = riskError ?? (e as Error).message
      }
    }

    // A mark batch that fails costs its own marks only; the ones that landed
    // are kept, each with the transaction that carried it.
    const landed: PushedMark[] = []
    let at = 0
    for (const batch of packInstructions(markIxs, attestor.publicKey)) {
      const carried = marks.slice(at, at + batch.length)
      at += batch.length
      try {
        const sig = await send(conn, batch, [attestor])
        markSignature = markSignature ?? sig
        signatures.push(sig)
        for (const m of carried) landed.push({ ...m, signature: sig })
      } catch (e) {
        markError = markError ?? (e as Error).message
      }
    }
    marks = landed
    signature = signature ?? markSignature
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
    signatures,
    unregistered,
    breaker,
  }
}

export { HaltState, fairOut }
export type { Verdict, PublicKey }
