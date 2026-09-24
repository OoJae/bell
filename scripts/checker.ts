/**
 * Run the checker: the program's second signer.
 *
 *   node scripts/checker.ts                     # dry run, every BELL_CHECKER_INTERVAL_MS (60s)
 *   node scripts/checker.ts --once              # one dry pass, then exit
 *   BELL_CHECKER_ARM=1 node scripts/checker.ts  # sign and push each symbol's check (every 45s)
 *   BELL_CHECKER_ARM=1 node scripts/checker.ts --dry   # the armed environment, still dry
 *
 * A process that is not the keeper, holding a key that is not the attestor's,
 * reading sources the keeper does not (Nasdaq, with Yahoo behind it, and the
 * local NYSE calendar). Every fill and every cross on chain needs its check to
 * agree with the keeper: the same session, and a mark within a band of the
 * checker's reference price. So the keeper alone can no longer open a market
 * or set the price a fill settles at.
 *
 * Armed, each pass pushes `push_check` for every registered symbol whose check
 * has been opened (`scripts/open-checks.ts`) naming this key:
 *
 * - open_now: the calendar says open AND Nasdaq says regular session.
 *   Pre-market and after-hours are closed.
 * - ref_rate_q64: the underlying's last sale, converted with the symbol's
 *   on-chain TokenRisk multiplier and its mint's decimals into the mark's
 *   convention (stock raw per quote raw, Q64.64), so the program compares the
 *   two directly.
 * - ref_px_num / ref_px_expo: the same price in dollars, for people.
 * - ref_at: when that sale printed. observed_at: when the checker looked, and
 *   never later than the cluster's clock, which the program judges it by.
 *
 * A symbol whose reading is missing, unparsed, stale in session, or has no
 * opinion about the session is pushed nothing that pass (`usableReading`).
 * Its check then ages out after MAX_CHECK_AGE_SECONDS and its fills stop,
 * which is the point: the checker never says what it cannot stand behind.
 *
 * Dry, which is the default, it holds no key and sends nothing. Each pass
 * prints what it would have pushed, next to what the keeper put on chain:
 *
 * - checker: its session verdict.
 * - keeper: the on-chain SymbolState and its age. Older than
 *   MAX_STATE_AGE_SECONDS reads as `stale`, because the program treats it as
 *   closed.
 * - ref: the underlying's last sale, which source gave it, and its age.
 * - mark: the on-chain SymbolMark price, its age and its confidence.
 * - |mark-ref|: the gap in basis points of the reference.
 *
 * and, under it, each symbol's push: the check it would carry, whether it can
 * be sent (no checker yet, another checker, a reading it will not stand
 * behind), and the gap measured the program's way, by rate, beside the same
 * gap by price, with the mark's own price converted to check the two share a
 * convention.
 *
 * What |mark-ref| measures: the keeper's executable price for a $200 buy,
 * against the last trade the source reported. So it includes the pool's spread
 * and price impact, the seconds between the two timestamps, and USDC against
 * USD. It does not say which of the two is right. The program's band is
 * MAX_SESSION_GAP_BPS in session and MAX_NIGHT_GAP_BPS at night.
 *
 * Runs in the keeper's image (Dockerfile.keeper copies src/ and scripts/) with
 * start command `node scripts/checker.ts`. It needs BELL_CLUSTER and
 * BELL_RPC_URL, which that image sets. Armed it also needs its key:
 * BELL_KEY_CHECKER (the key file's JSON array), or a file at
 * BELL_CHECKER_KEYPAIR (default `.checker.json`), and SOL on it for fees.
 */
import { PublicKey, SYSVAR_CLOCK_PUBKEY, type Keypair } from '@solana/web3.js'
import { connect, ixPushCheck, readAccounts, readBoard, rpcUrl, send, type SymbolAccounts } from '../src/chain/client.ts'
import {
  MAX_MARK_AGE_SECONDS,
  MAX_SESSION_REF_AGE_SECONDS,
  MAX_STATE_AGE_SECONDS,
  MarkSource,
  multiplierOf,
  rateQ64,
  type SymbolMark,
} from '../src/chain/codec.ts'
import { packInstructions, txBytes } from '../src/chain/keeper.ts'
import { loadKeypair } from '../src/chain/keys.ts'
import { ALLOWLIST, CLUSTER } from '../src/config.ts'
import { isRegularOpen } from '../src/policy/calendar.ts'
import { HaltState } from '../src/policy/reconcile.ts'
import { readReferences, usableReading, type Quote, type Reading } from '../src/sensor/nasdaq.ts'

/**
 * A row counts toward the band only when both prices describe the same moment
 * of a live session: the checker says open, the mark could still settle a fill
 * and the reference is recent. Nasdaq prints to the minute, so three minutes
 * is two whole minutes of slack past its resolution.
 */
const MAX_REF_AGE_S = 180

const haltName = (h: number) => Object.entries(HaltState).find(([, v]) => v === h)?.[0] ?? String(h)
const markSourceName = (s: number) => Object.entries(MarkSource).find(([, v]) => v === s)?.[0] ?? String(s)
const short = (k: PublicKey) => `${k.toBase58().slice(0, 4)}…${k.toBase58().slice(-4)}`

/** 45 → "45s", 192 → "3m12s", 7500 → "2h05m". */
export function ageText(seconds: number): string {
  const s = Math.round(seconds)
  if (s < 0) return `${s}s`
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`
  if (s < 86_400) return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`
  return `${Math.floor(s / 86_400)}d`
}

// ------------------------------------------------------------------- the push
//
// Pure: a reading and the symbol's accounts in, the check to push (or why
// not) out. Exported for the tests, which hold it to the program's rules.

/** The arguments of one `push_check`, as `ixPushCheck` takes them less the signer. */
export interface PushArgs {
  symbol: string
  openNow: boolean
  refRateQ64: bigint
  refPxNum: bigint
  refPxExpo: number
  refAt: bigint
  observedAt: bigint
}

export interface CheckPlan {
  symbol: string
  /**
   * What a push would carry, whenever the reading supports one. Present even
   * when it cannot be sent (no check opened yet, another key's check), so a
   * dry run can still show the reference beside the mark.
   */
  push: PushArgs | null
  /** Why nothing is sent for this symbol this pass; null when it is sent. */
  skip: string | null
  /** The last sale behind the push, for the log. */
  quote: Quote | null
}

/**
 * `ref_rate_q64` for a last sale of `price` dollars a share: stock raw per
 * quote raw in Q64.64, the multiplier folded in. The keeper's mark is built
 * with the same function (`markFromQuote`), which is what makes the program's
 * `|mark - ref|` a comparison of like with like.
 */
export function referenceRate(price: number, multiplier: number, stockDecimals: number, quoteDecimals: number): bigint {
  return rateQ64({ pricePerShare: price, multiplier, quoteDecimals, stockDecimals })
}

/**
 * The check this pass would push for one symbol, or why it pushes none.
 *
 * The reading decides whether there is anything to say (`usableReading`); the
 * chain decides whether this key may say it: the symbol has to be registered,
 * its check opened, and opened naming this key, which must not be the
 * attestor's. `checker` is null in a dry run with no key, and then only the
 * first two are asked.
 */
export function planCheck(args: {
  symbol: string
  reading: Reading | undefined
  accounts: SymbolAccounts | undefined
  stockDecimals: number | undefined
  quoteDecimals: number | undefined
  checker: PublicKey | null
  /** Unix seconds: the earlier of when the readings were taken and the cluster's clock. */
  observedAt: number
  /** When the readings were taken. */
  at: Date
}): CheckPlan {
  const { symbol, accounts } = args
  const none = (skip: string, quote: Quote | null = null): CheckPlan => ({ symbol, push: null, skip, quote })
  if (!accounts?.state) return none('not registered on this cluster')
  const usable = usableReading(args.reading, args.at, MAX_SESSION_REF_AGE_SECONDS)
  if (!usable.ok) return none(usable.why, args.reading?.quote ?? null)
  const q = usable.quote
  if (!accounts.risk) return none('no TokenRisk on this cluster, so no multiplier to convert the price with', q)
  if (args.stockDecimals === undefined) return none('the mint could not be read, so no decimals to convert with', q)
  if (!accounts.mark) return none('no mark, so no quote asset to price the reference in', q)
  if (args.quoteDecimals === undefined) return none('the quote mint could not be read, so no decimals to convert with', q)
  // A sale dated after the observation is a clock read wrong somewhere, and
  // the program refuses it (BadParameters), which would fail the batch with it.
  const refAt = Math.floor(q.lastAt / 1000)
  if (refAt > args.observedAt) return none(`the last sale is dated ${refAt - args.observedAt}s after this observation`, q)
  const refRateQ64 = referenceRate(q.last, multiplierOf(accounts.risk.multiplierBits), args.stockDecimals, args.quoteDecimals)
  const push: PushArgs = {
    symbol,
    openNow: usable.openNow,
    refRateQ64,
    refPxNum: BigInt(Math.round(q.last * 1e6)),
    refPxExpo: -6,
    refAt: BigInt(refAt),
    observedAt: BigInt(args.observedAt),
  }
  const plan = (skip: string | null): CheckPlan => ({ symbol, push, skip, quote: q })
  const check = accounts.check
  if (!check) return plan('no checker yet (open_check has not run for this symbol)')
  if (args.checker) {
    if (accounts.state.attestor.equals(args.checker)) return plan("this key is the symbol's attestor; the checker must be another key")
    if (!check.checker.equals(args.checker)) return plan(`the check names ${short(check.checker)} as its checker, not this key`)
  }
  // The program ignores an observation older than the one on record; sending
  // it would pay for nothing.
  if (check.observedAt > push.observedAt) return plan('the check on record is newer than this observation')
  return plan(null)
}

/**
 * The reference against the on-chain mark, measured two ways, and the
 * convention the two share.
 *
 * - byRate: `|mark - ref| / ref` over the Q64.64 rates, in bps: exactly what
 *   the program compares with MAX_SESSION_GAP_BPS and MAX_NIGHT_GAP_BPS.
 * - byPrice: `|markPx - refPx| / refPx`, the `|mark-ref|` column above.
 * - expected: byPrice scaled by refPx / markPx. Rate is the inverse of price,
 *   so a rate gap measured against the reference is a price gap measured
 *   against the mark; the two agree when this equals byRate.
 * - convention: the mark's own price run through `referenceRate`, against the
 *   mark's own rate. Near zero means the checker's multiplier and decimals
 *   are the ones the keeper priced with.
 */
export function gapCheck(
  push: Pick<PushArgs, 'refRateQ64' | 'refPxNum' | 'refPxExpo'>,
  mark: Pick<SymbolMark, 'rateQ64' | 'pxNum' | 'pxExpo'>,
  multiplier: number,
  stockDecimals: number,
  quoteDecimals: number,
): { byRate: number; byPrice: number; expected: number; convention: number } | null {
  if (mark.rateQ64 <= 0n || mark.pxNum <= 0n || push.refRateQ64 <= 0n) return null
  const bps = (a: bigint, b: bigint) => Number(((a > b ? a - b : b - a) * 10_000_000_000n) / b) / 1_000_000
  const markPx = Number(mark.pxNum) * 10 ** mark.pxExpo
  const refPx = Number(push.refPxNum) * 10 ** push.refPxExpo
  const byPrice = (Math.abs(markPx - refPx) / refPx) * 10_000
  return {
    byRate: bps(mark.rateQ64, push.refRateQ64),
    byPrice,
    expected: (byPrice * refPx) / markPx,
    convention: bps(referenceRate(markPx, multiplier, stockDecimals, quoteDecimals), mark.rateQ64),
  }
}

// -------------------------------------------------------------------- the table

/**
 * A mark whose price stops moving while the market does. PFE's read $28.6744
 * then $28.6743 for over twenty minutes on 2026-09-24, with its observed_at
 * fresh every tick, so the age test above never catches it. It can be true (a
 * thin pool nobody arbitrages quotes the same fill) or a quote re-pushed; this
 * cannot tell which. Either way its gap is the pool's drift, not a spread, and
 * a band read off it would be read off that. Loop mode only: one pass has
 * nothing to compare with.
 *
 * Counted in keeper pushes (distinct observed_at), not in checker passes: a
 * checker faster than the keeper's 45 s tick sees the same push twice, and
 * that is not a price standing still.
 */
const UNMOVED_BPS = 1
const UNMOVED_PUSHES = 3
const lastMarks = new Map<string, { px: number; at: bigint; ref: number | null; pushes: number }>()

function unmoved(symbol: string, px: number, at: bigint, ref: number | null): string | null {
  const seen = lastMarks.get(symbol)
  if (!seen || (Math.abs(px - seen.px) / seen.px) * 10_000 >= UNMOVED_BPS) {
    lastMarks.set(symbol, { px, at, ref, pushes: 1 })
    return null
  }
  if (at !== seen.at) [seen.at, seen.pushes] = [at, seen.pushes + 1]
  if (seen.pushes < UNMOVED_PUSHES) return null
  const refMoved = ref !== null && seen.ref !== null ? `${((Math.abs(ref - seen.ref) / seen.ref) * 10_000).toFixed(1)}bps` : 'unknown'
  return `mark unmoved (<${UNMOVED_BPS}bps) over ${seen.pushes} keeper pushes; ref moved ${refMoved} meanwhile`
}

interface Row {
  symbol: string
  reading: Reading | undefined
  accounts: SymbolAccounts | undefined
  /** Absolute gap in bps, when both prices exist. */
  gapBps: number | null
  comparable: boolean
  line: string
}

function row(
  symbol: string,
  reading: Reading | undefined,
  accounts: SymbolAccounts | undefined,
  chainRead: boolean,
  nowS: number,
): Row {
  const cols: string[] = [symbol.padEnd(6)]
  const notesEarly: string[] = []

  cols.push((reading ? (reading.openNow ? 'open' : 'closed') : '?').padEnd(7))

  let keeperOpen: boolean | null = null
  let keeperStale = false
  let keeper: string
  const state = accounts?.state
  if (!chainRead) keeper = 'unread'
  else if (!state) keeper = 'none'
  else if (state.observedAt === 0n) keeper = 'never'
  else {
    const age = nowS - Number(state.observedAt)
    // The program refuses a state this old, so it is closed whatever it says.
    keeperStale = age >= MAX_STATE_AGE_SECONDS
    keeperOpen = !keeperStale && state.openNow
    const said = keeperStale ? 'stale' : state.openNow ? 'open' : 'closed'
    keeper = `${said} ${ageText(age)}`
  }
  cols.push(keeper.padEnd(12))

  const q = reading?.quote ?? null
  const refAge = q ? nowS - q.lastAt / 1000 : null
  // A last sale from before the bell, read in the first minutes of the
  // session, is recent but is a pre-market print. Nasdaq's time is the start
  // of the print's minute, so a 09:30 print still counts.
  const refInSession = q ? isRegularOpen(new Date(q.lastAt)) === true : false
  cols.push(q ? `$${q.last.toFixed(4)} ${q.source} ${ageText(refAge!)}`.padEnd(26) : 'no reference'.padEnd(26))

  const mark = accounts?.mark
  let markPx: number | null = null
  let markAge: number | null = null
  let markStale = false
  if (mark && mark.observedAt > 0n && mark.pxNum > 0n) {
    markPx = Number(mark.pxNum) * 10 ** mark.pxExpo
    markAge = nowS - Number(mark.observedAt)
    markStale = markAge > MAX_MARK_AGE_SECONDS
    const still = markStale ? null : unmoved(symbol, markPx, mark.observedAt, q?.last ?? null)
    if (still) notesEarly.push(still)
    cols.push(
      `$${markPx.toFixed(4)} ${ageText(markAge)} ${mark.confBps}bps ${markSourceName(mark.source)}`.padEnd(34),
    )
  } else cols.push((chainRead ? 'no mark' : 'unread').padEnd(34))

  let gapBps: number | null = null
  if (q && markPx !== null) {
    gapBps = (Math.abs(markPx - q.last) / q.last) * 10_000
    cols.push(`${gapBps.toFixed(1)}bps ${markPx >= q.last ? 'over' : 'under'}`)
  } else cols.push('-')

  const comparable =
    gapBps !== null &&
    reading?.openNow === true &&
    markAge !== null &&
    markAge <= MAX_MARK_AGE_SECONDS &&
    refAge !== null &&
    refAge <= MAX_REF_AGE_S &&
    refInSession

  const notes: string[] = [...notesEarly]
  // A keeper that stopped refreshing is not a session disagreement: that is
  // the keeper down, not the two of them reading the market differently.
  if (keeperStale) notes.push('keeper stale: the program reads it as closed')
  // Nor is a halt. The checker judges only whether the market is in its
  // regular session; a symbol the keeper closed for a halt or an issuer's
  // withdrawal is closed for a reason this checker does not read.
  else if (keeperOpen !== null && state!.halt !== HaltState.None) {
    notes.push(`keeper halt=${haltName(state!.halt)}, which the checker does not judge`)
  }
  // The disagreement that matters: when the two session verdicts differ, the
  // on-chain check closes the symbol.
  else if (reading && keeperOpen !== null && keeperOpen !== reading.openNow) {
    notes.push(`DISAGREE: checker ${reading.openNow ? 'open' : 'closed'} (${reading.why})`)
  }
  if (reading && !reading.openNow && keeperOpen === null) notes.push(reading.why)
  // Said so the gap beside it is not read as a price the keeper would fill at.
  if (markStale) notes.push('mark stale: no fill settles at it, gap left out of the band')
  if (reading?.openNow && q && !refInSession) notes.push('ref printed before the session, left out of the band')
  // Said of when it was read, not of the print: outside the session Nasdaq's
  // last sale can be an extended-hours trade, and Yahoo's is the close.
  if (q && q.session && q.session !== 'regular') notes.push(`ref read outside the regular session (${q.session})`)
  if (reading?.errors.length) notes.push(reading.errors.join('; '))

  return {
    symbol,
    reading,
    accounts,
    gapBps,
    comparable,
    line: `  ${cols.join(' ')}${notes.length ? `  [${notes.join(' | ')}]` : ''}`,
  }
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

// --------------------------------------------------------------------- the pass

/** Decimals never change, so each mint is read once per process: the stocks' and the quote asset's. */
const decimalsCache = new Map<string, number>()

/** One pass. Armed (`key` given) it pushes, and throws when a push failed, so the watchdog sees it. */
async function once(key: Keypair | null) {
  const now = new Date()
  const conn = connect()
  // Two issuers can list the same underlying; ask Nasdaq once for it.
  const underlyings = [...new Set(ALLOWLIST.map((l) => l.underlying))]
  const stockMints = ALLOWLIST.map((l) => new PublicKey(l.mint)).filter((m) => !decimalsCache.has(m.toBase58()))

  // The references first, then the chain. The cluster's clock rides in the
  // board's request (with each stock mint the first time), so it is read
  // after every sale the references report: Nasdaq dates a sale to the start
  // of its minute, and a clock read before the answer arrived could be
  // earlier than a sale printed while it was on its way, which the program
  // refuses (a reference later than its observation). A chain that will not
  // answer still leaves the checker's own verdicts on the page.
  const pass = await readReferences(underlyings, now)
  const board = await readBoard(conn, ALLOWLIST, [SYSVAR_CLOCK_PUBKEY, ...stockMints]).then(
    (b) => ({ ok: true as const, ...b }),
    (e: Error) => ({ ok: false as const, error: e.message }),
  )
  const nowS = Date.now() / 1000

  let clusterS: number | null = null
  if (board.ok) {
    const clock = board.extras[0]
    if (clock) clusterS = Number(new DataView(clock.data.buffer, clock.data.byteOffset).getBigInt64(32, true))
    stockMints.forEach((m, i) => {
      const d = board.extras[1 + i]?.data
      if (d && d.length >= 82) decimalsCache.set(m.toBase58(), d[44])
    })
    // The quote asset each mark is priced in, read once. Byte 44 of an SPL
    // mint is its decimals, as for the stock.
    const quoteMints = [
      ...new Map(
        [...board.symbols.values()].flatMap((a) => (a.mark ? [[a.mark.quoteMint.toBase58(), a.mark.quoteMint] as const] : [])),
      ).values(),
    ].filter((m) => !decimalsCache.has(m.toBase58()))
    if (quoteMints.length > 0) {
      const infos = await readAccounts(conn, quoteMints).catch(() => [])
      quoteMints.forEach((m, i) => {
        const d = infos[i]?.data
        if (d && d.length >= 82) decimalsCache.set(m.toBase58(), d[44])
      })
    }
  }
  // Attested in the cluster's time frame, never ahead of it: the program
  // refuses an observation in its future, and our clock only has to run a
  // second fast for that. The instant is when the readings were in hand.
  const observedAt = Math.min(Math.floor(nowS), clusterS ?? Number.POSITIVE_INFINITY)

  const market = pass.market ? `${pass.market.session ?? 'unrecognised'} ("${pass.market.label}")` : 'UNREAD'
  const calendar = pass.calendarOpen === null ? 'no opinion' : pass.calendarOpen ? 'open' : 'closed'
  const mode = key ? `ARMED as ${key.publicKey.toBase58()}` : 'DRY RUN, holds no key, writes nothing'
  console.log(`\n[${now.toISOString().slice(11, 19)}] checker ${mode}`)
  console.log(`  calendar=${calendar}  nasdaq market-info=${market}`)
  if (pass.marketError) console.log(`  market-info failed: ${pass.marketError}`)
  if (!board.ok) console.log(`  chain UNREAD: ${board.error}`)
  console.log(
    `  ${'symbol'.padEnd(6)} ${'checker'.padEnd(7)} ${'keeper'.padEnd(12)} ${'ref (source, age)'.padEnd(26)} ` +
      `${'mark (age, conf, source)'.padEnd(34)} |mark-ref|`,
  )

  const rows = ALLOWLIST.map((l) =>
    row(l.symbol, pass.readings.get(l.underlying), board.ok ? board.symbols.get(l.symbol) : undefined, board.ok, nowS),
  )
  for (const r of rows) console.log(r.line)

  const used = rows.filter((r) => r.comparable).map((r) => r.gapBps!)
  const fallbacks = rows.filter((r) => r.reading?.quote?.source === 'yahoo').map((r) => r.symbol)
  // Yahoo can also be where the session came from while the price is still
  // Nasdaq's, and a verdict resting on Yahoo's trading periods should say so.
  const yahooSession = rows.filter((r) => r.reading?.sessionFrom === 'yahoo').map((r) => r.symbol)
  if (used.length) {
    console.log(
      `  band: |mark-ref| over ${used.length} comparable rows: max ${Math.max(...used).toFixed(1)}bps, ` +
        `median ${median(used).toFixed(1)}bps (checker open, mark <=${MAX_MARK_AGE_SECONDS}s, ` +
        `ref <=${MAX_REF_AGE_S}s and printed in the session)`,
    )
  } else console.log('  band: no comparable rows this pass (needs checker open, a fresh mark and a recent reference)')
  if (fallbacks.length) console.log(`  yahoo stood in for: ${fallbacks.join(', ')}`)
  if (yahooSession.length) console.log(`  session from yahoo for: ${yahooSession.join(', ')}`)

  // ------------------------------------------------------------ the pushes
  if (!board.ok || clusterS === null) {
    // Without the chain there is no clock to date a push by and no check to
    // push to. Armed, that is a failed pass, so the watchdog counts it.
    console.log('  push_check: nothing, the chain was not read')
    if (key) throw new Error(`chain unread, nothing pushed: ${board.ok ? 'no clock' : board.error}`)
    return
  }
  const plans = ALLOWLIST.map((l) => {
    const accounts = board.symbols.get(l.symbol)
    return {
      listing: l,
      accounts,
      plan: planCheck({
        symbol: l.symbol,
        reading: pass.readings.get(l.underlying),
        accounts,
        stockDecimals: decimalsCache.get(l.mint),
        quoteDecimals: accounts?.mark ? decimalsCache.get(accounts.mark.quoteMint.toBase58()) : undefined,
        checker: key?.publicKey ?? null,
        observedAt,
        at: now,
      }),
    }
  })
  const sendable = plans.filter((p) => p.plan.push && !p.plan.skip)
  // Measured, as the keeper packs its marks: one push_check adds about 100
  // bytes, so fourteen take two transactions under the 1,232-byte limit.
  const signer = key?.publicKey ?? PublicKey.default
  const ixs = sendable.map((p) => ixPushCheck({ checker: signer, ...p.plan.push! }))
  const batches = packInstructions(ixs, signer)
  const sizes = batches.map((b) => txBytes(b, signer)).join(' + ')
  console.log(
    `  push_check: ${key ? 'pushing' : 'would push'} ${sendable.length} of ${plans.length}` +
      `${batches.length ? ` in ${batches.length} transaction(s), ${sizes} bytes` : ''} (observed_at ${observedAt}, cluster ${clusterS})`,
  )
  for (const { listing, accounts, plan } of plans) {
    const cols = [`  ${plan.symbol.padEnd(6)}`]
    const p = plan.push
    if (p) {
      const px = Number(p.refPxNum) * 10 ** p.refPxExpo
      cols.push(`${p.openNow ? 'open  ' : 'closed'} ref $${px.toFixed(4)} ${plan.quote?.source ?? ''} ${ageText(observedAt - Number(p.refAt))} old`)
      const mark = accounts?.mark
      const decimals = decimalsCache.get(listing.mint)
      const quoteDecimals = mark ? decimalsCache.get(mark.quoteMint.toBase58()) : undefined
      if (mark && accounts?.risk && decimals !== undefined && quoteDecimals !== undefined && mark.observedAt > 0n) {
        const g = gapCheck(p, mark, multiplierOf(accounts.risk.multiplierBits), decimals, quoteDecimals)
        if (g) {
          cols.push(
            `| mark-ref by rate ${g.byRate.toFixed(2)}bps, by price ${g.byPrice.toFixed(2)}bps ` +
              `(x ref/mark = ${g.expected.toFixed(2)}, residual ${Math.abs(g.byRate - g.expected).toFixed(3)}) ` +
              `| mark's own price converts to its rate within ${g.convention.toFixed(3)}bps`,
          )
        }
      }
    }
    if (plan.skip) cols.push(`${p ? '| ' : ''}NOT PUSHED: ${plan.skip}`)
    console.log(cols.join(' '))
  }

  if (!key || batches.length === 0) return
  // Every batch is sent even when an earlier one failed, so one bad batch
  // costs only its own symbols; the pass then fails, as the keeper's does.
  let failure: Error | null = null
  let at = 0
  for (const batch of batches) {
    const names = sendable.slice(at, at + batch.length).map((p) => p.listing.symbol)
    at += batch.length
    try {
      const sig = await send(conn, batch, [key])
      console.log(`  pushed ${names.join(', ')}  sig=${sig}`)
    } catch (e) {
      failure = failure ?? (e as Error)
      console.log(`  push FAILED for ${names.join(', ')}: ${(e as Error).message.split('\n')[0]}`)
    }
  }
  if (failure) throw failure
}

if (import.meta.main) {
  /**
   * Each pass asks Nasdaq ten times, so a cadence typo is not harmless: "60s"
   * is NaN, and NaN or 0 makes the loop below spin as fast as Nasdaq answers,
   * which is how an IP gets blocked. A bad value refuses to start rather than
   * guessing.
   */
  const MIN_INTERVAL_MS = 15_000
  const msFromEnv = (name: string, fallback: number, min: number): number => {
    const raw = process.env[name]
    const n = raw === undefined || raw === '' ? fallback : Number(raw)
    if (!Number.isFinite(n) || n < min) {
      console.error(`${name}=${raw} is not a number of milliseconds >= ${min}. Refusing.`)
      process.exit(1)
    }
    return n
  }
  const ONCE = process.argv.includes('--once')
  // Dry unless asked twice, the keeper's rule: a process that writes to a
  // chain should never do so because someone forgot a flag. `--dry` wins over
  // the environment, so an armed deployment can be run by hand without writing.
  const armed = process.env.BELL_CHECKER_ARM === '1' && !process.argv.includes('--dry')
  // Armed, a check lives MAX_CHECK_AGE_SECONDS (120 s), and 45 s gives each
  // one two more chances to land before it ages out; the keeper's cadence.
  const INTERVAL_MS = msFromEnv('BELL_CHECKER_INTERVAL_MS', armed ? 45_000 : 60_000, MIN_INTERVAL_MS)
  /**
   * Exit if no pass has finished for this long, so the restart policy brings
   * the checker back. Every fetch has a timeout, but a hang somewhere else
   * would leave Railway showing a running service that has stopped checking
   * anything, and armed, every check would quietly age out. It must outlast a
   * pass, or a healthy checker would restart itself forever.
   */
  const WATCHDOG_MS = msFromEnv('BELL_CHECKER_WATCHDOG_MS', Math.max(300_000, INTERVAL_MS + 60_000), INTERVAL_MS + 60_000)

  // The host only, never the full URL: a keyed RPC carries its key in the query.
  const rpcHost = (() => {
    try {
      return new URL(rpcUrl()).host
    } catch {
      return 'unparseable BELL_RPC_URL'
    }
  })()
  console.log(`checker on ${CLUSTER} via ${rpcHost}, ${ALLOWLIST.length} listings`)

  let key: Keypair | null = null
  if (armed) {
    // The file, else BELL_KEY_CHECKER (keys.ts). Refused, not ignored: someone
    // who armed this expects a signer, and one that quietly stayed dry would
    // let them believe the venue has one.
    try {
      key = loadKeypair(process.env.BELL_CHECKER_KEYPAIR ?? '.checker.json')
    } catch (e) {
      console.error(`BELL_CHECKER_ARM=1 but no checker key: ${(e as Error).message} Refusing.`)
      process.exit(1)
    }
    const lamports = await connect().getBalance(key.publicKey).catch(() => null)
    if (lamports === 0) {
      console.error(`checker ${key.publicKey.toBase58()} holds no SOL to pay for its pushes. Fund it, then start again. Refusing.`)
      process.exit(1)
    }
    console.log(`checker ARMED as ${key.publicKey.toBase58()}${lamports === null ? '' : `, ${lamports / 1e9} SOL for fees`}`)
  }

  if (ONCE) {
    try {
      await once(key)
    } catch (e) {
      console.error('pass failed:', (e as Error).message)
      process.exitCode = 1
    }
  } else {
    console.log(`checker every ${INTERVAL_MS / 1000}s, ctrl-c to stop`)
    let lastOk = Date.now()
    setInterval(() => {
      if (Date.now() - lastOk > WATCHDOG_MS) {
        console.error(`watchdog: no finished pass for ${Math.round((Date.now() - lastOk) / 1000)}s, exiting to be restarted`)
        process.exit(1)
      }
    }, 15_000).unref()
    for (;;) {
      const started = Date.now()
      try {
        await once(key)
        lastOk = Date.now()
      } catch (e) {
        // A failed pass pushed nothing, or not everything. Say so and try
        // again: an unpushed check ages out on its own, which closes its
        // symbol, and the watchdog is for the pass that never comes back.
        console.error('  pass failed:', (e as Error).message)
      }
      // The interval is the cadence, not the gap, as in the keeper.
      await new Promise((r) => setTimeout(r, Math.max(0, INTERVAL_MS - (Date.now() - started))))
    }
  }
}
