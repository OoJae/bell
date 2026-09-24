/**
 * The public tape: every BELL fill and cross in the last thirty days, in the
 * shape §II.G of SEC Order 34-106402 gives a transaction report.
 *
 * §II.G asks a Tokenized Securities Venue to publish, free and machine-readable,
 * for every transaction in the past thirty days and within ten minutes of it:
 * the symbol and its paired asset, the price, the size, the time at the pool in
 * UTC and the direction, plus the smart contract's address. BELL is not a TSV
 * and makes no claim to meet the order (see NOTICE.md). It publishes this
 * because every number here is already public on chain, and a venue that says
 * "the transaction is the record" should make the record easy to read.
 *
 * The fills and crosses themselves are read by `tradesOf`, in
 * `src/chain/fills.ts` and re-exported below. Everything from there to the
 * loader is pure: a transaction as the RPC returns it goes in, rows come out.
 * The loader at the bottom is the only part that talks to the network, and it
 * takes its transport as an argument so tests can stand in for the RPC.
 */
import { decodeSymbolMark } from '../../src/chain/codec.ts'
import { markPda } from '../../src/chain/client.ts'
import { PROGRAM_ADDRESS, fromBase64, tradesOf, type RpcTransaction } from '../../src/chain/fills.ts'
import type { Listing } from '../../src/listings.ts'

// The fill reader moved to src/chain/fills.ts so the keeper, whose image holds
// only src/ and scripts/, can read fills for per-wallet alerts. Re-exported
// here under the names the tape always had, so every import of them still
// works and the tape and the alerts cannot disagree about what a fill is.
export {
  crossesOf,
  decodeOrderFilled,
  decodeOrdersCrossed,
  decodeSellOrderFilled,
  fillsOf,
  fromBase58,
  tradesOf,
  type Cross,
  type Fill,
  type OrderFilled,
  type OrdersCrossed,
  type RpcInstruction,
  type RpcTransaction,
  type Trade,
} from '../../src/chain/fills.ts'

export const PROGRAM_ID: string = PROGRAM_ADDRESS

/** Mainnet USDC, the only quote asset here that is worth a dollar. */
const USDC_MAINNET = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'

/**
 * A quote mint's name on the tape: USDC for mainnet USDC, demo-USDC for the
 * deployment's own demo quote asset, and otherwise the address itself, so an
 * unknown asset is never given a name it has not earned.
 */
export const quoteLabel = (mint: string, demoQuoteMint: string | undefined): string =>
  mint === USDC_MAINNET ? 'USDC' : mint === demoQuoteMint ? 'demo-USDC' : mint

// ------------------------------------------------------------------ the rows

/** `ScaledUiAmountConfig`, as the mint holds it. */
export interface ScaledUi {
  multiplier: number
  newMultiplier: number
  /** Unix seconds; 0 when no change is scheduled. */
  effectiveAt: number
}

/** Token-2022's extension number for the scaled-UI amount. */
const SCALED_UI_AMOUNT = 25
const NO_SCALING: ScaledUi = { multiplier: 1, newMultiplier: 1, effectiveAt: 0 }

/**
 * A mint's scaled-UI multiplier configuration, read from its account bytes.
 *
 * Raw balances of these tokens are not shares: a share count is the raw amount
 * times the multiplier in force, and the multiplier steps with each dividend.
 * A mint without the extension is already in share units. Null means the bytes
 * are not a mint at all.
 */
export function scaledUiOf(data: Uint8Array): ScaledUi | null {
  if (data.length === 82) return NO_SCALING
  // Token-2022 pads the base mint to an account's 165 bytes, then writes the
  // account type (1 for a mint) and the extensions as type-length-value.
  if (data.length <= 166 || data[165] !== 1) return null
  const d = new DataView(data.buffer, data.byteOffset, data.byteLength)
  for (let o = 166; o + 4 <= data.length; ) {
    const type = d.getUint16(o, true)
    const len = d.getUint16(o + 2, true)
    o += 4
    if (type === SCALED_UI_AMOUNT && len >= 56) {
      // authority 32, multiplier f64, effective timestamp i64, new multiplier f64
      return {
        multiplier: d.getFloat64(o + 32, true),
        effectiveAt: Number(d.getBigInt64(o + 40, true)),
        newMultiplier: d.getFloat64(o + 48, true),
      }
    }
    o += len
  }
  return NO_SCALING
}

/**
 * The multiplier in force at an instant, by the same rule the program's
 * `read_mint` and Token-2022 apply: the new one from its effective time on.
 *
 * The mint remembers only its latest change, so a fill from before an earlier
 * change would be priced with the wrong one. Thirty days holds at most one
 * dividend step for these names in the normal course; the tape says which
 * multiplier it used, so a reader can check.
 */
export function multiplierAt(cfg: ScaledUi, unix: number): number {
  return cfg.effectiveAt !== 0 && unix >= cfg.effectiveAt ? cfg.newMultiplier : cfg.multiplier
}

/**
 * One transaction on the tape.
 *
 * Money fields are numbers in dollars for reading and strings in raw units for
 * checking, since a raw u64 does not survive a JSON number. The buyer's wallet
 * is left off: §II.G does not ask for it and the tape does not need to be an
 * index of who bought what, though anyone can follow `signature` to it.
 */
export interface TapeRow {
  /** Block time, UTC, ISO 8601. */
  time: string
  slot: number
  symbol: string
  underlying: string
  stockMint: string
  /** The asset the stock was paired with, and its mint. */
  paired: string
  pairedMint: string
  /**
   * A buy contributes `paired` and withdraws `symbol`; a sell contributes
   * `symbol` and withdraws `paired`. A cross is a buy and a sell settled
   * against each other with no filler: the buyer contributed `paired` and
   * withdrew `symbol`, the seller the reverse, and `contributed` and
   * `withdrawn` are given from the buyer's side, since the quote leads.
   */
  direction: 'buy' | 'sell' | 'cross'
  contributed: string
  withdrawn: string
  /** Dollars per share; null when the stock mint's multiplier could not be read. */
  priceUsd: number | null
  /** Shares bought or sold, multiplier applied; null when it could not be read. */
  shares: number | null
  notionalUsd: number
  stockRaw: string
  quoteRaw: string
  /** The scaled-UI multiplier `shares` and `priceUsd` were computed with. */
  multiplier: number | null
  /** The attested mark the program priced the fill against. */
  markPriceUsd: number
  markSource: string
  markObservedAt: string
  /**
   * How far below the mark's fair value the user's side landed, in bps: the
   * stock a buy received, or the quote a sell was paid. Zero on a cross, for
   * both sides: the buyer receives exactly the stock the quote buys at the
   * mark, and the seller at least the quote the stock is worth there.
   */
  realizedBps: number
  /** The order filled; on a cross, the buy order (the sell order is `sellOrder`). */
  order: string
  program: string
  /**
   * Who settled it. On a cross, the account that sent the transaction: it
   * supplied nothing and was paid nothing, since the two owners' own orders
   * are each other's counterparty.
   */
  filler: string
  signature: string
  explorer: string
  /** On a cross only: the sell order it settled against `order`. */
  sellOrder?: string
  /**
   * The buyer's wallet. Never in the public tape: the route strips it, and
   * returns it only to a request for one buyer's own fills (`?buyer=`), which is
   * how the page shows you your receipts. Anyone can follow `signature` to the
   * same address, so this reveals nothing — but the default view is not an index.
   * Set on buys and crosses.
   */
  buyer?: string
  /**
   * The seller's wallet, on sells and crosses, and kept off the public tape
   * exactly as `buyer` is. A separate field rather than `buyer` reused, so a
   * request for one wallet's purchases can never return its sales as though
   * they were. A cross carries both, so either party's request finds it; see
   * `rowsFor` for how each is shown only its own side.
   */
  seller?: string
}

export interface RowContext {
  cluster: string
  /** The listing a fill must belong to, found by symbol and pinned by stock mint. */
  listing: (symbol: string, stockMint: string) => Pick<Listing, 'symbol' | 'underlying'> | null
  /** Display name of a quote mint. */
  label: (mint: string) => string
  /** The stock mint's multiplier configuration, if it could be read. */
  scaled: (mint: string) => ScaledUi | null
  /** Decimals of a mint the transaction's own token balances do not mention. */
  decimals?: (mint: string) => number | null
}

const iso = (unix: number) => new Date(unix * 1000).toISOString().replace('.000Z', 'Z')
const round = (x: number, dp: number) => Math.round(x * 10 ** dp) / 10 ** dp

export function explorerTx(signature: string, cluster: string): string {
  const base = `https://explorer.solana.com/tx/${signature}`
  if (cluster === 'mainnet') return base
  if (cluster === 'localnet') return `${base}?cluster=custom&customUrl=http%3A%2F%2F127.0.0.1%3A8899`
  return `${base}?cluster=${cluster}`
}

/**
 * A transaction's fills and crosses as tape rows, and how many it left off
 * because they were not trades of a listed security.
 *
 * `register_symbol` and `open_mark` are permissionless, so anyone can create a
 * ticker, attest its price as its own attestor and fill against it through this
 * same program. Those are not BELL's listings, and a tape that printed them
 * would let a stranger write whatever price they liked onto BELL's record. A
 * trade is kept only when its symbol is listed and its stock mint is the one
 * that listing is pinned to.
 *
 * A cross is one row, not one per party. It is one transaction at one price,
 * and §II.G reports transactions: two rows would count its shares twice in the
 * day's volume and print the same trade twice on the public tape. Its row
 * carries both wallets, so the per-wallet view finds it by either one.
 */
export function tapeRows(tx: RpcTransaction, ctx: RowContext): { rows: TapeRow[]; excluded: number } {
  const signature = tx.transaction.signatures[0]
  const at = tx.blockTime
  const trades = tradesOf(tx)
  if (at === null) {
    if (trades.length) throw new Error('no block time')
    return { rows: [], excluded: 0 }
  }
  const balances = [...(tx.meta?.preTokenBalances ?? []), ...(tx.meta?.postTokenBalances ?? [])]
  const decimalsOf = (mint: string) =>
    balances.find((b) => b.mint === mint)?.uiTokenAmount.decimals ?? ctx.decimals?.(mint) ?? null

  const rows: TapeRow[] = []
  let excluded = 0
  for (const t of trades) {
    const listing = ctx.listing(t.event.symbol, t.stockMint)
    if (!listing) {
      excluded++
      continue
    }
    const qd = decimalsOf(t.quoteMint)
    const sd = decimalsOf(t.stockMint)
    if (qd === null || sd === null) throw new Error(`decimals unknown for ${t.event.symbol}`)
    // A fill's event names its legs from the user's side (see `OrderFilled`),
    // so which one is stock depends on the side. A cross names them outright.
    const sell = t.side === 'sell'
    const quoteRaw = t.side === 'cross' ? t.event.quote : sell ? t.event.amountOut : t.event.amountIn
    const stockRaw = t.side === 'cross' ? t.event.stock : sell ? t.event.amountIn : t.event.amountOut
    const notional = Number(quoteRaw) / 10 ** qd
    const cfg = ctx.scaled(t.stockMint)
    const multiplier = cfg ? multiplierAt(cfg, at) : null
    const shares = multiplier === null ? null : (Number(stockRaw) / 10 ** sd) * multiplier
    const paired = ctx.label(t.quoteMint)
    rows.push({
      time: iso(at),
      slot: tx.slot,
      symbol: listing.symbol,
      underlying: listing.underlying,
      stockMint: t.stockMint,
      paired,
      pairedMint: t.quoteMint,
      direction: t.side,
      contributed: sell ? listing.symbol : paired,
      withdrawn: sell ? paired : listing.symbol,
      priceUsd: shares ? round(notional / shares, 6) : null,
      shares: shares === null ? null : round(shares, 9),
      notionalUsd: notional,
      stockRaw: stockRaw.toString(),
      quoteRaw: quoteRaw.toString(),
      multiplier,
      // Divided rather than multiplied by a negative power: 10^-6 is not
      // exact in binary, and 772617876 × 1e-6 prints as 772.6178759999999.
      markPriceUsd:
        t.event.pxExpo < 0
          ? Number(t.event.pxNum) / 10 ** -t.event.pxExpo
          : Number(t.event.pxNum) * 10 ** t.event.pxExpo,
      markSource: t.event.source,
      markObservedAt: iso(t.event.markObservedAt),
      realizedBps: t.side === 'cross' ? 0 : t.event.realizedBps,
      order: t.side === 'cross' ? t.buyOrder : t.order,
      program: PROGRAM_ID,
      filler: t.side === 'cross' ? t.cranker : t.filler,
      signature,
      explorer: explorerTx(signature, ctx.cluster),
      ...(t.side === 'cross'
        ? { sellOrder: t.sellOrder, buyer: t.buyer, seller: t.seller }
        : sell
          ? { seller: t.owner }
          : { buyer: t.owner }),
    })
  }
  return { rows, excluded }
}

/**
 * The rows a tape request may see.
 *
 * With no wallet asked for, every row with its wallets taken off: the public
 * tape. With one, or a buyer and a seller, only the rows that wallet is a
 * party to, each carrying the asked-for wallet and no other. A cross names
 * both parties, so it is found by either one's request, and each is then
 * shown only its own side: a wallet's receipts are not a list of whom it
 * traded with. Buy and sell rows come back exactly as the tape holds them.
 */
export function rowsFor(rows: readonly TapeRow[], ask: { buyer?: string | null; seller?: string | null }): TapeRow[] {
  const { buyer, seller } = ask
  if (!buyer && !seller) return rows.map(({ buyer: _b, seller: _s, ...r }) => r)
  const out: TapeRow[] = []
  for (const r of rows) {
    const asBuyer = Boolean(buyer) && r.buyer === buyer
    const asSeller = Boolean(seller) && r.seller === seller
    if (!asBuyer && !asSeller) continue
    if (r.direction !== 'cross') {
      out.push(r)
      continue
    }
    const { buyer: b, seller: s, ...rest } = r
    out.push({ ...rest, ...(asBuyer ? { buyer: b } : {}), ...(asSeller ? { seller: s } : {}) })
  }
  return out
}

/** §II.G's "daily asset pair share volume": the 24 hours before `now`, per pair. */
export interface PairVolume {
  symbol: string
  paired: string
  trades: number
  shares: number
  notionalUsd: number
}

export function volume24h(rows: readonly TapeRow[], now: number): PairVolume[] {
  const since = now - 86_400
  const out = new Map<string, PairVolume>()
  for (const r of rows) {
    const t = Date.parse(r.time) / 1000
    if (t <= since || t > now) continue
    const key = `${r.symbol}/${r.paired}`
    const v = out.get(key) ?? { symbol: r.symbol, paired: r.paired, trades: 0, shares: 0, notionalUsd: 0 }
    v.trades++
    v.shares = round(v.shares + (r.shares ?? 0), 9)
    v.notionalUsd = round(v.notionalUsd + r.notionalUsd, 6)
    out.set(key, v)
  }
  return [...out.values()].sort((a, b) => (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0))
}

const CSV_COLUMNS = [
  'time', 'symbol', 'underlying', 'paired', 'direction', 'contributed', 'withdrawn',
  'priceUsd', 'shares', 'notionalUsd', 'stockRaw', 'quoteRaw', 'multiplier',
  'markPriceUsd', 'markSource', 'markObservedAt', 'realizedBps',
  'order', 'program', 'filler', 'stockMint', 'pairedMint', 'slot', 'signature', 'explorer',
] as const satisfies readonly (keyof TapeRow)[]

/** RFC 4180: a field is quoted when it holds a comma, a quote or a line break. */
function csvField(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v)
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s
}

export function toCsv(rows: readonly TapeRow[]): string {
  const lines = [CSV_COLUMNS.join(',')]
  for (const r of rows) lines.push(CSV_COLUMNS.map((c) => csvField(r[c])).join(','))
  return lines.join('\r\n') + '\r\n'
}

// ------------------------------------------------------------------- loading

/** A JSON-RPC call: method and params in, the `result` out. */
export type Rpc = (method: string, params: unknown[]) => Promise<unknown>

export interface Tape {
  venue: 'BELL'
  cluster: string
  program: string
  generatedAt: string
  windowFrom: string
  /** The addresses whose signatures were searched for fills: the listed marks' quote mints. */
  indexedBy: string[]
  /**
   * False while some transactions in the window have not been read yet — after
   * a restart, or when more landed than one refresh reads. The count says how
   * many; they are read on the next refreshes, newest first.
   */
  complete: boolean
  pending: number
  /**
   * Transactions holding a fill the tape could not render — logs that do not
   * line up with the instructions, or a mint whose decimals are unknown. Named
   * here rather than dropped silently.
   */
  unreadable: string[]
  /** Fills through this program of symbols BELL does not list. */
  excluded: number
  /**
   * Set when the last refresh failed, and the rows are then the last good
   * ones; or when it stopped reading transactions early, and `pending` counts
   * what it left.
   */
  error?: string
  notes: Record<string, string>
  volume24h: PairVolume[]
  rows: TapeRow[]
}

export const TAPE_DAYS = 30
/** How long a tape is served before the chain is asked again. */
export const TTL_MS = 60_000
/** `getSignaturesForAddress` pages, of at most 1,000, read per refresh. */
const MAX_PAGES = 5
const PAGE = 1_000
/**
 * Transactions read per refresh, how many at once, and the pause between
 * batches. Public devnet RPC answers a burst of `getTransaction` with 429.
 */
const MAX_TX_PER_REFRESH = 100
const BATCH = 2
const BATCH_GAP_MS = 250

interface Entry {
  blockTime: number | null
  state: 'pending' | 'done' | 'unreadable'
  rows: TapeRow[]
  excluded: number
}

interface SignatureInfo {
  signature: string
  err: unknown
  blockTime?: number | null
}

interface AccountInfo {
  data: [string, string]
}

/**
 * A tape that refreshes itself at most once a `TTL_MS`, however many ask.
 *
 * **Why fills are found through the quote mint, not the program.** The program
 * id's signature list is almost all keeper traffic: three transactions a tick,
 * one tick every 45 seconds. Measured on devnet at 03:05 UTC on 24 September,
 * its latest 1,000 signatures went back only 4.1 hours, so thirty days would be
 * some 170,000 signatures, each needing its own `getTransaction` to tell a fill
 * from an attestation. The quote mint had 27 signatures in its whole life. And
 * nothing is lost by asking it: `fill_order` names its order's quote mint as an
 * account, the program requires that to be the mark's, and each mark's quote
 * mint is fixed when it is opened, so every fill of a listed symbol appears in
 * its mark's quote mint's history. `fill_sell_order` names the quote mint the
 * same way under the same rule, and `cross_orders` names the buy's, which the
 * program requires to be the sell's and the mark's, so sells and crosses are
 * found by the same search. Which quote mints those are is read from the marks
 * themselves on every refresh, not configured.
 *
 * Transactions are immutable once finalized, so each is read once and kept for
 * as long as it is inside the window; a refresh walks back from the newest
 * signature only until it meets one it has already seen. Everything is read at
 * `finalized` commitment for the same reason: a kept result must not be undone
 * by a fork.
 */
export function createTape(opts: {
  rpc: Rpc
  cluster: string
  listings: readonly Listing[]
  label: (mint: string) => string
  /** Milliseconds since the epoch; injectable so a test can move time. */
  clock?: () => number
}): () => Promise<Tape> {
  const clock = opts.clock ?? Date.now
  const known = new Map<string, Entry>()
  /** Per indexed address, the `before` cursors a refresh ran out of pages at. */
  const holes = new Map<string, string[]>()
  let cache: { at: number; tape: Tape } | null = null
  let failure: { at: number; error: unknown } | null = null
  let inflight: Promise<Tape> | null = null

  const bySymbol = new Map(opts.listings.map((l) => [l.symbol, l]))

  async function refresh(): Promise<Tape> {
    const t = Math.floor(clock() / 1000)
    const cutoff = t - TAPE_DAYS * 86_400

    // One read for every listing's mark and stock mint: the marks name the
    // quote mints to search, the mints carry the multipliers that turn raw
    // amounts into shares.
    const markKeys = opts.listings.map((l) => markPda(l.symbol).toBase58())
    const mintKeys = opts.listings.map((l) => l.mint)
    const read = (await opts.rpc('getMultipleAccounts', [
      [...markKeys, ...mintKeys],
      { encoding: 'base64', commitment: 'finalized' },
    ])) as { value: (AccountInfo | null)[] }
    const quoteMints = new Set<string>()
    const scaled = new Map<string, ScaledUi | null>()
    opts.listings.forEach((l, i) => {
      const mark = read.value[i]
      if (mark) quoteMints.add(decodeSymbolMark(fromBase64(mark.data[0])).quoteMint.toBase58())
      const mint = read.value[markKeys.length + i]
      scaled.set(l.mint, mint ? scaledUiOf(fromBase64(mint.data[0])) : null)
    })

    // Walk each index back from its newest signature, and from wherever the
    // last refresh ran out of pages, until meeting a signature already seen,
    // the start of the window or the start of its history.
    let pages = MAX_PAGES
    const walk = async (address: string, before?: string): Promise<string | null> => {
      let cursor = before
      while (pages > 0) {
        pages--
        const page = (await opts.rpc('getSignaturesForAddress', [
          address,
          { limit: PAGE, commitment: 'finalized', ...(cursor ? { before: cursor } : {}) },
        ])) as SignatureInfo[]
        for (const s of page) {
          if (known.has(s.signature)) return null
          const blockTime = s.blockTime ?? null
          if (blockTime !== null && blockTime < cutoff) return null
          // A failed transaction filled nothing, so it is never fetched.
          known.set(s.signature, {
            blockTime,
            state: s.err === null || s.err === undefined ? 'pending' : 'done',
            rows: [],
            excluded: 0,
          })
        }
        if (page.length < PAGE) return null
        cursor = page[page.length - 1].signature
      }
      return cursor ?? null
    }
    for (const address of quoteMints) {
      const open: string[] = []
      const head = await walk(address)
      if (head) open.push(head)
      for (const hole of holes.get(address) ?? []) {
        const rest = await walk(address, hole)
        if (rest) open.push(rest)
      }
      holes.set(address, open)
    }

    for (const [sig, e] of known) if (e.blockTime !== null && e.blockTime < cutoff) known.delete(sig)

    const ctx: RowContext = {
      cluster: opts.cluster,
      listing: (symbol, stockMint) => {
        const l = bySymbol.get(symbol)
        return l && l.mint === stockMint ? l : null
      },
      label: opts.label,
      scaled: (mint) => scaled.get(mint) ?? null,
    }
    // Newest first, so a backlog fills in from the present backwards. An entry
    // with no block time yet sorts first; it can only be recent.
    const newestFirst = (e: Entry) => e.blockTime ?? Number.MAX_SAFE_INTEGER
    const pending = [...known]
      .filter(([, e]) => e.state === 'pending')
      .sort(([, a], [, b]) => newestFirst(b) - newestFirst(a))
      .slice(0, MAX_TX_PER_REFRESH)
    // A refused read stops this refresh's reading rather than failing it: what
    // was read is kept, the rest stays pending for the next refresh, and the
    // tape says so. Pressing on after a 429 only earns more of them. (An object
    // rather than a `let`, because the callbacks set it, and TypeScript would
    // narrow a `let` to forever null out here.)
    const reading = { refused: null as string | null }
    for (let i = 0; i < pending.length && !reading.refused; i += BATCH) {
      if (i > 0) await new Promise((r) => setTimeout(r, BATCH_GAP_MS))
      await Promise.all(
        pending.slice(i, i + BATCH).map(async ([sig, e]) => {
          let tx: RpcTransaction | null
          try {
            tx = (await opts.rpc('getTransaction', [
              sig,
              { encoding: 'json', maxSupportedTransactionVersion: 0, commitment: 'finalized' },
            ])) as RpcTransaction | null
          } catch (err) {
            reading.refused ??= (err as Error).message
            return
          }
          if (!tx) return // not served yet; stays pending
          try {
            const { rows, excluded } = tapeRows(tx, ctx)
            e.rows = rows
            e.excluded = excluded
            e.state = 'done'
          } catch {
            e.state = 'unreadable'
          }
          e.blockTime = tx.blockTime ?? e.blockTime
        }),
      )
    }

    const entries = [...known.entries()]
    const rows = entries
      .flatMap(([, e]) => e.rows)
      .sort((a, b) => (a.time < b.time ? 1 : a.time > b.time ? -1 : b.slot - a.slot))
    const waiting = entries.filter(([, e]) => e.state === 'pending').length
    const unfinished = [...holes.values()].some((h) => h.length > 0)
    return {
      venue: 'BELL',
      cluster: opts.cluster,
      program: PROGRAM_ID,
      generatedAt: iso(t),
      windowFrom: iso(cutoff),
      indexedBy: [...quoteMints],
      complete: waiting === 0 && !unfinished,
      pending: waiting,
      unreadable: entries.filter(([, e]) => e.state === 'unreadable').map(([s]) => s),
      excluded: entries.reduce((n, [, e]) => n + e.excluded, 0),
      ...(reading.refused
        ? { error: `stopped reading transactions, ${waiting} left for the next refresh: ${reading.refused}` }
        : {}),
      notes: notes(opts.cluster),
      volume24h: volume24h(rows, t),
      rows,
    }
  }

  /**
   * At most one refresh per `TTL_MS`, successful or not. A failure is held for
   * the same minute as a success: retrying on every request while the RPC is
   * refusing would be exactly the hammering the minute exists to prevent. The
   * last good tape is served meanwhile, saying why it is not newer.
   */
  return async function tape(): Promise<Tape> {
    const now = clock()
    if (cache && now - cache.at < TTL_MS) return cache.tape
    if (failure && now - failure.at < TTL_MS) {
      if (cache) return cache.tape
      throw failure.error
    }
    inflight ??= refresh()
      .then((fresh) => {
        cache = { at: clock(), tape: fresh }
        failure = null
        return fresh
      })
      .catch((e: unknown) => {
        failure = { at: clock(), error: e }
        if (!cache) throw e
        cache = { at: cache.at, tape: { ...cache.tape, error: (e as Error).message } }
        return cache.tape
      })
      .finally(() => {
        inflight = null
      })
    return inflight
  }
}

/** What a reader needs to know to use the numbers, published with them. */
function notes(cluster: string): Record<string, string> {
  return {
    scope:
      'Every fill_order, fill_sell_order and cross_orders of a listed symbol that finalized in the window. ' +
      'BELL has no liquidity pool: on a buy a filler delivers the stock from its own inventory and is paid ' +
      'by the buyer’s delegation, on a sell it pays the quote and takes the stock by the seller’s ' +
      'delegation, and on a cross a buyer and a seller settle directly by their own delegations, with no ' +
      'filler. So there is no pool size to report and the program address stands in for a pool contract.',
    price:
      'priceUsd is notionalUsd divided by the shares bought or sold, where shares are raw units times the ' +
      'stock mint’s scaled-UI multiplier in force at the block time. markPriceUsd is the attested ' +
      'price the program measured the fill against.',
    usd:
      cluster === 'mainnet'
        ? 'The paired asset is USDC, counted at one dollar.'
        : 'The paired asset is demo-USDC, a devnet token with no value. It is counted at one dollar ' +
          'only so the arithmetic is the one mainnet USDC would use.',
    direction:
      'A buy contributes the paired asset and withdraws the stock; a sell contributes the stock and ' +
      'withdraws the paired asset. A cross is one row for both: the buyer contributed the paired asset ' +
      'and withdrew the stock, the seller the reverse, at the attested mark with no filler spread; its ' +
      'contributed and withdrawn are the buyer’s, and its order is the buy order.',
    time: 'The block time the cluster reports for the transaction, in UTC.',
    freshness:
      `Refreshed at most once a minute, at finalized commitment. A fill reaches the tape on the first ` +
      `request after it finalizes and the minute is up.`,
  }
}
