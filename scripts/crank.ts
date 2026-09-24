/**
 * The filler.
 *
 *   node scripts/crank.ts            # report what it would do
 *   BELL_ARM=1 node scripts/crank.ts # settle due orders
 *   BELL_GC=1                        # also close expired / unfunded orders (rent to their owners)
 *
 * The cross first, then buys, then sells, in one pass. While the market is in
 * session, a due buy and a due sell of the same symbol from two different
 * owners settle against each other at the mark (`cross_orders`), with no
 * filler between them, when the pair meets both orders' minimum fill. The
 * orders are all-or-nothing by default, so a pair crosses only when one side
 * can take the other whole; `queue.ts --partial` places one that can be taken
 * in parts. Whatever the cross leaves goes to the fills.
 *
 * A sell is the same queue with its legs swapped: the filler pays quote from
 * its own account and the program takes the user's stock by delegation, priced
 * by the same mark and refused by the same gate. The sell loop runs after the
 * buy loop and changes nothing it does, so a book with no sells settles exactly
 * as it did before sells existed.
 *
 * While the primary market is shut an order waits for the bell, unless its
 * owner has opted in to night fills (`queue.ts night on`). Then it fills only
 * when the second signer's check agrees the market is closed, the sale behind
 * its reference is under twelve hours old, and the mark sits within
 * MAX_NIGHT_GAP_BPS of that reference; and the filler delivers at least what
 * the reference itself says, on top of the order's own band.
 *
 * Deliberately not privileged: it re-runs the identical on-chain gate that
 * refused the trade in the first place, and it is paid by the spread rather
 * than by a tip. Anyone can run this, which is the point — the venue does not
 * depend on our server. We happen to run it every five minutes as a Railway
 * cron job, so "filled at the opening bell" is true without anyone at a
 * keyboard; delete that service and nothing else changes.
 *
 * Built to be run unattended: one pass, a watchdog so it can never hang (a
 * cron run still active makes every later run skip), every order in its own
 * try/catch so one rate-limited read cannot end the pass for everybody, and
 * everything knowable is read in one round trip so orders that are certainly
 * refused are never simulated at all.
 *
 * On localnet it settles from inventory conjured at genesis. On devnet from
 * the filler's associated accounts, minted from mirror mints we control. On
 * mainnet the same loop would swap through Jupiter in its own transaction
 * first, which is why the program never needs to CPI a router.
 *
 * The planning below the imports is exported and pure, so the tests can hold
 * it to the program's rules; the pass itself runs only when this file is run.
 */
import { PublicKey, SYSVAR_CLOCK_PUBKEY, type Keypair } from '@solana/web3.js'
import {
  authPda,
  connect,
  errorName,
  ixCancelOrder,
  ixCancelSellOrder,
  ixCrossOrders,
  ixFillOrder,
  ixFillSellOrder,
  ixRefreshTokenRisk,
  nightPda,
  readBoard,
  readOrders,
  readSellOrders,
  send,
  simulate,
  TOKEN_PROGRAM,
  TOKEN_2022,
  type SymbolAccounts,
} from '../src/chain/client.ts'
import {
  buyMinOut,
  checkRefusal,
  crossAmounts,
  decodeOrdersCrossedEvent,
  fairOut,
  markHeld,
  MAX_CHECK_AGE_SECONDS,
  MAX_MARK_AGE_SECONDS,
  MAX_MARK_STEP_AGE_SECONDS,
  MAX_MARK_STEP_BPS,
  MAX_NIGHT_GAP_BPS,
  MAX_NIGHT_REF_AGE_SECONDS,
  MAX_SESSION_GAP_BPS,
  MAX_SESSION_REF_AGE_SECONDS,
  MAX_STATE_AGE_SECONDS,
  mulShr64Ceil,
  multiplierOf,
  nightConsent,
  sellBandOut,
  sellMinOut,
  stockToQuoteCeil,
  type BellOrder,
  type OrdersCrossedEvent,
  type SellOrder,
  type SymbolCheck,
  type SymbolMark,
} from '../src/chain/codec.ts'
import { loadKeypair } from '../src/chain/keys.ts'
import { ataFor, decodeTokenAccount } from '../src/chain/spl.ts'
import { CLUSTER } from '../src/config.ts'
import { minutesAfterBell, notify, type NotifyEvent } from '../src/notify.ts'

// ------------------------------------------------------------------ planning
//
// Pure: accounts in, a decision out. Each mirrors a rule of the program's so
// that an order the program would certainly refuse is named here, with the
// program's own numbers, instead of being simulated to find out.

/** 45 → "45s", 192 → "3m12s", 7500 → "2h05m". */
export function ageText(seconds: number): string {
  const s = Math.round(seconds)
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`
  if (s < 86_400) return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`
  return `${Math.floor(s / 86_400)}d`
}

/** How far `rate` sits from `ref`, in bps of `ref`: the program's own measure for MarkOffReference. */
export const gapBps = (rate: bigint, ref: bigint): number =>
  ref > 0n ? Number(((rate > ref ? rate - ref : ref - rate) * 1_000_000n) / ref) / 100 : Number.POSITIVE_INFINITY

/**
 * Why the second signer's check would refuse a fill now, in words, or null
 * when it would not. The program's order (`checkRefusal`, which mirrors
 * `admit`), with the numbers that decided it: which clock is stale and by how
 * much, who says which session, how far the mark is from the reference.
 *
 * `night` is a night fill: the market shut and the owner opted in. A cross is
 * never one. A symbol with no check at all is "no checker yet": the upgraded
 * program refuses its fills until `open_check` has run.
 */
export function checkBlocker(args: {
  check: SymbolCheck | null | undefined
  markRateQ64: bigint
  night: boolean
  now: number
}): string | null {
  const { check, markRateQ64, night } = args
  const now = BigInt(args.now)
  const why = checkRefusal({ check: check ?? null, markRateQ64, night, now })
  if (why === null) return null
  if (!check || why === 'AccountNotInitialized') {
    return 'no checker yet — open_check has not run for this symbol, and the upgraded program refuses its fills until it has (AccountNotInitialized)'
  }
  if (why === 'CheckerDisagrees') {
    return night
      ? 'the keeper says closed but the checker says the market is open, so no night fill (CheckerDisagrees)'
      : 'the keeper says open but the checker says the market is closed (CheckerDisagrees)'
  }
  if (why === 'MarkOffReference') {
    const band = night ? MAX_NIGHT_GAP_BPS : MAX_SESSION_GAP_BPS
    const px = Number(check.refPxNum) * 10 ** check.refPxExpo
    return (
      `the mark is ${gapBps(markRateQ64, check.refRateQ64).toFixed(1)} bps from the checker's reference ` +
      `($${px.toFixed(4)}), outside the ${band} bps ${night ? 'night' : 'session'} band (MarkOffReference)`
    )
  }
  // CheckStale, which the program uses for three different faults.
  if (check.observedAt === 0n) return 'the checker has never pushed for this symbol (CheckStale)'
  const pushed = Number(now - check.observedAt)
  if (pushed > MAX_CHECK_AGE_SECONDS) {
    return `the checker's last push is ${ageText(pushed)} old, over the ${MAX_CHECK_AGE_SECONDS}s limit; is the checker running? (CheckStale)`
  }
  if (check.refRateQ64 <= 0n) return 'the checker has pushed no reference price (CheckStale)'
  const limit = night ? MAX_NIGHT_REF_AGE_SECONDS : MAX_SESSION_REF_AGE_SECONDS
  return (
    `the sale behind the checker's reference is ${ageText(Number(now - check.refAt))} old, ` +
    `over the ${ageText(limit)} ${night ? 'night' : 'session'} limit (CheckStale)`
  )
}

/** What a held mark means, said the same way wherever it stops an order. */
export const PAUSED_LINE =
  `waiting — PAUSED (circuit breaker): the price mark is held (MarkPaused); it clears when a keeper push lands ` +
  `within ${MAX_MARK_STEP_BPS / 100}% a minute of the held price, or once that price is ${MAX_MARK_STEP_AGE_SECONDS}s old`

/**
 * A refusal's name, and for the ones the checker and the breaker brought, what
 * it means. Every other name prints exactly as it did.
 */
const REFUSALS: Readonly<Record<string, string>> = {
  MarkPaused: `the price mark is held by the circuit breaker; it clears when a push lands within ${MAX_MARK_STEP_BPS / 100}% a minute of the held price, or once that price is ${MAX_MARK_STEP_AGE_SECONDS}s old`,
  CheckStale: "the checker's last push, or the sale behind its reference, is too old",
  CheckerDisagrees: 'the checker and the keeper disagree about whether the market is open',
  MarkOffReference: "the mark is too far from the checker's reference price",
  AccountNotInitialized: 'no checker yet: open_check has not run for this symbol',
  // The same "no checker yet", when someone has sent lamports to the check's
  // address before open_check: the account exists, but the system program's.
  AccountOwnedByWrongProgram: 'no checker yet: open_check has not run for this symbol (its address holds only lamports someone sent)',
  AccountNotEnoughKeys: 'the program wants more accounts than this client sends: update the client',
  InstructionFallbackNotFound: 'the deployed program does not have this instruction yet',
  SelfCross: 'a buy and a sell of the same owner never cross',
}
export const explainRefusal = (name: string): string => (REFUSALS[name] ? `${name} — ${REFUSALS[name]}` : name)

/** A simulation's refusal, named, and explained where the name alone would not say what to do. */
function refusalOf(err: unknown): string {
  const e = err as { InstructionError?: [number, { Custom?: number }] }
  const code = e.InstructionError?.[1]?.Custom
  return code !== undefined ? explainRefusal(errorName(code)) : JSON.stringify(err)
}

type Terms = Pick<BellOrder, 'maxSlipBps' | 'floorRateQ64'>

/**
 * What a buy of `leg` quote raw is owed, in stock raw: the band edge below
 * fair, or the owner's floor when their limit asks for more, or at night the
 * checker's reference minimum when that asks for more still. Each exactly as
 * `fill_order` computes it, since the filler delivers the larger and the
 * program refuses a unit less. `fair` and `floor` come back so the caller can
 * tell a limit below the market (floor over fair) from a fill.
 */
export function buyDeliver(
  leg: bigint,
  rate: bigint,
  o: Terms,
  nightRef: bigint | null,
): { fair: bigint; floor: bigint; deliver: bigint } {
  const fair = fairOut(leg, rate)
  const band = (fair * BigInt(10_000 - o.maxSlipBps)) / 10_000n
  const floor = fairOut(leg, o.floorRateQ64)
  // The reference minimum is the band formula again, over the checker's rate
  // with the night gap in place of the order's slippage (fill.rs).
  const byRef = nightRef === null ? 0n : buyMinOut(leg, nightRef, MAX_NIGHT_GAP_BPS, 0n)
  const deliver = [band, floor, byRef].reduce((a, b) => (b > a ? b : a))
  return { fair, floor, deliver }
}

/**
 * What a sell of `leg` stock raw is owed, in quote raw, as `fill_sell_order`
 * computes it: every step rounded up. The night reference minimum can sit one
 * quote raw above fair at the edge of the band (sell.rs says so), and the
 * filler then pays that unit.
 */
export function sellDeliver(
  leg: bigint,
  rate: bigint,
  o: Terms,
  nightRef: bigint | null,
): { fair: bigint; floor: bigint; deliver: bigint } {
  const fair = stockToQuoteCeil(leg, rate)
  const band = sellBandOut(leg, rate, o.maxSlipBps)
  const floor = mulShr64Ceil(leg, o.floorRateQ64)
  const byRef = nightRef === null ? 0n : sellMinOut(leg, nightRef, MAX_NIGHT_GAP_BPS, 0n)
  const deliver = [band, floor, byRef].reduce((a, b) => (b > a ? b : a))
  return { fair, floor, deliver }
}

/** Oldest first, by when the order was placed, then by nonce: the order the cross serves them in. */
export const oldestFirst = (a: BellOrder, b: BellOrder): number =>
  a.createdAt !== b.createdAt ? (a.createdAt < b.createdAt ? -1 : 1) : a.nonce < b.nonce ? -1 : a.nonce > b.nonce ? 1 : 0

/** One order's name in the book, buy and sell kept apart since they can share a nonce. */
export const orderKey = (side: 'buy' | 'sell', o: Pick<BellOrder, 'owner' | 'nonce'>): string =>
  `${side}:${o.owner.toBase58()}:${o.nonce}`
const pairKey = (b: BellOrder, s: SellOrder) => `${orderKey('buy', b)}|${orderKey('sell', s)}`

export interface CrossPlan {
  buy: BellOrder
  sell: SellOrder
  /** What the buyer pays and the seller receives, quote raw. */
  quote: bigint
  /** What the seller delivers and the buyer receives, stock raw. */
  stock: bigint
}

/**
 * The next pair to cross, or null when none can: the oldest buy against the
 * oldest sell it can cross with, skipping pairs already `tried`.
 *
 * Different owners only, since the program refuses a self cross before
 * anything else. The amounts are `crossAmounts`, cross.rs step for step, so a
 * pair is offered only when it meets both orders' minimum fill and both
 * floors at `rate`. The orders passed in are the caller's working copies:
 * their `filledIn` is what this pass has already crossed of them.
 */
export function nextCross(
  buys: readonly BellOrder[],
  sells: readonly SellOrder[],
  rate: bigint,
  tried: ReadonlySet<string> = new Set(),
): CrossPlan | null {
  const bs = [...buys].sort(oldestFirst)
  const ss = [...sells].sort(oldestFirst)
  for (const b of bs) {
    if (b.filledIn >= b.amountIn) continue
    for (const s of ss) {
      if (s.filledIn >= s.amountIn || s.owner.equals(b.owner) || tried.has(pairKey(b, s))) continue
      let c: ReturnType<typeof crossAmounts>
      try {
        c = crossAmounts(b, s, rate)
      } catch {
        continue // a product past u128: the program refuses it as MathOverflow
      }
      if (c.refused === null) return { buy: b, sell: s, quote: c.quote, stock: c.stock }
    }
  }
  return null
}

/**
 * Why no pair crossed, in a few words, counted by the program's reason: an
 * all-or-nothing order is FillTooSmall against any counterpart smaller than
 * itself, which is the usual answer.
 */
export function whyNoCross(buys: readonly BellOrder[], sells: readonly SellOrder[], rate: bigint): string {
  const reasons = new Map<string, number>()
  for (const b of buys) {
    if (b.filledIn >= b.amountIn) continue
    for (const s of sells) {
      if (s.filledIn >= s.amountIn) continue
      let why: string
      if (s.owner.equals(b.owner)) why = 'SelfCross'
      else {
        try {
          why = crossAmounts(b, s, rate).refused ?? 'crossable'
        } catch {
          why = 'MathOverflow'
        }
      }
      reasons.set(why, (reasons.get(why) ?? 0) + 1)
    }
  }
  if (reasons.size === 0) return 'nothing left to cross'
  const words: Record<string, string> = {
    FillTooSmall: "under an order's minimum fill (all-or-nothing orders cross only whole)",
    PriceOutOfBand: "outside an owner's limit at the mark",
    SelfCross: 'same owner on both sides',
    MathOverflow: 'amounts too large to price',
    crossable: 'crossable but refused in simulation',
  }
  return [...reasons].map(([k, n]) => `${n} pair${n === 1 ? '' : 's'} ${words[k] ?? k}`).join('; ')
}

/** The `OrdersCrossed` events in a transaction's logs, from a simulation or a landed transaction. */
export function crossedFromLogs(logs: readonly string[]): OrdersCrossedEvent[] {
  const out: OrdersCrossedEvent[] = []
  for (const l of logs) {
    if (!l.startsWith('Program data: ')) continue
    try {
      const e = decodeOrdersCrossedEvent(Uint8Array.from(Buffer.from(l.slice(14), 'base64')))
      if (e) out.push(e)
    } catch {
      // Not ours, or not an event: the logs carry whatever else ran.
    }
  }
  return out
}

// --------------------------------------------------------------------- the pass

const FILLER_PATH = process.env.BELL_FILLER_KEYPAIR ?? '.filler.json'
const arm = process.env.BELL_ARM === '1'
const gc = process.env.BELL_GC === '1'

const conn = connect()
/** Loaded when the pass runs, not when a test imports the planning above. */
let filler!: Keypair

/**
 * Where this filler keeps inventory for a given mint.
 *
 * Localnet: a PDA of a nonexistent program, conjured at genesis by
 * `localnet.sh`'s `--account` flags — the real issuers hold the mint authority
 * on the real mints, so there is no way to mint a test holding. That address
 * cannot exist anywhere else. Devnet: an ordinary associated account, because
 * we hold the mirror mint authorities and simply minted the stock.
 */
function inventoryFor(mint: PublicKey): PublicKey {
  if (CLUSTER === 'devnet') return ataFor(filler.publicKey, mint, TOKEN_2022)
  return PublicKey.findProgramAddressSync(
    [Buffer.from('inv'), filler.publicKey.toBytes(), mint.toBytes()],
    new PublicKey('11111111111111111111111111111112'),
  )[0]
}

/** The quote account the filler is paid into; overridable, defaults to its ATA. */
const fillerInFor = (quoteMint: PublicKey) =>
  process.env.BELL_FILLER_QUOTE ? new PublicKey(process.env.BELL_FILLER_QUOTE) : ataFor(filler.publicKey, quoteMint)

const line = (o: BellOrder, what: string) => console.log(`  ${o.symbol.padEnd(7)} ${what}`)
/** A sell's line, marked as one, so an operator reading the pass can tell the two books apart. */
const sellLine = (o: SellOrder, what: string) => line(o, `sell: ${what}`)
const short = (k: PublicKey) => `${k.toBase58().slice(0, 4)}…`
/** A cross's line: which buy met which sell. */
const crossLine = (c: Pick<CrossPlan, 'buy' | 'sell'>, what: string) =>
  line(c.buy, `cross: buy ${c.buy.nonce} (${short(c.buy.owner)}) x sell ${c.sell.nonce} (${short(c.sell.owner)}): ${what}`)

/**
 * Notifications in flight. Sent as each fill lands rather than awaited there,
 * so a slow Telegram never holds up the next order, and awaited once before the
 * process exits so that `process.exit` does not cut them off. `notify` never
 * rejects and gives up after a few seconds, which bounds that last wait.
 */
const notices: Promise<void>[] = []
/**
 * Takes the event as a function so that building it is inside the guard too.
 * It runs after the transaction has landed, inside the order's try, and a throw
 * there would print "error" beneath a fill that happened.
 */
function tell(build: () => NotifyEvent): void {
  try {
    notices.push(notify(build(), { cluster: CLUSTER }))
  } catch (e) {
    console.error(`  notify: skipped: ${(e as Error).message}`)
  }
}
/** What the quote mint is called here; the devnet one is BELL's own token, not USDC. */
const QUOTE = CLUSTER === 'mainnet' ? 'USDC' : 'demo-USDC'

/**
 * Returns the fill's signature, or null when it was refused or this is a dry
 * run. `night` marks a fill made while the market is shut, for an owner who
 * opted in; `note` is appended to a line that is not a refusal, whose name
 * already says what it is.
 */
async function fillOne(o: BellOrder, deliver: bigint, remaining: bigint, night: boolean, note = ''): Promise<string | null> {
  // Re-read the mint in the same transaction as the fill, so the gate judges a
  // multiplier, pause or hook as it stands at settlement — not as the last
  // refresh left it. The fill carries the symbol's check and the owner's night
  // opt-in (the chain layer adds both), so the program can judge a night fill.
  const ixs = [
    ixRefreshTokenRisk(o.mint),
    ixFillOrder({
      filler: filler.publicKey,
      order: o,
      fillerIn: fillerInFor(o.quoteMint),
      fillerOut: inventoryFor(o.mint),
      amountInLeg: remaining,
      amountOut: deliver,
      quoteTokenProgram: TOKEN_PROGRAM,
      stockTokenProgram: TOKEN_2022,
    }),
  ]

  // Simulate first: it is the authoritative check, and it costs nothing. The
  // node's own blockhash, so a load-balanced RPC cannot turn a fillable order
  // into "BlockhashNotFound" and skip it until the next pass.
  const sim = await simulate(conn, ixs, filler.publicKey)
  if (sim.value.err) {
    line(o, `REFUSED  ${refusalOf(sim.value.err)}`)
    return null
  }
  const when = night ? ' at night' : ''
  if (!arm) {
    line(o, `would fill${when} ${Number(remaining) / 1e6} quote -> ${deliver} raw (${o.maxSlipBps}bps band${night ? ", and the checker's reference" : ''})${note}`)
    return null
  }
  // `send()` retries transient failures by re-signing. Safe for a fill: an order
  // can only be filled once — a second attempt meets OverFill or a closed
  // account and is rejected in preflight before it costs anything.
  const sig = await send(conn, ixs, [filler])
  line(o, `FILLED${when} ${Number(remaining) / 1e6} quote -> ${deliver} raw  sig=${sig}`)
  return sig
}

/**
 * Settle one sell: pay `deliver` quote, take `remaining` stock. Returns the
 * signature, or null when it was refused or this is a dry run.
 *
 * The same simulate-then-send as `fillOne`. The accounts are the buy's with
 * the legs swapped: the stock lands in the filler's inventory (`filler_in`),
 * and the quote is paid from the same account a buy pays the filler into
 * (`filler_out`), so fills in both directions net against one balance.
 */
async function fillSellOne(o: SellOrder, deliver: bigint, remaining: bigint, night: boolean, note = ''): Promise<string | null> {
  // Re-read the mint in the same transaction, as for a buy: the gate judges
  // the multiplier, pause and hook as they stand at settlement.
  const ixs = [
    ixRefreshTokenRisk(o.mint),
    ixFillSellOrder({
      filler: filler.publicKey,
      order: o,
      fillerIn: inventoryFor(o.mint),
      fillerOut: fillerInFor(o.quoteMint),
      amountInLeg: remaining,
      amountOut: deliver,
      quoteTokenProgram: TOKEN_PROGRAM,
      stockTokenProgram: TOKEN_2022,
    }),
  ]

  const sim = await simulate(conn, ixs, filler.publicKey)
  if (sim.value.err) {
    sellLine(o, `REFUSED  ${refusalOf(sim.value.err)}`)
    return null
  }
  const when = night ? ' at night' : ''
  if (!arm) {
    sellLine(o, `would fill${when} ${remaining} raw -> ${Number(deliver) / 1e6} quote (${o.maxSlipBps}bps band${night ? ", and the checker's reference" : ''})${note}`)
    return null
  }
  // Safe to re-sign on a transient failure for the same reason as a buy: a
  // second landing meets OverFill or a closed account and is refused.
  const sig = await send(conn, ixs, [filler])
  sellLine(o, `FILLED${when} ${remaining} raw -> ${Number(deliver) / 1e6} quote  sig=${sig}`)
  return sig
}

/**
 * The sell book, or none if it cannot be read. A failed read here must not
 * cost the buy book its pass, so it is reported and the pass carries on
 * without sells rather than throwing out of `main`.
 */
async function readSells(): Promise<SellOrder[]> {
  try {
    return await readSellOrders(conn)
  } catch (e) {
    console.error(`  sell orders unreadable this pass: ${(e as Error).message.split('\n')[0]}`)
    return []
  }
}

type Infos = Awaited<ReturnType<typeof readBoard>>['extras']

/** Everything a pass decides from, read in one round trip (split only by the node's key limit). */
interface Book {
  orders: BellOrder[]
  sells: SellOrder[]
  listings: { symbol: string; mint: string }[]
  symbols: Map<string, SymbolAccounts>
  /** The cluster's clock at the read, in unix seconds. */
  now: number
  payers: Infos
  inventories: Infos
  decimalsOf: Map<string, number | undefined>
  sellPayers: Infos
  fillerQuotes: Infos
  /** Owners (base58) whose night opt-in the program would count, read as `admit` reads it. */
  night: Set<string>
}

async function readBook(): Promise<Book> {
  const orders = await readOrders(conn)
  const sells = await readSells()
  // Everything else in one round trip: each symbol in the book, each order's
  // quote account, the filler's inventory, the cluster's clock — time comes
  // from the chain, because that is what the program will judge us by — and
  // each symbol's mint, whose decimals turn a delivered amount into shares for
  // the fill notice.
  const listings = [
    ...new Map([...orders, ...sells].map((o) => [o.symbol, { symbol: o.symbol, mint: o.mint.toBase58() }])).values(),
  ]
  const owners = [...new Map([...orders, ...sells].map((o) => [o.owner.toBase58(), o.owner])).values()]
  if (orders.length === 0 && sells.length === 0) {
    return { orders, sells, listings, symbols: new Map(), now: 0, payers: [], inventories: [], decimalsOf: new Map(), sellPayers: [], fillerQuotes: [], night: new Set() }
  }
  const extra = [
    SYSVAR_CLOCK_PUBKEY,
    ...orders.map((o) => o.payerIn),
    ...orders.map((o) => inventoryFor(o.mint)),
    ...listings.map((l) => new PublicKey(l.mint)),
    // The sell book's accounts go after the buy book's, so that no index the
    // buy book reads moves: each sell's stock account, which carries its
    // delegation, and the filler's quote account that would pay for it.
    ...sells.map((o) => o.payerIn),
    ...sells.map((o) => fillerInFor(o.quoteMint)),
    // Last, each owner's night opt-in address, whether or not anything lives
    // there: that is the whole of what the program reads to allow a night fill.
    ...owners.map((k) => nightPda(k)),
  ]
  const { symbols, extras } = await readBoard(conn, listings, extra)
  const clock = extras[0]
  const now = clock ? Number(new DataView(clock.data.buffer, clock.data.byteOffset).getBigInt64(32, true)) : Math.floor(Date.now() / 1000)
  // Byte 44 of an SPL mint, Token-2022 included, is its decimals.
  const mintsAt = 1 + 2 * orders.length
  const sellsAt = mintsAt + listings.length
  const nightAt = sellsAt + 2 * sells.length
  const night = new Set(
    owners.filter((k, i) => nightConsent(extras[nightAt + i], k)).map((k) => k.toBase58()),
  )
  return {
    orders,
    sells,
    listings,
    symbols,
    now,
    payers: extras.slice(1, 1 + orders.length),
    inventories: extras.slice(1 + orders.length, mintsAt),
    decimalsOf: new Map(listings.map((l, i) => [l.symbol, extras[mintsAt + i]?.data[44]] as const)),
    sellPayers: extras.slice(sellsAt, sellsAt + sells.length),
    fillerQuotes: extras.slice(sellsAt + sells.length, nightAt),
    night,
  }
}

/** Whether an order's own account can pay `remaining` through its owner's delegate authority. */
function funded(info: Infos[number], owner: PublicKey, remaining: bigint): boolean {
  if (!info) return false
  const a = decodeTokenAccount(info.data)
  return !!a.delegate?.equals(authPda(owner)) && a.delegatedAmount >= remaining && a.amount >= remaining
}

async function main() {
  // Orders first. Most passes find none, and then this is one RPC call per
  // book. A pass with no sells prints exactly what it printed before sells
  // existed.
  let book = await readBook()
  console.log(`crank — ${CLUSTER} — ${arm ? 'SETTLING' : 'dry run'} — ${book.orders.length} order(s)`)
  if (book.orders.length === 0 && book.sells.length === 0) return

  // The pass can outlive a mark, so "now" advances with the wall clock from the
  // chain's reading rather than staying frozen at the start.
  let base = { now: book.now, t0: Date.now() }
  const chainNow = () => base.now + Math.floor((Date.now() - base.t0) / 1000)
  // Symbols whose mark this pass already waited on: a later order for the same
  // symbol uses what that wait found instead of sitting out another 70s. Three
  // orders each waiting afresh was enough to hit the watchdog. The check read
  // with a fresh mark is kept beside it, since it is at least as new.
  const waited = new Map<string, SymbolMark | null>()
  const rechecked = new Map<string, SymbolCheck | null>()
  const listingOf = new Map(book.listings.map((l) => [l.symbol, l]))

  /**
   * A mark fresh enough to settle `symbol` against, or the line that says why
   * there is none.
   *
   * A price has to be fresh at settlement, and the keeper's marks land every
   * ~45-60s — so a mark read at a random moment is often most of a minute old.
   * Rather than eat MarkStale, wait for the next one to land. Every book shares
   * `waited`, so a symbol with a buy and a sell due waits once, not twice.
   */
  async function freshMark(symbol: string, read: SymbolMark | null | undefined): Promise<SymbolMark | string> {
    let mark = waited.has(symbol) ? waited.get(symbol) : read
    if (!mark || mark.observedAt === 0n) {
      return waited.has(symbol) ? 'waiting — no fresh mark arrived this pass' : 'no mark — cannot price, so cannot fill'
    }
    // A held mark keeps its old time until a push releases it, so waiting for
    // a new one would be waiting on the breaker. The pass says so and moves
    // on; the keeper's next good push releases it, and the next pass fills.
    if (markHeld(mark)) return PAUSED_LINE
    if (chainNow() - Number(mark.observedAt) > MAX_MARK_AGE_SECONDS - 10) {
      const seenAt = mark.observedAt
      const until = Date.now() + 70_000
      let fresh: SymbolMark | null = null
      while (Date.now() < until) {
        await new Promise((r) => setTimeout(r, 5_000))
        const next = (await readBoard(conn, [listingOf.get(symbol)!])).symbols.get(symbol)
        if (next?.mark && next.mark.observedAt !== seenAt) {
          fresh = next.mark
          rechecked.set(symbol, next.check)
          break
        }
      }
      waited.set(symbol, fresh)
      if (!fresh) return 'waiting — no fresh mark arrived this pass'
      mark = fresh
    }
    return markHeld(mark) ? PAUSED_LINE : mark
  }
  /** The newest check this pass has read for `symbol`. */
  const checkOf = (symbol: string): SymbolCheck | null =>
    rechecked.has(symbol) ? rechecked.get(symbol)! : (book.symbols.get(symbol)?.check ?? null)

  // ------------------------------------------------------------ the cross
  //
  // Before any fill: a buyer and a seller of the same stock, both due at the
  // open, are each other's counterparty, and neither needs a filler's spread.
  // Session only, because the program admits both orders as Strict fills with
  // no night opt-in, so it needs the market open, a fresh mark nobody has
  // held, and a checker that agrees; the crank asks the same first, and then
  // the program's own arithmetic (`nextCross`) for a pair that meets both
  // orders' minimum fill and both floors.
  //
  // What a dry run would cross is taken off those orders' remainders below,
  // so the fills that follow report what the cross would leave. Armed, the
  // book is read again after anything crossed.
  const taken = new Map<string, bigint>()
  let crossed = 0
  const bothSides = book.listings.filter(
    (l) => book.orders.some((o) => o.symbol === l.symbol) && book.sells.some((o) => o.symbol === l.symbol),
  )
  for (const l of bothSides) {
    const say = (what: string) => console.log(`  ${l.symbol.padEnd(7)} cross: ${what}`)
    try {
      const acc = book.symbols.get(l.symbol)
      const state = acc?.state
      // Out of session there is nothing to say here: the fills below say why
      // each order waits, and a cross never runs at night.
      if (!state || !state.openNow || state.halt !== 0 || book.now - Number(state.observedAt) > MAX_STATE_AGE_SECONDS) continue
      if (!acc?.check) {
        say(`none — no checker yet (open_check has not run for ${l.symbol}), and a cross needs one`)
        continue
      }
      // The check's clocks and session first, before waiting on a mark it
      // would refuse anyway; the price comparison once the mark is in hand.
      const early = checkBlocker({ check: acc.check, markRateQ64: acc.check.refRateQ64, night: false, now: chainNow() })
      if (early) {
        say(`none — ${early}`)
        continue
      }
      const got = await freshMark(l.symbol, acc.mark)
      if (typeof got === 'string') {
        say(`none — ${got}`)
        continue
      }
      const mark = got
      const blocked = checkBlocker({ check: checkOf(l.symbol), markRateQ64: mark.rateQ64, night: false, now: chainNow() })
      if (blocked) {
        say(`none — ${blocked}`)
        continue
      }

      // Working copies of the orders that could cross now, by the same tests
      // the fills apply below: due, alive, funded through the owner's delegate
      // authority, built for the multiplier in force, and willing to accept
      // this mark's confidence and quote asset.
      const t = chainNow()
      const live = (o: BellOrder, info: Infos[number]) =>
        t >= Number(o.notBefore) &&
        t < Number(o.expiresAt) &&
        acc.risk?.multiplierBits === o.expectedMultiplierBits &&
        mark.confBps <= o.maxConfBps &&
        o.quoteMint.equals(mark.quoteMint) &&
        funded(info, o.owner, o.amountIn - o.filledIn)
      const buys = book.orders
        .map((o, i) => [o, book.payers[i]] as const)
        .filter(([o, info]) => o.symbol === l.symbol && live(o, info))
        .map(([o]) => ({ ...o }))
      const sells = book.sells
        .map((o, i) => [o, book.sellPayers[i]] as const)
        .filter(([o, info]) => o.symbol === l.symbol && live(o, info))
        .map(([o]) => ({ ...o }))
      if (buys.length === 0 || sells.length === 0) continue

      const tried = new Set<string>()
      let any = false
      for (;;) {
        const plan = nextCross(buys, sells, mark.rateQ64, tried)
        if (!plan) break
        tried.add(pairKey(plan.buy, plan.sell))
        any = true
        // The mint re-read first, as for a fill, so the gate judges the mint
        // as it stands at settlement.
        const ixs = [ixRefreshTokenRisk(plan.buy.mint), ixCrossOrders({ cranker: filler.publicKey, buy: plan.buy, sell: plan.sell })]
        const sim = await simulate(conn, ixs, filler.publicKey)
        if (sim.value.err) {
          crossLine(plan, `REFUSED  ${refusalOf(sim.value.err)}`)
          continue
        }
        const px = Number(mark.pxNum) * 10 ** mark.pxExpo
        let moved = { quote: plan.quote, stock: plan.stock }
        let sig: string | null = null
        if (arm) {
          // `send()` may re-sign after a transient failure. A cross that did
          // land meets a closed order, or crosses what the two have left at
          // the mark within both owners' terms, which the next pass would do.
          sig = await send(conn, ixs, [filler])
          crossed++
          // What moved, from the program's own event: the mark can move
          // between the plan and the landing, and the program prices at its own.
          try {
            const tx = await conn.getTransaction(sig, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 })
            const e = crossedFromLogs(tx?.meta?.logMessages ?? [])[0]
            if (e) moved = { quote: e.quote, stock: e.stock }
          } catch {
            // The planned amounts stand in; the book is re-read below either way.
          }
          crossLine(plan, `CROSSED ${Number(moved.quote) / 1e6} quote for ${moved.stock} raw at the mark ($${px.toFixed(4)}), no filler spread  sig=${sig}`)
        } else {
          crossLine(plan, `would cross ${Number(moved.quote) / 1e6} quote for ${moved.stock} raw at the mark ($${px.toFixed(4)}), no filler spread`)
        }
        plan.buy.filledIn += moved.quote
        plan.sell.filledIn += moved.stock
        const kb = orderKey('buy', plan.buy)
        const ks = orderKey('sell', plan.sell)
        taken.set(kb, (taken.get(kb) ?? 0n) + moved.quote)
        taken.set(ks, (taken.get(ks) ?? 0n) + moved.stock)
        if (sig) {
          const decimals = book.decimalsOf.get(l.symbol)
          const [buyer, seller, signature] = [plan.buy.owner.toBase58(), plan.sell.owner.toBase58(), sig]
          tell(() => ({
            kind: 'cross',
            symbol: l.symbol,
            amount: Number(moved.quote) / 1e6,
            quote: QUOTE,
            shares:
              decimals === undefined
                ? null
                : (Number(moved.stock) / 10 ** decimals) * multiplierOf(plan.buy.expectedMultiplierBits),
            minutesAfterBell: minutesAfterBell(chainNow()),
            buyer,
            seller,
            signature,
          }))
        }
      }
      if (!any) say(`none — ${whyNoCross(buys, sells, mark.rateQ64)}`)
    } catch (e) {
      say(`error — ${(e as Error).message.split('\n')[0]}`)
    }
  }

  // Armed, what crossed has changed the orders, their delegations and their
  // balances, and some are closed: read it all again rather than reason about
  // it. A dry run changed nothing on chain, so it keeps what it read and takes
  // the crosses it would have made off the remainders instead.
  if (crossed > 0) {
    book = await readBook()
    base = { now: book.now, t0: Date.now() }
    waited.clear()
    rechecked.clear()
    taken.clear()
    for (const l of book.listings) listingOf.set(l.symbol, l)
    console.log(`  after ${crossed} cross(es): ${book.orders.length} order(s), ${book.sells.length} sell(s) left`)
  }
  const { orders, sells, symbols, now, payers, inventories, decimalsOf, sellPayers, fillerQuotes } = book

  for (const [i, o] of orders.entries()) {
    try {
      const crossedHere = taken.get(orderKey('buy', o)) ?? 0n
      const remaining = o.amountIn - o.filledIn - crossedHere
      if (remaining <= 0n) {
        line(o, 'would be crossed in full above')
        continue
      }
      const acc = symbols.get(o.symbol)
      const state = acc?.state
      const payer = payers[i] ? decodeTokenAccount(payers[i]!.data) : null
      const inventory = inventories[i] ? decodeTokenAccount(inventories[i]!.data) : null

      const expired = now >= Number(o.expiresAt)
      const defunded =
        !payer ||
        !payer.delegate?.equals(authPda(o.owner)) ||
        payer.delegatedAmount < remaining

      // Dead orders: the owner revoked (their cancel), spent the delegation
      // elsewhere, or let it expire. Anyone may close these, rent returns to
      // the owner, and closing them keeps the book honest.
      if (expired || defunded) {
        const why = expired ? 'expired' : 'no longer funded (revoked or re-approved elsewhere)'
        if (!gc) {
          line(o, `dead — ${why}`)
          continue
        }
        if (!arm) {
          line(o, `would close — ${why}; rent to the owner`)
          continue
        }
        const sig = await send(
          conn,
          [ixCancelOrder({ signer: filler.publicKey, owner: o.owner, nonce: o.nonce, payerIn: o.payerIn })],
          [filler],
        )
        line(o, `CLOSED — ${why}; rent returned to owner  sig=${sig}`)
        tell(() => ({ kind: 'closed', symbol: o.symbol, owner: o.owner.toBase58(), why, signature: sig }))
        continue
      }
      if (now < Number(o.notBefore)) {
        line(o, 'not due yet')
        continue
      }

      // Certain refusals, known from the accounts already in hand. Simulating
      // these would only confirm what the chain already says.
      if (!state) {
        line(o, 'symbol not registered here')
        continue
      }
      const age = now - Number(state.observedAt)
      if (age > MAX_STATE_AGE_SECONDS) {
        line(o, `waiting — attestation ${age}s old (StateStale)`)
        continue
      }
      if (state.halt !== 0) {
        line(o, 'waiting — halted (MarketClosed)')
        continue
      }
      // The market shut. An owner who opted in fills at night, if the checker
      // agrees; everyone else parks until the bell, as before.
      const night = !state.openNow
      if (night && !book.night.has(o.owner.toBase58())) {
        line(o, 'waiting — market closed; parks until the bell (MarketClosed)')
        continue
      }
      if (night && !acc?.check) {
        line(o, 'waiting — market closed; its owner opted in to night fills, but there is no checker yet to agree the market is shut')
        continue
      }
      // Built against a multiplier that is no longer in force: the gate will
      // refuse it for as long as it lives. Only its owner can close it (it is
      // still funded), so say so rather than simulating it every pass.
      if (acc?.risk && acc.risk.multiplierBits !== o.expectedMultiplierBits) {
        line(o, 'dead — a corporate action changed its size (MultiplierMoved); the owner can cancel to reclaim rent')
        continue
      }
      if (payer && payer.amount < remaining) {
        line(o, 'waiting — the owner no longer holds the funds this order would spend')
        continue
      }
      // The check's clocks and session, before waiting on a mark it would
      // refuse anyway. A symbol with no check at all is simulated regardless:
      // a program that predates the checker fills it, and one that has it
      // refuses it by name.
      const nightTag = night ? 'night: ' : ''
      const early = acc?.check ? checkBlocker({ check: acc.check, markRateQ64: acc.check.refRateQ64, night, now: chainNow() }) : null
      if (early) {
        line(o, `waiting — ${nightTag}${early}`)
        continue
      }

      const mark = await freshMark(o.symbol, acc?.mark)
      if (typeof mark === 'string') {
        line(o, mark)
        continue
      }
      const check = checkOf(o.symbol)
      const blocked = checkBlocker({ check, markRateQ64: mark.rateQ64, night, now: chainNow() })
      // With no check in session the fill is simulated anyway (see above); a
      // night fill always needs one.
      if (blocked && (check || night)) {
        line(o, `waiting — ${nightTag}${blocked}`)
        continue
      }
      const note = check ? '' : ' (no checker yet)'

      // Deliver the band edge, which is why max_slip_bps is the user's maximum
      // cost rather than a tolerance — or the user's own floor, when their
      // limit asks for more stock than the band does; at night, or the
      // checker's reference minimum. The program takes the largest as its
      // minimum, computed exactly as here.
      const { fair, floor, deliver } = buyDeliver(remaining, mark.rateQ64, o, night ? check!.refRateQ64 : null)
      // A limit below the market asks for more stock than the price gives:
      // filling it would sell below the mark, so it waits for the price to
      // come down to it, as a limit order does.
      if (floor > fair) {
        line(o, `waiting — its limit is below the market (asks ${floor} raw; the price gives ${fair})`)
        continue
      }

      // A short filler is the filler's problem, and saying so matters: the
      // token program would report it as insufficient funds, which reads as
      // though the *user* were short.
      if (!inventory || inventory.amount < deliver) {
        line(o, `filler short of ${o.symbol} inventory — not the owner's fault`)
        continue
      }

      const sig = await fillOne(o, deliver, remaining, night, note)
      if (sig) {
        // Shares as the page counts them: raw ÷ 10^decimals × the scaled-UI
        // multiplier. The order's own multiplier is exact here, because gate 5
        // refuses any fill where the one in force differs from it.
        const decimals = decimalsOf.get(o.symbol)
        tell(() => ({
          kind: 'fill',
          symbol: o.symbol,
          amountIn: Number(remaining) / 1e6,
          quote: QUOTE,
          shares:
            decimals === undefined
              ? null
              : (Number(deliver) / 10 ** decimals) * multiplierOf(o.expectedMultiplierBits),
          minutesAfterBell: minutesAfterBell(chainNow()),
          owner: o.owner.toBase58(),
          signature: sig,
        }))
      }
    } catch (e) {
      // One failure is one order's problem, not the whole pass's.
      line(o, `error — ${(e as Error).message.split('\n')[0]}`)
    }
  }

  // ------------------------------------------------------------------ sells
  //
  // The buy loop's checks in the buy loop's order, each against the sell's own
  // accounts: its stock account for the delegation and the balance, the
  // filler's quote account for inventory. Only the pricing is different.
  if (sells.length > 0) console.log(`sells — ${sells.length} order(s)`)
  // Quote this pass has already paid out, per filler account. Every sell pays
  // from the same account, but its balance was read once at the start of the
  // pass, so without this a second sale would be judged against money the
  // first one already spent, and be refused on chain as insufficient funds:
  // a refusal that reads as though the seller were short.
  const quoteSpent = new Map<string, bigint>()
  for (const [i, o] of sells.entries()) {
    try {
      const crossedHere = taken.get(orderKey('sell', o)) ?? 0n
      const remaining = o.amountIn - o.filledIn - crossedHere
      if (remaining <= 0n) {
        sellLine(o, 'would be crossed in full above')
        continue
      }
      const acc = symbols.get(o.symbol)
      const state = acc?.state
      const payer = sellPayers[i] ? decodeTokenAccount(sellPayers[i]!.data) : null
      const quote = fillerQuotes[i] ? decodeTokenAccount(fillerQuotes[i]!.data) : null

      // Dead by the rule cancel_sell_order applies: expired, or the stock
      // account no longer delegates the remainder to the owner's authority,
      // or is gone. Anyone may close these; the rent goes to the owner.
      const expired = now >= Number(o.expiresAt)
      const defunded =
        !payer ||
        !payer.delegate?.equals(authPda(o.owner)) ||
        payer.delegatedAmount < remaining
      if (expired || defunded) {
        const why = expired ? 'expired' : 'no longer funded (revoked or re-approved elsewhere)'
        if (!gc) {
          sellLine(o, `dead — ${why}`)
          continue
        }
        if (!arm) {
          sellLine(o, `would close — ${why}; rent to the owner`)
          continue
        }
        const sig = await send(
          conn,
          [ixCancelSellOrder({ signer: filler.publicKey, owner: o.owner, nonce: o.nonce, payerIn: o.payerIn })],
          [filler],
        )
        sellLine(o, `CLOSED — ${why}; rent returned to owner  sig=${sig}`)
        tell(() => ({ kind: 'closed', side: 'sell', symbol: o.symbol, owner: o.owner.toBase58(), why, signature: sig }))
        continue
      }
      if (now < Number(o.notBefore)) {
        sellLine(o, 'not due yet')
        continue
      }

      // The same certain refusals as a buy: fill_sell_order runs the same
      // gate against the same attestation.
      if (!state) {
        sellLine(o, 'symbol not registered here')
        continue
      }
      const age = now - Number(state.observedAt)
      if (age > MAX_STATE_AGE_SECONDS) {
        sellLine(o, `waiting — attestation ${age}s old (StateStale)`)
        continue
      }
      if (state.halt !== 0) {
        sellLine(o, 'waiting — halted (MarketClosed)')
        continue
      }
      const night = !state.openNow
      if (night && !book.night.has(o.owner.toBase58())) {
        sellLine(o, 'waiting — market closed; parks until the bell (MarketClosed)')
        continue
      }
      if (night && !acc?.check) {
        sellLine(o, 'waiting — market closed; its owner opted in to night fills, but there is no checker yet to agree the market is shut')
        continue
      }
      // A sell is sized in raw units, so a multiplier change makes it a
      // different number of shares from the one the user placed; the gate
      // refuses it for as long as it lives.
      if (acc?.risk && acc.risk.multiplierBits !== o.expectedMultiplierBits) {
        sellLine(o, 'dead — a corporate action changed its size (MultiplierMoved); the owner can cancel to reclaim rent')
        continue
      }
      if (payer && payer.amount < remaining) {
        sellLine(o, 'waiting — the owner no longer holds the stock this order would sell')
        continue
      }
      const nightTag = night ? 'night: ' : ''
      const early = acc?.check ? checkBlocker({ check: acc.check, markRateQ64: acc.check.refRateQ64, night, now: chainNow() }) : null
      if (early) {
        sellLine(o, `waiting — ${nightTag}${early}`)
        continue
      }

      const mark = await freshMark(o.symbol, acc?.mark)
      if (typeof mark === 'string') {
        sellLine(o, mark)
        continue
      }
      const check = checkOf(o.symbol)
      const blocked = checkBlocker({ check, markRateQ64: mark.rateQ64, night, now: chainNow() })
      if (blocked && (check || night)) {
        sellLine(o, `waiting — ${nightTag}${blocked}`)
        continue
      }
      const note = check ? '' : ' (no checker yet)'

      // Pay the band edge, or the seller's own floor when their minimum asks
      // for more than the band does, or at night the checker's reference
      // minimum. Each figure rounds up, exactly as fill_sell_order computes
      // it: the buy side's rounding would pay one unit short and be refused as
      // PriceOutOfBand.
      const { fair, floor, deliver } = sellDeliver(remaining, mark.rateQ64, o, night ? check!.refRateQ64 : null)
      // A minimum above the market asks for more quote than the price says the
      // stock is worth: paying it would buy above the mark, so it waits for the
      // price to come up to it, as a limit order does.
      if (floor > fair) {
        sellLine(o, `waiting — its limit is above the market (asks ${floor} quote raw; the price gives ${fair})`)
        continue
      }

      // The filler pays from its own quote. A short there is the filler's
      // problem, and the token program would report it as insufficient funds,
      // which reads as though the seller were short.
      const payFrom = fillerInFor(o.quoteMint).toBase58()
      if (!quote || quote.amount - (quoteSpent.get(payFrom) ?? 0n) < deliver) {
        sellLine(o, `filler short of ${QUOTE} — not the owner's fault`)
        continue
      }

      const sig = await fillSellOne(o, deliver, remaining, night, note)
      if (sig) {
        quoteSpent.set(payFrom, (quoteSpent.get(payFrom) ?? 0n) + deliver)
        // Shares as the page counts them, from the stock taken; the order's
        // multiplier is exact here for the same reason as a buy's (gate 5).
        const decimals = decimalsOf.get(o.symbol)
        tell(() => ({
          kind: 'fill',
          side: 'sell',
          symbol: o.symbol,
          amountIn: Number(deliver) / 1e6,
          quote: QUOTE,
          shares:
            decimals === undefined
              ? null
              : (Number(remaining) / 10 ** decimals) * multiplierOf(o.expectedMultiplierBits),
          minutesAfterBell: minutesAfterBell(chainNow()),
          owner: o.owner.toBase58(),
          signature: sig,
        }))
      }
    } catch (e) {
      sellLine(o, `error — ${(e as Error).message.split('\n')[0]}`)
    }
  }
}

if (import.meta.main) {
  // A pass that is still running when the next cron tick arrives makes Railway
  // skip that tick, so a hung RPC call would silently stop filling altogether.
  setTimeout(() => {
    console.error('watchdog: pass exceeded 240s, exiting')
    process.exit(2)
  }, 240_000).unref()
  filler = loadKeypair(FILLER_PATH)
  try {
    await main()
    await Promise.all(notices)
    process.exit(0)
  } catch (e) {
    console.error(`crank failed: ${(e as Error).message}`)
    await Promise.all(notices)
    process.exit(1)
  }
}
