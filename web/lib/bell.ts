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
import { ataFor, decodeTokenAccount, TOKEN_2022 } from '../../src/chain/spl.ts'
import {
  LIMITS,
  MAX_MARK_AGE_SECONDS,
  MAX_RISK_AGE_SECONDS,
  MAX_STATE_AGE_SECONDS,
  Mode,
  multiplierOf,
  PROGRAM_ID,
  REBASE_GUARD_SECONDS,
  RebaseKind,
  rebaseKindName,
  type BellOrder,
  type SymbolMark,
  type TokenRisk,
} from '../../src/chain/codec.ts'
import { ALLOWLIST, CLUSTER, type Issuer, type Listing } from '../../src/config.ts'
import { confCap } from '../../src/policy/order.ts'
import { HaltState } from '../../src/policy/reconcile.ts'

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
   * fail, such as who can move the token out of their wallet. A disclosure
   * never carries `refuses`, so it never votes on the verdict.
   */
  ok: boolean | null | 'disclosure'
  detail: string
  /**
   * The `BellError` this row stands for in `check_tradeable`, or absent when the
   * row is informational. Only rows with a code decide the board's verdict:
   * "price fresh" gates a *fill*, not `assert_tradeable`, and letting it vote
   * made the board say "closed" for a symbol the program calls tradeable.
   */
  refuses?: string
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
  /** The multiplier in force, as the last mint read recorded it. */
  multiplierBits: bigint | null
  /** When a scheduled multiplier change lands, if one is still ahead; else 0. */
  changeAt: number
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
 * all nine listings (README, verified against the mainnet accounts), and the
 * mainnet mint fixtures the program tests parse carry the same two.
 */
const ISSUER_DELEGATE: Record<Issuer, { name: string; key: string }> = {
  backed: { name: 'Backed', key: '5aMNNLQJwAEeoemTEMkv5NVjqKwvvefRYCQ5Z67HFvEq' },
  backpack: { name: 'Backpack', key: '2cVYpagTt7ZGc3mmTXBa7fAznUtx5DUu6aCq8uVDaf4a' },
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
  const whose =
    CLUSTER === 'devnet'
      ? onChain === DEVNET_DEPLOY_KEY
        ? `On this devnet mirror that is BELL's own deploy key; on the real mint it is ${issuer.name}'s ${shortKey(issuer.key)}.`
        : `It is not the key this devnet mirror was made with.`
      : onChain === issuer.key
        ? `It is ${issuer.name}'s key.`
        : `It is not ${issuer.name}'s known key, ${shortKey(issuer.key)}.`
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
  return mark.confBps <= cap
    ? { label, ok: true, detail: `attested to within ${mark.confBps}bps; an order here accepts up to ${cap}bps` }
    : {
        label,
        ok: false,
        detail: `attested only to within ${mark.confBps}bps — wider than the ${cap}bps an order here accepts, so a fill waits`,
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
      status: 'unlisted',
      gates: [{ label: 'registered', ok: false, detail: 'this symbol is not set up on chain' }],
      attestationAge: null,
      nextChangeAt: 0,
      openNow: false,
      priceUsd: null,
      registered: false,
      halt: HaltState.None,
      markRateQ64: null,
      multiplierBits: null,
      changeAt: 0,
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
    {
      label: 'market open',
      refuses: 'MarketClosed',
      ok: state.openNow,
      detail: state.openNow
        ? 'primary market is trading'
        : 'primary market is closed — queue it for the bell',
    },
    {
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
    },
    precisionRow(listing, mark),
    delegateRow(listing, risk),
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
      multiplierBits: risk.multiplierBits,
      changeAt:
        risk.pendingMultiplierBits !== 0n && Number(risk.activatesAt) > now ? Number(risk.activatesAt) : 0,
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
    allowed = verdict.allowed
    reason = verdict.reason
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

/** "9:30 AM" today, "Thu 9:30 AM" this week, "Mon, Oct 5 9:30 AM" beyond — all New York time. */
function nyWhen(at: number, now: number): string {
  const d = new Date(at * 1000)
  if (nyDay.format(d) === nyDay.format(new Date(now * 1000))) return nyTime.format(d)
  return `${(at - now < 6 * 86_400 ? nyWeekday : nyDate).format(d)} ${nyTime.format(d)}`
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
  const line: MarketLine = { time: nyClock.format(new Date(nowMs)), state: null, when: null }
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
  return { ...line, state, when: `${v.openNow ? 'closes' : 'opens'} ${nyWhen(next, now)}, in ${span(next - now)}` }
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
  /** Securities the wallet holds, in shares — what a fill leaves behind. */
  holdings: { symbol: string; shares: number }[]
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
  const extra = wallet
    ? [
        wallet,
        ataFor(wallet, quoteMint),
        ...ALLOWLIST.flatMap((l) => [ataFor(wallet, new PublicKey(l.mint), TOKEN_2022), new PublicKey(l.mint)]),
      ]
    : []
  const { symbols, extras } = await readBoard(conn, ALLOWLIST, extra)
  const views = await Promise.all(
    ALLOWLIST.map((l) =>
      loadSymbol(conn, l, null, Mode.Strict, symbols.get(l.symbol), l.symbol === focus),
    ),
  )
  if (!wallet) return { views, wallet: null }
  const [sys, ata, ...perSymbol] = extras
  const token = ata ? decodeTokenAccount(ata.data) : null

  // Shares, not raw units: raw × the scaled-UI multiplier ÷ 10^decimals. A
  // scaled mint's raw balance is not a share count, which is the whole reason
  // gate 4 exists — so the page does the conversion the mint defines.
  const holdings: { symbol: string; shares: number }[] = []
  ALLOWLIST.forEach((l, i) => {
    const acct = perSymbol[i * 2]
    const mint = perSymbol[i * 2 + 1]
    const risk = symbols.get(l.symbol)?.risk
    if (!acct || !mint || !risk) return
    const raw = decodeTokenAccount(acct.data).amount
    if (raw === 0n) return
    const decimals = mint.data[44]
    holdings.push({
      symbol: l.symbol,
      shares: (Number(raw) / 10 ** decimals) * multiplierOf(risk.multiplierBits),
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
    },
  }
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
      return 'The primary market is closed. An order parks and fills at the opening bell.'
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
    case 'unavailable':
      return 'Cannot reach the chain or the program right now — and that is not permission to trade.'
    case 'NotRegistered':
      return 'This symbol is not set up on chain yet.'
    default:
      return reason ? `Refused: ${reason}` : ''
  }
}

export { Mode }
