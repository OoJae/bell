'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useWallet } from '@solana/wallet-adapter-react'
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui'
import {
  connection,
  explain,
  loadBoard,
  loadOrders,
  RPC_URL,
  type SymbolView,
  type WalletView,
} from '../lib/bell.ts'
import {
  cancelOrderTx,
  committedOf,
  MAX_ORDER_USD,
  placeOrderTx,
  QUOTE_DECIMALS,
  QUOTE_MINT,
  refusalFrom,
  submit,
} from '../lib/queue.ts'
import { authPda } from '../../src/chain/client.ts'
import type { BellOrder } from '../../src/chain/codec.ts'
import { CLUSTER } from '../../src/config.ts'

const POLL_MS = 10_000

/**
 * Roughly what a first order in a new symbol costs a fresh wallet in SOL:
 * the stock account's rent, the order account's rent and a fee (measured on
 * devnet: 1.56M + 2.00M + 5k lamports). Below this, say so before the wallet
 * opens rather than after the token program refuses.
 */
const MIN_SOL_FOR_ORDER = 0.0036

function Badge({ view }: { view: SymbolView }) {
  if (view.allowed === null) return <span className="badge">…</span>
  if (view.allowed) return <span className="badge ok">tradeable</span>
  const halted =
    view.reason === 'MarketClosed' && view.gates.find((g) => g.label === 'not halted')?.ok === false
  return <span className={`badge ${halted ? 'stop' : 'no'}`}>{halted ? 'halted' : 'closed'}</span>
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
  const { publicKey, signTransaction } = useWallet()
  const [views, setViews] = useState<SymbolView[]>([])
  const [wallet, setWallet] = useState<WalletView | null>(null)
  // `null` means "not read yet, or the last read failed" — never "none".
  const [orders, setOrders] = useState<BellOrder[] | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null)
  const [amount, setAmount] = useState('200')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null)
  // The wallet button renders from browser-only state, so it must not be part
  // of the server-rendered markup.
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])

  const refresh = useCallback(async () => {
    try {
      const board = await loadBoard(conn, QUOTE_MINT, selected ?? undefined, publicKey)
      setViews(board.views)
      setWallet(board.wallet)
      setUpdatedAt(new Date())
      setError(null)
    } catch (e) {
      // Losing the RPC is not permission to trade; say so rather than showing
      // a stale board that still reads "tradeable".
      setError((e as Error).message)
    }
    if (publicKey) {
      try {
        setOrders(await loadOrders(conn, publicKey))
      } catch {
        // Keep showing the last list we actually read. What must never happen
        // is a failed read becoming "you have no orders" — `place()` below
        // re-reads for itself rather than trusting this copy.
      }
    } else {
      setOrders(null)
    }
    // `selected` decides which symbol gets the authoritative on-chain check.
  }, [conn, publicKey, selected])

  useEffect(() => {
    void refresh()
    const id = setInterval(() => void refresh(), POLL_MS)
    return () => clearInterval(id)
  }, [refresh])

  const current = views.find((v) => v.listing.symbol === selected) ?? views[0]
  const tradeable = views.filter((v) => v.allowed).length
  const auth = useMemo(() => (publicKey ? authPda(publicKey) : null), [publicKey])

  /** An order the wallet's single delegation no longer covers cannot fill. */
  const funded = useCallback(
    (list: BellOrder[]) => {
      if (!wallet || !auth) return true
      const delegatedToUs = wallet.delegate?.equals(auth) ?? false
      return delegatedToUs && wallet.delegatedAmount >= committedOf(list)
    },
    [auth, wallet],
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

      // Re-read this wallet's orders now, with no fallback. The approval has
      // to cover the whole book, because SPL `Approve` replaces the delegated
      // amount rather than adding to it: approving just this order would
      // silently defund every earlier one. If we cannot see the book, we do
      // not guess at it.
      let book: BellOrder[]
      try {
        book = await loadOrders(conn, publicKey)
      } catch {
        throw new Error(
          'Could not read your existing orders just now, so nothing was sent — approving without them would defund them. Try again in a moment.',
        )
      }
      const committed = committedOf(book)
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
        now: Math.floor(Date.now() / 1000),
        committed,
        nextOpen: current.openNow ? null : current.nextChangeAt || null,
      })
      const sig = await submit(conn, tx, publicKey, signTransaction)
      setNotice({
        ok: true,
        text: current.allowed
          ? `Placed $${usdAmount} of ${current.listing.symbol}. The filler settles it on its next pass, within about five minutes. Your funds stay in your wallet until then — ${sig.slice(0, 16)}…`
          : `Queued $${usdAmount} of ${current.listing.symbol} for the opening bell. Your funds never left your wallet — ${sig.slice(0, 16)}…`,
      })
      await refresh()
    } catch (e) {
      setNotice({ ok: false, text: describe(e) })
    } finally {
      setBusy(false)
    }
  }, [amount, conn, current, publicKey, refresh, signTransaction, wallet])

  const cancel = useCallback(
    async (order: BellOrder) => {
      if (!publicKey || !signTransaction) return
      setBusy(true)
      setNotice(null)
      try {
        const sig = await submit(conn, cancelOrderTx(publicKey, order), publicKey, signTransaction)
        setNotice({ ok: true, text: `Revoked and cancelled — ${sig.slice(0, 16)}…` })
        await refresh()
      } catch (e) {
        setNotice({ ok: false, text: describe(e) })
      } finally {
        setBusy(false)
      }
    },
    [conn, publicKey, refresh, signTransaction],
  )

  const bookFunded = orders ? funded(orders) : true

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
                <span className="fail">✕</span> {explain(current.reason)}
              </>
            )}
          </p>

          {current.gates.map((g) => (
            <div className="gate" key={g.label}>
              <span className={`mark ${g.ok ? 'pass' : 'fail'}`}>{g.ok ? '✓' : '✕'}</span>
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
              disabled={!publicKey || busy || !(Number(amount) > 0)}
              onClick={() => void place()}
            >
              {busy
                ? 'working…'
                : !publicKey
                  ? 'Connect a wallet'
                  : current.allowed
                    ? `Place order · the filler settles it within ~5 min`
                    : `Queue it for the opening bell${
                        !current.openNow && current.nextChangeAt > 0
                          ? ` · ${new Date(current.nextChangeAt * 1000).toLocaleString()}`
                          : ''
                      }`}
            </button>
          </div>

          {notice && <div className={`notice ${notice.ok ? 'ok' : 'bad'}`}>{notice.text}</div>}

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
            const expired = Number(o.expiresAt) <= Date.now() / 1000
            return (
              <div className="order" key={String(o.nonce)}>
                <span className="label">{o.symbol}</span>
                <span className="detail">
                  ${usd(o.amountIn)}
                  {o.filledIn > 0n ? ` · $${usd(o.filledIn)} filled` : ''}
                  {expired
                    ? ' · expired — cancel to reclaim the rent'
                    : !bookFunded
                      ? ' · not funded — the delegation no longer covers it, so it cannot fill'
                      : ' · waiting for the bell'}{' '}
                  · slip ≤ {o.maxSlipBps}bps · until {new Date(Number(o.expiresAt) * 1000).toLocaleString()}
                </span>
                <button className="mini" disabled={busy} onClick={() => void cancel(o)}>
                  cancel
                </button>
              </div>
            )
          })}
          <div className="note">
            ${usd(committedOf(orders))} of your demo-USDC is delegated against these orders and stays
            in your wallet until a fill. Cancelling sends <code>revoke</code> first and reclaims the
            rent second — the revoke alone makes the order unfillable, so it works even if this
            program never runs again, and it cancels <em>all</em> of them, because one token account
            has one delegate.
          </div>
        </div>
      )}
    </div>
  )
}
