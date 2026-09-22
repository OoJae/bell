'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useWallet } from '@solana/wallet-adapter-react'
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui'
import {
  clearsWhen,
  connection,
  explain,
  explainView,
  explorerTx,
  loadBoard,
  loadOrders,
  offline,
  RPC_URL,
  type Status,
  type SymbolView,
  type WalletView,
} from '../lib/bell.ts'
import {
  cancelOrderTxs,
  MAX_ORDER_USD,
  orderExpiry,
  placeOrderTx,
  QUOTE_DECIMALS,
  QUOTE_MINT,
  refusalFrom,
  revokeAllTxs,
  submit,
  submitInOrder,
} from '../lib/queue.ts'
import { authPda } from '../../src/chain/client.ts'
import type { BellOrder } from '../../src/chain/codec.ts'
import { ataFor } from '../../src/chain/spl.ts'
import { ALLOWLIST, CLUSTER } from '../../src/config.ts'
import { deadReason, stillOwed } from '../../src/policy/order.ts'

const POLL_MS = 10_000

/**
 * Roughly what a first order in a new symbol costs a fresh wallet in SOL:
 * the stock account's rent, the order account's rent and a fee (measured on
 * devnet: 1.56M + 2.00M + 5k lamports). Below this, say so before the wallet
 * opens rather than after the token program refuses.
 */
const MIN_SOL_FOR_ORDER = 0.0036

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
  refused: ['refused', 'no'],
}

function Badge({ view }: { view: SymbolView }) {
  const [text, tone] = BADGE[view.status]
  return <span className={`badge ${tone}`}>{text}</span>
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
  const [selected, setSelected] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null)
  const [amount, setAmount] = useState('200')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<Notice | null>(null)
  // The wallet button renders from browser-only state, so it must not be part
  // of the server-rendered markup.
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])

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
        try {
          const book = await loadOrders(conn, publicKey)
          setOrders(book.filter((o) => !closed.current.has(String(o.nonce))))
        } catch {
          // Keep showing the last list we actually read. What must never happen
          // is a failed read becoming "you have no orders" — `place()` below
          // re-reads for itself rather than trusting this copy.
        }
      } else {
        setOrders(null)
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
      if (usdAmount > MAX_ORDER_USD) {
        throw new Error(`Orders are capped at $${MAX_ORDER_USD.toLocaleString()} while the program has an upgrade authority.`)
      }
      if (!wallet || wallet.quote === null) {
        throw new Error('This wallet has no demo-USDC yet — use "Get demo funds" first.')
      }
      if (wallet.sol < MIN_SOL_FOR_ORDER) {
        throw new Error('This wallet needs a little devnet SOL for account rent — use "Get demo funds".')
      }
      if (current.status === 'withdrawn') {
        throw new Error('The issuer has withdrawn this token, so an order would wait on the issuer, not on a bell.')
      }
      const now = nowS()
      const nextOpen = current.openNow ? null : current.nextChangeAt || null
      // An order snapshots the multiplier it was built against, and the gate
      // refuses it for good once that moves. Parking one across a scheduled
      // change is parking an order that can never fill.
      if (!current.allowed && current.changeAt > 0 && current.changeAt < orderExpiry(now, nextOpen)) {
        throw new Error(
          `A corporate action is scheduled for ${new Date(current.changeAt * 1000).toLocaleString()}, before this order could fill — it would be refused as resized. Place it after the change lands.`,
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
      const wanted = committed + BigInt(Math.round(usdAmount * 10 ** QUOTE_DECIMALS))
      if (wallet.quote < wanted) {
        throw new Error(
          `That needs $${usd(wanted)} of demo-USDC across your orders; the wallet holds $${usd(wallet.quote)}.`,
        )
      }

      const { tx } = placeOrderTx({
        owner: publicKey,
        listing: current.listing,
        usd: usdAmount,
        nonce: BigInt(Date.now()),
        now,
        committed,
        nextOpen,
        markRateQ64: current.markRateQ64,
      })
      const sig = await submit(conn, tx, publicKey, signTransaction)
      setNotice({
        ok: true,
        sig,
        text: current.allowed
          ? `Placed $${usdAmount} of ${current.listing.symbol}. The filler settles it on its next pass, within about five minutes. Your funds stay in your wallet until then.`
          : current.status === 'closed'
            ? `Queued $${usdAmount} of ${current.listing.symbol} for the opening bell. Your funds never left your wallet.`
            : `Parked $${usdAmount} of ${current.listing.symbol}; it fills when ${clearsWhen(current)}. Your funds never left your wallet.`,
      })
      await refresh()
    } catch (e) {
      setNotice({ ok: false, text: describe(e) })
    } finally {
      setBusy(false)
    }
  }, [amount, conn, current, known, multiplierOf, publicKey, refresh, signTransaction, wallet])

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
   * The emergency exit: revoke every approval to BELL, then close every order.
   * Offered whenever any approval is outstanding, including one no order
   * explains — an approval whose order never landed is still an approval.
   */
  const revokeAll = useCallback(async () => {
    if (!publicKey || !signTransaction) return
    setBusy(true)
    setNotice(null)
    try {
      const book = await loadOrders(conn, publicKey).catch(() => orders ?? [])
      const txs = revokeAllTxs(publicKey, ataFor(publicKey, QUOTE_MINT), book)
      const { sigs, error, failedAt } = await submitInOrder(
        conn,
        txs,
        publicKey,
        signTransaction,
        signAllTransactions,
        (_, e) => refusalFrom(e) === 'AlreadyClosed',
      )
      if (failedAt === null) {
        for (const o of book) closed.current.add(String(o.nonce))
        setOrders([])
      }
      setNotice(
        failedAt === null
          ? {
              ok: true,
              sig: sigs[0] ?? undefined,
              text: `Funding revoked — BELL can no longer spend any of your demo-USDC.${book.length ? ` ${book.length} order(s) closed and their rent returned.` : ''}`,
            }
          : failedAt > 0
            ? {
                ok: true,
                sig: sigs[0] ?? undefined,
                text: `Funding revoked — nothing can fill. Closing the orders failed (${describe(error)}); cancel them to reclaim the rent.`,
              }
            : { ok: false, text: describe(error) },
      )
      await refresh()
    } catch (e) {
      setNotice({ ok: false, text: describe(e) })
    } finally {
      setBusy(false)
    }
  }, [conn, orders, publicKey, refresh, signAllTransactions, signTransaction])

  const bookFunded = orders ? funded(orders) : true
  const canPlace = !!current && !['withdrawn', 'offline', 'unlisted'].includes(current.status)

  return (
    <div className="wrap">
      {CLUSTER === 'devnet' && (
        <div className="banner">
          <strong>Devnet — test money only.</strong> Switch your wallet to devnet (Phantom: Settings
          → Developer Settings → Testnet Mode → Solana Devnet). <em>Get demo funds</em> gives a
          fresh wallet 1,000 demo-USDC — a devnet token BELL issued, not USDC — and a little devnet
          SOL for rent and fees. Your wallet will warn that an order lets another account spend your
          demo-USDC: that is the delegation, and cancelling revokes it. If your wallet shows zero
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
          </div>
          {mounted && <WalletMultiButton />}
        </div>
        <div className="sub" style={{ marginTop: 8 }}>
          {views.length > 0 && (
            <>
              {tradeable} of {views.length} tradeable ·{' '}
            </>
          )}
          {updatedAt ? `updated ${updatedAt.toLocaleTimeString()}` : 'loading…'} ·{' '}
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
        {publicKey && wallet && bellDelegated && wallet.delegatedAmount > 0n && (
          <div className="revoke">
            <span>
              BELL may spend up to <strong>${usd(wallet.delegatedAmount)}</strong> of your demo-USDC,
              for your orders only.
            </span>
            <button className="mini" disabled={busy} onClick={() => void revokeAll()}>
              Revoke all funding
            </button>
          </div>
        )}
        {publicKey && wallet && wallet.holdings.length > 0 && (
          <div className="bal holdings">
            <span>holding</span>
            {wallet.holdings.map((h) => (
              <span key={h.symbol}>
                <strong>{h.shares.toLocaleString(undefined, { maximumFractionDigits: 6 })}</strong>{' '}
                {h.symbol}
              </span>
            ))}
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
            </div>
            <div className="px">
              {v.priceUsd ? `$${v.priceUsd.toFixed(2)}` : 'no price'} · {v.listing.issuer}
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

          {current.gates.map((g) => (
            <div className="gate" key={g.label}>
              <span className={`mark ${g.ok === null ? 'wait' : g.ok ? 'pass' : 'fail'}`}>
                {g.ok === null ? '↻' : g.ok ? '✓' : '✕'}
              </span>
              <span className="label">{g.label}</span>
              <span className="detail">{g.detail}</span>
            </div>
          ))}

          <div className="note">{current.listing.note}</div>

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
                                ? ` · ${new Date(current.nextChangeAt * 1000).toLocaleString()}`
                                : ''
                            }`
                          : `Park it — fills when ${clearsWhen(current)}`}
            </button>
          </div>

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
                  {dead === 'expired'
                    ? ' · expired — cancel to reclaim the rent'
                    : dead === 'resized'
                      ? ' · refused: a corporate action changed its size — cancel to reclaim the rent'
                      : !bookFunded
                        ? ' · not funded — the delegation no longer covers it, so it cannot fill'
                        : view?.allowed
                          ? ' · the filler settles it on its next pass'
                          : !view || view.status === 'closed'
                            ? ' · waiting for the bell'
                            : ` · parked — fills when ${clearsWhen(view)}`}{' '}
                  · slip ≤ {o.maxSlipBps}bps · until {new Date(Number(o.expiresAt) * 1000).toLocaleString()}
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
    </div>
  )
}
