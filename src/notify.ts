/**
 * Notifications: a Telegram bot posting to one channel.
 *
 * Environment. Both must be set, or every call here returns without doing
 * anything:
 *
 *   BELL_TELEGRAM_BOT_TOKEN  The bot's token from @BotFather. A secret: it is
 *                            never logged, and is redacted from any error
 *                            message that might carry it.
 *   BELL_TELEGRAM_CHAT_ID    The channel, as `@channelusername` or its numeric
 *                            id (`-100…`). The bot has to be an administrator
 *                            of the channel with the right to post messages.
 *
 * On Railway, set both on the keeper service (halts, corporate-action windows,
 * the open and the close) and on the crank cron service (fills, and dead
 * orders closed under BELL_GC). The web service needs neither.
 *
 * Deliberately the simple version: one channel, and every subscriber sees every
 * event. Telling one wallet's followers about only its own fills is
 * `alerts.ts`, run by the keeper, which links a chat to a wallet when someone
 * sends the bot "/start <wallet>".
 *
 * A notification is never part of the venue. The fill has already landed and
 * the attestation has already been pushed by the time anything here runs, so a
 * failure is logged and dropped, never thrown, and `notify` gives up after a
 * few seconds whether or not Telegram answers. It does not retry: a retry is a
 * longer wait for the caller, and a missed message costs nothing that the
 * chain does not still show.
 */
/** Telegram's limit on a message's text. */
const MAX_TEXT = 4096
/** How long a caller can be kept waiting, at most. */
const DEFAULT_TIMEOUT_MS = 4_000
/**
 * The on-chain halt kinds, by discriminant, as `policy/reconcile.ts` exports
 * them in `HaltState`. Copied rather than imported because the crank loads this
 * module on the fill path and does not otherwise load `reconcile.ts`; a message
 * formatter should not be how a change there reaches the filler. The test pins
 * these to `HaltState`, so the copy cannot drift unnoticed.
 */
export const HALT = { None: 0, Luld: 1, NewsPending: 2, MarketWide: 3, Suspension: 4, Unspecified: 5 } as const
/** The regular session, in New York minutes past midnight. */
const OPEN_MINUTE = 9 * 60 + 30
const SESSION_MINUTES = 390

export type NotifyEvent =
  | {
      kind: 'fill'
      /**
       * Which way the stock moved. Absent means a buy, which is what every fill
       * was before sells existed, so an older caller still reads correctly.
       */
      side?: 'buy' | 'sell'
      symbol: string
      /** The quote leg, in whole units: what a buy spent, or what a sell was paid. */
      amountIn: number
      /** What the quote is called on this cluster, e.g. `demo-USDC`. */
      quote: string
      /** Shares bought or sold, multiplier applied; null if the mint could not be read. */
      shares: number | null
      /** Minutes since 09:30 ET; null outside the regular session. */
      minutesAfterBell: number | null
      owner: string
      signature: string
    }
  | {
      kind: 'cross'
      /**
       * Whose side the message is told from: `buy` to the buyer's followers,
       * `sell` to the seller's. Absent on the channel, which names both.
       */
      side?: 'buy' | 'sell'
      symbol: string
      /** The quote leg, in whole units: what the buyer paid and the seller was paid, one number. */
      amount: number
      quote: string
      /** Shares that changed hands, multiplier applied; null if the mint could not be read. */
      shares: number | null
      /** Minutes since 09:30 ET; null outside the regular session. */
      minutesAfterBell: number | null
      buyer: string
      seller: string
      signature: string
    }
  | { kind: 'closed'; side?: 'buy' | 'sell'; symbol: string; owner: string; why: string; signature: string }
  | {
      kind: 'breaker'
      symbol: string
      /** True when the breaker is found holding the symbol's mark, false when a push has released it. */
      held: boolean
      /** Dollars a share on record, and in the push that was held, when known. */
      heldPrice?: number | null
      pushedPrice?: number | null
      /** The program's step, in bps a minute, and how old the held price may get before any push is accepted. */
      stepBps?: number
      resetSeconds?: number
    }
  | {
      kind: 'halt'
      symbol: string
      fromHalt: number
      toHalt: number
      /** Whether the symbol is attested open after the change. */
      toOpen: boolean
      detail: string
    }
  | {
      kind: 'rebase'
      symbol: string
      /** True on entering the refusal window, false on leaving it. */
      entering: boolean
      /** Unix seconds this was noticed, which says whether the change is ahead or past. */
      at: number
      /** Unix seconds the multiplier change activates. */
      activatesAt: number
      guardSeconds: number
    }
  | { kind: 'open'; at: number; open: number; total: number }
  | { kind: 'close'; at: number; total: number }

/**
 * New York wall-clock fields for an instant.
 *
 * `record.ts` has the same conversion as `eastern`, but importing it would load
 * better-sqlite3, a native module, into the crank. A message formatter is not
 * worth a new way for the filler to fail at import.
 */
function newYork(unixSeconds: number) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(unixSeconds * 1000))
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00'
  return {
    day: `${get('year')}-${get('month')}-${get('day')}`,
    // Some ICU versions render midnight as "24" even in h23, as record.ts notes.
    hour: Number(get('hour')) % 24,
    minute: Number(get('minute')),
  }
}

/** The New York date of an instant, `YYYY-MM-DD`: the trading day it belongs to. */
export const etDay = (unixSeconds: number): string => newYork(unixSeconds).day

/** `HH:MM ET` for an instant. */
export function etTime(unixSeconds: number): string {
  const { hour, minute } = newYork(unixSeconds)
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')} ET`
}

/**
 * Whole minutes since 09:30 in New York, or null outside 09:30-16:00.
 *
 * Clock arithmetic only, with no holiday calendar: the crank calls it for a
 * fill it has just made, and a fill only happens while the attested session is
 * open, so the calendar question has already been answered by the time it asks.
 */
export function minutesAfterBell(unixSeconds: number): number | null {
  const { hour, minute } = newYork(unixSeconds)
  const m = hour * 60 + minute - OPEN_MINUTE
  return m >= 0 && m < SESSION_MINUTES ? m : null
}

/** `7xKX…p9Qz`: enough of an address to recognise, not to copy. */
export const shortKey = (key: string): string =>
  key.length > 10 ? `${key.slice(0, 4)}…${key.slice(-4)}` : key

/**
 * A transaction's explorer link, or null where no public explorer can see it.
 * The explorer shows mainnet unless told otherwise, so leaving the cluster off a
 * devnet link would send a reader to a transaction that does not exist.
 */
export function explorerTx(signature: string, cluster: string): string | null {
  if (cluster === 'devnet' || cluster === 'testnet')
    return `https://explorer.solana.com/tx/${signature}?cluster=${cluster}`
  if (cluster === 'mainnet' || cluster === 'mainnet-beta') return `https://explorer.solana.com/tx/${signature}`
  return null
}

/**
 * The kind of stop, in words. `Unspecified` has none: it is what a boolean
 * issuer flag, a missing source or a disagreement between sources produces, and
 * the verdict's detail says which of those it was.
 */
function haltLabel(h: number): string | null {
  switch (h) {
    case HALT.Luld:
      return 'LULD pause'
    case HALT.NewsPending:
      return 'halt, news pending'
    case HALT.MarketWide:
      return 'market-wide halt'
    case HALT.Suspension:
      return 'suspension'
    default:
      return null
  }
}

const money = (n: number) => n.toFixed(2)
const sentence = (s: string) => (/[.!?]$/.test(s) ? s : `${s}.`)

function linkLine(signature: string, cluster: string): string {
  return explorerTx(signature, cluster) ?? `sig ${signature}`
}

/** One event as plain text. Pure, so the wording is testable without a network. */
export function formatEvent(e: NotifyEvent, cluster: string): string {
  switch (e.kind) {
    case 'fill': {
      const what = e.shares !== null ? `${e.shares.toFixed(6)} ${e.symbol}` : e.symbol
      const price = e.shares ? `, ${money(e.amountIn / e.shares)} ${e.quote} a share` : ''
      const when = e.minutesAfterBell !== null ? `, ${e.minutesAfterBell} min after the bell` : ''
      // A sell is worded as one: "Filled" alone would read as a purchase, and a
      // subscriber who sold would be told they had bought.
      const verb = e.side === 'sell' ? 'Sold' : 'Filled'
      return [
        `${verb}: ${what} for ${money(e.amountIn)} ${e.quote}${price}${when}.`,
        `Owner ${shortKey(e.owner)}`,
        linkLine(e.signature, cluster),
      ].join('\n')
    }
    case 'cross': {
      const what = e.shares !== null ? `${e.shares.toFixed(6)} ${e.symbol}` : e.symbol
      const price = e.shares ? `, ${money(e.amount / e.shares)} ${e.quote} a share` : ''
      const when = e.minutesAfterBell !== null ? `, ${e.minutesAfterBell} min after the bell` : ''
      // Told to one party, a cross says which way their stock went, as a fill
      // does. On the channel it is one trade between two wallets, so it names
      // both and neither direction. "No filler spread", never "fair": the mark
      // is an executable ask, so a cross at it is the pool's price, not a mid.
      const verb = e.side === 'buy' ? 'bought ' : e.side === 'sell' ? 'sold ' : ''
      const who =
        e.side === 'buy'
          ? `Owner ${shortKey(e.buyer)}`
          : e.side === 'sell'
            ? `Owner ${shortKey(e.seller)}`
            : `Buyer ${shortKey(e.buyer)}, seller ${shortKey(e.seller)}`
      return [
        `Crossed: ${verb}${what} for ${money(e.amount)} ${e.quote}${price}, at the pool's price, no filler spread${when}.`,
        who,
        linkLine(e.signature, cluster),
      ].join('\n')
    }
    case 'breaker': {
      if (!e.held) return `${e.symbol}: the price mark is no longer held, and fills can price against it again.`
      const step = e.stepBps !== undefined ? `${e.stepBps / 100}% a minute` : 'one step'
      const moved =
        e.heldPrice && e.pushedPrice ? ` (${money(e.heldPrice)} on record, ${money(e.pushedPrice)} pushed)` : ''
      const until =
        e.resetSeconds !== undefined
          ? `the held price is ${Math.round(e.resetSeconds / 60)} minutes old`
          : 'the held price ages out'
      return `${e.symbol}: price mark held. A push moved further than ${step} allows${moved}, so BELL refuses its fills (MarkPaused) until a push lands within the step or ${until}; queued orders wait.`
    }
    case 'closed':
      return [
        `Closed a dead ${e.symbol} ${e.side === 'sell' ? 'sell ' : ''}order: ${e.why}. Its rent went back to the owner, ${shortKey(e.owner)}.`,
        linkLine(e.signature, cluster),
      ].join('\n')
    case 'halt': {
      const to = haltLabel(e.toHalt)
      const from = haltLabel(e.fromHalt)
      if (e.fromHalt === HALT.None) {
        return `${e.symbol} stopped${to ? ` (${to})` : ''}: ${sentence(e.detail)} BELL refuses it until the stop clears; queued orders wait.`
      }
      if (e.toHalt === HALT.None) {
        // A stop can clear into a closed session: the issuer's own pause a few
        // minutes before 16:00 ends at the close. "Cleared" alone would read as
        // tradeable again, so say which it is.
        const was = from ? ` (was ${from})` : ''
        return e.toOpen
          ? `${e.symbol}: the stop has cleared${was} and it trades again. ${sentence(e.detail)}`
          : `${e.symbol}: no longer stopped${was}, but not open either: ${sentence(e.detail)}`
      }
      return `${e.symbol}: still stopped, ${from ?? 'unpublished kind'} -> ${to ?? 'unpublished kind'}. ${sentence(e.detail)}`
    }
    case 'rebase': {
      const when = `${etDay(e.activatesAt)} ${etTime(e.activatesAt)}`
      const minutes = Math.round(e.guardSeconds / 60)
      // The keeper can first see a change after it activated (one made effective
      // immediately, or one it was down for), so the tense follows the clock.
      const changes = e.activatesAt > e.at ? 'changes' : 'changed'
      // Hedged on purpose: a mint can record an activation whose multiplier
      // equals the old one, and then no order was sized for a different one.
      return e.entering
        ? `${e.symbol}: a corporate action ${changes} the token's multiplier at ${when}. BELL refuses trades and fills for ${minutes} minutes either side of it (RebasePending).`
        : `${e.symbol}: the corporate-action window around ${when} has passed. An order built against the previous multiplier is refused (MultiplierMoved); its owner can cancel it to reclaim the rent.`
    }
    case 'open':
      return `Market open (${etTime(e.at)}): ${e.open} of ${e.total} symbols attested open. Orders queued for the bell fill on the filler's next pass; it runs every five minutes.`
    case 'close':
      return `Market closed (${etTime(e.at)}): none of the ${e.total} symbols is attested open. New orders queue for the next bell.`
  }
}

/** Several events as one message, which is one request against Telegram's flood control. */
export function formatMessage(events: readonly NotifyEvent[], cluster: string): string {
  const text = [`BELL (${cluster})`, ...events.map((e) => formatEvent(e, cluster))].join('\n\n')
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 1)}…` : text
}

/**
 * What the keeper has already said, so that it says each thing once.
 *
 * In memory on purpose. A restart forgets it, but the keeper's transitions come
 * from the evidence log, which does survive a restart, so a restarted keeper
 * does not see the day's open as new. The worst a restart can do is repeat that
 * day's open or close message (only if the whole board closes and reopens again
 * that day), or miss a symbol entering or leaving a rebase window while it was
 * down, since its first reading only records where it is. A log that does not
 * survive the restart has no previous state to compare with, so the first tick
 * after it reports no transitions: silence, never a crash or a false message.
 */
export interface Announced {
  /** The New York date of the last open and close announced. */
  open: string | null
  close: string | null
  /** Per symbol, whether it was inside a corporate-action window when last read. */
  inWindow: Map<string, boolean>
  /** Per symbol, whether the breaker held its mark when last read. */
  held: Map<string, boolean>
}

export const announced = (): Announced => ({ open: null, close: null, inWindow: new Map(), held: new Map() })

/** The fields of a recorded transition that notifications read. */
export interface TransitionLike {
  symbol: string
  fromOpen: boolean
  toOpen: boolean
  fromHalt: number
  toHalt: number
  detail: string
}

/**
 * What one keeper tick should announce. Updates `memo`.
 *
 * - Every change of halt state, into, out of, or between kinds of stop.
 * - The open and the close, each at most once per New York day. They are read
 *   from the whole board rather than from any one symbol: the open is the tick
 *   on which the count of open symbols leaves zero, the close the tick on which
 *   it returns to zero. One symbol stopping mid-session is a halt message, not
 *   a close.
 * - A symbol entering or leaving the window either side of a multiplier change
 *   in which the program refuses (gate 4). The first reading of a symbol only
 *   records where it stands, since it is not a change.
 *
 * - A symbol's mark being held by the circuit breaker, or released, read from
 *   `breakers` the same way: the first reading only records.
 *
 * `windows` is null when the risk records could not be read this tick, which
 * leaves the window memory as it was rather than treating every symbol as
 * having left its window. `breakers` null or absent does the same for the
 * marks.
 */
export function keeperEvents(
  memo: Announced,
  tick: {
    at: number
    open: number
    total: number
    transitions: readonly TransitionLike[]
    windows: readonly { symbol: string; activatesAt: number }[] | null
    guardSeconds: number
    breakers?: readonly { symbol: string; held: boolean; heldPrice?: number | null; pushedPrice?: number | null }[] | null
    /** The program's `MAX_MARK_STEP_BPS` and `MAX_MARK_STEP_AGE_SECONDS`, for the wording. */
    markStep?: { bps: number; resetSeconds: number }
  },
): NotifyEvent[] {
  const events: NotifyEvent[] = []

  for (const t of tick.transitions) {
    if (t.fromHalt !== t.toHalt) {
      events.push({
        kind: 'halt',
        symbol: t.symbol,
        fromHalt: t.fromHalt,
        toHalt: t.toHalt,
        toOpen: t.toOpen,
        detail: t.detail,
      })
    }
  }

  // The count before this tick, from the count now and what moved.
  const opened = tick.transitions.filter((t) => !t.fromOpen && t.toOpen).length
  const closed = tick.transitions.filter((t) => t.fromOpen && !t.toOpen).length
  const before = tick.open - opened + closed
  const day = etDay(tick.at)
  if (before === 0 && tick.open > 0 && memo.open !== day) {
    memo.open = day
    events.push({ kind: 'open', at: tick.at, open: tick.open, total: tick.total })
  }
  if (before > 0 && tick.open === 0 && memo.close !== day) {
    memo.close = day
    events.push({ kind: 'close', at: tick.at, total: tick.total })
  }

  // Gate 4's own test: |activates_at - now| <= REBASE_GUARD_SECONDS refuses.
  for (const w of tick.windows ?? []) {
    const inside = w.activatesAt !== 0 && Math.abs(w.activatesAt - tick.at) <= tick.guardSeconds
    const was = memo.inWindow.get(w.symbol)
    memo.inWindow.set(w.symbol, inside)
    if (was === undefined || was === inside) continue
    events.push({
      kind: 'rebase',
      symbol: w.symbol,
      entering: inside,
      at: tick.at,
      activatesAt: w.activatesAt,
      guardSeconds: tick.guardSeconds,
    })
  }

  for (const b of tick.breakers ?? []) {
    const was = memo.held.get(b.symbol)
    memo.held.set(b.symbol, b.held)
    if (was === undefined || was === b.held) continue
    events.push({
      kind: 'breaker',
      symbol: b.symbol,
      held: b.held,
      ...(b.held && b.heldPrice != null ? { heldPrice: b.heldPrice } : {}),
      ...(b.held && b.pushedPrice != null ? { pushedPrice: b.pushedPrice } : {}),
      ...(tick.markStep ? { stepBps: tick.markStep.bps, resetSeconds: tick.markStep.resetSeconds } : {}),
    })
  }
  return events
}

type Fetch = (url: string, init: RequestInit) => Promise<Response>

export interface NotifyOptions {
  /** The cluster the events happened on; it heads every message and picks the explorer. */
  cluster: string
  /** Defaults to `process.env`. */
  env?: Readonly<Record<string, string | undefined>>
  /** Defaults to the global `fetch`. */
  fetch?: Fetch
  /** Defaults to four seconds. */
  timeoutMs?: number
  /** Where a failure is reported. Defaults to stderr. */
  log?: (line: string) => void
}

/** Whether the two environment variables are set. */
export function notifyConfigured(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return Boolean(env.BELL_TELEGRAM_BOT_TOKEN?.trim() && env.BELL_TELEGRAM_CHAT_ID?.trim())
}

/**
 * Post events to the channel as one message.
 *
 * Resolves, never rejects, and within `timeoutMs` however Telegram behaves. The
 * request carries an abort signal, and the wait is also raced against a timer,
 * because a signal only bounds a fetch that honours it.
 */
export async function notify(events: NotifyEvent | readonly NotifyEvent[], opts: NotifyOptions): Promise<void> {
  const log = opts.log ?? ((line: string) => console.error(line))
  const say = (line: string) => {
    try {
      log(line)
    } catch {
      // A logger that throws is not a reason to throw into a fill.
    }
  }
  let token = ''
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const env = opts.env ?? process.env
    token = env.BELL_TELEGRAM_BOT_TOKEN?.trim() ?? ''
    const chatId = env.BELL_TELEGRAM_CHAT_ID?.trim() ?? ''
    if (!token || !chatId) return
    const list: readonly NotifyEvent[] = Array.isArray(events) ? events : [events as NotifyEvent]
    if (list.length === 0) return

    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const request = post(opts.fetch ?? fetch, token, chatId, formatMessage(list, opts.cluster), timeoutMs)
    const expired = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), timeoutMs)
    })
    const outcome = await Promise.race([request, expired])
    if (outcome === 'timeout') say(`notify: Telegram did not answer within ${timeoutMs}ms; not sent`)
    else if (outcome !== null) say(`notify: not sent: ${redact(outcome, token)}`)
  } catch (e) {
    say(`notify: not sent: ${redact(describe(e), token)}`)
  } finally {
    clearTimeout(timer)
  }
}

/**
 * One `sendMessage` call. Resolves to null on success or to why it failed; it
 * never rejects, so a request still in flight when `notify` stops waiting
 * cannot surface later as an unhandled rejection.
 */
async function post(f: Fetch, token: string, chatId: string, text: string, timeoutMs: number): Promise<string | null> {
  try {
    const res = await f(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, link_preview_options: { is_disabled: true } }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (res.ok) {
      await res.body?.cancel().catch(() => {})
      return null
    }
    // Telegram explains a refusal in `description`: a bot that is not an
    // administrator of the channel, a wrong chat id, or flood control.
    const body = await res.text().catch(() => '')
    let why = body.slice(0, 200)
    try {
      why = (JSON.parse(body) as { description?: string }).description ?? why
    } catch {
      // Not JSON; keep the raw text.
    }
    return `HTTP ${res.status}${why ? ` ${why}` : ''}`
  } catch (e) {
    return describe(e)
  }
}

/** What one Bot API call came to. `status` is null when Telegram never answered. */
export type TelegramOutcome = { ok: true; result: unknown } | { ok: false; status: number | null; why: string }

/**
 * One Bot API call to any method, for the keeper's per-wallet alerts
 * (`alerts.ts`), which read commands with `getUpdates` and write to private
 * chats rather than the channel.
 *
 * The same promises `notify` makes: it resolves, never rejects, within
 * `timeoutMs` however Telegram behaves, and the token is redacted from any
 * reason it gives. A refusal keeps its HTTP status, so a caller can tell a
 * user who blocked the bot (403) from a network that failed (null).
 */
export async function telegram(
  token: string,
  method: string,
  params: Record<string, unknown>,
  opts: { fetch?: Fetch; timeoutMs?: number } = {},
): Promise<TelegramOutcome> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  let timer: ReturnType<typeof setTimeout> | undefined
  const call = async (): Promise<TelegramOutcome> => {
    try {
      const res = await (opts.fetch ?? fetch)(`https://api.telegram.org/bot${token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(params),
        signal: AbortSignal.timeout(timeoutMs),
      })
      const body = await res.text().catch(() => '')
      type Answer = { ok?: boolean; result?: unknown; description?: string }
      let parsed: Answer | null = null
      try {
        parsed = JSON.parse(body) as Answer
      } catch {
        // Not JSON; the raw text explains it below.
      }
      if (res.ok && parsed?.ok === true) return { ok: true, result: parsed.result }
      const why = parsed?.description ?? body.slice(0, 200)
      return { ok: false, status: res.status, why: `HTTP ${res.status}${why ? ` ${why}` : ''}` }
    } catch (e) {
      return { ok: false, status: null, why: describe(e) }
    }
  }
  try {
    const expired = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), timeoutMs)
    })
    const outcome = await Promise.race([call(), expired])
    if (outcome === 'timeout') return { ok: false, status: null, why: `Telegram did not answer within ${timeoutMs}ms` }
    return outcome.ok ? outcome : { ...outcome, why: redact(outcome.why, token) }
  } catch (e) {
    return { ok: false, status: null, why: redact(describe(e), token) }
  } finally {
    clearTimeout(timer)
  }
}

/** An error's message and, for Node's `fetch failed`, the code that says why. */
function describe(e: unknown): string {
  const err = e as { message?: string; cause?: { code?: string } }
  const message = typeof err?.message === 'string' ? err.message : String(e)
  return err?.cause?.code ? `${message} (${err.cause.code})` : message
}

/** A URL-parse error quotes the URL, and the URL contains the token. */
const redact = (s: string, token: string): string => (token ? s.split(token).join('<token>') : s)
