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
import { reconcile, HaltState, type Verdict } from '../policy/reconcile.ts'
import { ixPushSession, readSymbolState, send } from './client.ts'

/**
 * The cluster's idea of the current time, which is what the program compares
 * an attestation against.
 */
export async function clusterTime(conn: Connection): Promise<number> {
  const slot = await conn.getSlot()
  const t = await conn.getBlockTime(slot)
  return t ?? Math.floor(Date.now() / 1000)
}

/** Everything the loop needs, gathered once per tick. */
export interface Observation {
  at: Date
  xstocks: Map<string, XStock>
  pyth: Map<string, PythSession>
  halts: Map<string, Halt>
  backpack: {
    sessions: SessionWindow[]
    holidays: HolidayWindow[]
    /** Asset -> that security's own session names. */
    supported: Map<string, string[]>
  }
}

export async function sense(): Promise<Observation> {
  // Only the allowlisted Backed names, not all 928: nine small reads instead of
  // thirteen pages, which keeps a tick well clear of the refresh threshold.
  const backedSymbols = ALLOWLIST.filter((l) => l.issuer === 'backed').map((l) => l.symbol)
  const [assets, pyth, halts, sessions, holidays, securities] = await Promise.all([
    Promise.all(backedSymbols.map((s) => fetchAsset(s))),
    fetchEquitySessions(),
    fetchHalts(),
    fetchSessions(),
    fetchHolidays(),
    fetchSecurities(),
  ])
  return {
    at: new Date(),
    xstocks: new Map(
      assets.filter((x): x is XStock => x !== null).map((x) => [x.mint, x]),
    ),
    pyth,
    halts,
    backpack: {
      sessions,
      holidays,
      supported: new Map(
        securities.map((s) => [s.asset, (s.sessions ?? []).map((x) => x.name)]),
      ),
    },
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

  return ALLOWLIST.map((listing) => {
    const feed = obs.pyth.get(listing.underlying)
    const halt = obs.halts.get(listing.underlying)
    const exchangeHalt =
      halt && isActive(halt, nowSeconds)
        ? { kind: halt.kind as HaltState, resumesAt: halt.resumesAt }
        : null

    let issuer = null
    if (listing.issuer === 'backed') {
      const x = obs.xstocks.get(listing.mint)
      if (x) {
        issuer = {
          openNow: x.openNow,
          issuerHalted: x.halted,
          nextChangeAt: x.nextChangeAt,
        }
      }
    } else {
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

    return {
      listing,
      verdict: reconcile({
        pyth: feed
          ? { isOpen: feed.isOpen, nextOpen: feed.nextOpen, nextClose: feed.nextClose }
          : null,
        issuer,
        exchangeHalt,
      }),
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

export interface TickResult {
  at: Date
  decisions: Decision[]
  pushed: string[]
  signature: string | null
  dryRun: boolean
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
}): Promise<TickResult> {
  const { conn, attestor } = args
  const refreshBefore = args.refreshBefore ?? 60
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

  const ixs = []
  const pushed: string[] = []

  for (const d of decisions) {
    const state = await readSymbolState(conn, d.listing.symbol)
    if (!needsPush(state, d.verdict, nowSeconds, refreshBefore)) continue
    ixs.push(
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

  let signature: string | null = null
  if (ixs.length > 0 && !dryRun) {
    signature = await send(conn, ixs, [attestor])
  }

  return { at: obs.at, decisions, pushed, signature, dryRun }
}

export { HaltState }
export type { Verdict, PublicKey }
