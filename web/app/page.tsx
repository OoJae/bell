'use client'

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useWallet } from '@solana/wallet-adapter-react'
import type { PublicKey } from '@solana/web3.js'
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui'
import {
  bandText,
  bound,
  clearsWhen,
  connection,
  explain,
  explainView,
  explorerAddress,
  explorerTx,
  fillSide,
  loadBoard,
  loadNightOptIn,
  loadOrders,
  loadSellOrders,
  marketLine,
  localWhenOf,
  nyClockOf,
  nyDayOf,
  nyWhenOf,
  offline,
  PROGRAM,
  RPC_URL,
  shortKey,
  type GateRow,
  type Holding,
  type Status,
  type SymbolView,
  type WalletView,
} from '../lib/bell.ts'
import {
  cancelOrderTxs,
  cancelSellOrderTxs,
  MAX_ORDER_IN_RAW,
  MAX_ORDER_USD,
  maxSellRaw,
  NIGHT_OPT_IN_RENT_SOL,
  optInNightTx,
  optOutNightTx,
  orderExpiry,
  packTransactions,
  placeInstructions,
  placeOrderTx,
  placeSellOrderTx,
  rawToShares,
  recurringSlots,
  QUOTE_DECIMALS,
  QUOTE_MINT,
  refusalFrom,
  revokeAllTxs,
  SELL_MAX_USD,
  sellFloorUsd,
  sharesShown,
  submit,
  submitInOrder,
} from '../lib/queue.ts'
import { authPda } from '../../src/chain/client.ts'
import type { BellOrder, SellOrder } from '../../src/chain/codec.ts'
import { ataFor, TOKEN_2022 } from '../../src/chain/spl.ts'
import { ALLOWLIST, CLUSTER } from '../../src/config.ts'
import {
  deadReason,
  maxPricePerShare,
  sellOrderFloor,
  sharesToRaw,
  stillOwed,
  upcomingOpens,
} from '../../src/policy/order.ts'
import { isRegularOpen, nextChange } from '../../src/policy/calendar.ts'
import {
  LIMITS,
  MAX_NIGHT_GAP_BPS,
  MAX_NIGHT_REF_AGE_SECONDS,
  multiplierOf as multiplierFromBits,
  sellOrderValue,
  stockToQuoteCeil,
} from '../../src/chain/codec.ts'
import type { Reference } from '../lib/reference.ts'
import type { TapeRow } from '../lib/tape.ts'

const POLL_MS = 10_000

/**
 * Roughly what a first order in a new symbol costs a fresh wallet in SOL:
 * the stock account's rent, the order account's rent and a fee (measured on
 * devnet: 1.56M + 2.00M + 5k lamports). Below this, say so before the wallet
 * opens rather than after the token program refuses.
 */
const MIN_SOL_FOR_ORDER = 0.0036
/** Each further order in a recurring buy is another order account's rent, plus a fee's share. */
const SOL_PER_EXTRA_ORDER = 0.00201
/**
 * An SPL Token account's rent (165 bytes, 2,039,280 lamports): what a sale
 * costs on top of its order when the proceeds need a quote account made for them.
 */
const QUOTE_ACCOUNT_RENT_SOL = 0.00204

/**
 * How the page keys a sale wherever it tracks orders by nonce. A buy and a sale
 * are separate accounts that may share a nonce, so a sale's key carries its
 * side and a buy's stays the bare nonce it always was.
 */
const sellKey = (o: { nonce: bigint }) => `sell:${o.nonce}`

/**
 * The badge says what kind of no it is. It used to be binary — "closed" for a
 * stale attestation, a paused mint or a pending dividend alike — which is a
 * false statement about the market whenever the market is in fact open.
 */
const BADGE: Record<Status, [text: string, tone: string]> = {
  loading: ['…', ''],
  tradeable: ['tradeable', 'ok'],
  closed: ['closed', 'no'],
  halted: ['halted', 'stop'],
  withdrawn: ['withdrawn', 'stop'],
  suspended: ['suspended', 'stop'],
  stale: ['stale', 'no'],
  paused: ['paused', 'stop'],
  rebase: ['rebase', 'no'],
  hook: ['hook armed', 'stop'],
  offline: ['offline', 'dim'],
  unlisted: ['unlisted', 'dim'],
  // A fill's own stops, after the gate. Each clears by itself, the breaker
  // within five minutes, so they take the waiting tone rather than the halt's.
  breaker: ['price paused', 'no'],
  unchecked: ['unchecked', 'no'],
  disputed: ['disputed', 'no'],
  offband: ['off band', 'no'],
  refused: ['refused', 'no'],
}

function Badge({ view }: { view: SymbolView }) {
  const [text, tone] = BADGE[view.status]
  return <span className={`badge ${tone}`}>{text}</span>
}

/**
 * A gate row's mark. A disclosure gets its own, because it is neither a pass
 * nor a failure, and a ✓ beside "can move this token out of your wallet" would
 * read as reassurance. So does a check the program does not run yet: a ✓
 * would claim a check nobody made, and a ✕ a refusal nobody meets.
 */
const markOf = (ok: GateRow['ok']): [glyph: string, tone: string] =>
  ok === 'disclosure'
    ? ['ⓘ', 'disclose']
    : ok === 'unset'
      ? ['–', 'wait']
      : ok === null
        ? ['↻', 'wait']
        : ok
          ? ['✓', 'pass']
          : ['✕', 'fail']

/**
 * New York time and the US session, ticking every second. Mounted only in the
 * browser: the server's second is never the browser's, so rendering it in
 * both places would mismatch on every hydration.
 */
function Clock({ views, nightOn }: { views: readonly SymbolView[]; nightOn: boolean }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  const m = marketLine(views, now)
  return (
    <>
      New York <strong>{m.time}</strong> ET
      {m.state && (
        <>
          {' · '}
          <span className={`mkt ${m.state}`}>
            {m.state === 'halted' ? 'US market halted' : `regular session ${m.state}`}
          </span>
        </>
      )}
      {m.when && <> · {m.when}</>}
      {m.at && localWhenOf(m.at) && <> ({localWhenOf(m.at)})</>}
      {/* Only with the session attested shut: at any other time a night fill
          is not what this wallet's orders wait for. */}
      {nightOn && m.state === 'closed' && (
        <>
          {' · '}
          <span className="nightband">night band on: this wallet may fill within {MAX_NIGHT_GAP_BPS}bps</span>
        </>
      )}
    </>
  )
}

/**
 * The next `n` regular-session opens from the exchange calendar that an order
 * placed now can still reach. The calendar, not the attestation, because these
 * are future sessions nobody has attested yet; the gate still decides each fill.
 */
const nextOpens = (now: number, n: number) =>
  upcomingOpens(
    now,
    n,
    (at) => isRegularOpen(new Date(at * 1000)),
    (at) => nextChange(new Date(at * 1000)),
    LIMITS.MAX_ORDER_LIFETIME_SECONDS ?? 7 * 86_400,
  )

/**
 * Minutes between a fill and that day's opening bell, from the exchange
 * calendar; null when the fill was not during a regular session.
 */
function minutesAfterOpen(at: number): number | null {
  const [open] = upcomingOpens(
    at - 8 * 3_600,
    1,
    (t) => isRegularOpen(new Date(t * 1000)),
    (t) => nextChange(new Date(t * 1000)),
    86_400 + 3_600,
  )
  if (open === undefined || at < open || at - open > 6.5 * 3_600) return null
  return Math.round((at - open) / 60)
}

interface Notice {
  ok: boolean
  text: string
  /** The transaction that proves it, linked to the explorer. */
  sig?: string
}

const usd = (raw: bigint) =>
  (Number(raw) / 10 ** QUOTE_DECIMALS).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })

/** "1 AAPLx share", "0.5 AAPLx shares". */
const sharesOf = (n: string, symbol: string) => `${n} ${symbol} ${n === '1' ? 'share' : 'shares'}`


/** A failure, in the program's own words where it has any. */
function describe(e: unknown): string {
  const code = refusalFrom(e)
  if (code) return `${explain(code)} (${code})`
  const msg = (e as Error)?.message ?? String(e)
  if (/User rejected|rejected the request/i.test(msg)) return 'You declined in your wallet — nothing was sent.'
  return msg
}

export default function Page() {
  const conn = useMemo(() => connection(), [])
  const { publicKey, signTransaction, signAllTransactions } = useWallet()
  const [views, setViews] = useState<SymbolView[]>([])
  const [wallet, setWallet] = useState<WalletView | null>(null)
  // `null` means "not read yet, or the last read failed" — never "none".
  const [orders, setOrders] = useState<BellOrder[] | null>(null)
  // The same for sales, read separately: a sale is its own account type.
  const [sells, setSells] = useState<SellOrder[] | null>(null)
  // Buying spends demo-USDC and selling spends shares. The page opens on buy,
  // and everything about a buy is the same whichever side was last shown.
  const [side, setSide] = useState<'buy' | 'sell'>('buy')
  // Shares as typed. Kept as text so "0.29" becomes raw units exactly, never
  // through a float that makes it 0.28999999.
  const [sellShares, setSellShares] = useState('')
  // Optional: "don't sell for less than this a share". Empty means the price
  // the bell sets, protected only by the band and the loss cap.
  const [sellLimit, setSellLimit] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null)
  const [amount, setAmount] = useState('200')
  // Optional: "don't pay more than this a share". Empty means market-on-open,
  // protected only by the band and the loss cap.
  const [limit, setLimit] = useState('')
  // 1 for a single bell order; N for one at each of the next N opens.
  const [repeat, setRepeat] = useState(1)
  // The last US price of each underlying, for display beside the pool's price.
  const [refs, setRefs] = useState<Record<string, Reference | null>>({})
  // This wallet's fills, purchases and sales, from the tape's per-wallet view: the receipts.
  const [fills, setFills] = useState<TapeRow[]>([])
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<Notice | null>(null)
  // The wallet button renders from browser-only state, so it must not be part
  // of the server-rendered markup.
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])

  // Once a minute is plenty: the server caches it for that long anyway, and it
  // is shown, never used. A failure leaves the last answer (or nothing) on screen.
  useEffect(() => {
    let stopped = false
    const load = () =>
      fetch('/api/reference')
        .then((r) => (r.ok ? r.json() : null))
        .then((j) => {
          if (!stopped && j) setRefs(j as Record<string, Reference | null>)
        })
        .catch(() => {})
    void load()
    const timer = setInterval(() => void load(), 60_000)
    return () => {
      stopped = true
      clearInterval(timer)
    }
  }, [])

  // Receipts: the tape already reads every fill from the chain (cached a minute
  // on the server), so the page asks it for this wallet's rows rather than
  // walking transaction history from the browser. Purchases and sales are
  // asked for by name, because the tape never hands a sale to a buyer query.
  useEffect(() => {
    if (!publicKey) {
      setFills([])
      return
    }
    let stopped = false
    const me = publicKey.toBase58()
    const load = () =>
      fetch(`/api/tape?buyer=${me}&seller=${me}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((j) => {
          if (!stopped && j?.rows) setFills((j.rows as TapeRow[]).slice().sort((a, b) => b.time.localeCompare(a.time)))
        })
        .catch(() => {})
    void load()
    const timer = setInterval(() => void load(), 60_000)
    return () => {
      stopped = true
      clearInterval(timer)
    }
  }, [publicKey])

  // A limit is a price for one security, and a share count is a count of one
  // security; neither may carry over to the next.
  useEffect(() => {
    setLimit('')
    setSellLimit('')
    setSellShares('')
  }, [selected])

  // One poll at a time. A slow or throttled read used to overlap the next
  // one, and each overlap was another request at an endpoint already saying no.
  // A refresh asked for mid-poll is not dropped but run once the poll ends,
  // with the latest wallet and symbol — otherwise connecting a wallet during a
  // poll left its balances and orders off screen until the next one.
  const polling = useRef(false)
  const again = useRef(false)
  /** Orders this page has closed; a poll that began before the close must not bring them back. */
  const closed = useRef(new Set<string>())
  /**
   * A fresh read of the book, corrected by what this page already knows.
   * Public RPC load-balances across nodes that lag each other by a few
   * seconds, so a read right after a close can still list the closed order —
   * and one right after a place can miss the new one. Leaving out what we
   * closed and keeping what we last saw errs toward funding too much, never
   * toward silently defunding a live order.
   */
  const known = useCallback(
    (fresh: BellOrder[]) => {
      const byNonce = new Map<string, BellOrder>()
      for (const o of [...(orders ?? []), ...fresh]) byNonce.set(String(o.nonce), o)
      return [...byNonce.values()].filter((o) => !closed.current.has(String(o.nonce)))
    },
    [orders],
  )
  /** `known` for sales, keyed so a sale can never be mistaken for a buy with its nonce. */
  const knownSells = useCallback(
    (fresh: SellOrder[]) => {
      const byKey = new Map<string, SellOrder>()
      for (const o of [...(sells ?? []), ...fresh]) byKey.set(sellKey(o), o)
      return [...byKey.values()].filter((o) => !closed.current.has(sellKey(o)))
    },
    [sells],
  )
  const latest = useRef<() => Promise<void>>(async () => {})
  const refresh = useCallback(async () => {
    if (polling.current) {
      again.current = true
      return
    }
    polling.current = true
    try {
      try {
        // With nothing chosen yet, the first symbol on the board is the one on
        // screen — so it gets the program's own answer from the first load.
        const board = await loadBoard(conn, QUOTE_MINT, selected ?? ALLOWLIST[0]?.symbol, publicKey)
        setViews(board.views)
        setWallet(board.wallet)
        setUpdatedAt(new Date())
        setError(null)
      } catch (e) {
        // Losing the RPC is not permission to trade. Every tile says so too —
        // a red panel above tiles still reading "tradeable" from the last good
        // poll is the page disagreeing with itself.
        setViews((v) => offline(v))
        setError((e as Error).message)
      }
      if (publicKey) {
        // Both books at once, each kept or dropped on its own: a failed read of
        // the sales must not cost the buys their fresh read, or the reverse.
        const [book, sellBook] = await Promise.allSettled([
          loadOrders(conn, publicKey),
          loadSellOrders(conn, publicKey),
        ])
        // A failure keeps showing the last list we actually read. What must
        // never happen is a failed read becoming "you have no orders" —
        // `place()` below re-reads for itself rather than trusting this copy.
        if (book.status === 'fulfilled') setOrders(book.value.filter((o) => !closed.current.has(String(o.nonce))))
        if (sellBook.status === 'fulfilled') setSells(sellBook.value.filter((o) => !closed.current.has(sellKey(o))))
      } else {
        setOrders(null)
        setSells(null)
      }
    } finally {
      polling.current = false
    }
    if (again.current) {
      again.current = false
      await latest.current()
    }
    // `selected` decides which symbol gets the authoritative on-chain check.
  }, [conn, publicKey, selected])
  useEffect(() => {
    latest.current = refresh
  }, [refresh])

  useEffect(() => {
    // Each poll is scheduled when the last one finishes, never on a fixed beat.
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const tick = async () => {
      await refresh()
      if (!stopped) timer = setTimeout(() => void tick(), POLL_MS)
    }
    void tick()
    return () => {
      stopped = true
      clearTimeout(timer)
    }
  }, [refresh])

  const current = views.find((v) => v.listing.symbol === selected) ?? views[0]
  const tradeable = views.filter((v) => v.allowed).length
  const auth = useMemo(() => (publicKey ? authPda(publicKey) : null), [publicKey])
  const bellDelegated = !!(wallet && auth && wallet.delegate?.equals(auth))
  // The wallet's consent to night fills, as the board last read it.
  const nightOn = !!wallet?.night
  // Whether the program here fills at night at all. Only the upgraded program
  // has checks, and a night fill needs one, so before any exists the toggle
  // says so instead of sending an instruction the program does not have.
  const nightReady = views.some((v) => v.checked)

  /** The multiplier in force for a symbol, as the board last read it. */
  const multiplierOf = useCallback(
    (symbol: string) => views.find((v) => v.listing.symbol === symbol)?.multiplierBits,
    [views],
  )
  const nowS = () => Math.floor(Date.now() / 1000)

  /** An order the wallet's single delegation no longer covers cannot fill. */
  const funded = useCallback(
    (list: BellOrder[]) => {
      if (!wallet || !auth) return true
      return bellDelegated && wallet.delegatedAmount >= stillOwed(list, nowS(), multiplierOf)
    },
    [auth, bellDelegated, multiplierOf, wallet],
  )

  /** A stock account of this wallet's as the board last read it; null for one it does not read. */
  const holdingAt = useCallback(
    (account: PublicKey): Holding | null => wallet?.holdings.find((h) => h.account.equals(account)) ?? null,
    [wallet],
  )

  /**
   * A sale is funded when its stock account's one delegation is BELL's and
   * covers every live sale from that account. An account the page does not
   * read is not called unfunded, because that would be a guess.
   */
  const sellFunded = useCallback(
    (o: SellOrder, list: SellOrder[]) => {
      const h = holdingAt(o.payerIn)
      if (!h || !auth) return true
      const owed = stillOwed(
        list.filter((x) => x.payerIn.equals(o.payerIn)),
        nowS(),
        multiplierOf,
      )
      return !!h.delegate?.equals(auth) && h.delegatedAmount >= owed
    },
    [auth, holdingAt, multiplierOf],
  )

  /**
   * What a queued order's notice adds for a wallet that fills at night: the
   * bell is when it fills at the latest, not the only time it can.
   */
  const nightSooner = nightOn ? ' Night fills are on for this wallet, so it may fill sooner, inside the night band.' : ''

  const getFunds = useCallback(async () => {
    if (!publicKey) return
    setBusy(true)
    setNotice(null)
    try {
      const res = await fetch('/api/faucet', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ owner: publicKey.toBase58() }),
      })
      const body = (await res.json().catch(() => ({}))) as { message?: string }
      setNotice({ ok: res.ok, text: body.message ?? `The faucet answered ${res.status}.` })
      await refresh()
    } catch (e) {
      setNotice({ ok: false, text: describe(e) })
    } finally {
      setBusy(false)
    }
  }, [publicKey, refresh])

  const place = useCallback(async () => {
    if (!publicKey || !signTransaction || !current) return
    setBusy(true)
    setNotice(null)
    try {
      const usdAmount = Number(amount)
      // Everything checkable is checked before the wallet opens, so a problem
      // is explained in words instead of refused by a program in hex.
      if (!(usdAmount > 0)) throw new Error('Enter an amount.')
      const limitUsd = limit.trim() ? Number(limit) : null
      // A cent at least: below that the limit rounds to nothing in the mark's
      // own units, the order would carry only the loss cap, and the box above
      // would have promised a price the program never saw.
      if (limitUsd !== null && !(limitUsd >= 0.01)) {
        throw new Error('Enter a limit price per share, or leave it empty to buy at the price the bell sets.')
      }
      // A dollar limit becomes a floor by converting against the attested
      // price; without one there is nothing to convert against.
      if (limitUsd !== null && (!current.markPx || !current.markRateQ64)) {
        throw new Error('There is no attested price for this symbol yet, so a limit cannot be set. Try again in a minute.')
      }
      if (usdAmount > MAX_ORDER_USD) {
        throw new Error(`Orders are capped at $${MAX_ORDER_USD.toLocaleString()} while the program has an upgrade authority.`)
      }
      if (!wallet || wallet.quote === null) {
        throw new Error('This wallet has no demo-USDC yet — use "Get demo funds" first.')
      }
      if (current.status === 'withdrawn') {
        throw new Error('The issuer has withdrawn this token, so an order would wait on the issuer, not on a bell.')
      }
      const now = nowS()
      const nextOpen = current.openNow ? null : current.nextChangeAt || null
      // A recurring buy is one bell order per upcoming open, from the exchange
      // calendar, each held back until its own open.
      const opens = repeat > 1 ? nextOpens(now, repeat) : []
      if (repeat > 1 && opens.length === 0) {
        throw new Error('The exchange calendar has no opens inside an order\'s lifetime from here, so a recurring buy cannot be scheduled.')
      }
      // An order snapshots the multiplier it was built against, and the gate
      // refuses it for good once that moves. Parking one across a scheduled
      // change is parking an order that can never fill.
      const lastExpiry = repeat > 1 ? opens[opens.length - 1]! + 6 * 3_600 : orderExpiry(now, nextOpen)
      if (current.changeAt > 0 && current.changeAt < lastExpiry && (!current.allowed || repeat > 1)) {
        throw new Error(
          `A corporate action is scheduled for ${nyWhenOf(current.changeAt)}, before this order could fill — it would be refused as resized. Place it after the change lands.`,
        )
      }

      const count = repeat > 1 ? opens.length : 1
      // Every order is its own account, and each one's rent is paid up front.
      // Checked for all of them: five orders need three times the rent of one,
      // and the system program's "insufficient lamports" says none of that.
      if (wallet.sol < MIN_SOL_FOR_ORDER + (count - 1) * SOL_PER_EXTRA_ORDER) {
        throw new Error(
          count > 1
            ? `This wallet needs about ${(MIN_SOL_FOR_ORDER + (count - 1) * SOL_PER_EXTRA_ORDER).toFixed(4)} devnet SOL for the rent on ${count} orders — use "Get demo funds", or schedule fewer opens.`
            : 'This wallet needs a little devnet SOL for account rent — use "Get demo funds".',
        )
      }

      // Re-read this wallet's orders now, with no fallback. The approval has
      // to cover the whole book, because SPL `Approve` replaces the delegated
      // amount rather than adding to it: approving just this order would
      // silently defund every earlier one. If we cannot see the book, we do
      // not guess at it.
      let book: BellOrder[]
      try {
        book = known(await loadOrders(conn, publicKey))
      } catch {
        throw new Error(
          'Could not read your existing orders just now, so nothing was sent — approving without them would defund them. Try again in a moment.',
        )
      }
      // Every order that can still fill, and only those: expired and resized
      // orders never settle, so funding them only ties up the quote.
      const committed = stillOwed(book, now, multiplierOf)
      const wanted = committed + BigInt(Math.round(usdAmount * 10 ** QUOTE_DECIMALS)) * BigInt(count)
      if (wallet.quote < wanted) {
        throw new Error(
          `That needs $${usd(wanted)} of demo-USDC across your orders; the wallet holds $${usd(wallet.quote)}.`,
        )
      }

      const args = {
        owner: publicKey,
        listing: current.listing,
        usd: usdAmount,
        nonce: BigInt(Date.now()),
        now,
        committed,
        nextOpen,
        markRateQ64: current.markRateQ64,
        markPx: current.markPx,
        limitUsd,
      }
      let sig: string
      if (repeat > 1) {
        // One approval for all of them, then the orders, packed into as few
        // transactions as fit; one prompt where the wallet signs a batch.
        const { ixs } = placeInstructions(args, recurringSlots(now, args.nonce, opens))
        const { sigs, error, failedAt } = await submitInOrder(
          conn,
          packTransactions(ixs, publicKey),
          publicKey,
          signTransaction,
          signAllTransactions,
        )
        if (failedAt !== null) {
          throw failedAt === 0
            ? error
            : new Error(
                `Only part of the recurring buy was placed (${describe(error)}). The approval covers all of it: cancel what landed, or use "Revoke all funding", and try again.`,
              )
        }
        sig = sigs[0]!
      } else {
        sig = await submit(conn, placeOrderTx(args).tx, publicKey, signTransaction)
      }
      const placed = repeat > 1
        ? `Scheduled $${usdAmount} of ${current.listing.symbol} at each of the next ${opens.length} opens (${opens.map((o) => nyDayOf(o)).join(', ')}), from one approval. Your funds stay in your wallet until each fills.`
        : current.allowed
        ? `Placed $${usdAmount} of ${current.listing.symbol}. The filler settles it on its next pass, within about five minutes. Your funds stay in your wallet until then.`
        : current.status === 'closed'
          ? `Queued $${usdAmount} of ${current.listing.symbol} for the opening bell. Your funds never left your wallet.${nightSooner}`
          : `Parked $${usdAmount} of ${current.listing.symbol}; it fills when ${clearsWhen(current)}. Your funds never left your wallet.`
      const limitNote =
        limitUsd === null
          ? ''
          : current.priceUsd && limitUsd < current.priceUsd
            ? ` Limit $${limitUsd.toFixed(2)} a share: below the pool's price now, so it fills only if the price comes down to it.`
            : ` Limit $${limitUsd.toFixed(2)} a share.`
      setNotice({ ok: true, sig, text: placed + limitNote })
      await refresh()
    } catch (e) {
      setNotice({ ok: false, text: describe(e) })
    } finally {
      setBusy(false)
    }
  }, [amount, conn, current, known, limit, multiplierOf, nightSooner, publicKey, refresh, repeat, signAllTransactions, signTransaction, wallet])

  /**
   * Place a sale. The mirror of `place()` on the other account: the approval is
   * on the wallet's stock account, under Token-2022, for every live sale of
   * that stock plus this one. The quote approval that funds the wallet's buys
   * is never touched, because approving it for a sale would defund them all.
   */
  const placeSell = useCallback(async () => {
    if (!publicKey || !signTransaction || !current) return
    setBusy(true)
    setNotice(null)
    try {
      const symbol = current.listing.symbol
      // Checked before the wallet opens, as for a buy, so a problem is
      // explained in words instead of refused by a program in hex.
      const holding = wallet?.holdings.find((h) => h.symbol === symbol) ?? null
      if (!holding || holding.raw === 0n) throw new Error(`This wallet holds no ${symbol} to sell.`)
      if (current.status === 'withdrawn') {
        throw new Error('The issuer has withdrawn this token, so a sale would wait on the issuer, not on a bell.')
      }
      // The program sizes a sale against the mark and refuses one without a
      // price, so there is nothing to place without one.
      if (!current.markRateQ64 || !current.markPx || current.multiplierBits === null) {
        throw new Error('There is no attested price for this symbol yet, and a sale is sized against it. Try again in a minute.')
      }
      const multiplier = multiplierFromBits(current.multiplierBits)
      let amountIn: bigint
      try {
        amountIn = sharesToRaw(sellShares, holding.decimals, multiplier)
      } catch {
        throw new Error('Enter a number of shares to sell, such as 0.5.')
      }
      if (amountIn <= 0n) throw new Error(`That is less than the smallest unit of ${symbol} there is.`)
      const shown = sharesShown(sellShares, amountIn, holding.decimals, multiplier)
      const limitUsd = sellLimit.trim() ? Number(sellLimit) : null
      // A cent at least, for the reason `place()` gives: below that the
      // minimum rounds to nothing in the mark's units.
      if (limitUsd !== null && !(limitUsd >= 0.01)) {
        throw new Error('Enter a minimum price per share, or leave it empty to sell at the price the bell sets.')
      }
      const value = sellOrderValue(amountIn, current.markRateQ64)
      if (value > MAX_ORDER_IN_RAW) {
        throw new Error(
          `${sharesOf(shown, symbol)} are worth $${usd(value)} at the price now. A sale is capped at $${MAX_ORDER_USD.toLocaleString()} of value while the program has an upgrade authority; "max" offers up to about $${SELL_MAX_USD}.`,
        )
      }
      const now = nowS()
      const nextOpen = current.openNow ? null : current.nextChangeAt || null
      // A sale snapshots the multiplier as a buy does, and parking one across a
      // scheduled change parks an order that can never fill.
      if (current.changeAt > 0 && current.changeAt < orderExpiry(now, nextOpen) && !current.allowed) {
        throw new Error(
          `A corporate action is scheduled for ${nyWhenOf(current.changeAt)}, before this sale could fill — it would be refused as resized. Place it after the change lands.`,
        )
      }
      // The order's rent, and a quote account's when the proceeds need one made.
      const solNeeded = SOL_PER_EXTRA_ORDER + (wallet?.quote === null ? QUOTE_ACCOUNT_RENT_SOL : 0)
      if (!wallet || wallet.sol < solNeeded) {
        throw new Error('This wallet needs a little devnet SOL for account rent — use "Get demo funds".')
      }

      // Re-read this wallet's sales now, with no fallback, for the reason
      // `place()` re-reads its orders: the approval assigns, so it has to cover
      // every live sale from this stock account, and a guess at them defunds them.
      let book: SellOrder[]
      try {
        book = knownSells(await loadSellOrders(conn, publicKey))
      } catch {
        throw new Error(
          'Could not read your existing sales just now, so nothing was sent — approving without them would defund them. Try again in a moment.',
        )
      }
      const committed = stillOwed(
        book.filter((o) => o.payerIn.equals(holding.account)),
        now,
        multiplierOf,
      )
      // A sale of shares the wallet does not hold would park and never fill.
      if (holding.raw < committed + amountIn) {
        throw new Error(
          committed > 0n
            ? `Your other sales of ${symbol} already offer ${rawToShares(committed, holding.decimals, multiplier)}; with this one that is more than the ${rawToShares(holding.raw, holding.decimals, multiplier)} the wallet holds.`
            : `The wallet holds ${rawToShares(holding.raw, holding.decimals, multiplier)} ${symbol}.`,
        )
      }

      const { tx } = placeSellOrderTx({
        owner: publicKey,
        listing: current.listing,
        amountIn,
        decimals: holding.decimals,
        nonce: BigInt(Date.now()),
        now,
        committed,
        nextOpen,
        markRateQ64: current.markRateQ64,
        markPx: current.markPx,
        minLimitUsd: limitUsd,
      })
      const sig = await submit(conn, tx, publicKey, signTransaction)
      const placed = current.allowed
        ? `Placed a sale of ${sharesOf(shown, symbol)}. The filler settles it on its next pass, within about five minutes. Your shares stay in your wallet until then.`
        : current.status === 'closed'
          ? `Queued a sale of ${sharesOf(shown, symbol)} for the opening bell. Your shares never left your wallet.${nightSooner}`
          : `Parked a sale of ${sharesOf(shown, symbol)}; it fills when ${clearsWhen(current)}. Your shares never left your wallet.`
      const limitNote =
        limitUsd === null
          ? ''
          : current.priceUsd && limitUsd > current.priceUsd
            ? ` Minimum $${limitUsd.toFixed(2)} a share: above the pool's price now, so it sells only if the price comes up to it.`
            : ` Minimum $${limitUsd.toFixed(2)} a share.`
      setNotice({ ok: true, sig, text: placed + limitNote })
      setSellShares('')
      await refresh()
    } catch (e) {
      setNotice({ ok: false, text: describe(e) })
    } finally {
      setBusy(false)
    }
  }, [conn, current, knownSells, multiplierOf, nightSooner, publicKey, refresh, sellLimit, sellShares, signTransaction, wallet])

  const cancel = useCallback(
    async (order: BellOrder) => {
      if (!publicKey || !signTransaction) return
      setBusy(true)
      setNotice(null)
      try {
        // What the other orders still need, read fresh. If the book cannot be
        // read, cancel anyway and leave them unfunded — a cancel that waits on
        // a read is a cancel that can fail, and stopping is the safe direction.
        let rest = 0n
        let unread = false
        try {
          const book = known(await loadOrders(conn, publicKey))
          rest = stillOwed(
            book.filter((o) => o.nonce !== order.nonce),
            nowS(),
            multiplierOf,
          )
        } catch {
          unread = true
        }
        const txs = cancelOrderTxs(publicKey, order, rest, bellDelegated)
        const { sigs, error, failedAt } = await submitInOrder(
          conn,
          txs,
          publicKey,
          signTransaction,
          signAllTransactions,
          (i, e) => bellDelegated && i === 1 && refusalFrom(e) === 'AlreadyClosed',
        )
        const revoked = bellDelegated && sigs[0] != null
        // The close landed (or found it already gone): take it off the list
        // now. A poll that began before the close would otherwise put it back
        // on screen, and the next cancel press would land on a closed order.
        if (failedAt === null) {
          closed.current.add(String(order.nonce))
          setOrders((list) => list?.filter((o) => o.nonce !== order.nonce) ?? list)
        }
        if (failedAt === null) {
          setNotice({
            ok: true,
            sig: sigs[0] ?? undefined,
            text: !bellDelegated
              ? 'Closed, and the rent returned. It was already unfunded — nothing was revoked.'
              : `Cancelled. Funding was revoked first, then ${sigs[1] ? 'the order closed and its rent returned' : 'the order turned out to be closed already'}${rest > 0n ? `, then your other orders re-funded ($${usd(rest)})` : ''}.${unread ? ' Your other orders could not be read, so they are unfunded too — cancel or re-place them.' : ''}`,
          })
        } else if (revoked) {
          // The part that matters landed. Say so before saying what did not.
          setNotice({
            ok: true,
            sig: sigs[0] ?? undefined,
            text:
              failedAt === 1
                ? `Funding revoked — this order can no longer fill. Closing it failed (${describe(error)}); press cancel again to reclaim the rent.${rest > 0n ? ' Your other orders are unfunded until then.' : ''}`
                : `Cancelled, but re-funding your other orders failed (${describe(error)}). They cannot fill until re-funded — placing any order re-approves the whole book.`,
          })
        } else {
          setNotice({ ok: false, text: describe(error) })
        }
        await refresh()
      } catch (e) {
        setNotice({ ok: false, text: describe(e) })
      } finally {
        setBusy(false)
      }
    },
    [bellDelegated, conn, known, multiplierOf, publicKey, refresh, signAllTransactions, signTransaction],
  )

  /**
   * Cancel a sale: revoke the stock account's approval on its own, close the
   * order, then re-approve the other sales from that account — the buy
   * cancel's three steps, on the stock account.
   */
  const cancelSell = useCallback(
    async (order: SellOrder) => {
      if (!publicKey || !signTransaction || !auth) return
      setBusy(true)
      setNotice(null)
      try {
        const holding = holdingAt(order.payerIn)
        // Revoke when the account's approval is BELL's. When the page does not
        // read the account (a sale placed from the command line out of another
        // one), revoke all the same: it was BELL's when the sale was placed,
        // and stopping is the safe direction. Only a read that found no such
        // account at all leaves nothing to revoke.
        const missing =
          !holding && !!wallet && order.payerIn.equals(ataFor(publicKey, order.mint, TOKEN_2022))
        const stockDelegated = holding ? !!holding.delegate?.equals(auth) : !missing
        const decimals =
          holding?.decimals ?? wallet?.holdings.find((h) => h.symbol === order.symbol)?.decimals ?? null
        // What the other sales from this account still need, read fresh. As
        // for a buy, an unreadable book does not hold up the cancel.
        let rest = 0n
        let unread = false
        try {
          const book = knownSells(await loadSellOrders(conn, publicKey))
          rest = stillOwed(
            book.filter((o) => o.nonce !== order.nonce && o.payerIn.equals(order.payerIn)),
            nowS(),
            multiplierOf,
          )
        } catch {
          unread = true
        }
        const refund = stockDelegated && rest > 0n && decimals !== null
        const txs = cancelSellOrderTxs(publicKey, order, rest, stockDelegated, decimals)
        const { sigs, error, failedAt } = await submitInOrder(
          conn,
          txs,
          publicKey,
          signTransaction,
          signAllTransactions,
          (i, e) => stockDelegated && i === 1 && refusalFrom(e) === 'AlreadyClosed',
        )
        const revoked = stockDelegated && sigs[0] != null
        if (failedAt === null) {
          closed.current.add(sellKey(order))
          setSells((list) => list?.filter((o) => o.nonce !== order.nonce) ?? list)
        }
        const restShown = decimals === null ? `${rest} raw` : rawToShares(rest, decimals, multiplierFromBits(order.expectedMultiplierBits))
        if (failedAt === null) {
          setNotice({
            ok: true,
            sig: sigs[0] ?? undefined,
            text: !stockDelegated
              ? 'Closed, and the rent returned. It was already unfunded — nothing was revoked.'
              : `Cancelled. The stock approval was revoked first, then ${sigs[1] ? 'the sale closed and its rent returned' : 'the sale turned out to be closed already'}${refund ? `, then your other sales of ${order.symbol} re-approved (${sharesOf(restShown, order.symbol)})` : ''}.${unread ? ` Your other sales of ${order.symbol} could not be read, so they are unfunded too — cancel or re-place them.` : ''}${rest > 0n && decimals === null ? ` Your other sales of ${order.symbol} could not be re-approved from here, so they are unfunded — cancel or re-place them.` : ''}`,
          })
        } else if (revoked) {
          // The part that matters landed. Say so before saying what did not.
          setNotice({
            ok: true,
            sig: sigs[0] ?? undefined,
            text:
              failedAt === 1
                ? `Stock approval revoked — this sale can no longer fill. Closing it failed (${describe(error)}); press cancel sell again to reclaim the rent.${rest > 0n ? ` Your other sales of ${order.symbol} are unfunded until then.` : ''}`
                : `Cancelled, but re-approving your other sales of ${order.symbol} failed (${describe(error)}). They cannot fill until re-approved — placing any sale of ${order.symbol} re-approves them all.`,
          })
        } else {
          setNotice({ ok: false, text: describe(error) })
        }
        await refresh()
      } catch (e) {
        setNotice({ ok: false, text: describe(e) })
      } finally {
        setBusy(false)
      }
    },
    [auth, conn, holdingAt, knownSells, multiplierOf, publicKey, refresh, signAllTransactions, signTransaction, wallet],
  )

  /**
   * The emergency exit: revoke every approval to BELL, then close every order.
   * Offered whenever any approval is outstanding, including one no order
   * explains — an approval whose order never landed is still an approval.
   * The quote account's revoke goes first and alone, as it always has; then
   * each stock account BELL may sell from; then every buy and sale is closed.
   */
  const revokeAll = useCallback(async () => {
    if (!publicKey || !signTransaction || !auth) return
    setBusy(true)
    setNotice(null)
    try {
      const book = await loadOrders(conn, publicKey).catch(() => orders ?? [])
      const sellBook = await loadSellOrders(conn, publicKey).catch(() => sells ?? [])
      // The stock accounts to revoke: each the last read saw delegated to
      // BELL, and each live sale's own account too, since a sale placed after
      // that read has an approval the read never saw. Revoking an account with
      // no approval costs nothing, so the only ones left out are an account
      // whose approval the read says belongs to someone else, which is not
      // BELL's to take away, and one the read found does not exist, whose
      // revoke would fail and take the others in its transaction with it.
      const stock = new Map<string, PublicKey>()
      for (const h of wallet?.holdings ?? []) {
        if (h.delegate?.equals(auth)) stock.set(h.account.toBase58(), h.account)
      }
      for (const o of sellBook) {
        const h = holdingAt(o.payerIn)
        if (h?.delegate && !h.delegate.equals(auth)) continue
        if (!h && wallet && o.payerIn.equals(ataFor(publicKey, o.mint, TOKEN_2022))) continue
        stock.set(o.payerIn.toBase58(), o.payerIn)
      }
      // The quote account, unless there is none or its approval is someone
      // else's; either way there is nothing of BELL's on it to revoke.
      const quote =
        wallet && (wallet.quote === null || (wallet.delegate && !wallet.delegate.equals(auth)))
          ? null
          : ataFor(publicKey, QUOTE_MINT)
      const { txs, revokes } = revokeAllTxs(publicKey, quote, book, [...stock.values()], sellBook)
      if (txs.length === 0) {
        setNotice({ ok: true, text: 'Nothing to revoke: BELL holds no approval on this wallet, and it has no orders.' })
        return
      }
      const { sigs, error, failedAt } = await submitInOrder(
        conn,
        txs,
        publicKey,
        signTransaction,
        signAllTransactions,
        (i, e) => i >= revokes && refusalFrom(e) === 'AlreadyClosed',
      )
      const closedCount = book.length + sellBook.length
      if (failedAt === null) {
        for (const o of book) closed.current.add(String(o.nonce))
        for (const o of sellBook) closed.current.add(sellKey(o))
        setOrders([])
        setSells([])
      }
      const what = stock.size > 0 ? 'spend any of your demo-USDC or sell any of your shares' : 'spend any of your demo-USDC'
      setNotice(
        failedAt === null
          ? {
              ok: true,
              sig: sigs[0] ?? undefined,
              text: `Funding revoked — BELL can no longer ${what}.${closedCount ? ` ${closedCount} order(s) closed and their rent returned.` : ''}`,
            }
          : failedAt >= revokes
            ? {
                ok: true,
                sig: sigs[0] ?? undefined,
                text: `Funding revoked — nothing can fill. Closing the orders failed (${describe(error)}); cancel them to reclaim the rent.`,
              }
            : failedAt > 0
              ? {
                  // A revoke landed and a later stock revoke did not: a sale
                  // can still fill, so this is not the all-clear.
                  ok: false,
                  sig: sigs[0] ?? undefined,
                  text: `${quote ? 'Your demo-USDC funding was revoked, so no buy can fill — but revoking' : 'Revoking'} the approval on some of your shares failed (${describe(error)}), so a sale still can. Press "Revoke all funding" again.`,
                }
              : { ok: false, text: describe(error) },
      )
      await refresh()
    } catch (e) {
      setNotice({ ok: false, text: describe(e) })
    } finally {
      setBusy(false)
    }
  }, [auth, conn, holdingAt, orders, publicKey, refresh, sells, signAllTransactions, signTransaction, wallet])

  /**
   * Night fills on or off, for every order this wallet has.
   *
   * What to send is decided from a fresh read, not the last poll's, and only
   * in the direction the switch showed: opting in twice fails on the account
   * that exists, opting out with none fails on the one that does not, and a
   * press that meant "on" must never turn it off.
   */
  const toggleNight = useCallback(async () => {
    if (!publicKey || !signTransaction) return
    const want = !nightOn
    setBusy(true)
    setNotice(null)
    try {
      let on: boolean
      try {
        on = (await loadNightOptIn(conn, publicKey)) !== null
      } catch {
        throw new Error('Could not read whether night fills are on for this wallet just now, so nothing was sent. Try again in a moment.')
      }
      if (on === want) {
        setNotice({ ok: true, text: `Night fills are already ${on ? 'on' : 'off'} for this wallet; nothing was sent.` })
      } else if (want) {
        // The opt-in is an account, and its rent comes from this wallet.
        if (!wallet || wallet.sol < NIGHT_OPT_IN_RENT_SOL + 0.00001) {
          throw new Error(
            `Night fills hold about ${NIGHT_OPT_IN_RENT_SOL.toFixed(4)} devnet SOL of rent while they are on, returned when you turn them off — use "Get demo funds".`,
          )
        }
        const sig = await submit(conn, optInNightTx(publicKey), publicKey, signTransaction)
        setNotice({
          ok: true,
          sig,
          text: `Night fills are on, for every live order of this wallet and every one after. While New York is shut, an order fills only when the pool's price is within ${bandText(MAX_NIGHT_GAP_BPS)} of the exchange's last price, and only within ${bound(MAX_NIGHT_REF_AGE_SECONDS)} of that sale; a halt, a paused mint or a dividend window still refuses it.`,
        })
      } else {
        const sig = await submit(conn, optOutNightTx(publicKey), publicKey, signTransaction)
        setNotice({
          ok: true,
          sig,
          text: 'Night fills are off. Every order of this wallet fills only in the regular session again, and the rent is back.',
        })
      }
      await refresh()
    } catch (e) {
      // A program without night fills refuses the instruction as unknown
      // before it runs; that is said as what it means for this switch.
      setNotice({
        ok: false,
        text:
          refusalFrom(e) === 'InstructionFallbackNotFound'
            ? 'The program on this cluster does not take night fills yet; they arrive with its next upgrade. Nothing landed.'
            : describe(e),
      })
    } finally {
      setBusy(false)
    }
  }, [conn, nightOn, publicKey, refresh, signTransaction, wallet])

  const bookFunded = orders ? funded(orders) : true
  const canPlace = !!current && !['withdrawn', 'offline', 'unlisted'].includes(current.status)

  // What the wallet holds: the stock accounts with a balance. An empty one
  // stays in the wallet view for "Revoke all funding", but is not a holding.
  const held = wallet?.holdings.filter((h) => h.raw > 0n) ?? []
  /** Raw stock as shares, at the multiplier in force for its symbol. */
  const sharesAt = (h: Pick<Holding, 'symbol' | 'decimals'>, raw: bigint) => {
    const bits = multiplierOf(h.symbol)
    return rawToShares(raw, h.decimals, bits != null ? multiplierFromBits(bits) : 1)
  }
  // Each approval BELL holds, on the quote account and on any stock account.
  const quoteApproved = !!wallet && bellDelegated && wallet.delegatedAmount > 0n
  const stockApprovals = auth
    ? (wallet?.holdings ?? []).filter((h) => h.delegate?.equals(auth) && h.delegatedAmount > 0n)
    : []

  // The sale being typed: the account it would draw on, and its size in raw
  // units, or null while the text is not yet a number of shares.
  const sellHolding = (current && wallet?.holdings.find((h) => h.symbol === current.listing.symbol)) || null
  const sellMultiplier = current?.multiplierBits != null ? multiplierFromBits(current.multiplierBits) : null
  const sellRaw = (() => {
    if (!sellHolding || sellMultiplier === null || !sellShares.trim()) return null
    try {
      return sharesToRaw(sellShares, sellHolding.decimals, sellMultiplier)
    } catch {
      return null
    }
  })()
  /**
   * "max": what this stock account holds less what the wallet's other sales
   * already offer, and at most about $990 of it at the price now, so the sale
   * it proposes is one the program's $1,000 cap accepts.
   */
  const sellMax = () => {
    if (!current || !sellHolding || sellMultiplier === null) return
    const symbol = current.listing.symbol
    const owed = stillOwed(
      (sells ?? []).filter((o) => o.payerIn.equals(sellHolding.account)),
      nowS(),
      multiplierOf,
    )
    const raw = maxSellRaw({ held: sellHolding.raw, owed, rateQ64: current.markRateQ64 })
    if (raw > 0n) {
      setSellShares(rawToShares(raw, sellHolding.decimals, sellMultiplier))
      return
    }
    setNotice({
      ok: false,
      text: !current.markRateQ64
        ? `There is no attested price for ${symbol} yet, so there is nothing to size a sale against.`
        : `Your other sales of ${symbol} already offer every share this wallet holds.`,
    })
  }

  return (
    <div className="wrap">
      {CLUSTER === 'devnet' && (
        <div className="banner">
          <strong>Devnet — test money only.</strong> Switch your wallet to devnet (Phantom: Settings
          → Developer Settings → Testnet Mode → Solana Devnet). <em>Get demo funds</em> gives a
          fresh wallet 1,000 demo-USDC — a devnet token BELL issued, not USDC — and a little devnet
          SOL for rent and fees. Your wallet will warn that an order lets another account spend your
          demo-USDC (for a sale, your shares): that is the delegation, and cancelling revokes it. If your wallet shows zero
          after funding, it is looking at mainnet.
        </div>
      )}

      <header>
        <div className="top">
          <div>
            <h1>BELL</h1>
            <div className="sub">
              The venue for real US securities on Solana that knows what time it is.
            </div>
            {/* Not `.sub`: the demo script reads the second `.sub` as the board line. */}
            <p className="what">
              The safe way to trade US stocks from your own wallet, at any hour. In the regular session
              BELL trades; when a stock is halted or a dividend is about to change the token, it refuses
              on-chain; while New York is shut, it holds your order for a real price.
            </p>
          </div>
          {mounted && <WalletMultiButton />}
        </div>
        <div className="clock">{mounted && <Clock views={views} nightOn={!!publicKey && nightOn} />}</div>
        <div className="sub" style={{ marginTop: 8 }}>
          {views.length > 0 && (
            <>
              {tradeable} of {views.length} tradeable ·{' '}
            </>
          )}
          {updatedAt ? `updated ${nyClockOf(updatedAt)}` : 'loading…'} ·{' '}
          <span style={{ opacity: 0.6 }}>{RPC_URL}</span>
        </div>
        {publicKey && wallet && (
          <div className="bal">
            <span>
              demo-USDC <strong>{wallet.quote === null ? '—' : usd(wallet.quote)}</strong>
            </span>
            <span>
              SOL <strong>{wallet.sol.toFixed(4)}</strong>
            </span>
            {CLUSTER === 'devnet' && (
              <button className="mini" disabled={busy} onClick={() => void getFunds()}>
                Get demo funds
              </button>
            )}
          </div>
        )}
        {publicKey && wallet && (quoteApproved || stockApprovals.length > 0) && (
          <div className="revoke">
            <span>
              BELL may{' '}
              {quoteApproved && (
                <>
                  spend up to <strong>${usd(wallet.delegatedAmount)}</strong> of your demo-USDC
                </>
              )}
              {quoteApproved && stockApprovals.length > 0 && ' and '}
              {stockApprovals.length > 0 && 'sell up to '}
              {stockApprovals.map((h, i) => (
                <Fragment key={h.symbol}>
                  {i === 0 ? '' : i === stockApprovals.length - 1 ? ' and ' : ', '}
                  <strong>{sharesAt(h, h.delegatedAmount)}</strong> {h.symbol}
                </Fragment>
              ))}
              , for your orders only.
            </span>
            <button className="mini" disabled={busy} onClick={() => void revokeAll()}>
              Revoke all funding
            </button>
          </div>
        )}
        {publicKey && wallet && held.length > 0 && (
          <div className="bal holdings">
            <span>holding</span>
            {held.map((h) => (
              <span key={h.symbol}>
                <strong>{h.shares.toLocaleString(undefined, { maximumFractionDigits: 6 })}</strong>{' '}
                {h.symbol}
              </span>
            ))}
          </div>
        )}
        {/* Night fills, off by default. Not `.bal`: the demo script reads the
            first `.bal` as the balances row. The sentence beside the switch is
            what the owner consents to, so it is always there, on or off. */}
        {publicKey && wallet && (
          <div className="night">
            <button
              type="button"
              role="switch"
              className="switch"
              aria-checked={nightOn}
              aria-labelledby="night-label"
              disabled={busy || (!nightOn && !nightReady)}
              onClick={() => void toggleNight()}
            >
              <span className="knob" />
            </button>
            <span>
              <strong id="night-label">Fill my orders at night, inside the band</strong> · {nightOn ? 'on' : 'off'}.{' '}
              {!nightOn && !nightReady && <>Not set up yet: night fills arrive with the program&apos;s next upgrade. </>}
              For every live order of this wallet, including ones already placed (a recurring buy&apos;s later
              days still keep to their own open): while New York is shut, an
              order fills only when the pool&apos;s price is within {bandText(MAX_NIGHT_GAP_BPS)} of the
              exchange&apos;s last price, and only within {bound(MAX_NIGHT_REF_AGE_SECONDS)} of that sale, so a
              weekend mostly waits for the bell. A halt, a paused mint or a dividend window still refuses it.
              {nightOn
                ? ' Off stops night fills for every order at once and returns the rent.'
                : ` On holds about ${NIGHT_OPT_IN_RENT_SOL.toFixed(4)} SOL of rent until you turn it off.`}
            </span>
          </div>
        )}
      </header>

      {error && (
        <div className="panel" style={{ borderColor: 'var(--stop)' }}>
          <strong className="fail">Cannot reach the chain.</strong>
          <div className="note">
            Nothing is tradeable while this is true — an unreachable chain is not permission to
            trade. {error}
          </div>
        </div>
      )}

      <div className="grid">
        {views.map((v) => (
          <button
            key={v.listing.symbol}
            className="tile"
            data-selected={current?.listing.symbol === v.listing.symbol}
            onClick={() => setSelected(v.listing.symbol)}
          >
            <div className="sym">
              {v.listing.symbol} <Badge view={v} />
              {/* The night band, on the board: this wallet opted in, the session
                  is shut, and nothing but "market open" stands in the way. */}
              {publicKey && nightOn && v.registered && !v.openNow && v.nightReason === null && (
                <span className="nb" title="Inside the night band: an order of yours here may fill before the bell">
                  {' '}☾
                </span>
              )}
            </div>
            <div className="px">
              {/* A held price is the last one the breaker let through: shown as
                  held, since the badge already says nothing fills on it. */}
              {v.priceUsd
                ? `$${v.priceUsd.toFixed(2)}`
                : v.markHeld && v.markPx
                  ? `$${(Number(v.markPx.num) * 10 ** v.markPx.expo).toFixed(2)} held`
                  : 'no price'}{' '}
              · {v.listing.issuer}
            </div>
          </button>
        ))}
      </div>

      {current && (
        <div className="panel">
          <p className="verdict">
            {current.allowed ? (
              <>
                <span className="pass">✓</span> {current.listing.symbol} is tradeable right now.
              </>
            ) : (
              <>
                <span className="fail">✕</span> {explainView(current)}
              </>
            )}
          </p>

          {current.gates.map((g) => {
            const [glyph, tone] = markOf(g.ok)
            return (
              <div className="gate" key={g.label}>
                <span className={`mark ${tone}`}>{glyph}</span>
                <span className="label">{g.label}</span>
                <span className="detail">{g.detail}</span>
              </div>
            )
          })}

          {(() => {
            // What the real market last said, next to what the pool would
            // charge now. Display only: nothing on chain reads it.
            const ref = refs[current.listing.underlying]
            if (!ref || !current.priceUsd) return null
            const bps = ((current.priceUsd - ref.last) / ref.last) * 10_000
            const away =
              Math.abs(bps) < 1 ? 'level with it' : `${Math.abs(bps).toFixed(0)}bps ${bps > 0 ? 'above' : 'below'} it`
            return (
              <div className="gate">
                <span className="mark disclose">ⓘ</span>
                <span className="label">pool vs US price</span>
                <span className="detail">
                  $200 buys at ${current.priceUsd.toFixed(2)} a share in the Solana pool;{' '}
                  {current.listing.underlying} last traded at ${ref.last.toFixed(2)} (
                  {ref.marketStatus.toLowerCase()}
                  {ref.realTime ? '' : ', delayed'}, Nasdaq) — {away}
                </span>
              </div>
            )
          })()}

          {/* What night fills mean for this symbol now, for a wallet that
              opted in. The verdict above stays the session's: it is what an
              order that has not opted in meets, and the bell is when an order
              that has fills at the latest. */}
          {publicKey && nightOn && current.registered && !current.openNow && (
            <div className="note nightnote">
              ☾ Night fills are on for this wallet.{' '}
              {current.nightReason === null
                ? `${current.listing.symbol} is inside the night band${
                    current.refGap
                      ? ` (${current.refGap.bps}bps from the checker's last sale, within ${current.refGap.bandBps}bps)`
                      : ''
                  }, so an order of yours here may fill before the bell.`
                : `${current.listing.symbol} does not fill at night right now: ${explain(current.nightReason)}`}
            </div>
          )}

          {/* The note describes the real security. A devnet mirror is not it,
              and a note like "an entitlement to the real PFE share" would be
              false of the token actually on screen without saying so. */}
          <div className="note">
            {current.listing.note}
            {CLUSTER === 'devnet' && " On devnet this is BELL's mirror of that token, not the security itself."}
          </div>

          {/* Buy or sell. Buy is where the page opens, and its row below is the
              same row whichever side was shown last. */}
          <div className="side" role="group" aria-label="buy or sell">
            <button type="button" aria-pressed={side === 'buy'} onClick={() => setSide('buy')}>
              Buy
            </button>
            <button type="button" aria-pressed={side === 'sell'} onClick={() => setSide('sell')}>
              Sell
            </button>
          </div>

          {side === 'buy' ? (
          <div className="buy">
            <label className="amt">
              <span>$</span>
              <input
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                aria-label="amount in dollars"
              />
            </label>
            <label className="amt lim" title="Leave empty to buy at the price the bell sets">
              <span>max $</span>
              <input
                inputMode="decimal"
                value={limit}
                onChange={(e) => setLimit(e.target.value)}
                placeholder="any"
                aria-label="limit price per share"
              />
              <span>/share</span>
            </label>
            <label className="amt rep" title="One bell order, or one at each of the next few opens">
              <select value={repeat} onChange={(e) => setRepeat(Number(e.target.value))} aria-label="repeat">
                <option value={1}>once</option>
                <option value={3}>next 3 opens</option>
                <option value={5}>up to 5 opens</option>
              </select>
            </label>
            <button
              className={`act ${current.allowed ? '' : 'secondary'}`}
              disabled={!publicKey || busy || !canPlace || !(Number(amount) > 0)}
              onClick={() => void place()}
            >
              {busy
                ? 'working…'
                : !publicKey
                  ? 'Connect a wallet'
                  : current.allowed
                    ? `Place order · the filler settles it within ~5 min`
                    : current.status === 'withdrawn'
                      ? 'Not queueable · fills only if the issuer resumes'
                      : current.status === 'offline'
                        ? 'Cannot reach the chain'
                        : current.status === 'closed'
                          ? `Queue it for the opening bell${
                              current.nextChangeAt > 0
                                ? ` · ${nyWhenOf(current.nextChangeAt)}`
                                : ''
                            }`
                          : `Park it — fills when ${clearsWhen(current)}`}
            </button>
          </div>
          ) : (
          // The sale row. It takes the buy row's layout, and its own controls:
          // shares rather than dollars, a minimum price rather than a maximum,
          // and no repeat, since a sale is of shares already held.
          <div className="buy sell">
            <div className="amt shares">
              <input
                inputMode="decimal"
                value={sellShares}
                onChange={(e) => setSellShares(e.target.value)}
                placeholder="0"
                aria-label="shares to sell"
              />
              <span>{current.listing.symbol}</span>
              <button
                type="button"
                className="mini max"
                disabled={busy || !sellHolding || sellHolding.raw === 0n}
                onClick={sellMax}
                title={`Everything you hold that your other sales do not offer, up to about $${SELL_MAX_USD} at the price now`}
              >
                max
              </button>
            </div>
            <label className="amt lim" title="Leave empty to sell at the price the bell sets">
              <span>min $</span>
              <input
                inputMode="decimal"
                value={sellLimit}
                onChange={(e) => setSellLimit(e.target.value)}
                placeholder="any"
                aria-label="sell limit price per share"
              />
              <span>/share</span>
            </label>
            <button
              className={`act ${current.allowed ? '' : 'secondary'}`}
              disabled={!publicKey || busy || !canPlace || !sellHolding || sellHolding.raw === 0n || !(sellRaw && sellRaw > 0n)}
              onClick={() => void placeSell()}
            >
              {busy
                ? 'working…'
                : !publicKey
                  ? 'Connect a wallet'
                  : !sellHolding || sellHolding.raw === 0n
                    ? `Nothing to sell · this wallet holds no ${current.listing.symbol}`
                    : current.allowed
                      ? 'Place sale · the filler settles it within ~5 min'
                      : current.status === 'withdrawn'
                        ? 'Not queueable · fills only if the issuer resumes'
                        : current.status === 'offline'
                          ? 'Cannot reach the chain'
                          : current.status === 'closed'
                            ? `Queue the sale for the opening bell${
                                current.nextChangeAt > 0 ? ` · ${nyWhenOf(current.nextChangeAt)}` : ''
                              }`
                            : `Park it — fills when ${clearsWhen(current)}`}
            </button>
          </div>
          )}

          {side === 'buy' && current.priceUsd && current.markRateQ64 && Number(amount) > 0 && canPlace && (() => {
            // What the user is agreeing to, in money, before the wallet opens.
            // The band is relative to the price at the bell; the cap is absolute.
            const usdAmount = Number(amount)
            const limitUsd = limit.trim() && Number(limit) >= 0.01 ? Number(limit) : null
            const cap = maxPricePerShare(current.priceUsd, limitUsd)
            const shares = usdAmount / current.priceUsd
            const opens = repeat > 1 ? nextOpens(nowS(), repeat) : []
            return (
              <div className="worst">
                {opens.length > 0 && (
                  <>
                    ${usdAmount.toLocaleString()} at each of the next {opens.length} opens (
                    {opens.map((o) => nyDayOf(o)).join(', ')}): $
                    {(usdAmount * opens.length).toLocaleString()} in all, approved once.{' '}
                  </>
                )}
                At the pool's price now (${current.priceUsd.toFixed(2)}), ${usdAmount.toLocaleString()} buys about{' '}
                {shares.toLocaleString(undefined, { maximumFractionDigits: 4 })} {current.listing.symbol}. The fill uses
                the price at that moment, plus at most 30bps — and whatever the price does before then, never more
                than <strong>${cap.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} a share</strong>
                {limitUsd && cap === limitUsd ? ' (your limit)' : ' (a third over the price now: the loss cap)'}.
                {limitUsd && limitUsd < current.priceUsd
                  ? ' Your limit is under the price now, so it fills only if the price comes down to it; if it does not, the order lapses and nothing is spent.'
                  : ''}
              </div>
            )
          })()}

          {side === 'sell' && current.priceUsd && current.markRateQ64 && sellHolding && sellMultiplier !== null && sellRaw && sellRaw > 0n && canPlace && (() => {
            // The same promise as the buy box, from the seller's side: the band
            // is relative to the price at the fill, the floor is absolute, and
            // both are in the seller's favour. "About" because the fill is priced
            // at that moment, not now.
            const limitUsd = sellLimit.trim() && Number(sellLimit) >= 0.01 ? Number(sellLimit) : null
            // The minimum is read back from the floor `placeSell` would put on
            // the order, built by the same function from the same mark, so the
            // figure promised is the one the program enforces, rounded down to
            // the cent, and never three quarters of a price rounded up past it.
            if (!current.markPx) return null
            const lossFloor = sellOrderFloor(current.markRateQ64, current.markPx, null)
            let placedFloor: bigint
            try {
              placedFloor = sellOrderFloor(current.markRateQ64, current.markPx, limitUsd)
            } catch {
              // A minimum too large to carry as a floor; `placeSell` says so.
              return null
            }
            const floor = sellFloorUsd(placedFloor, current.markRateQ64, current.markPx)
            const byLimit = placedFloor > lossFloor
            const n = sharesShown(sellShares, sellRaw, sellHolding.decimals, sellMultiplier)
            const proceeds = stockToQuoteCeil(sellRaw, current.markRateQ64)
            const over = sellOrderValue(sellRaw, current.markRateQ64) > MAX_ORDER_IN_RAW
            return (
              <div className="worst">
                At the pool's price now (${current.priceUsd.toFixed(2)}), {sharesOf(n, current.listing.symbol)} sell for
                about ${usd(proceeds)}. The fill uses the price at that moment, minus at most 30bps — and whatever the
                price does before then, never less than{' '}
                <strong>${floor.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} a share</strong>
                {byLimit ? ' (your limit)' : ' (three quarters of the price now: the loss cap)'}.{' '}
                {byLimit && limitUsd! > current.priceUsd
                  ? 'Your limit is over the price now, so it sells only if the price comes up to it; if it does not, the order lapses and none of your shares are taken.'
                  : byLimit
                    ? 'If the price is under your limit when it comes to fill, the order does not sell and none of your shares are taken.'
                    : `If the stock ${current.openNow ? 'falls' : 'opens'} more than 25% below the price now, the order does not sell and none of your shares are taken.`}
                {over && ` That is over the $${MAX_ORDER_USD.toLocaleString()} a sale may be worth; "max" offers the most it can.`}
              </div>
            )
          })()}

          {notice && (
            <div className={`notice ${notice.ok ? 'ok' : 'bad'}`}>
              {notice.text}
              {notice.sig && (
                <>
                  {' '}
                  <a href={explorerTx(notice.sig)} target="_blank" rel="noreferrer">
                    view on explorer ↗
                  </a>
                </>
              )}
            </div>
          )}

          <div className="note">
            A refusal is never the end of it: the order parks and fills at the open, and cancelling is
            an SPL <code>revoke</code> from your own wallet that this program plays no part in.
          </div>
        </div>
      )}

      {publicKey && fills.length > 0 && (
        <div className="panel">
          <p className="verdict">Your fills</p>
          {fills.map((f) => {
            const at = Math.floor(Date.parse(f.time) / 1000)
            const after = minutesAfterOpen(at)
            // A cross is one row with both parties on it; this wallet's side
            // is the one it is named on.
            const sold = fillSide(f, publicKey.toBase58()) === 'sold'
            const crossed = f.direction === 'cross'
            // Over the checked price, as a price: the program's `realizedBps`
            // is the stock short of fair, rounded down, so a fill at the edge
            // of a 30bps band reads 31 beside a box that promised at most 30.
            // On a sale it is the quote short of fair, which is a price under
            // the mark, so the fallback turns it the other way.
            const over =
              f.priceUsd !== null && f.markPriceUsd > 0
                ? Math.round((f.priceUsd / f.markPriceUsd - 1) * 10_000)
                : sold
                  ? -f.realizedBps
                  : f.realizedBps
            const count =
              f.shares !== null ? f.shares.toLocaleString(undefined, { maximumFractionDigits: 6 }) : f.stockRaw + ' raw'
            return (
              // One transaction can carry several crosses of one buy against
              // different sales, so the sale is part of what tells rows apart.
              <div className="receipt" key={`${f.signature}:${f.direction}:${f.order}:${f.sellOrder ?? ''}`}>
                <span className="label">{f.symbol}</span>
                <span className="detail">
                  {nyWhenOf(at)}
                  {after !== null ? ` · ${after} min after the bell` : ''} ·{' '}
                  {crossed ? (
                    // No filler stood between the two sides, so there is no
                    // spread to report: the price is the pool's, and that is
                    // all the line claims. Not "fair": the pool's price is an
                    // executable ask, spread and all.
                    <>
                      crossed with another user at the pool&apos;s price, no filler spread: {sold ? 'sold' : 'bought'}{' '}
                      {count} {f.symbol}
                      {f.priceUsd !== null ? ` at $${f.priceUsd.toFixed(2)} a share` : ''} for ${f.notionalUsd.toFixed(2)}
                    </>
                  ) : sold ? (
                    <>
                      sold {count} {f.symbol} for ${f.notionalUsd.toFixed(2)}
                      {f.priceUsd !== null ? ` ($${f.priceUsd.toFixed(2)} a share)` : ''}
                    </>
                  ) : (
                    <>
                      ${f.notionalUsd.toFixed(2)} bought {count} {f.symbol}
                      {f.priceUsd !== null ? ` at $${f.priceUsd.toFixed(2)} a share` : ''}
                    </>
                  )}{' '}
                  ·{' '}
                  {/* A cross settles at the price it is checked against, so it has no "over" to report. */}
                  {!crossed && (
                    <>
                      {over < 0 ? `${-over}bps under` : `${over}bps over`} the price it was checked against (${f.markPriceUsd.toFixed(2)}, a {f.markSource} quote) ·{' '}
                    </>
                  )}
                  <a href={f.explorer} target="_blank" rel="noreferrer">
                    receipt on the explorer ↗
                  </a>
                </span>
              </div>
            )
          })}
          <div className="note">
            Read back from the chain by this site&apos;s tape route: each line is a fill or a cross and
            the event the program emitted when it settled, and each links to that transaction, so none of
            it rests on our word. The same record, for every buyer and seller and without wallets, is the
            public tape at <a href="/api/tape">/api/tape</a>.
          </div>
        </div>
      )}

      {publicKey && orders && orders.length > 0 && (
        <div className="panel">
          <p className="verdict">Your bell orders</p>
          {orders.map((o) => {
            const dead = deadReason(o, nowS(), multiplierOf(o.symbol))
            const view = views.find((v) => v.listing.symbol === o.symbol)
            return (
              <div className="order" key={String(o.nonce)}>
                <span className="label">{o.symbol}</span>
                <span className="detail">
                  ${usd(o.amountIn)}
                  {o.filledIn > 0n ? ` · $${usd(o.filledIn)} filled` : ''}
                  {Number(o.notBefore) > nowS() ? ` · for the ${nyWhenOf(Number(o.notBefore))} open` : ''}
                  {dead === 'expired'
                    ? ' · expired — cancel to reclaim the rent'
                    : dead === 'resized'
                      ? ' · refused: a corporate action changed its size — cancel to reclaim the rent'
                      : !bookFunded
                        ? ' · not funded — the delegation no longer covers it, so it cannot fill'
                        : Number(o.notBefore) > nowS()
                          ? // A later day of a recurring buy: the program holds it
                            // back until its own open, whatever the session is now.
                            ' · held until then'
                          : view?.allowed
                          ? ' · the filler settles it on its next pass'
                          : !view || view.status === 'closed'
                            ? nightOn
                              ? ' · waiting for the bell, or a night fill inside the band'
                              : ' · waiting for the bell'
                            : ` · parked — fills when ${clearsWhen(view)}`}{' '}
                  {(() => {
                    // The floor as a price: rate and price are inverse, so the
                    // cap is today's price scaled by today's rate over the floor.
                    // Only meaningful while the multiplier it was built on holds.
                    if (!view?.markRateQ64 || !view.markPx || o.floorRateQ64 <= 0n || dead) return null
                    const px = Number(view.markPx.num) * 10 ** view.markPx.expo
                    const cap = (px * Number(view.markRateQ64)) / Number(o.floorRateQ64)
                    return <> · never above ${cap.toFixed(2)}/share</>
                  })()}
                  {' '}· slip ≤ {o.maxSlipBps}bps · until {nyWhenOf(Number(o.expiresAt))}
                </span>
                <button className="mini" disabled={busy} onClick={() => void cancel(o)}>
                  cancel
                </button>
              </div>
            )
          })}
          <div className="note">
            ${usd(stillOwed(orders, nowS(), multiplierOf))} of your demo-USDC is delegated against
            these orders and stays in your wallet until a fill. Cancelling sends <code>revoke</code>{' '}
            on its own first — that alone makes every order unfillable, and it works even if this
            program never runs again — then closes the order for its rent, then re-funds any others
            you still have.
          </div>
        </div>
      )}

      {/* Sales get their own list and their own row class. Not `.order`: the
          judge-path script counts `.order` rows to watch a buy fill, and presses
          every button named exactly "cancel" to cancel buys. */}
      {publicKey && sells && sells.length > 0 && (
        <div className="panel">
          <p className="verdict">Your sell orders</p>
          {sells.map((o) => {
            const dead = deadReason(o, nowS(), multiplierOf(o.symbol))
            const view = views.find((v) => v.listing.symbol === o.symbol)
            const decimals =
              holdingAt(o.payerIn)?.decimals ?? wallet?.holdings.find((h) => h.symbol === o.symbol)?.decimals
            // In shares at the multiplier the sale was sized at, which is the
            // one it can fill under.
            const shares = (raw: bigint) =>
              decimals === undefined
                ? `${raw} raw`
                : rawToShares(raw, decimals, multiplierFromBits(o.expectedMultiplierBits))
            return (
              <div className="sell-order" key={sellKey(o)}>
                <span className="label">{o.symbol}</span>
                <span className="detail">
                  sell {shares(o.amountIn)} {o.symbol}
                  {o.filledIn > 0n ? ` · ${shares(o.filledIn)} sold` : ''}
                  {dead === 'expired'
                    ? ' · expired — cancel to reclaim the rent'
                    : dead === 'resized'
                      ? ' · refused: a corporate action changed its size — cancel to reclaim the rent'
                      : !sellFunded(o, sells)
                        ? ' · not funded — the approval on your shares no longer covers it, so it cannot fill'
                        : view?.allowed
                          ? ' · the filler settles it on its next pass'
                          : !view || view.status === 'closed'
                            ? nightOn
                              ? ' · waiting for the bell, or a night fill inside the band'
                              : ' · waiting for the bell'
                            : ` · parked — fills when ${clearsWhen(view)}`}{' '}
                  {(() => {
                    // The floor as a price. A sale's floor is quote per stock,
                    // the inverse of the mark's rate, so the price is today's
                    // price scaled by the floor times today's rate, rounded
                    // down to the cent as the box before signing rounds it.
                    // Only meaningful while the multiplier it was built on holds.
                    if (!view?.markRateQ64 || !view.markPx || o.floorRateQ64 <= 0n || dead) return null
                    const min = sellFloorUsd(o.floorRateQ64, view.markRateQ64, view.markPx)
                    return <> · never below ${min.toFixed(2)}/share</>
                  })()}
                  {' '}· slip ≤ {o.maxSlipBps}bps · until {nyWhenOf(Number(o.expiresAt))}
                </span>
                <button className="mini" disabled={busy} onClick={() => void cancelSell(o)}>
                  cancel sell
                </button>
              </div>
            )
          })}
          <div className="note">
            Your shares stay in your wallet until a fill: each sale is funded by an approval on that
            stock&apos;s account, not a transfer, and the filler pays you before it takes them.
            Cancelling sends <code>revoke</code> on that account on its own first — that alone makes
            every sale of that stock unfillable, and it works even if this program never runs again —
            then closes the sale for its rent, then re-approves any other sales of the same stock.
          </div>
        </div>
      )}

      <footer className="foot">
        <span>
          source{' '}
          <a href="https://github.com/OoJae/bell" target="_blank" rel="noreferrer">
            github.com/OoJae/bell ↗
          </a>
        </span>
        <span>
          program{' '}
          <a href={explorerAddress(PROGRAM)} target="_blank" rel="noreferrer">
            {shortKey(PROGRAM)} on Solana Explorer ↗
          </a>
        </span>
        <span>
          mainnet{' '}
          <a href="/overpay">did you overpay at night?</a>
        </span>
        <span>
          fills{' '}
          <a href="https://t.me/bellfills" target="_blank" rel="noreferrer">
            t.me/bellfills ↗
          </a>
        </span>
        {/* Opens the bot with "/start <wallet>" ready to send. The keeper then
            messages that chat when this wallet's orders fill. Fills are public
            on chain, so the link proves nothing and needs nothing signed. */}
        {publicKey && (
          <span>
            telegram{' '}
            <a
              href={`https://t.me/Bell_solbot?start=${publicKey.toBase58()}`}
              target="_blank"
              rel="noreferrer"
              title="Anyone can follow any wallet: fills are public on chain."
            >
              alerts for this wallet ↗
            </a>
          </span>
        )}
      </footer>
    </div>
  )
}
