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
  nightPda,
  readAllSymbols,
  readBoard,
  readNightOptIn,
  readOrders,
  readSellOrders,
  type SymbolAccounts,
} from '../../src/chain/client.ts'
import { ataFor, decodeTokenAccount, TOKEN_2022 } from '../../src/chain/spl.ts'
import {
  checkRefusal,
  decodeNightOptIn,
  LIMITS,
  MAX_CHECK_AGE_SECONDS,
  MAX_MARK_AGE_SECONDS,
  MAX_MARK_STEP_AGE_SECONDS,
  MAX_MARK_STEP_BPS,
  MAX_NIGHT_GAP_BPS,
  MAX_NIGHT_REF_AGE_SECONDS,
  MAX_RISK_AGE_SECONDS,
  MAX_SESSION_GAP_BPS,
  MAX_SESSION_REF_AGE_SECONDS,
  MAX_STATE_AGE_SECONDS,
  markHeld,
  Mode,
  multiplierOf,
  nightConsent,
  PROGRAM_ID,
  REBASE_GUARD_SECONDS,
  RebaseKind,
  rebaseKindName,
  type BellOrder,
  type NightOptIn,
  type SellOrder,
  type SymbolCheck,
  type SymbolMark,
  type TokenRisk,
} from '../../src/chain/codec.ts'
import { ALLOWLIST, CLUSTER, type Issuer, type Listing } from '../../src/config.ts'
import { confCap, type MarkPrice } from '../../src/policy/order.ts'
import { HaltState } from '../../src/policy/reconcile.ts'
import type { TapeRow } from './tape.ts'

export const RPC_URL = process.env.NEXT_PUBLIC_BELL_RPC ?? 'http://127.0.0.1:8899'
/**
 * No automatic retry on 429. web3.js otherwise sleeps and retries a
 * rate-limited request with backoff, silently, for as long as it takes — so a
 * throttled poll overlapped the next one and the page piled requests onto the
 * endpoint that was already refusing it. A failed poll is shown as one, and
 * the next poll is the retry.
 */
export const connection = () =>
  new Connection(RPC_URL, { commitment: 'confirmed', disableRetryOnRateLimit: true })

const explorerCluster = RPC_URL.includes('devnet') ? '?cluster=devnet' : ''

/** A devnet explorer link for a signature, so every claim on the page can be checked. */
export const explorerTx = (sig: string) => `https://explorer.solana.com/tx/${sig}${explorerCluster}`

/** An explorer link for an account, on the same cluster as `explorerTx`. */
export const explorerAddress = (key: string) =>
  `https://explorer.solana.com/address/${key}${explorerCluster}`

/** The program this page talks to, from the IDL the client is built from. */
export const PROGRAM = PROGRAM_ID.toBase58()

/** A key short enough to sit in a sentence and still be matched by eye. */
export const shortKey = (key: string) => `${key.slice(0, 4)}…${key.slice(-4)}`

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
  /**
   * Null for "in between": a price that is due to be replaced, not a failure.
   * `'disclosure'` for a fact a holder should know that no check can pass or
   * fail, such as who can move the token out of their wallet. `'unset'` for a
   * check the program on this cluster does not run yet: not a pass, since
   * nothing checked, and not a failure, since nothing is refused for it.
   * Neither ever carries `refuses`, so neither votes on the verdict.
   */
  ok: boolean | null | 'disclosure' | 'unset'
  detail: string
  /**
   * The `BellError` this row stands for, or absent when the row is
   * informational. Only rows with a code decide the board's verdict. "Price
   * fresh" and "price precise enough" carry none: a new price lands every
   * minute, so an old one is due rather than a stop, and letting "price fresh"
   * vote made the board say "closed" for a symbol the program calls tradeable.
   */
  refuses?: string
  /**
   * Asked by a fill after the gate passes (the breaker, the second source,
   * the band), not by `assert_tradeable`. The simulated verdict speaks for
   * the gate rows only, so these are applied after it: a symbol whose gate is
   * open and whose price is held still has nothing fill.
   */
  fill?: true
}

/**
 * What the board badge says. Derived from the refusal's *reason*, because
 * "closed" for a stale attestation, a paused mint or a pending dividend is a
 * claim about the market that is not true — and for a product whose output is
 * why it said no, the wrong why is the bug.
 */
export type Status =
  | 'loading'
  | 'tradeable'
  | 'closed' // the primary market is shut; parks for the bell
  | 'halted' // a halt with an exchange reason code
  | 'withdrawn' // the issuer stopped its own token; the underlying trades
  | 'suspended' // stopped, reason not published
  | 'stale' // our attestation or mint read is too old to vouch for
  | 'paused' // the issuer froze the mint
  | 'rebase' // a corporate action is pending or just landed
  | 'hook' // the issuer armed a transfer hook
  | 'offline' // we cannot reach the chain or the program
  | 'unlisted'
  | 'breaker' // the circuit breaker holds the last price; nothing fills on it
  | 'unchecked' // the second source is missing or too old to vouch for now
  | 'disputed' // the two sources disagree about whether the market is open
  | 'offband' // the pool's price is too far from the exchange's last sale
  | 'refused'

export interface SymbolView {
  listing: Listing
  /** The program's own answer. Null while loading. */
  allowed: boolean | null
  /** `BellError` variant when refused. */
  reason: string | null
  status: Status
  gates: GateRow[]
  /** Seconds since the attestation, or null if never attested. */
  attestationAge: number | null
  nextChangeAt: number
  /** The attested session state, so `nextChangeAt` can be read as the next open. */
  openNow: boolean
  priceUsd: number | null
  registered: boolean
  /** The attested halt state (`HaltState`). */
  halt: number
  /** The mark's raw-per-raw rate, for an order's loss floor; null without a mark. */
  markRateQ64: bigint | null
  /** The per-share price that rate stands for, to convert a dollar limit into a floor. */
  markPx: MarkPrice | null
  /** The multiplier in force, as the last mint read recorded it. */
  multiplierBits: bigint | null
  /** When a scheduled multiplier change lands, if one is still ahead; else 0. */
  changeAt: number
  /** The circuit breaker holds this symbol's last price, so nothing fills on it. */
  markHeld: boolean
  /** Whether this symbol's check (the second source) exists on chain. */
  checked: boolean
  /**
   * How far the pool's price sits from the checker's last sale, against the
   * band the fill that could happen now must stay inside: the session band
   * while the market is open, the night band while it is shut. Null without
   * both a price and a reference.
   */
  refGap: { bps: number; bandBps: number; within: boolean; night: boolean } | null
  /**
   * While the session is closed, what a night fill for an owner who opted in
   * would be refused as now, or null when one could fill. The gate runs in
   * Guarded mode for such a fill, which lifts "market open" and nothing else,
   * so every other row still answers, the two price rows included (as
   * MarkStale and MarkTooWide). Null while the session is open.
   */
  nightReason: string | null
}

/**
 * Fold a refusal into a badge. `halt` separates the kinds of stopped: a reason
 * code from the exchange feed is a halt; an unflagged stop on a listing whose
 * issuer is known to have withdrawn it is a withdrawal; anything else says
 * only what is known.
 */
export function statusOf(v: Pick<SymbolView, 'allowed' | 'reason' | 'halt' | 'listing'>): Status {
  if (v.allowed === null) return 'loading'
  if (v.allowed) return 'tradeable'
  switch (v.reason) {
    case 'StateStale':
    case 'RiskStale':
      return 'stale'
    case 'IssuerPaused':
      return 'paused'
    case 'RebasePending':
    case 'RebaseUnclassified':
      return 'rebase'
    case 'HookArmed':
      return 'hook'
    case 'unavailable':
      return 'offline'
    case 'NotRegistered':
      return 'unlisted'
    case 'MarketClosed':
      if (v.halt === HaltState.None) return 'closed'
      if (v.halt !== HaltState.Unspecified) return 'halted'
      return v.listing.withdrawn ? 'withdrawn' : 'suspended'
    // A fill's own refusals, after the gate. None of them is the market being
    // closed, and saying "closed" for a price the breaker holds would be the
    // wrong why.
    case 'MarkPaused':
      return 'breaker'
    case 'CheckStale':
    case 'AccountNotInitialized':
      return 'unchecked'
    case 'CheckerDisagrees':
      return 'disputed'
    case 'MarkOffReference':
      return 'offband'
    default:
      return 'refused'
  }
}

/** What has to change for a parked order to fill — the end of "fills when …". */
export function clearsWhen(v: Pick<SymbolView, 'reason' | 'status'>): string {
  switch (v.status) {
    case 'stale':
      return v.reason === 'RiskStale' ? 'the mint is re-read' : 'the attestation is fresh'
    case 'paused':
      return 'the issuer unpauses'
    case 'rebase':
      return v.reason === 'RebaseUnclassified' ? 'the corporate action is identified' : 'the rebase window passes'
    case 'hook':
      return 'the hook is disarmed'
    case 'halted':
    case 'suspended':
      return 'trading resumes'
    case 'offline':
      return 'the chain is reachable'
    case 'breaker':
      return 'the circuit breaker releases the price'
    case 'unchecked':
      return v.reason === 'AccountNotInitialized'
        ? "the symbol's second check is opened on chain"
        : 'the second source reports again'
    case 'disputed':
      return 'both sources agree on the session'
    case 'offband':
      return "the pool's price is back inside the band"
    default:
      return 'the gate clears'
  }
}

/** A price counts as due for replacement, not stale, for this long past the limit. */
const MARK_GRACE_SECONDS = 10

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
 * The permanent delegate each issuer's real mainnet mints name. Two keys cover
 * the Backed and Backpack listings (README, verified against the mainnet
 * accounts), and the mainnet mint fixtures the program tests parse carry the
 * same two. Ondo's five mints name none (all five read on 24 Sep 2026), which
 * is `null` here.
 */
const ISSUER_DELEGATE: Record<Issuer, { name: string; key: string | null }> = {
  backed: { name: 'Backed', key: '5aMNNLQJwAEeoemTEMkv5NVjqKwvvefRYCQ5Z67HFvEq' },
  backpack: { name: 'Backpack', key: '2cVYpagTt7ZGc3mmTXBa7fAznUtx5DUu6aCq8uVDaf4a' },
  ondo: { name: 'Ondo', key: null },
}

/**
 * The key BELL deploys with. `scripts/mirror-mints.ts` reproduces each real
 * mint's extensions on devnet, permanent delegate included, and the only key it
 * can name there is the one creating the mirror.
 */
const DEVNET_DEPLOY_KEY = 'Dqp6DbUh6j5Jddff9VHPAK1UpByo85NhLVw83S58Ziqs'

/**
 * Who can take this token out of a wallet without its holder's signature.
 *
 * A disclosure, not a gate: every one of these mints has a permanent delegate,
 * so refusing on it would refuse the asset class, and no venue can change it.
 * What the page can do is name the key the chain records — never the one we
 * expect — and say whose it is.
 */
function delegateRow(listing: Listing, r: TokenRisk): GateRow {
  const label = 'permanent delegate'
  const onChain = r.permanentDelegate?.toBase58() ?? null
  if (!onChain) {
    return { label, ok: 'disclosure', detail: "none — no key can move this token without its holder's signature" }
  }
  const issuer = ISSUER_DELEGATE[listing.issuer]
  const power = `${shortKey(onChain)} can move or burn this token in any wallet, without the holder's signature`
  const real = issuer.key ? `${issuer.name}'s ${shortKey(issuer.key)}` : `no one: ${issuer.name}'s real mint names none`
  const whose =
    CLUSTER === 'devnet'
      ? onChain === DEVNET_DEPLOY_KEY
        ? `On this devnet mirror that is BELL's own deploy key; on the real mint it is ${real}.`
        : `It is not the key this devnet mirror was made with.`
      : onChain === issuer.key
        ? `It is ${issuer.name}'s key.`
        : issuer.key
          ? `It is not ${issuer.name}'s known key, ${shortKey(issuer.key)}.`
          : `${issuer.name}'s real mints name no permanent delegate, so this one is unexpected.`
  return { label, ok: 'disclosure', detail: `${power}. ${whose}` }
}

/**
 * How precisely the price is attested, against what an order here accepts.
 *
 * Informational: it gates a *fill* (`MarkTooWide`), not `assert_tradeable`.
 * The figure is the attestor's own uncertainty about the mark, and an order
 * snapshots its listing's cap when placed. A mark nobody has pushed yet opens
 * with the widest possible figure and a zero timestamp, which means "no
 * price", not "a wide one".
 */
function precisionRow(listing: Listing, mark: SymbolMark | null | undefined): GateRow {
  const label = 'price precise enough'
  const cap = confCap(listing)
  if (!mark || mark.observedAt <= 0n) {
    return { label, ok: false, detail: 'no price attested yet, so there is nothing to fill against' }
  }
  // A held price carries the breaker's marker where its precision was, and
  // "within 65535bps" would be a number nobody attested.
  if (markHeld(mark)) {
    return { label, ok: null, detail: 'not known while the breaker holds the price; the next accepted price brings one' }
  }
  return mark.confBps <= cap
    ? { label, ok: true, detail: `attested to within ${mark.confBps}bps; an order here accepts up to ${cap}bps` }
    : {
        label,
        ok: false,
        detail: `attested only to within ${mark.confBps}bps — wider than the ${cap}bps an order here accepts, so a fill waits`,
      }
}

/** A program bound as a person says it: "5 min", "12h", "120s". */
export const bound = (s: number) => (s % 3_600 === 0 ? `${s / 3_600}h` : s % 60 === 0 ? `${s / 60} min` : `${s}s`)

/** "150bps (1.5%)": a band as the program counts it and as a person reads it. */
export const bandText = (bps: number) => `${bps}bps (${bps / 100}%)`

/**
 * What the three rows below say before the program on this cluster runs
 * them. Worded the same in each, so a reader sees one fact, not three.
 */
const NOT_SET_UP = 'not set up yet'

/**
 * The circuit breaker `push_mark` runs: a new price that moves further than
 * the time since the last one allows is held, not written, and every fill
 * refuses a held price as MarkPaused, after MarkStale and before MarkTooWide.
 *
 * Before any check exists the program is taken to be the one without a
 * breaker, and the row says "not set up yet" rather than "clear". A held mark
 * can only come from a program that has one, so it shows as held regardless.
 */
function breakerRow(mark: SymbolMark | null | undefined, checksLive: boolean): GateRow {
  const label = 'circuit breaker clear'
  const step = `${MAX_MARK_STEP_BPS}bps a minute`
  if (mark && markHeld(mark)) {
    // Once the held price is MAX_MARK_STEP_AGE_SECONDS old it anchors nothing,
    // and the next price is written at any rate. The keeper pushes every
    // minute, so that is when the hold ends at the latest.
    const free = new Date((Number(mark.observedAt) + MAX_MARK_STEP_AGE_SECONDS) * 1000)
    return {
      label,
      refuses: 'MarkPaused',
      fill: true,
      ok: false,
      detail: `price paused by the circuit breaker: a new price moved more than ${step}, so the last one is held and nothing fills on it. The next price within the step releases it, and after ${nyClockOf(free)} any new price does`,
    }
  }
  if (!checksLive) {
    return {
      label,
      ok: 'unset',
      detail: `${NOT_SET_UP}: with the program's next upgrade, a price that jumps more than ${step} is held, not taken`,
    }
  }
  return {
    label,
    refuses: 'MarkPaused',
    fill: true,
    ok: true,
    detail: `clear: a new price may move at most ${step}, and a bigger jump is held, not taken`,
  }
}

/**
 * The second source: a separate key, with its own price feed, that every
 * fill needs to agree with the attestor, both that the market is open (shut,
 * for a night fill) and about roughly what the stock last sold for.
 *
 * The refusal comes from `checkRefusal`, the client's copy of step 4 of the
 * program's `admit`, so the row and the program cannot hold two opinions; the
 * words are built from the same numbers in the same order. The price question
 * is the band row's, below, so a MarkOffReference is left to it.
 *
 * `checksLive` is whether any symbol on the board has a check. None does
 * before the upgrade, and no fill reads one then, so the row says "not set up
 * yet" and does not vote. Once some do, the program is the new one, and a
 * symbol without a check has every fill refused as AccountNotInitialized.
 */
function checkRow(
  check: SymbolCheck | null,
  checksLive: boolean,
  markRateQ64: bigint,
  night: boolean,
  now: number,
): GateRow {
  const label = 'second source agrees'
  if (!check) {
    return checksLive
      ? {
          label,
          refuses: 'AccountNotInitialized',
          fill: true,
          ok: false,
          detail: `${NOT_SET_UP} for this symbol, though others have theirs: every fill of it is refused until its check is opened`,
        }
      : {
          label,
          ok: 'unset',
          detail: `${NOT_SET_UP}: with the program's next upgrade, a second key with its own price feed has to agree before anything fills`,
        }
  }
  const code = checkRefusal({ check, markRateQ64, night, now: BigInt(now) })
  const refuses = code === 'MarkOffReference' ? null : code
  const row = (ok: boolean, detail: string): GateRow => ({ label, refuses: refuses ?? 'CheckStale', fill: true, ok, detail })
  if (check.observedAt <= 0n) return row(false, 'opened, but its checker has not reported yet')
  const seen = Math.max(0, now - Number(check.observedAt))
  const sale = Math.max(0, now - Number(check.refAt))
  const refLimit = night ? MAX_NIGHT_REF_AGE_SECONDS : MAX_SESSION_REF_AGE_SECONDS
  // `admit`'s order: the check's own age, the session, the sale's age, a price at all.
  if (seen > MAX_CHECK_AGE_SECONDS) {
    return row(false, `last reported ${span(seen)} ago, older than the ${MAX_CHECK_AGE_SECONDS}s a fill accepts`)
  }
  if (refuses === 'CheckerDisagrees') {
    return row(
      false,
      `the checker says the market is ${check.openNow ? 'open' : 'shut'} and the attestor says ${night ? 'shut' : 'open'}; nothing fills until they agree`,
    )
  }
  if (sale > refLimit) {
    return row(false, `its last sale is ${span(sale)} old, older than the ${bound(refLimit)} a ${night ? 'night' : 'session'} fill accepts`)
  }
  if (check.refRateQ64 <= 0n) return row(false, 'its checker has not reported a price yet')
  return row(true, `agrees the market is ${night ? 'shut' : 'open'}, reported ${span(seen)} ago; its last sale was ${span(sale)} ago`)
}

/**
 * The band: how far the pool's price may sit from the checker's last sale,
 * which `admit` asks last, as MarkOffReference. Measured in the mark's own
 * rate, as the program measures it, and against the band for the fill that
 * could happen now: the session band while the market is open, the tighter
 * night band while it is shut, when no live market pulls a wrong price back.
 *
 * Votes only when both numbers exist. Without a check, a reference or a
 * price, the program refuses earlier (the check row, or MarkStale), and this
 * row claiming the refusal would give the wrong why.
 */
function bandRow(
  check: SymbolCheck | null,
  checksLive: boolean,
  mark: SymbolMark | null | undefined,
  night: boolean,
): { row: GateRow; gap: SymbolView['refGap'] } {
  const label = 'within the band of Nasdaq'
  const bandBps = night ? MAX_NIGHT_GAP_BPS : MAX_SESSION_GAP_BPS
  if (!check) {
    const detail = checksLive
      ? 'no second source to measure the price against'
      : `${NOT_SET_UP}: with the program's next upgrade, a fill needs the pool's price within ${MAX_SESSION_GAP_BPS}bps of the exchange's last sale in session, and ${MAX_NIGHT_GAP_BPS}bps at night`
    return { row: { label, ok: checksLive ? false : 'unset', detail }, gap: null }
  }
  if (check.refRateQ64 <= 0n) {
    return { row: { label, ok: false, detail: 'no last sale from the checker to measure against yet' }, gap: null }
  }
  if (!mark || mark.observedAt <= 0n || mark.rateQ64 <= 0n) {
    return { row: { label, ok: false, detail: 'no pool price to measure yet' }, gap: null }
  }
  const ref = check.refRateQ64
  const off = mark.rateQ64 > ref ? mark.rateQ64 - ref : ref - mark.rateQ64
  const within = off <= (ref / 10_000n) * BigInt(bandBps)
  // Inside the band, to the nearest basis point, which cannot round past the
  // band. Outside it, rounded up, and within a hair of the edge said as "just
  // over": the program's bound rounds the reference down first, so a price a
  // billionth of a basis point past it is refused, and "300bps" beside a
  // refusal at 300 would read as a contradiction.
  const scaled = off * 10_000n
  const bps = Number(within ? (scaled * 2n + ref) / (2n * ref) : (scaled + ref - 1n) / ref)
  const bpsSaid = within || bps > bandBps ? `${bps}bps` : `just over ${bandBps}bps`
  // The rate is stock per dollar, so more of it is a lower price.
  const side = mark.rateQ64 > ref ? 'below' : 'above'
  const refUsd = Number(check.refPxNum) * 10 ** check.refPxExpo
  const sale = `the checker's last sale${refUsd > 0 ? `, $${refUsd.toFixed(2)}` : ''} at ${nyClockOf(new Date(Number(check.refAt) * 1000))}`
  const where = off === 0n ? `level with ${sale}` : `${bpsSaid} ${side} ${sale}`
  const when = night ? ' at night' : ''
  return {
    row: {
      label,
      refuses: 'MarkOffReference',
      fill: true,
      ok: within,
      detail: within
        ? `the pool's price is ${where}; a fill${when} needs it within ${bandBps}bps`
        : `the pool's price is ${where}: outside the ${bandBps}bps a fill${when} allows, so nothing fills until they converge`,
    },
    gap: { bps, bandBps, within, night },
  }
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
  /**
   * Whether any symbol on the board has a check, which is how the page tells
   * the program that runs checks from the one before it. Only the board knows;
   * one symbol on its own can say only whether it has one.
   */
  checksLive?: boolean,
): Promise<SymbolView> {
  const mint = new PublicKey(listing.mint)
  const accounts = prefetched ?? (await readAllSymbols(conn, [listing])).get(listing.symbol)!
  const { state, risk, mark } = accounts
  const check = accounts.check ?? null
  const live = checksLive ?? check !== null
  const now = Math.floor(Date.now() / 1000)

  if (!state || !risk) {
    return {
      listing,
      allowed: false,
      reason: 'NotRegistered',
      status: 'unlisted',
      gates: [{ label: 'registered', ok: false, detail: 'this symbol is not set up on chain' }],
      attestationAge: null,
      nextChangeAt: 0,
      openNow: false,
      priceUsd: null,
      registered: false,
      halt: HaltState.None,
      markRateQ64: null,
      markPx: null,
      multiplierBits: null,
      changeAt: 0,
      markHeld: false,
      checked: check !== null,
      refGap: null,
      nightReason: null,
    }
  }

  const age = ago(state.observedAt, now)
  const markAge = mark ? ago(mark.observedAt, now) : null
  // The only fill that can happen while the session is shut is a night fill,
  // for an owner who opted in, so that is the fill the check and the band are
  // judged for then. An owner who has not opted in meets "market open" first.
  const night = !state.openNow
  const band = bandRow(check, live, mark, night)
  const marketOpen: GateRow = {
    label: 'market open',
    refuses: 'MarketClosed',
    ok: state.openNow,
    detail: state.openNow
      ? 'primary market is trading'
      : 'the regular session is closed — queue it for the bell',
  }
  const priceFresh: GateRow = {
    // Informational: it gates a fill, not `assert_tradeable`. A new price
    // lands every 45–60s, so one just past the limit is due, not stale — and
    // the filler waits for it rather than filling on the old one.
    label: 'price fresh',
    ok:
      markAge === null
        ? false
        : markAge <= MAX_MARK_AGE_SECONDS - 5
          ? true
          : markAge <= MAX_MARK_AGE_SECONDS + MARK_GRACE_SECONDS
            ? null
            : false,
    detail:
      markAge === null
        ? 'no price attested — cannot fill'
        : markAge <= MAX_MARK_AGE_SECONDS - 5
          ? `${markAge}s old`
          : markAge <= MAX_MARK_AGE_SECONDS + MARK_GRACE_SECONDS
            ? `${markAge}s old — refreshing; a fill waits for the next price`
            : `${markAge}s old — stale`,
  }
  const precise = precisionRow(listing, mark)

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
          : state.halt !== HaltState.Unspecified
            ? `halted on ${state.exchangeMic}: ${HALT_NAMES[state.halt] ?? 'halted'}`
            : listing.withdrawn
              ? `the issuer has withdrawn this token — its stop, not a halt of ${listing.underlying}`
              : 'trading stopped; no reason published',
    },
    {
      // Gate 2b. Everything below is proven from the mint, but only as of the
      // last read — so the read itself has to be recent.
      label: 'mint read fresh',
      refuses: 'RiskStale',
      ok: now - Number(risk.verifiedAt) <= MAX_RISK_AGE_SECONDS,
      detail:
        now - Number(risk.verifiedAt) <= MAX_RISK_AGE_SECONDS
          ? `extensions re-read ${now - Number(risk.verifiedAt)}s ago`
          : `last read ${now - Number(risk.verifiedAt)}s ago — too old to vouch for, so treated as closed`,
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
    marketOpen,
    priceFresh,
    // A fill's own questions, after the gate, in `admit`'s order: the price
    // is fresh (above), not held, precise enough; then the second source.
    breakerRow(mark, live),
    precise,
    checkRow(check, live, mark?.rateQ64 ?? 0n, night, now),
    band.row,
    delegateRow(listing, risk),
  ]

  let allowed: boolean | null = null
  let reason: string | null = null
  // Derived from the accounts we already hold. A fill refuses on the first
  // failing check in `admit`'s order (the gate in `check_tradeable`'s order,
  // then the price, then the second source), and the rows above are in that
  // order, so the first failing row with a code reproduces both the verdict
  // and the reason without another round trip. Informational rows do not vote.
  const firstFail = gates.find((g) => g.refuses && !g.ok)
  allowed = !firstFail
  reason = firstFail?.refuses ?? null
  // A night fill runs the gate as Guarded, which drops "market open" alone.
  // Whether one could happen now is a stronger claim than the board's, so the
  // two price rows count here too: a price too old or too wide for an order
  // stops a night fill as surely as a held one, and a mark for the page to
  // say "may fill" beside would be a promise the program then refuses.
  const nightStop = (g: GateRow) =>
    g === marketOpen ? null : g.refuses && !g.ok ? g.refuses : g === priceFresh && g.ok === false ? 'MarkStale' : g === precise && g.ok === false ? 'MarkTooWide' : null
  const nightReason = night ? (gates.map(nightStop).find((r) => r !== null) ?? null) : null

  const view = (): SymbolView => {
    const v = {
      listing,
      allowed,
      reason,
      gates,
      attestationAge: age,
      nextChangeAt: Number(state.nextChangeAt),
      openNow: state.openNow,
      // A mark at the program's 200bps ceiling is a $200 quote that moved its
      // pool by 2% or more — a withdrawn wrapper's empty pool quotes IWMx at
      // several times IWM's price. That is a fact about the pool, not a price
      // for the security, so the tile does not show it as one.
      priceUsd:
        mark && mark.pxNum > 0n && mark.confBps < LIMITS.MAX_CONF_BPS ? Number(mark.pxNum) / 1e6 : null,
      registered: true,
      halt: state.halt,
      markRateQ64: mark && mark.observedAt > 0n && mark.rateQ64 > 0n ? mark.rateQ64 : null,
      markPx: mark && mark.observedAt > 0n && mark.pxNum > 0n ? { num: mark.pxNum, expo: mark.pxExpo } : null,
      multiplierBits: risk.multiplierBits,
      changeAt:
        risk.pendingMultiplierBits !== 0n && Number(risk.activatesAt) > now ? Number(risk.activatesAt) : 0,
      markHeld: !!mark && markHeld(mark),
      checked: check !== null,
      refGap: band.gap,
      nightReason,
    }
    return { ...v, status: statusOf(v) }
  }

  if (!simulate) return view()

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
    // The simulation answers for the gate alone: `assert_tradeable` reads no
    // mark and no check. When it says the gate is open, the fill's own rows
    // still decide whether an order placed now settles, and the badge says
    // what an order would meet, not only what the gate says.
    const fillFail = verdict.allowed ? gates.find((g) => g.fill && g.refuses && !g.ok) : undefined
    allowed = verdict.allowed && !fillFail
    reason = verdict.allowed ? (fillFail?.refuses ?? null) : verdict.reason
  } catch {
    // A simulation that cannot run is not permission to trade.
    allowed = false
    reason = 'unavailable'
  }

  return view()
}

/**
 * The board when the chain cannot be read: every symbol refused. A red panel
 * above tiles still reading "tradeable" from the last good poll is the board
 * disagreeing with itself — and the tiles are what gets believed.
 */
export const offline = (views: SymbolView[]): SymbolView[] =>
  views.map((v) => ({ ...v, allowed: false, reason: 'unavailable', status: 'offline' as const }))

const NY = 'America/New_York'
const nyClock = new Intl.DateTimeFormat('en-US', { timeZone: NY, hour: 'numeric', minute: '2-digit', second: '2-digit' })
const nyTime = new Intl.DateTimeFormat('en-US', { timeZone: NY, hour: 'numeric', minute: '2-digit' })
const nyDay = new Intl.DateTimeFormat('en-CA', { timeZone: NY, year: 'numeric', month: '2-digit', day: '2-digit' })
const nyWeekday = new Intl.DateTimeFormat('en-US', { timeZone: NY, weekday: 'short' })
const nyDate = new Intl.DateTimeFormat('en-US', { timeZone: NY, weekday: 'short', month: 'short', day: 'numeric' })

/**
 * A moment as New York wall-clock time, to the second. Everything the page
 * timestamps sits beside the New York clock, so it reads in the same zone.
 */
export const nyClockOf = (d: Date) => `${nyClock.format(d)} ET`

/**
 * "9:30 AM" today, "Thu 9:30 AM" within six days either way, "Mon, Oct 5 9:30
 * AM" beyond — all New York time. Either way, because a receipt is in the past:
 * a fill three weeks ago read as a bare "Wed" when only the future was measured.
 */
function nyWhen(at: number, now: number): string {
  const d = new Date(at * 1000)
  if (nyDay.format(d) === nyDay.format(new Date(now * 1000))) return nyTime.format(d)
  return `${(Math.abs(at - now) < 6 * 86_400 ? nyWeekday : nyDate).format(d)} ${nyTime.format(d)}`
}

/**
 * The New York day of an instant, for a list of opens: "today", "Fri" this
 * week, "Thu Oct 1" beyond. Taking the time off `nyWhenOf` instead left an
 * empty entry for today's open and a stray comma in "Thu, Oct 1".
 */
export function nyDayOf(at: number, now: number = Math.floor(Date.now() / 1000)): string {
  const d = new Date(at * 1000)
  if (nyDay.format(d) === nyDay.format(new Date(now * 1000))) return 'today'
  return Math.abs(at - now) < 6 * 86_400 ? nyWeekday.format(d) : nyDate.format(d).replace(',', '')
}

/**
 * A future instant for the page's own text — the bell on the queue button, a
 * scheduled corporate action, an order's expiry — in New York time and
 * labelled, so it cannot disagree with the clock above it for a viewer
 * elsewhere. They used to be the viewer's local time, unlabelled.
 */
export const nyWhenOf = (at: number) => `${nyWhen(at, Math.floor(Date.now() / 1000))} ET`

/** "42s", "7m", "2h 5m", "2d 17h". */
function span(s: number): string {
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ${m % 60}m`
  return `${Math.floor(h / 24)}d ${h % 24}h`
}

export interface MarketLine {
  /** New York wall-clock time, to the second. */
  time: string
  /**
   * The US session as attested, or null when no attestation can vouch for it
   * or its scheduled change is due and not yet attested.
   */
  state: 'open' | 'closed' | 'halted' | null
  /** When that changes, or why it is stopped; null when not known. */
  when: string | null
  /** The instant of that change, so the page can also say it in the viewer's own zone. */
  at: number | null
}

/**
 * Whether a symbol's attestation speaks for the US session: read, fresh, and
 * not stopped for a reason that is about this one security or its issuer. A
 * market-wide circuit breaker is the one halt that is about the whole market.
 */
const speaksForSession = (v: SymbolView) =>
  v.registered &&
  v.status !== 'offline' &&
  v.status !== 'loading' &&
  v.attestationAge !== null &&
  v.attestationAge <= MAX_STATE_AGE_SECONDS &&
  (v.halt === HaltState.None || v.halt === HaltState.MarketWide)

/**
 * The New York clock, and the US session as the board's attestations state it.
 *
 * Only the attested state, never a calendar kept by the page: a second source
 * of market hours here would be a second answer to disagree with the gate.
 * Read from the first listing (SPYx) whenever its attestation can vouch for
 * the session, and otherwise from the next one that can — every listing is a
 * US security on the same regular session, and a wrapper its issuer has
 * stopped says nothing about the market. When none can, the line says nothing
 * about the market at all.
 */
export function marketLine(views: readonly SymbolView[], nowMs: number): MarketLine {
  const now = Math.floor(nowMs / 1000)
  const line: MarketLine = { time: nyClock.format(new Date(nowMs)), state: null, when: null, at: null }
  const v = views.find(speaksForSession)
  if (!v) return line
  if (v.halt === HaltState.MarketWide) return { ...line, state: 'halted', when: 'market-wide circuit breaker' }

  const state = v.openNow ? 'open' : 'closed'
  const next = v.nextChangeAt
  if (next <= 0) return { ...line, state }
  // The scheduled change has passed but the attestation saying so has not
  // landed yet; the keeper re-attests within a minute. The line names neither
  // state: the old one is no longer true of the market, and the new one is not
  // yet what the gate answers from, so it says only that the change is due.
  if (now >= next) {
    return { ...line, when: `the ${nyTime.format(new Date(next * 1000))} ${v.openNow ? 'close' : 'open'} is due; awaiting its attestation` }
  }
  return { ...line, state, at: next, when: `${v.openNow ? 'closes' : 'opens'} ${nyWhen(next, now)}, in ${span(next - now)}` }
}

/**
 * The same instant in the viewer's own time zone, when that is not New York:
 * "2:30 PM your time" beside "9:30 AM" for someone in Lagos, with the weekday
 * when the local date differs from New York's. Null in New York, or anywhere
 * the clock reads the same, where it would only repeat itself. Browser only:
 * the server's zone is not the viewer's.
 */
export function localWhenOf(at: number): string | null {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
  if (!zone || zone === NY) return null
  const d = new Date(at * 1000)
  const local = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' }).format(d)
  if (local === nyTime.format(d)) return null
  const localDay = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(d)
  const day = localDay === nyDay.format(d) ? '' : `${new Intl.DateTimeFormat('en-US', { weekday: 'short' }).format(d)} `
  return `${day}${local} your time`
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
  const live = checksLiveOf(accounts)
  return Promise.all(
    ALLOWLIST.map((l) =>
      loadSymbol(conn, l, payer, Mode.Strict, accounts.get(l.symbol), l.symbol === focus, live),
    ),
  )
}

/**
 * Whether the program on this cluster runs the second check: whether any
 * symbol has one. Only `open_check` on the upgraded program can create one,
 * so none anywhere means the program before it, whose fills read none.
 */
export const checksLiveOf = (symbols: ReadonlyMap<string, Pick<SymbolAccounts, 'check'>>) =>
  [...symbols.values()].some((a) => !!a.check)

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

/**
 * One owner's sell orders. Throws on failure, for the reason `loadOrders`
 * does: a sale's approval covers every sale from the same stock account, and a
 * failed read taken for "none" would approve only the new one and defund the rest.
 */
export async function loadSellOrders(conn: Connection, owner: PublicKey): Promise<SellOrder[]> {
  return readSellOrders(conn, owner)
}

/** One of the wallet's stock accounts, as the board read it. */
export interface Holding {
  symbol: string
  /** The account: the wallet's associated Token-2022 account for the stock. */
  account: PublicKey
  /** Shares, raw × the multiplier in force ÷ 10^decimals. */
  shares: number
  /** Raw units, which is what an order counts and what "max" starts from. */
  raw: bigint
  decimals: number
  /** Who may move this stock by approval, and how much: a sell's funding. */
  delegate: PublicKey | null
  delegatedAmount: bigint
}

/** What the connected wallet holds, read in the same round trip as the board. */
export interface WalletView {
  sol: number
  /** Demo-USDC in raw units; null when the wallet has no quote account yet. */
  quote: bigint | null
  delegate: PublicKey | null
  delegatedAmount: bigint
  /**
   * Every stock account the wallet has, including empty ones. An empty account
   * can still carry an approval to BELL, and "Revoke all funding" has to find
   * it; what the page lists as held is the ones with a balance.
   */
  holdings: Holding[]
  /**
   * The wallet's consent to night fills, read as the program reads it (its
   * account, this program's, naming this wallet), or null when it has none.
   */
  night: NightOptIn | null
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
  // The wallet, its quote account, then per symbol its stock account and the
  // mint (for decimals — read from the chain rather than assumed per issuer).
  const stockAccounts = wallet ? ALLOWLIST.map((l) => ataFor(wallet, new PublicKey(l.mint), TOKEN_2022)) : []
  // Last, the wallet's night opt-in address, read whether or not anything is
  // there: an empty address is the answer "off", in the same round trip.
  const extra = wallet
    ? [
        wallet,
        ataFor(wallet, quoteMint),
        ...ALLOWLIST.flatMap((l, i) => [stockAccounts[i]!, new PublicKey(l.mint)]),
        nightPda(wallet),
      ]
    : []
  const { symbols, extras } = await readBoard(conn, ALLOWLIST, extra)
  const live = checksLiveOf(symbols)
  const views = await Promise.all(
    ALLOWLIST.map((l) =>
      loadSymbol(conn, l, null, Mode.Strict, symbols.get(l.symbol), l.symbol === focus, live),
    ),
  )
  if (!wallet) return { views, wallet: null }
  const [sys, ata, ...rest] = extras
  const perSymbol = rest.slice(0, ALLOWLIST.length * 2)
  const nightAccount = rest[ALLOWLIST.length * 2]
  const token = ata ? decodeTokenAccount(ata.data) : null

  // Shares, not raw units: raw × the scaled-UI multiplier ÷ 10^decimals. A
  // scaled mint's raw balance is not a share count, which is the whole reason
  // gate 4 exists — so the page does the conversion the mint defines. The raw
  // figures ride along, because a sale is placed and approved in them.
  const holdings: Holding[] = []
  ALLOWLIST.forEach((l, i) => {
    const acct = perSymbol[i * 2]
    const mint = perSymbol[i * 2 + 1]
    const risk = symbols.get(l.symbol)?.risk
    if (!acct || !mint || !risk) return
    const t = decodeTokenAccount(acct.data)
    const decimals = mint.data[44]
    holdings.push({
      symbol: l.symbol,
      account: stockAccounts[i]!,
      shares: (Number(t.amount) / 10 ** decimals) * multiplierOf(risk.multiplierBits),
      raw: t.amount,
      decimals,
      delegate: t.delegate,
      delegatedAmount: t.delegatedAmount,
    })
  })

  return {
    views,
    wallet: {
      sol: (sys?.lamports ?? 0) / 1e9,
      quote: token ? token.amount : null,
      delegate: token?.delegate ?? null,
      delegatedAmount: token?.delegatedAmount ?? 0n,
      holdings,
      night: nightAccount && nightConsent(nightAccount, wallet) ? decodeNightOptIn(nightAccount.data) : null,
    },
  }
}

/**
 * The wallet's night opt-in, read on its own, fresh. Throws on failure, as
 * `loadOrders` does: the toggle decides which instruction to send from this,
 * and a failed read taken for "off" would send an opt-in that already exists.
 */
export async function loadNightOptIn(conn: Connection, owner: PublicKey): Promise<NightOptIn | null> {
  return readNightOptIn(conn, owner)
}

/**
 * The verdict line for a symbol: the refusal in words, told apart by what
 * kind of stopped it is. `MarketClosed` alone covers a shut market, an
 * exchange halt and an issuer withdrawal, and only one of those is the market
 * being closed.
 */
export function explainView(v: SymbolView): string {
  switch (v.status) {
    case 'closed':
      return 'The regular session is closed. An order parks and fills at the opening bell.'
    case 'halted':
      return `Halted on its primary exchange (${HALT_NAMES[v.halt] ?? 'halted'}). Nothing trades until it resumes.`
    case 'withdrawn':
      return `The issuer has withdrawn this token. That is the issuer's stop, not a halt of ${v.listing.underlying}, and BELL refuses it as a withdrawal.`
    case 'suspended':
      return 'Trading in this security has stopped, and no reason has been published.'
    default:
      return explain(v.reason)
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
    case 'RiskStale':
      return "Nobody has re-read this token's issuer settings recently enough to trust them."
    case 'MarkTooWide':
      return 'The price is attested less precisely than this order accepts, so it waits for a tighter one.'
    case 'AlreadyClosed':
      return 'That order is already closed — filled, or tidied up after its funding was revoked.'
    case 'InstructionFallbackNotFound':
      return 'The program on this cluster does not have that instruction yet; it arrives with its next upgrade. Nothing landed.'
    case 'MarkPaused':
      return `The price jumped more than the ${MAX_MARK_STEP_BPS}bps a minute the program allows, so the circuit breaker holds the last price and nothing fills on it. The next price within the step releases it, and after ${bound(MAX_MARK_STEP_AGE_SECONDS)} any new price does.`
    case 'CheckStale':
      // Three of `admit`'s refusals share this code: the check's own age, the
      // age of the sale behind it, and no sale at all. A checker that reports
      // every minute over a weekend still meets the second one at night.
      return `The second source, a separate key with its own price feed, cannot vouch for now: it has not reported in the last ${bound(MAX_CHECK_AGE_SECONDS)}, or the last sale it saw is older than a fill accepts (${bound(MAX_SESSION_REF_AGE_SECONDS)} in session, ${bound(MAX_NIGHT_REF_AGE_SECONDS)} at night). Nothing fills until it can.`
    case 'CheckerDisagrees':
      return 'The two sources disagree about whether the market is open, so nothing fills until they agree.'
    case 'MarkOffReference':
      return `The pool's price is further from the exchange's last sale than a fill allows (${MAX_SESSION_GAP_BPS}bps in session, ${MAX_NIGHT_GAP_BPS}bps at night), so nothing fills until the two converge.`
    case 'AccountNotInitialized':
      return "This symbol's second check has not been opened on chain yet, and the program refuses every fill of it until it is."
    case 'AccountNotEnoughKeys':
      return 'The fill left out the second check, as a filler built for the older program does, and the program refuses it before anything moves.'
    case 'NotAuthority':
      return "Only the program's upgrade authority may open a symbol's check."
    case 'NotChecker':
      return 'Only the checker named for this symbol may report its check.'
    case 'SelfCross':
      return "A wallet's buy cannot be crossed with its own sale."
    case 'unavailable':
      return 'Cannot reach the chain or the program right now — and that is not permission to trade.'
    case 'NotRegistered':
      return 'This symbol is not set up on chain yet.'
    default:
      return reason ? `Refused: ${reason}` : ''
  }
}

/**
 * Which side of a fill a wallet was on. A buy row is a purchase and a sell
 * row a sale; a cross is both, the buyer's purchase and the seller's sale in
 * one transaction, so it is the side the wallet was named on. A cross never
 * names one wallet twice: the program refuses a wallet crossing itself.
 */
export function fillSide(f: Pick<TapeRow, 'direction' | 'seller'>, me: string): 'bought' | 'sold' {
  if (f.direction === 'cross') return f.seller === me ? 'sold' : 'bought'
  return f.direction === 'sell' ? 'sold' : 'bought'
}

export { Mode }
