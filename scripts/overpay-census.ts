/**
 * The overpay census: what real wallets paid for the listed stocks when they
 * bought outside the regular session, against the next regular-session open.
 *
 *   node scripts/overpay-census.ts [out.json]
 *   node scripts/overpay-census.ts --from out.json   (figures again, no RPC)
 *
 * Read-only, mainnet, and gentle: it stops at a fixed number of RPC calls
 * (CENSUS_BUDGET, default 600), sends at most two at a time, and at most nine
 * of any one method in ten seconds (see `httpRpc`).
 *
 * **How it samples, and why.** The busy mints cannot be walked. On 24 September
 * SPYx's latest 1,000 signatures covered 72 seconds, so a week would be some
 * eight thousand pages. Instead the census picks instants spread evenly over
 * the week's outside-session hours, finds a block at each (`getBlock`, which
 * returns its signatures), and asks each mint for its signatures just before
 * that block's first: `before` accepts any signature and resolves it to its
 * slot. From each of those pages it reads a few transactions, spread across the
 * page. Mints quiet enough that one page of 1,000 covers the whole week are
 * sampled from that page instead.
 *
 * What it therefore measures, and what it does not:
 * - A sample of transactions at chosen instants, weighted by time, not by
 *   volume. It is not every buy, and a busy hour counts no more than a quiet one.
 * - Buys whose signer's own balance of a listed stock rose while its USDC fell,
 *   and nothing else it holds moved. A pool's vault shows the same pattern when
 *   someone sells into it, and never signs, so signers only. A market maker
 *   filling a customer's sale on a quote venue does sign, and pays the fee; its
 *   leg is the customer's sale, not a buy, so it is left out too (`maker` in
 *   `buysIn`). Buys paid in SOL or anything else are not seen.
 * - Many of the signers are bots. The census reports how concentrated the
 *   buys are so that is visible rather than hidden.
 * - Only outside-session buys whose next open Nasdaq has already recorded,
 *   which during a session means opens up to yesterday's.
 *
 * Env: BELL_MAINNET_RPC (default the public endpoint), CENSUS_DAYS (7),
 * CENSUS_TARGETS (12 instants), CENSUS_PER_PAGE (5 transactions per mint per
 * instant), CENSUS_QUIET (25 per quiet mint), CENSUS_BUDGET (600 calls),
 * CENSUS_MIN_USD (1: smaller buys are counted as dust and left out of the
 * figures, since a $0.01 buy's price is mostly rounding).
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// Every listing, whatever cluster the environment names: this reads mainnet only.
import { LISTINGS } from '../src/listings.ts'
import {
  buysIn,
  createOpens,
  httpRpc,
  nyWall,
  priceBuy,
  quantile,
  RateLimited,
  readMints,
  readTransactions,
  sessionOf,
  withOpens,
  type Buy,
  type MainnetTx,
  type Rpc,
} from '../src/overpay.ts'

const RPC_URL = process.env.BELL_MAINNET_RPC ?? 'https://api.mainnet-beta.solana.com'
const env = (name: string, fallback: number) => Number(process.env[name] ?? fallback)
const DAYS = env('CENSUS_DAYS', 7)
const TARGETS = env('CENSUS_TARGETS', 12)
const PER_PAGE = env('CENSUS_PER_PAGE', 5)
const QUIET = env('CENSUS_QUIET', 25)
const BUDGET = env('CENSUS_BUDGET', 600)
const MIN_USD = env('CENSUS_MIN_USD', 1)
const OUT = process.argv[2] ?? join(tmpdir(), `overpay-census-${new Date().toISOString().slice(0, 10)}.json`)

let calls = 0
const byMethod: Record<string, number> = {}
const base = httpRpc(RPC_URL, {
  concurrency: 2,
  onCall: (m) => {
    calls++
    byMethod[m] = (byMethod[m] ?? 0) + 1
  },
})
// A spent budget stops the reading the way a rate limit does, keeping what was
// read, rather than marking every remaining transaction unreadable. Calls not
// yet sent count against it too, or two workers checking at 129 of 130 would
// both go ahead and spend 131.
let pending = 0
const rpc: Rpc = async (method, params) => {
  if (calls + pending >= BUDGET) throw new RateLimited(`call budget of ${BUDGET} spent`)
  pending++
  try {
    return await base(method, params)
  } finally {
    pending--
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const log = (...a: unknown[]) => console.error(...a)

interface Sig {
  signature: string
  err: unknown
  blockTime?: number | null
}

/** Up to `n` items spread evenly across a list, first and last included. */
function spread<T>(xs: readonly T[], n: number): T[] {
  if (xs.length <= n) return [...xs]
  return Array.from({ length: n }, (_, i) => xs[Math.round((i * (xs.length - 1)) / Math.max(1, n - 1))])
}

/** A block's time, trying the next few slots when one was skipped. */
async function blockNear(slot: number): Promise<{ slot: number; time: number; first: string } | null> {
  for (let s = slot; s < slot + 4; s++) {
    try {
      const b = (await rpc('getBlock', [
        s,
        { transactionDetails: 'signatures', rewards: false, maxSupportedTransactionVersion: 1, commitment: 'finalized' },
      ])) as { blockTime: number | null; signatures: string[] } | null
      if (b && b.blockTime && b.signatures.length) return { slot: s, time: b.blockTime, first: b.signatures[0] }
    } catch (e) {
      if (!/skipped|not available|missing/i.test((e as Error).message)) throw e
    }
    await sleep(300)
  }
  return null
}

async function timeOf(slot: number): Promise<{ slot: number; time: number }> {
  for (let s = slot; s < slot + 6; s++) {
    try {
      const t = (await rpc('getBlockTime', [s])) as number | null
      if (t) return { slot: s, time: t }
    } catch (e) {
      if (!/skipped|not available|missing/i.test((e as Error).message)) throw e
    }
  }
  throw new Error(`no block time near slot ${slot}`)
}

async function main() {
  const now = Math.floor(Date.now() / 1000)
  const start = now - DAYS * 86_400
  const today = nyWall(now).date
  // A day's row appears after its close; half an hour's grace before counting on it.
  const todayClosed = sessionOf(now).session === 'outside' && nyWall(now).minutes >= 16 * 60 + 30
  const recorded = (date: string | null) => date !== null && (date < today || (date === today && todayClosed))
  log(`census: ${DAYS} days to ${new Date(now * 1000).toISOString()}, budget ${BUDGET} calls`)

  const { scaled } = await readMints(rpc, LISTINGS)
  const stockMints = new Set(LISTINGS.map((l) => l.mainnetMint))
  const byMint = new Map(LISTINGS.map((l) => [l.mainnetMint, l]))

  // Slot ↔ time, measured rather than assumed: slots ran near 0.27s in
  // September 2026, not the 0.4s long quoted, so a fixed rate misses by days.
  const head = await timeOf((await rpc('getSlot', [{ commitment: 'finalized' }])) as number)
  let back = await timeOf(head.slot - Math.round((DAYS * 86_400) / 0.4))
  const rate = () => (head.time - back.time) / (head.slot - back.slot)
  if (back.time > start) back = await timeOf(head.slot - Math.round((head.time - start + 3_600) / rate()))
  const slotAt = (t: number) => Math.round(back.slot + (t - back.time) / rate())
  log(`slots: ${rate().toFixed(4)}s each over the window`)

  // The instants: every twenty minutes that is outside the session, at least
  // half an hour from either edge of it, and whose next open is already on
  // record; then an even spread of them. The margin is there because a page of
  // signatures reaches back a little way from its instant, and should not
  // reach back into a session.
  const outside = (t: number) => sessionOf(t).session === 'outside'
  const candidates: number[] = []
  for (let t = start + 600; t < now; t += 1_200) {
    if (outside(t) && outside(t - 1_800) && outside(t + 1_800) && recorded(sessionOf(t).nextOpenDate)) candidates.push(t)
  }
  const instants = spread(candidates, TARGETS)
  // A week-long average rate still misses a given instant by half an hour, so
  // each estimate is read once and corrected by what it missed by.
  const anchors: { at: number; slot: number; blockTime: number; first: string }[] = []
  for (const at of instants) {
    const probe = await timeOf(slotAt(at))
    const b = await blockNear(probe.slot + Math.round((at - probe.time) / rate()))
    if (b) anchors.push({ at, slot: b.slot, blockTime: b.time, first: b.first })
    await sleep(300)
  }
  log(`anchors: ${anchors.length} blocks, ${anchors.map((a) => nyWall(a.blockTime).label).join('; ')}`)

  // Which mints one page covers, and which need the anchors.
  const quiet = new Map<string, Sig[]>()
  for (const l of LISTINGS) {
    const page = (await rpc('getSignaturesForAddress', [l.mainnetMint, { limit: 1000 }])) as Sig[]
    const oldest = page.at(-1)?.blockTime ?? now
    if (page.length < 1000 || oldest < start) quiet.set(l.mainnetMint, page)
    await sleep(300)
  }

  // What to read, one list per page so a budget stop leaves the sample even.
  const lists: { label: string; sigs: string[] }[] = []
  for (const [mint, page] of quiet) {
    const pick = page.filter((s) => {
      if (s.err !== null && s.err !== undefined) return false
      if (!s.blockTime || s.blockTime < start) return false
      const v = sessionOf(s.blockTime)
      return v.session === 'outside' && recorded(v.nextOpenDate)
    })
    lists.push({ label: `${byMint.get(mint)!.symbol} (whole week)`, sigs: spread(pick, QUIET).map((s) => s.signature) })
  }
  for (const a of anchors) {
    for (const l of LISTINGS) {
      if (quiet.has(l.mainnetMint)) continue
      const page = (await rpc('getSignaturesForAddress', [l.mainnetMint, { limit: 100, before: a.first }])) as Sig[]
      const ok = page.filter((s) => (s.err === null || s.err === undefined) && s.blockTime && s.blockTime >= start)
      lists.push({ label: `${l.symbol} before ${nyWall(a.blockTime).label}`, sigs: spread(ok, PER_PAGE).map((s) => s.signature) })
      await sleep(250)
    }
  }
  // Round-robin across the lists, without repeats.
  const order: string[] = []
  const seen = new Set<string>()
  for (let i = 0; lists.some((x) => i < x.sigs.length); i++) {
    for (const x of lists) {
      const s = x.sigs[i]
      if (s && !seen.has(s)) {
        seen.add(s)
        order.push(s)
      }
    }
  }
  const room = Math.max(0, BUDGET - calls - 4)
  const toRead = order.slice(0, room)
  log(`reading ${toRead.length} of ${order.length} sampled transactions (${calls} calls so far)`)
  const { txs, unreadable, stopped } = await readTransactions(rpc, toRead, {
    workers: 2,
    deadline: Infinity,
    clock: Date.now,
  })

  let mixed = 0
  let unsigned = 0
  let makers = 0
  const legs: Buy[] = []
  for (const tx of txs as MainnetTx[]) {
    const found = buysIn(tx, stockMints)
    mixed += found.mixed
    for (const leg of found.buys) {
      if (!leg.signed) {
        unsigned++
        continue
      }
      if (leg.maker) {
        makers++
        continue
      }
      legs.push({ ...priceBuy(leg, byMint.get(leg.mint)!, scaled.get(leg.mint) ?? null), owner: leg.owner })
    }
  }
  const buys = await withOpens(legs, createOpens())

  const report: Census = {
    generatedAt: new Date().toISOString(),
    window: { from: new Date(start * 1000).toISOString(), to: new Date(now * 1000).toISOString(), days: DAYS },
    rpc: { calls, byMethod, budget: BUDGET },
    sampling: {
      instants: anchors.map((a) => ({ target: new Date(a.at * 1000).toISOString(), slot: a.slot, blockEt: nyWall(a.blockTime).label })),
      quietMints: [...quiet.keys()].map((m) => byMint.get(m)!.symbol),
      pages: lists.map((x) => ({ page: x.label, sampled: x.sigs.length })),
      sampled: order.length,
      read: txs.length,
      unreadable,
      stopped,
    },
    ...figures(buys, { unsigned, makers, mixed }),
    buys,
  }
  writeFileSync(OUT, JSON.stringify(report, null, 2))
  print(report, OUT)
}

// ------------------------------------------------------------------ figures

interface Census {
  generatedAt: string
  window: { from: string; to: string; days: number }
  rpc: { calls: number; byMethod: Record<string, number>; budget: number }
  sampling: {
    instants: { target: string; slot: number; blockEt: string }[]
    quietMints: string[]
    pages: { page: string; sampled: number }[]
    sampled: number
    read: number
    unreadable: number
    stopped: string | null
  }
  found: ReturnType<typeof figures>['found']
  aggregate: ReturnType<typeof figures>['aggregate']
  buys: Buy[]
}

const r1 = (x: number | null) => (x === null ? null : Math.round(x * 10) / 10)

function stats(xs: readonly Buy[]) {
  const g = xs.map((b) => b.gapBps!).sort((a, b) => a - b)
  const usd = xs.reduce((n, b) => n + b.usdcPaid, 0)
  return {
    buys: xs.length,
    wallets: new Set(xs.map((b) => b.owner)).size,
    usdc: Math.round(usd * 100) / 100,
    p25Bps: r1(quantile(g, 0.25)),
    medianBps: r1(quantile(g, 0.5)),
    p75Bps: r1(quantile(g, 0.75)),
    /** Each buy's gap weighted by the dollars it paid. */
    dollarWeightedBps: usd > 0 ? r1(xs.reduce((n, b) => n + b.gapBps! * b.usdcPaid, 0) / usd) : null,
    paidMoreShare: g.length ? Math.round((g.filter((x) => x > 0).length / g.length) * 1000) / 1000 : null,
  }
}

/**
 * The figures, over outside-session buys of at least MIN_USD with a recorded
 * open and a multiplier known to be right. The rest are counted, not dropped.
 */
function figures(buys: readonly Buy[], skipped: { unsigned: number; makers: number; mixed: number }) {
  const outside = buys.filter((b) => b.session === 'outside')
  const dust = outside.filter((b) => b.usdcPaid < MIN_USD)
  const inexact = outside.filter((b) => b.usdcPaid >= MIN_USD && b.gapBps !== null && !b.multiplierExact)
  const counted = outside.filter((b) => b.usdcPaid >= MIN_USD && b.gapBps !== null && b.multiplierExact)
  const group = (key: (b: Buy) => string) =>
    Object.fromEntries([...new Set(counted.map(key))].sort().map((k) => [k, stats(counted.filter((b) => key(b) === k))]))
  const perWallet = new Map<string, number>()
  for (const b of counted) perWallet.set(b.owner!, (perWallet.get(b.owner!) ?? 0) + 1)
  const busiest = Math.max(0, ...perWallet.values())
  return {
    found: {
      signedBuys: buys.length,
      regular: buys.filter((b) => b.session === 'regular').length,
      outside: outside.length,
      dustUnderMinUsd: dust.length,
      multiplierInexact: inexact.length,
      openNotYetRecorded: outside.filter((b) => b.nextOpen?.status === 'not yet recorded').length,
      openUnavailable: outside.filter((b) => b.nextOpen?.status === 'unavailable').length,
      unsignedOwnersSkipped: skipped.unsigned,
      makerLegsSkipped: skipped.makers,
      mixed: skipped.mixed,
      minUsd: MIN_USD,
    },
    aggregate: {
      ...stats(counted),
      busiestWalletShare: counted.length ? Math.round((busiest / counted.length) * 1000) / 1000 : null,
      byWindow: group((b) => b.window ?? 'none'),
      // By issuer because the pools differ so much: a $200 quote moved most
      // Ondo names by percents, where the deep xStocks moved by basis points.
      byIssuer: group((b) => ISSUER.get(b.symbol) ?? 'unknown'),
      bySymbol: group((b) => b.symbol),
    },
  }
}

const ISSUER = new Map(LISTINGS.map((l) => [l.symbol, l.issuer]))

function print(r: Census, path: string) {
  const { found: f, aggregate: a } = r
  const pct = (x: number | null) => (x === null ? 'n/a' : `${Math.round(x * 1000) / 10}%`)
  console.log(
    [
      `Overpay census, ${r.window.from.slice(0, 16)}Z to ${r.window.to.slice(0, 16)}Z (${r.window.days} days), mainnet`,
      `  RPC calls: ${r.rpc.calls} of ${r.rpc.budget} (${Object.entries(r.rpc.byMethod).map(([m, n]) => `${m} ${n}`).join(', ')})`,
      `  sampled ${r.sampling.sampled} transactions at ${r.sampling.instants.length} outside-session instants plus ${r.sampling.quietMints.length} quiet mints; read ${r.sampling.read}, unreadable ${r.sampling.unreadable}${r.sampling.stopped ? `, stopped: ${r.sampling.stopped}` : ''}`,
      `  signed USDC buys found: ${f.signedBuys} (${f.regular} in session, ${f.outside} outside); outside, ${f.dustUnderMinUsd} under $${f.minUsd} and ${f.multiplierInexact} with an inexact multiplier left out; ${f.mixed} mixed; ${f.unsignedOwnersSkipped} pool-side and ${f.makerLegsSkipped} market-maker legs skipped`,
      `  outside-session buys of $${f.minUsd}+ compared with the next open: ${a.buys} buys, ${a.wallets} wallets, $${a.usdc.toLocaleString()} paid`,
      `  gap vs next open: median ${a.medianBps} bps, quartiles ${a.p25Bps} / ${a.p75Bps} bps, dollar-weighted ${a.dollarWeightedBps} bps`,
      `  paid more than the open: ${pct(a.paidMoreShare)}; busiest wallet made ${pct(a.busiestWalletShare)} of the buys`,
      ...Object.entries(a.byWindow).map(([k, s]) => `    ${k}: ${s.buys} buys, median ${s.medianBps} bps, ${pct(s.paidMoreShare)} paid more`),
      ...Object.entries(a.byIssuer).map(([k, s]) => `    ${k}: ${s.buys} buys, ${s.wallets} wallets, median ${s.medianBps} bps, quartiles ${s.p25Bps} / ${s.p75Bps}, ${pct(s.paidMoreShare)} paid more, $${s.usdc.toLocaleString()}`),
      ...Object.entries(a.bySymbol).map(([k, s]) => `    ${k}: ${s.buys} buys, ${s.wallets} wallets, median ${s.medianBps} bps`),
      `  JSON: ${path}`,
    ].join('\n'),
  )
}

/**
 * `--from <census.json>`: the figures again from a saved run's buys, with no
 * RPC call at all, for when the rule for what counts changes after a run.
 */
if (process.argv[2] === '--from') {
  const path = process.argv[3]
  const saved = JSON.parse(readFileSync(path, 'utf8')) as Census
  const again: Census = {
    ...saved,
    ...figures(saved.buys, {
      unsigned: saved.found.unsignedOwnersSkipped,
      // A run saved before makers were told apart counted none.
      makers: saved.found.makerLegsSkipped ?? 0,
      mixed: saved.found.mixed,
    }),
  }
  writeFileSync(path, JSON.stringify(again, null, 2))
  print(again, path)
} else {
  await main()
}
