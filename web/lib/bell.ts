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
  MAX_MARK_AGE_SECONDS,
  MAX_RISK_AGE_SECONDS,
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
/**
 * No automatic retry on 429. web3.js otherwise sleeps and retries a
 * rate-limited request with backoff, silently, for as long as it takes — so a
 * throttled poll overlapped the next one and the page piled requests onto the
 * endpoint that was already refusing it. A failed poll is shown as one, and
 * the next poll is the retry.
 */
export const connection = () =>
  new Connection(RPC_URL, { commitment: 'confirmed', disableRetryOnRateLimit: true })

/** A devnet explorer link for a signature, so every claim on the page can be checked. */
export const explorerTx = (sig: string) =>
  `https://explorer.solana.com/tx/${sig}${RPC_URL.includes('devnet') ? '?cluster=devnet' : ''}`

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
  /** Null for "in between": a price that is due to be replaced, not a failure. */
  ok: boolean | null
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
              ? `the issuer has withdrawn this token — ${listing.underlying} itself is not halted`
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
      priceUsd: mark && mark.pxNum > 0n ? Number(mark.pxNum) / 1e6 : null,
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
      return `The issuer has withdrawn this token; ${v.listing.underlying} itself is not halted. BELL refuses it as a withdrawal, not an exchange halt.`
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
      return 'The price sources disagree by more than this order accepts, so it waits for them to agree.'
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
