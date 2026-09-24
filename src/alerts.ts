/**
 * Per-wallet alerts: a Telegram direct message when a wallet someone follows
 * has an order filled or crossed on BELL.
 *
 * The keeper runs this because it is the one BELL service that is always on
 * and keeps storage. The channel (`notify.ts`) tells everyone about every
 * fill. This tells a chat about the wallets it asked for, and nothing else.
 *
 * Following a wallet. The page's footer links to
 * https://t.me/Bell_solbot?start=<wallet>. Telegram opens a private chat with
 * the bot, and pressing Start sends it "/start <wallet>". The keeper reads that
 * with `getUpdates` and stores the pair in its database (`record.ts`).
 * "/stop <wallet>" drops one wallet, "/stop" drops them all, and "/list" says
 * which ones the chat follows.
 *
 * What following is and is not. It is not a claim to own the wallet, and the
 * bot never asks for one. Anyone can follow any wallet, because every fill is
 * public on chain already, and the bot says so when it confirms. It reads; it
 * cannot sign, trade or move anything.
 *
 * Finding fills. After each armed tick, the program's signatures since the last
 * one read are listed at finalized commitment. Each new transaction is read
 * once and its fills and crosses decoded by `chain/fills.ts` (`tradesOf`), the
 * same reader the public tape uses. The keeper knows its own attestations by
 * signature and never fetches them, so a quiet tick costs one or two requests.
 * A wallet's fills are the ones whose order it owns. A cross settles one
 * wallet's buy order against another's sell order, so it is two messages: the
 * buyer's followers are told the wallet bought, the seller's that it sold, and
 * neither message carries the other party's wallet. A fill or cross of a
 * symbol BELL does not list, or at a stock mint other than the one that
 * listing is pinned to, is not a BELL trade and gets no message, as on the
 * tape.
 *
 * Never part of the venue. The keeper starts a pass and does not wait for it.
 * Only one pass runs at a time, its reading stops after twenty seconds, and it
 * never throws. A missed message costs nothing the chain, the tape and the
 * channel do not still show.
 *
 * Environment: BELL_TELEGRAM_BOT_TOKEN, the channel's own bot. Without it
 * everything here does nothing. BELL_TELEGRAM_CHAT_ID is not needed.
 *
 * One reader of `getUpdates` per bot. A second process polling the same token
 * gets HTTP 409, and each takes updates the other then never sees. So only an
 * armed keeper polls: a dry run on a laptop with the token in its environment
 * would otherwise answer, and store, follows the hosted keeper knows nothing of.
 */
import { PublicKey } from '@solana/web3.js'
import { multiplierOf, type TokenRisk } from './chain/codec.ts'
import { PROGRAM_ADDRESS, tradesOf, type Cross, type Fill, type RpcTransaction, type Trade } from './chain/fills.ts'
import type { Listing } from './listings.ts'
import {
  formatMessage,
  minutesAfterBell,
  shortKey,
  telegram,
  type NotifyEvent,
  type TelegramOutcome,
} from './notify.ts'

type Fetch = (url: string, init: RequestInit) => Promise<Response>
type Env = Readonly<Record<string, string | undefined>>

/** What `alerts.ts` keeps between passes. `Recorder` in record.ts is the real one. */
export interface AlertStore {
  follow(chatId: string, wallet: string, since: number): boolean
  unfollow(chatId: string, wallet?: string): number
  following(chatId: string): string[]
  followers(wallet: string): string[]
  followed(): Set<string>
  alertCursor(name: string): string | null
  setAlertCursor(name: string, value: string): void
  seen(signature: string): boolean
  claim(signature: string, at: number): boolean
  forgetSeen(before: number): number
}

// ------------------------------------------------------------------ commands

export type Command =
  | { kind: 'start'; wallet: string }
  /** `wallet` null means every wallet the chat follows. */
  | { kind: 'stop'; wallet: string | null }
  | { kind: 'list' }
  | { kind: 'help' }
  /** A /start or /stop whose argument is not a wallet address. */
  | { kind: 'invalid'; input: string }

/**
 * A wallet address as typed, if it is one: base58 that decodes to exactly 32
 * bytes, written the one way base58 writes those bytes. Any 32 bytes are a
 * public key; being on the curve is not required, since a program-owned vault
 * can own orders too.
 */
export function walletOf(s: string): string | null {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s)) return null
  try {
    return new PublicKey(s).toBase58() === s ? s : null
  } catch {
    return null
  }
}

/**
 * A private message to the bot, as a command.
 *
 * Exactly one argument or none: "/start <wallet> please" is refused rather
 * than read as the first word, so a chat never follows a wallet it did not
 * name exactly. Anything that is not a command gets the help text.
 */
export function parseCommand(text: string): Command {
  const [head = '', ...args] = text.trim().split(/\s+/)
  // "/start@Bell_solbot" is how a command arrives when picked from a menu.
  const name = /^\/([a-z]+)(?:@\w+)?$/i.exec(head)?.[1]?.toLowerCase()
  if (name === 'start' || name === 'stop') {
    if (args.length === 0) return name === 'start' ? { kind: 'help' } : { kind: 'stop', wallet: null }
    const wallet = args.length === 1 ? walletOf(args[0]) : null
    if (!wallet) return { kind: 'invalid', input: args.join(' ') }
    return name === 'start' ? { kind: 'start', wallet } : { kind: 'stop', wallet }
  }
  if (name === 'list') return { kind: 'list' }
  return { kind: 'help' }
}

/** The most wallets one chat can follow: plenty for someone's own, too few to mirror the tape. */
export const MAX_FOLLOWS = 20

const CHANNEL = 'https://t.me/bellfills'
const PUBLIC =
  'Anyone can follow any wallet. Fills are public on chain, so these messages show nothing the chain does ' +
  'not, and following a wallet does not mean you own it. The bot only reads: it cannot trade or move anything.'

/**
 * Carry out one command for one chat and say what happened.
 *
 * Every change is safe to repeat, because the keeper can see an update twice:
 * following a wallet twice is one follow, and stopping twice stops once.
 */
export function reply(store: AlertStore, chatId: string, cmd: Command, now: number, cluster: string): string {
  switch (cmd.kind) {
    case 'start': {
      const already = store.following(chatId)
      if (!already.includes(cmd.wallet) && already.length >= MAX_FOLLOWS) {
        return `This chat already follows ${MAX_FOLLOWS} wallets, the most one chat can. Send /list to see them, and /stop followed by one of them to make room.`
      }
      store.follow(chatId, cmd.wallet, now)
      return [
        `Following ${cmd.wallet} on BELL (${cluster}).`,
        'This chat gets a message when one of its orders fills, a buy or a sale, including one crossed with another wallet’s order.',
        PUBLIC,
        'Send /stop to stop every message, or /stop followed by an address to stop one wallet.',
      ].join('\n\n')
    }
    case 'stop': {
      if (cmd.wallet === null) {
        return store.unfollow(chatId) > 0
          ? 'Stopped. This chat no longer follows any wallet.'
          : 'This chat was not following any wallet.'
      }
      return store.unfollow(chatId, cmd.wallet) > 0
        ? `Stopped following ${cmd.wallet}.`
        : `This chat was not following ${cmd.wallet}.`
    }
    case 'list': {
      const wallets = store.following(chatId)
      return wallets.length > 0
        ? ['This chat follows:', ...wallets].join('\n')
        : 'This chat follows no wallets. Send /start followed by an address to follow one.'
    }
    case 'invalid': {
      const shown = cmd.input.length > 60 ? `${cmd.input.slice(0, 59)}…` : cmd.input
      return `"${shown}" is not a Solana wallet address. Send /start followed by one, or use the "alerts for this wallet" link at the foot of the BELL page.`
    }
    case 'help':
      return [
        'BELL can message you when a wallet’s orders fill.',
        'To follow a wallet, connect it on the BELL page and use the "alerts for this wallet" link at the foot of the page. Or send /start followed by its address.',
        PUBLIC,
        `Every fill from every wallet is also posted to the public channel, ${CHANNEL}.`,
      ].join('\n\n')
  }
}

/** The Telegram update offset: the first update not yet handled. */
const OFFSET = 'telegram_offset'
/** How long one `getUpdates` waits for a message before answering with none. */
const POLL_SECONDS = 10

interface Update {
  update_id: number
  message?: {
    chat?: { id?: number | string; type?: string }
    from?: { is_bot?: boolean }
    text?: string
  }
}

/**
 * One `getUpdates`, and every command in it carried out and answered. Returns
 * how many commands it handled; throws when Telegram could not be read.
 *
 * Private chats only. In a group, one member's "/start" would sign up everyone
 * in it, and the channel's own posts are not commands to anyone.
 *
 * The offset is saved after each update is carried out and before it is
 * answered. A restart between the two carries it out again, which `reply`
 * makes harmless; saving it first would drop a command instead.
 */
export async function pollCommands(o: {
  token: string
  store: AlertStore
  cluster: string
  fetch?: Fetch
  /** Unix seconds. */
  now?: () => number
  log: (line: string) => void
  pollSeconds?: number
}): Promise<number> {
  const pollSeconds = o.pollSeconds ?? POLL_SECONDS
  const now = o.now ?? (() => Math.floor(Date.now() / 1000))
  const saved = o.store.alertCursor(OFFSET)
  const got = await telegram(
    o.token,
    'getUpdates',
    { ...(saved ? { offset: Number(saved) } : {}), timeout: pollSeconds, allowed_updates: ['message'] },
    // The request waits up to `pollSeconds` by design, so its own limit is longer.
    { fetch: o.fetch, timeoutMs: (pollSeconds + 10) * 1000 },
  )
  if (!got.ok) throw new Error(`getUpdates: ${got.why}`)
  const updates = (Array.isArray(got.result) ? (got.result as Update[]) : [])
    .filter((u) => Number.isSafeInteger(u?.update_id))
    .sort((a, b) => a.update_id - b.update_id)

  let handled = 0
  for (const u of updates) {
    const m = u.message
    const chatId = m?.chat?.id
    let answer: string | null = null
    if (m?.chat?.type === 'private' && chatId !== undefined && typeof m.text === 'string' && !m.from?.is_bot) {
      answer = reply(o.store, String(chatId), parseCommand(m.text), now(), o.cluster)
      handled++
    }
    o.store.setAlertCursor(OFFSET, String(u.update_id + 1))
    if (answer !== null) {
      const sent = await telegram(
        o.token,
        'sendMessage',
        { chat_id: chatId, text: answer, link_preview_options: { is_disabled: true } },
        { fetch: o.fetch },
      )
      if (!sent.ok) o.log(`alerts: a reply was not sent: ${sent.why}`)
    }
  }
  return handled
}

// --------------------------------------------------------------------- fills

/** A JSON-RPC call: method and params in, the `result` out. */
export type Rpc = (method: string, params: unknown[]) => Promise<unknown>

/** JSON-RPC over `fetch`, every call bounded. A refusal, 429 included, throws and ends the pass. */
export function jsonRpc(url: string, opts: { fetch?: Fetch; timeoutMs?: number } = {}): Rpc {
  let id = 0
  return async (method, params) => {
    const res = await (opts.fetch ?? fetch)(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
    })
    if (!res.ok) {
      await res.body?.cancel().catch(() => {})
      throw new Error(`${method}: HTTP ${res.status}`)
    }
    const body = (await res.json()) as { result?: unknown; error?: { message?: string } }
    if (body.error) throw new Error(`${method}: ${body.error.message ?? 'RPC error'}`)
    return body.result
  }
}

/** Mainnet USDC, the one quote asset that is worth a dollar. */
const USDC_MAINNET = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'

/**
 * What the quote is called in a message, as the crank calls it in the
 * channel. Off mainnet a listed symbol's quote is BELL's own demo token: the
 * program requires a fill's quote mint to be its mark's, and BELL opened the
 * marks.
 */
const quoteName = (mint: string, cluster: string): string =>
  mint === USDC_MAINNET ? 'USDC' : cluster === 'mainnet' ? shortKey(mint) : 'demo-USDC'

/**
 * The scaled-UI multiplier in force at `at`, from a TokenRisk record read
 * after it, or null when the record cannot say.
 *
 * While a change is ahead the program keeps both multipliers, but once it has
 * passed it keeps only the new one and the instant (verify_token_risk.rs). So
 * a fill from before a change that has since happened has no multiplier here,
 * and its message gives no share count rather than a wrong one.
 */
export function multiplierFromRisk(
  risk: Pick<TokenRisk, 'multiplierBits' | 'pendingMultiplierBits' | 'activatesAt'>,
  at: number,
): number | null {
  const when = Number(risk.activatesAt)
  if (when === 0) return multiplierOf(risk.multiplierBits)
  if (risk.pendingMultiplierBits !== 0n) {
    return multiplierOf(at >= when ? risk.pendingMultiplierBits : risk.multiplierBits)
  }
  return at >= when ? multiplierOf(risk.multiplierBits) : null
}

export interface EventContext {
  cluster: string
  /** The listings, each pinned to its stock mint on this cluster. */
  listings: readonly Pick<Listing, 'symbol' | 'mint'>[]
  /** A symbol's multiplier at an instant, if it can be known. */
  multiplier: (symbol: string, at: number) => number | null
}

/**
 * A trade's amounts as a message states them, or null when it is not a trade
 * of a listed security. Throws when an amount cannot be stated: the quote
 * mint's decimals missing from the transaction's own token balances.
 */
function stated(
  t: { event: { symbol: string }; quoteMint: string; stockMint: string },
  quoteRaw: bigint,
  stockRaw: bigint,
  tx: RpcTransaction,
  ctx: EventContext,
) {
  const listing = ctx.listings.find((l) => l.symbol === t.event.symbol)
  if (!listing || listing.mint !== t.stockMint) return null
  const balances = [...(tx.meta?.preTokenBalances ?? []), ...(tx.meta?.postTokenBalances ?? [])]
  const decimalsOf = (mint: string) => balances.find((b) => b.mint === mint)?.uiTokenAmount.decimals ?? null
  const qd = decimalsOf(t.quoteMint)
  if (qd === null) throw new Error(`decimals unknown for ${t.quoteMint}`)
  const sd = decimalsOf(t.stockMint)
  const at = tx.blockTime
  const multiplier = at === null ? null : ctx.multiplier(listing.symbol, at)
  return {
    symbol: listing.symbol,
    quoteAmount: Number(quoteRaw) / 10 ** qd,
    quote: quoteName(t.quoteMint, ctx.cluster),
    shares: sd === null || multiplier === null ? null : (Number(stockRaw) / 10 ** sd) * multiplier,
    minutesAfterBell: at === null ? null : minutesAfterBell(at),
    signature: tx.transaction.signatures[0],
  }
}

/**
 * One fill as the channel's fill message would put it, or null when it is not
 * a fill of a listed security. Throws when an amount cannot be stated: the
 * quote mint's decimals missing from the transaction's own token balances.
 */
export function alertEvent(f: Fill, tx: RpcTransaction, ctx: EventContext): NotifyEvent | null {
  // Each event names its legs from the user's side (see `OrderFilled`), so
  // which one is stock depends on the side.
  const sell = f.side === 'sell'
  const s = stated(f, sell ? f.event.amountOut : f.event.amountIn, sell ? f.event.amountIn : f.event.amountOut, tx, ctx)
  if (!s) return null
  return {
    kind: 'fill',
    side: f.side,
    symbol: s.symbol,
    amountIn: s.quoteAmount,
    quote: s.quote,
    shares: s.shares,
    minutesAfterBell: s.minutesAfterBell,
    owner: f.owner,
    signature: s.signature,
  }
}

/**
 * One cross as the two messages its parties' followers get: the buyer's,
 * told as a purchase, and the seller's, told as a sale. Null when it is not a
 * cross of a listed security; throws as `alertEvent` does.
 *
 * Each message names only its own party. The other party's wallet is not in
 * the event at all, rather than only left out of the wording: a follower of
 * one wallet learns that it traded, at what price and in which transaction,
 * and not whom with. (The transaction itself is public, and the link leads to
 * it; the message does not do the looking up for anyone.) An empty string is
 * that withheld wallet, and `formatEvent` never prints the side not asked
 * for.
 */
export function crossAlertEvents(
  c: Cross,
  tx: RpcTransaction,
  ctx: EventContext,
): { buyer: NotifyEvent; seller: NotifyEvent } | null {
  const s = stated(c, c.event.quote, c.event.stock, tx, ctx)
  if (!s) return null
  const told = {
    kind: 'cross',
    symbol: s.symbol,
    amount: s.quoteAmount,
    quote: s.quote,
    shares: s.shares,
    minutesAfterBell: s.minutesAfterBell,
    signature: s.signature,
  } as const
  return {
    buyer: { ...told, side: 'buy', buyer: c.buyer, seller: '' },
    seller: { ...told, side: 'sell', buyer: '', seller: c.seller },
  }
}

/**
 * Every message one trade makes, with the wallet each is about: one for a
 * fill, to its owner's followers; two for a cross, one to each party's.
 */
export function alertEvents(t: Trade, tx: RpcTransaction, ctx: EventContext): { owner: string; event: NotifyEvent }[] {
  if (t.side !== 'cross') {
    const event = alertEvent(t, tx, ctx)
    return event ? [{ owner: t.owner, event }] : []
  }
  const both = crossAlertEvents(t, tx, ctx)
  return both
    ? [
        { owner: t.buyer, event: both.buyer },
        { owner: t.seller, event: both.seller },
      ]
    : []
}

/** The wallet a per-wallet message is about. */
const ownerOf = (e: NotifyEvent): string | null =>
  e.kind === 'fill' ? e.owner : e.kind === 'cross' ? (e.side === 'sell' ? e.seller : e.side === 'buy' ? e.buyer : null) : null

const MAX_TEXT = 4096

/** One chat's fills and crosses as one message: the channel's wording, and how to stop it. */
export function alertText(events: readonly NotifyEvent[], cluster: string): string {
  const owners = new Set(events.map(ownerOf).filter(Boolean)).size
  const footer = `\n\nSent because this chat follows ${owners > 1 ? 'the owners' : 'the owner'} above. /stop ends these messages.`
  const body = formatMessage(events, cluster)
  return body.length + footer.length > MAX_TEXT
    ? `${body.slice(0, MAX_TEXT - footer.length - 1)}…${footer}`
    : body + footer
}

/** The newest program signature read, per cluster: a log moved to another cluster starts afresh. */
const cursorName = (cluster: string) => `program_signature:${cluster}`
/**
 * Signatures listed in a pass: one request. More than this since the last one
 * read, and the older ones are skipped, which the log says.
 */
export const PAGE = 200
/** Transactions read in a pass, and the pause between reads: public RPC answers a burst with 429. */
export const MAX_READS = 10
const READ_GAP_MS = 250
/** Chats messaged in a pass. */
const MAX_MESSAGES = 25
/** A finalized transaction the RPC still will not serve after this long is skipped rather than waited on forever. */
const UNSERVED_SECONDS = 600
/**
 * When this process first found a listed signature unserved, for the ones
 * listed without a block time. Without it such a signature would never be
 * old enough to skip, and would stall every pass behind it for good.
 */
const firstUnserved = new Map<string, number>()
/** How long a read signature is remembered. The cursor is always far past it by then. */
const SEEN_SECONDS = 3 * 86_400

interface SignatureInfo {
  signature: string
  err: unknown
  blockTime?: number | null
}

export interface ScanOptions extends EventContext {
  rpc: Rpc
  store: AlertStore
  /** Signatures the keeper sent itself: attestations, never fills, so never fetched. */
  own: ReadonlySet<string>
  send: (chatId: string, text: string) => Promise<TelegramOutcome>
  log: (line: string) => void
  /** Milliseconds since the epoch. */
  now?: () => number
  /** Reading stops at this instant, in the same milliseconds. Sending what was read does not. */
  deadline?: number
  sleep?: (ms: number) => Promise<void>
}

export interface ScanReport {
  /** Transactions fetched and read. */
  read: number
  /**
   * Fills of followed wallets found. A cross counts once for each of its
   * parties that is followed.
   */
  fills: number
  /** Messages Telegram accepted. */
  sent: number
  /** True when more signatures had landed than one pass lists, so the older ones were skipped. */
  behind: boolean
  /** Why reading stopped early, if it did. What was read before it is still sent. */
  error?: string
}

/**
 * One pass: read the program's transactions since the last pass, and message
 * each chat about the fills and crosses of the wallets it follows.
 *
 * The walk is oldest first and the cursor moves only past what was dealt
 * with, so a pass that stops early (the read cap, the deadline, a refused
 * request) leaves the rest for the next one. Each transaction is claimed in
 * the store before anything about it is sent, so it is messaged about at most
 * once even if the cursor's last write is lost: a restart can drop a message,
 * but never repeats one. A repeated "Filled" would read as a second purchase.
 */
export async function scanFills(o: ScanOptions): Promise<ScanReport> {
  const now = o.now ?? Date.now
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const deadline = o.deadline ?? Number.POSITIVE_INFINITY
  const seconds = () => Math.floor(now() / 1000)
  const report: ScanReport = { read: 0, fills: 0, sent: 0, behind: false }
  const name = cursorName(o.cluster)
  const cursor = o.store.alertCursor(name)
  const followed = o.store.followed()

  // With nobody to tell, or nowhere to start from, only the present matters:
  // move the cursor to it and stop. History is never messaged, so a follower
  // hears about fills from about when they followed, not before.
  if (cursor === null || followed.size === 0) {
    const head = (await o.rpc('getSignaturesForAddress', [
      PROGRAM_ADDRESS,
      { limit: 1, commitment: 'finalized' },
    ])) as SignatureInfo[]
    if (head[0]) o.store.setAlertCursor(name, head[0].signature)
    return report
  }

  const page = (await o.rpc('getSignaturesForAddress', [
    PROGRAM_ADDRESS,
    { until: cursor, limit: PAGE, commitment: 'finalized' },
  ])) as SignatureInfo[]
  if (page.length >= PAGE) {
    report.behind = true
    o.log(
      `alerts: ${PAGE} or more transactions since the last one read; reading from the newest ${PAGE}, ` +
        'so fills older than those get no message (the tape still has them)',
    )
  }

  const byChat = new Map<string, NotifyEvent[]>()
  let last: string | null = null
  let reads = 0
  try {
    for (const s of [...page].reverse()) {
      // Read in an earlier pass whose cursor was not saved.
      if (o.store.seen(s.signature)) {
        last = s.signature
        continue
      }
      // A failed transaction filled nothing, and the keeper's own attest and
      // never fill: neither is worth a request.
      if ((s.err !== null && s.err !== undefined) || o.own.has(s.signature)) {
        last = s.signature
        continue
      }
      if (reads >= MAX_READS || now() >= deadline) break
      if (reads > 0) await sleep(READ_GAP_MS)
      reads++
      const tx = (await o.rpc('getTransaction', [
        s.signature,
        { encoding: 'json', maxSupportedTransactionVersion: 0, commitment: 'finalized' },
      ])) as RpcTransaction | null
      if (!tx) {
        // Listed as finalized but not served yet: normally the next pass has
        // it. One that stays unserved would stall every pass behind it.
        if (firstUnserved.size > 1_000) firstUnserved.clear()
        const since = s.blockTime || firstUnserved.get(s.signature) || seconds()
        firstUnserved.set(s.signature, since)
        if (seconds() - since > UNSERVED_SECONDS) {
          o.log(`alerts: ${s.signature} is still not served after ${UNSERVED_SECONDS / 60} minutes; skipped`)
          o.store.claim(s.signature, seconds())
          firstUnserved.delete(s.signature)
          last = s.signature
          continue
        }
        break
      }
      report.read++
      let trades: Trade[] = []
      try {
        trades = tradesOf(tx)
      } catch (e) {
        o.log(`alerts: ${s.signature} could not be read, so it gets no message: ${(e as Error).message}`)
      }
      last = s.signature
      if (!o.store.claim(s.signature, seconds())) continue
      for (const t of trades) {
        const parties = t.side === 'cross' ? [t.buyer, t.seller] : [t.owner]
        if (!parties.some((p) => followed.has(p))) continue
        let told: { owner: string; event: NotifyEvent }[]
        try {
          told = alertEvents(t, tx, o)
        } catch (e) {
          const what = t.side === 'cross' ? 'cross' : 'fill'
          o.log(`alerts: a ${what} in ${s.signature} could not be stated, so it gets no message: ${(e as Error).message}`)
          continue
        }
        for (const { owner, event } of told) {
          if (!followed.has(owner)) continue
          report.fills++
          for (const chat of o.store.followers(owner)) {
            const list = byChat.get(chat) ?? []
            list.push(event)
            byChat.set(chat, list)
          }
        }
      }
    }
  } catch (e) {
    report.error = (e as Error).message
  } finally {
    if (last) o.store.setAlertCursor(name, last)
  }

  let tried = 0
  for (const [chat, events] of byChat) {
    if (tried >= MAX_MESSAGES) {
      o.log(`alerts: ${byChat.size - tried} chats not messaged; at most ${MAX_MESSAGES} a pass`)
      break
    }
    tried++
    const r = await o.send(chat, alertText(events, o.cluster))
    if (r.ok) report.sent++
    // 403 is a user who blocked the bot or deleted their account. Telegram
    // asks bots to stop writing to those, so the chat's follows go with it.
    else if (r.status === 403) {
      o.store.unfollow(chat)
      o.log(`alerts: a chat refused its message (${r.why}); its follows are dropped`)
    } else o.log(`alerts: a message was not sent: ${r.why}`)
  }
  o.store.forgetSeen(seconds() - SEEN_SECONDS)
  return report
}

// ------------------------------------------------------------------- running

/** How long a pass may spend reading before it stops and sends what it has. */
const PASS_BUDGET_MS = 20_000
/**
 * One RPC call's bound in a pass. A call started just before the deadline can
 * run this much past it, so the keeper's `readUntil` leaves room for it.
 */
export const ALERT_RPC_TIMEOUT_MS = 8_000
/** How many of the keeper's own signatures are remembered: a few ticks' worth. */
const OWN_KEPT = 64

export interface Alerts {
  /** Whether a bot token is set. Without one, every call below does nothing. */
  readonly enabled: boolean
  /**
   * After an armed tick. Starts a pass unless one is still running, and
   * returns at once; never throws. `own` is the tick's signatures, `board` its
   * symbol read, whose risk records give fills their share counts.
   *
   * `readUntil` (milliseconds since the epoch) is when the pass must stop
   * starting RPC calls. The keeper sets it before its next tick: the pass
   * shares the keeper's RPC endpoint, and on a public one its reads landing
   * during an attestation are how the attestation meets a 429.
   */
  afterTick(
    store: AlertStore,
    tick: {
      own: readonly (string | null)[]
      board: ReadonlyMap<string, { risk: TokenRisk | null }> | null
      readUntil?: number
    },
  ): void
  /** Start answering commands, until the returned function is called. `store` is asked afresh each time. */
  listen(store: () => AlertStore | null): () => void
  /** Resolves when no pass is running. */
  idle(): Promise<void>
}

export function createAlerts(o: {
  cluster: string
  listings: readonly Pick<Listing, 'symbol' | 'mint'>[]
  rpcUrl: string
  env?: Env
  fetch?: Fetch
  log?: (line: string) => void
}): Alerts {
  const token = (o.env ?? process.env).BELL_TELEGRAM_BOT_TOKEN?.trim() ?? ''
  const write = o.log ?? ((line: string) => console.error(line))
  const log = (line: string) => {
    try {
      write(line)
    } catch {
      // A logger that throws is not a reason to throw into the keeper.
    }
  }
  const rpc = jsonRpc(o.rpcUrl, { fetch: o.fetch, timeoutMs: ALERT_RPC_TIMEOUT_MS })
  const own: string[] = []
  let inflight: Promise<void> | null = null

  const send = (chatId: string, text: string) =>
    telegram(token, 'sendMessage', { chat_id: chatId, text, link_preview_options: { is_disabled: true } }, { fetch: o.fetch })

  async function pass(
    store: AlertStore,
    board: ReadonlyMap<string, { risk: TokenRisk | null }> | null,
    readUntil: number,
  ) {
    try {
      const report = await scanFills({
        rpc,
        store,
        own: new Set(own),
        send,
        log,
        cluster: o.cluster,
        listings: o.listings,
        multiplier: (symbol, at) => {
          const risk = board?.get(symbol)?.risk
          return risk ? multiplierFromRisk(risk, at) : null
        },
        deadline: Math.min(Date.now() + PASS_BUDGET_MS, readUntil),
      })
      if (report.fills > 0 || report.error) {
        log(
          `alerts: read ${report.read} transaction(s), ${report.fills} fill(s) or cross side(s) of followed wallets, ` +
            `${report.sent} message(s) sent${report.error ? `; stopped reading early: ${report.error}` : ''}`,
        )
      }
    } catch (e) {
      log(`alerts: pass failed: ${(e as Error).message}`)
    }
  }

  return {
    enabled: token !== '',
    afterTick(store, tick) {
      if (!token) return
      try {
        for (const s of tick.own) if (s && !own.includes(s)) own.push(s)
        own.splice(0, Math.max(0, own.length - OWN_KEPT))
        if (inflight) return
        // A tick that ran long leaves no quiet time before the next: skip.
        const readUntil = tick.readUntil ?? Number.POSITIVE_INFINITY
        if (readUntil <= Date.now()) return
        inflight = pass(store, tick.board, readUntil).finally(() => {
          inflight = null
        })
      } catch (e) {
        log(`alerts: pass not started: ${(e as Error).message}`)
      }
    },
    listen(getStore) {
      if (!token) return () => {}
      let stopped = false
      void (async () => {
        let backoff = 0
        while (!stopped) {
          const started = Date.now()
          try {
            const store = getStore()
            if (!store) {
              // The keeper's log would not open. It retries every tick; so do we.
              await new Promise((r) => setTimeout(r, 15_000))
              continue
            }
            await pollCommands({ token, store, cluster: o.cluster, fetch: o.fetch, log })
            backoff = 0
            // Never spin: a poll that returned at once waits out the second.
            const took = Date.now() - started
            if (took < 1_000) await new Promise((r) => setTimeout(r, 1_000 - took))
          } catch (e) {
            // 409 here is a second process reading this bot's updates, or a
            // webhook set on it; either way this one backs off and says so.
            backoff = Math.min(60_000, Math.max(2_000, backoff * 2))
            log(`alerts: commands not read, retrying in ${backoff / 1000}s: ${(e as Error).message}`)
            await new Promise((r) => setTimeout(r, backoff))
          }
        }
      })()
      return () => {
        stopped = true
      }
    },
    idle: () => inflight ?? Promise.resolve(),
  }
}
