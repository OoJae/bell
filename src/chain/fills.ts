/**
 * BELL's fills, read out of a transaction as the RPC returns it.
 *
 * Two readers share this. The public tape (`web/lib/tape.ts`) prints every
 * fill, and the keeper's per-wallet alerts (`src/alerts.ts`) tell a wallet's
 * followers about its own. It lives under `src/` because the keeper's image
 * holds only `src/` and `scripts/`, and the tape re-exports it, so the two
 * read a transaction the same way: neither can believe a fill the other would
 * refuse.
 *
 * Pure: a transaction goes in, fills come out. Nothing here talks to the
 * network.
 */
import idl from './idl.json' with { type: 'json' }

/** The program's address, as a string: what the RPC's account lists hold. */
export const PROGRAM_ADDRESS: string = idl.address

// Read from the IDL rather than restated, for the reason codec.ts gives: a
// program change that moved one of these is caught here, at import, not on
// the tape or in someone's messages.
function discriminator(kind: 'instructions' | 'events', name: string): Uint8Array {
  const found = (idl[kind] as { name: string; discriminator: number[] }[]).find((x) => x.name === name)
  if (!found) throw new Error(`${name} missing from the IDL`)
  return Uint8Array.from(found.discriminator)
}

/** Where each named account sits in an instruction. Throws at import if one a reader needs is gone. */
function accountIndex(instruction: string, needed: readonly string[]): Record<string, number> {
  const ix = idl.instructions.find((i) => i.name === instruction)
  if (!ix) throw new Error(`${instruction} missing from the IDL`)
  const index = Object.fromEntries(ix.accounts.map((a, i) => [a.name, i])) as Record<string, number>
  for (const name of needed) {
    if (index[name] === undefined) throw new Error(`${instruction} has no account ${name} in the IDL`)
  }
  return index
}

const EVENT_DISCRIMINATOR = discriminator('events', 'OrderFilled')
const SELL_EVENT_DISCRIMINATOR = discriminator('events', 'SellOrderFilled')
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

/** Base64, as account data and event payloads arrive. */
export function fromBase64(s: string): Uint8Array {
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
 * `OrderFilled`. The owner and filler keys are skipped: both are read from the
 * instruction instead, where the program itself checked them.
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

export interface RpcTokenBalance {
  mint: string
  uiTokenAmount: { decimals: number }
}

/** `getTransaction` with `encoding: 'json'`, as far as the fill readers read it. */
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

/**
 * How one BELL instruction's event is read, resolved against the IDL once, at
 * import.
 *
 * This is the extension point. An instruction that crosses a buy order with a
 * sell order directly, emitting something like `OrdersCrossed`, is one more
 * kind: its instruction's discriminator, and a `read` that checks the payload
 * is that event and returns a record for each order it settled, so that each
 * owner is told about their own side. The walk in `eventsOf`, which decides
 * which payloads are believed at all, does not change.
 */
export interface EventKind<T> {
  /** The instruction's discriminator. A payload is only read inside this instruction. */
  instruction: Uint8Array
  /** Where each of the instruction's accounts sits, by its IDL name. */
  accounts: Readonly<Record<string, number>>
  /**
   * The records one payload makes, or none when it is not this instruction's
   * own event. `account` names the instruction's accounts by their IDL names.
   */
  read: (payload: Uint8Array, account: (name: string) => string) => readonly T[]
}

const INVOKE = /^Program (\S+) invoke \[\d+\]$/
const EXIT = /^Program (\S+) (success|failed)/
const DATA = 'Program data: '

/**
 * Every event of the given kinds in a transaction, in the order the program
 * emitted them.
 *
 * An event is only believed when BELL itself logged it. `Program data:` lines
 * carry no author, and any program in the same transaction can write one with
 * the right eight bytes in front — so the logs are walked as a call stack, and
 * a payload counts only while the frame on top is BELL executing one of the
 * kinds' instructions. Each kind's `read` then insists on its own event, so a
 * payload the instruction never writes is not believed either.
 *
 * The same walk ties each event to its instruction: every instruction, top
 * level or cross-program, logs exactly one `invoke` line, in execution order,
 * so the n-th `invoke` is the n-th instruction of the flattened list. That is
 * where the accounts come from; the event does not carry them.
 *
 * Throws rather than guess when the logs and the instructions do not line up,
 * which is what a truncated log looks like. A fill left unread and counted as
 * such is honest; one attributed to the wrong order is not.
 */
export function eventsOf<T>(tx: RpcTransaction, kinds: readonly EventKind<T>[]): T[] {
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

  const out: T[] = []
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
    if (!top || top.program !== PROGRAM_ADDRESS) continue
    const ixData = fromBase58(top.ix.data)
    const kind = kinds.find((k) => startsWith(ixData, k.instruction))
    if (!kind) continue
    // sol_log_data writes one base64 field per slice; Anchor's emit! uses one.
    const payload = fromBase64(line.slice(DATA.length).split(' ')[0])
    out.push(...kind.read(payload, (name) => keys[top.ix.accounts[kind.accounts[name]]]))
  }
  return out
}

/**
 * A kind for `instruction`, with the accounts its `read` names checked against
 * the IDL now rather than found missing in a transaction later.
 */
export function eventKind<T>(
  instruction: string,
  accounts: readonly string[],
  read: EventKind<T>['read'],
): EventKind<T> {
  return { instruction: discriminator('instructions', instruction), accounts: accountIndex(instruction, accounts), read }
}

// ---------------------------------------------------------------------- fills

/** A fill, with the accounts its instruction named. */
export interface Fill {
  /** `fill_order` is a buy, `fill_sell_order` a sell. */
  side: 'buy' | 'sell'
  event: OrderFilled
  order: string
  /** The order's owner: the buyer, or on a sell the seller. Kept off the public tape; see `TapeRow.buyer` in web/lib/tape.ts. */
  owner: string
  filler: string
  quoteMint: string
  stockMint: string
}

const FILL_ACCOUNTS = ['order', 'owner', 'filler', 'quote_mint', 'stock_mint'] as const

/**
 * A fill instruction as a kind. The sell side's accounts are declared with the
 * same names in the same order as `fill_order`'s, but each is looked up by name
 * from its own instruction all the same, so a reordering there cannot
 * misattribute a sale.
 */
const fillKind = (side: Fill['side'], instruction: string, decode: (d: Uint8Array) => OrderFilled | null) =>
  eventKind<Fill>(instruction, FILL_ACCOUNTS, (payload, account) => {
    const event = decode(payload)
    if (!event) return []
    return [
      {
        side,
        event,
        order: account('order'),
        owner: account('owner'),
        filler: account('filler'),
        quoteMint: account('quote_mint'),
        stockMint: account('stock_mint'),
      },
    ]
  })

/** How each fill instruction is read: its side, its own event, and its accounts. */
export const FILL_KINDS: readonly EventKind<Fill>[] = [
  fillKind('buy', 'fill_order', decodeOrderFilled),
  fillKind('sell', 'fill_sell_order', decodeSellOrderFilled),
]

/**
 * Every `fill_order` and `fill_sell_order` in a transaction, with the event
 * each one emitted, by the rules `eventsOf` gives. An `OrderFilled` inside
 * `fill_sell_order`, or a `SellOrderFilled` inside `fill_order`, is not a fill,
 * because the program never writes either, and believing one would print a
 * sale as a purchase.
 */
export const fillsOf = (tx: RpcTransaction): Fill[] => eventsOf(tx, FILL_KINDS)
