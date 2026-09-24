/**
 * The public tape: every BELL fill in the last thirty days, in the shape §II.G
 * of SEC Order 34-106402 gives a transaction report.
 *
 * §II.G asks a Tokenized Securities Venue to publish, free and machine-readable,
 * for every transaction in the past thirty days and within ten minutes of it:
 * the symbol and its paired asset, the price, the size, the time at the pool in
 * UTC and the direction, plus the smart contract's address. BELL is not a TSV
 * and makes no claim to meet the order (see NOTICE.md). It publishes this
 * because every number here is already public on chain, and a venue that says
 * "the transaction is the record" should make the record easy to read.
 *
 * Everything below `fillsOf` is pure: a transaction as the RPC returns it goes
 * in, rows come out. The loader at the bottom is the only part that talks to
 * the network, and it takes its transport as an argument so tests can stand in
 * for the RPC.
 */
import idl from '../../src/chain/idl.json' with { type: 'json' }
import { decodeSymbolMark } from '../../src/chain/codec.ts'
import { markPda } from '../../src/chain/client.ts'
import type { Listing } from '../../src/listings.ts'

export const PROGRAM_ID: string = idl.address

/** Mainnet USDC, the only quote asset here that is worth a dollar. */
const USDC_MAINNET = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'

/**
 * A quote mint's name on the tape: USDC for mainnet USDC, demo-USDC for the
 * deployment's own demo quote asset, and otherwise the address itself, so an
 * unknown asset is never given a name it has not earned.
 */
export const quoteLabel = (mint: string, demoQuoteMint: string | undefined): string =>
  mint === USDC_MAINNET ? 'USDC' : mint === demoQuoteMint ? 'demo-USDC' : mint

// Read from the IDL rather than restated, for the reason codec.ts gives: a
// program change that moved one of these is caught here, not on the tape.
const FILL_IX = idl.instructions.find((i) => i.name === 'fill_order')
const FILLED_EVENT = idl.events.find((e) => e.name === 'OrderFilled')
if (!FILL_IX || !FILLED_EVENT) throw new Error('fill_order or OrderFilled missing from the IDL')
const FILL_DISCRIMINATOR = Uint8Array.from(FILL_IX.discriminator)
const EVENT_DISCRIMINATOR = Uint8Array.from(FILLED_EVENT.discriminator)
/** Where each account sits in a `fill_order` instruction, by its IDL name. */
const FILL_ACCOUNT = Object.fromEntries(FILL_IX.accounts.map((a, i) => [a.name, i])) as Record<string, number>
// The sell side's pair. Its accounts are declared with the same names in the
// same order as `fill_order`'s, but they are looked up by name from their own
// instruction all the same, so a reordering there cannot misattribute a sell.
const SELL_FILL_IX = idl.instructions.find((i) => i.name === 'fill_sell_order')
const SELL_FILLED_EVENT = idl.events.find((e) => e.name === 'SellOrderFilled')
if (!SELL_FILL_IX || !SELL_FILLED_EVENT) throw new Error('fill_sell_order or SellOrderFilled missing from the IDL')
const SELL_FILL_DISCRIMINATOR = Uint8Array.from(SELL_FILL_IX.discriminator)
const SELL_EVENT_DISCRIMINATOR = Uint8Array.from(SELL_FILLED_EVENT.discriminator)
const SELL_FILL_ACCOUNT = Object.fromEntries(SELL_FILL_IX.accounts.map((a, i) => [a.name, i])) as Record<string, number>
const MARK_SOURCES: readonly string[] =
  (idl.types.find((t) => t.name === 'MarkSource')?.type as { variants?: { name: string }[] } | undefined)
    ?.variants?.map((v) => v.name) ?? []

// ------------------------------------------------------------------ encodings

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

/** Base58, as instruction data arrives in the RPC's `json` encoding. */
export function fromBase58(s: string): Uint8Array {
  let n = 0n
  for (const c of s) {
    const d = B58.indexOf(c)
    if (d < 0) throw new Error(`not base58: ${s}`)
    n = n * 58n + BigInt(d)
  }
  const bytes: number[] = []
  while (n > 0n) {
    bytes.unshift(Number(n & 0xffn))
    n >>= 8n
  }
  for (const c of s) {
    if (c !== '1') break
    bytes.unshift(0)
  }
  return Uint8Array.from(bytes)
}

function fromBase64(s: string): Uint8Array {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0))
}

const startsWith = (b: Uint8Array, prefix: Uint8Array) =>
  b.length >= prefix.length && prefix.every((x, i) => b[i] === x)

// ---------------------------------------------------------------------- event

/**
 * `OrderFilled`, as the program emits it (state.rs), and `SellOrderFilled`,
 * which has the same fields in the same order.
 *
 * On a buy `amountIn` is quote and `amountOut` stock; on a sell it is the other
 * way round, `amountIn` the stock taken and `amountOut` the quote paid. In both,
 * the "in" leg is what left the user and the "out" leg what reached them.
 */
export interface OrderFilled {
  symbol: string
  amountIn: bigint
  /** What actually landed in the user's account, measured by the program. */
  amountOut: bigint
  /** The mark that priced the fill: `pxNum × 10^pxExpo` quote units per share. */
  pxNum: bigint
  pxExpo: number
  source: string
  markObservedAt: number
  realizedBps: number
}

/**
 * Decode one `Program data:` payload, or return null when it is not an
 * `OrderFilled`. The owner and filler keys are skipped: the filler is read from
 * the instruction instead, and the buyer is left off the tape (see `TapeRow`).
 */
export const decodeOrderFilled = (data: Uint8Array): OrderFilled | null => decodeFillEvent(data, EVENT_DISCRIMINATOR)

/** The same for a `SellOrderFilled`, whose payload differs only in its first eight bytes. */
export const decodeSellOrderFilled = (data: Uint8Array): OrderFilled | null =>
  decodeFillEvent(data, SELL_EVENT_DISCRIMINATOR)

function decodeFillEvent(data: Uint8Array, discriminator: Uint8Array): OrderFilled | null {
  // discriminator 8, symbol 12, owner 32, filler 32, three u64, i32, u8, i64, u16
  if (!startsWith(data, discriminator) || data.length < 123) return null
  const d = new DataView(data.buffer, data.byteOffset, data.byteLength)
  let o = 8
  const symbol = new TextDecoder().decode(data.subarray(o, o + 12)).trimEnd()
  o += 12 + 32 + 32
  const amountIn = d.getBigUint64(o, true)
  const amountOut = d.getBigUint64(o + 8, true)
  const pxNum = d.getBigUint64(o + 16, true)
  const pxExpo = d.getInt32(o + 24, true)
  const source = d.getUint8(o + 28)
  const markObservedAt = Number(d.getBigInt64(o + 29, true))
  const realizedBps = d.getUint16(o + 37, true)
  return {
    symbol,
    amountIn,
    amountOut,
    pxNum,
    pxExpo,
    source: MARK_SOURCES[source] ?? `source ${source}`,
    markObservedAt,
    realizedBps,
  }
}

// ---------------------------------------------------------------- transaction

/** One instruction as the RPC's `json` encoding gives it. */
export interface RpcInstruction {
  programIdIndex: number
  accounts: number[]
  /** Base58. */
  data: string
}

interface RpcTokenBalance {
  mint: string
  uiTokenAmount: { decimals: number }
}

/** `getTransaction` with `encoding: 'json'`, as far as the tape reads it. */
export interface RpcTransaction {
  slot: number
  blockTime: number | null
  meta: {
    err: unknown
    logMessages?: string[] | null
    innerInstructions?: { index: number; instructions: RpcInstruction[] }[] | null
    loadedAddresses?: { writable: string[]; readonly: string[] } | null
    preTokenBalances?: RpcTokenBalance[] | null
    postTokenBalances?: RpcTokenBalance[] | null
  } | null
  transaction: {
    signatures: string[]
    message: { accountKeys: string[]; instructions: RpcInstruction[] }
  }
}

/** A fill, with the accounts its instruction named. */
export interface Fill {
  /** `fill_order` is a buy, `fill_sell_order` a sell. */
  side: 'buy' | 'sell'
  event: OrderFilled
  order: string
  /** The order's owner: the buyer, or on a sell the seller. Kept off the public tape; see `TapeRow.buyer`. */
  owner: string
  filler: string
  quoteMint: string
  stockMint: string
}

const INVOKE = /^Program (\S+) invoke \[\d+\]$/
const EXIT = /^Program (\S+) (success|failed)/
const DATA = 'Program data: '

/** How each fill instruction is read: its side, its event, and where its accounts sit. */
const FILL_KINDS = [
  { side: 'buy', ix: FILL_DISCRIMINATOR, decode: decodeOrderFilled, account: FILL_ACCOUNT },
  { side: 'sell', ix: SELL_FILL_DISCRIMINATOR, decode: decodeSellOrderFilled, account: SELL_FILL_ACCOUNT },
] as const

/**
 * Every `fill_order` and `fill_sell_order` in a transaction, with the event
 * each one emitted.
 *
 * An event is only believed when BELL itself logged it. `Program data:` lines
 * carry no author, and any program in the same transaction can write one with
 * the right eight bytes in front — so the logs are walked as a call stack, and
 * a payload counts only while the frame on top is BELL executing a fill. The
 * event must also be the one that instruction emits: an `OrderFilled` inside
 * `fill_sell_order`, or a `SellOrderFilled` inside `fill_order`, is not a fill,
 * because the program never writes either, and believing one would print a
 * sale as a purchase.
 * The same walk ties each event to its instruction: every instruction, top
 * level or cross-program, logs exactly one `invoke` line, in execution order,
 * so the n-th `invoke` is the n-th instruction of the flattened list. That is
 * where the order's address comes from; the event does not carry it.
 *
 * Throws rather than guess when the logs and the instructions do not line up,
 * which is what a truncated log looks like. A fill left off the tape and
 * counted as unreadable is honest; one attributed to the wrong order is not.
 */
export function fillsOf(tx: RpcTransaction): Fill[] {
  const meta = tx.meta
  // A failed transaction changed nothing, whatever its logs say.
  if (!meta || (meta.err !== null && meta.err !== undefined)) return []
  const logs = meta.logMessages ?? []
  if (logs.some((l) => l.startsWith('Log truncated'))) throw new Error('log truncated')

  const keys = [
    ...tx.transaction.message.accountKeys,
    ...(meta.loadedAddresses?.writable ?? []),
    ...(meta.loadedAddresses?.readonly ?? []),
  ]
  const inner = new Map((meta.innerInstructions ?? []).map((g) => [g.index, g.instructions]))
  const flat: RpcInstruction[] = []
  tx.transaction.message.instructions.forEach((ix, i) => flat.push(ix, ...(inner.get(i) ?? [])))

  const fills: Fill[] = []
  const stack: { program: string; ix: RpcInstruction }[] = []
  let next = 0
  for (const line of logs) {
    const invoke = INVOKE.exec(line)
    if (invoke) {
      const ix = flat[next++]
      if (!ix || keys[ix.programIdIndex] !== invoke[1]) {
        throw new Error(`log invokes ${invoke[1]} where instruction ${next - 1} is not it`)
      }
      stack.push({ program: invoke[1], ix })
      continue
    }
    if (EXIT.test(line)) {
      stack.pop()
      continue
    }
    if (!line.startsWith(DATA)) continue
    const top = stack.at(-1)
    if (!top || top.program !== PROGRAM_ID) continue
    const ixData = fromBase58(top.ix.data)
    const kind = FILL_KINDS.find((k) => startsWith(ixData, k.ix))
    if (!kind) continue
    // sol_log_data writes one base64 field per slice; Anchor's emit! uses one.
    const event = kind.decode(fromBase64(line.slice(DATA.length).split(' ')[0]))
    if (!event) continue
    const account = (name: string) => keys[top.ix.accounts[kind.account[name]]]
    fills.push({
      side: kind.side,
      event,
      order: account('order'),
      owner: account('owner'),
      filler: account('filler'),
      quoteMint: account('quote_mint'),
      stockMint: account('stock_mint'),
    })
  }
  return fills
}

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
   * `symbol` and withdraws `paired`.
   */
  direction: 'buy' | 'sell'
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
   * stock a buy received, or the quote a sell was paid.
   */
  realizedBps: number
  order: string
  program: string
  filler: string
  signature: string
  explorer: string
  /**
   * The buyer's wallet. Never in the public tape: the route strips it, and
   * returns it only to a request for one buyer's own fills (`?buyer=`), which is
   * how the page shows you your receipts. Anyone can follow `signature` to the
   * same address, so this reveals nothing — but the default view is not an index.
   * Set on buys only.
   */
  buyer?: string
  /**
   * The seller's wallet, on sells only, and kept off the public tape exactly as
   * `buyer` is. A separate field rather than `buyer` reused, so a request for
   * one wallet's purchases can never return its sales as though they were.
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
 * A transaction's fills as tape rows, and how many it left off because they
 * were not fills of a listed security.
 *
 * `register_symbol` and `open_mark` are permissionless, so anyone can create a
 * ticker, attest its price as its own attestor and fill against it through this
 * same program. Those are not BELL's listings, and a tape that printed them
 * would let a stranger write whatever price they liked onto BELL's record. A
 * fill is kept only when its symbol is listed and its stock mint is the one
 * that listing is pinned to.
 */
export function tapeRows(tx: RpcTransaction, ctx: RowContext): { rows: TapeRow[]; excluded: number } {
  const signature = tx.transaction.signatures[0]
  const at = tx.blockTime
  const fills = fillsOf(tx)
  if (at === null) {
    if (fills.length) throw new Error('no block time')
    return { rows: [], excluded: 0 }
  }
  const balances = [...(tx.meta?.preTokenBalances ?? []), ...(tx.meta?.postTokenBalances ?? [])]
  const decimalsOf = (mint: string) =>
    balances.find((b) => b.mint === mint)?.uiTokenAmount.decimals ?? ctx.decimals?.(mint) ?? null

  const rows: TapeRow[] = []
  let excluded = 0
  for (const f of fills) {
    const listing = ctx.listing(f.event.symbol, f.stockMint)
    if (!listing) {
      excluded++
      continue
    }
    const qd = decimalsOf(f.quoteMint)
    const sd = decimalsOf(f.stockMint)
    if (qd === null || sd === null) throw new Error(`decimals unknown for ${f.event.symbol}`)
    // Each event names its legs from the user's side (see `OrderFilled`), so
    // which one is stock depends on the side.
    const sell = f.side === 'sell'
    const quoteRaw = sell ? f.event.amountOut : f.event.amountIn
    const stockRaw = sell ? f.event.amountIn : f.event.amountOut
    const notional = Number(quoteRaw) / 10 ** qd
    const cfg = ctx.scaled(f.stockMint)
    const multiplier = cfg ? multiplierAt(cfg, at) : null
    const shares = multiplier === null ? null : (Number(stockRaw) / 10 ** sd) * multiplier
    const paired = ctx.label(f.quoteMint)
    rows.push({
      time: iso(at),
      slot: tx.slot,
      symbol: listing.symbol,
      underlying: listing.underlying,
      stockMint: f.stockMint,
      paired,
      pairedMint: f.quoteMint,
      direction: f.side,
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
        f.event.pxExpo < 0
          ? Number(f.event.pxNum) / 10 ** -f.event.pxExpo
          : Number(f.event.pxNum) * 10 ** f.event.pxExpo,
      markSource: f.event.source,
      markObservedAt: iso(f.event.markObservedAt),
      realizedBps: f.event.realizedBps,
      order: f.order,
      program: PROGRAM_ID,
      filler: f.filler,
      signature,
      explorer: explorerTx(signature, ctx.cluster),
      ...(sell ? { seller: f.owner } : { buyer: f.owner }),
    })
  }
  return { rows, excluded }
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
 * same way under the same rule, so sells are found by the same search. Which
 * quote mints those are is read from the marks themselves on every refresh,
 * not configured.
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
      'Every fill_order and fill_sell_order of a listed symbol that finalized in the window. BELL has ' +
      'no liquidity pool: on a buy a filler delivers the stock from its own inventory and is paid by the ' +
      'buyer’s delegation, and on a sell it pays the quote and takes the stock by the seller’s delegation, ' +
      'so there is no pool size to report and the program address stands in for a pool contract.',
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
      'withdraws the paired asset.',
    time: 'The block time the cluster reports for the transaction, in UTC.',
    freshness:
      `Refreshed at most once a minute, at finalized commitment. A fill reaches the tape on the first ` +
      `request after it finalizes and the minute is up.`,
  }
}
