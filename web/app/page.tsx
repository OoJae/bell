'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useWallet } from '@solana/wallet-adapter-react'
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui'
import {
  connection,
  explain,
  loadAll,
  loadOrders,
  RPC_URL,
  type SymbolView,
} from '../lib/bell.ts'
import { cancelOrderTx, committedOf, placeOrderTx, submit, QUOTE_DECIMALS } from '../lib/queue.ts'
import type { BellOrder } from '../../src/chain/codec.ts'

const POLL_MS = 10_000

function Badge({ view }: { view: SymbolView }) {
  if (view.allowed === null) return <span className="badge">…</span>
  if (view.allowed) return <span className="badge ok">tradeable</span>
  const halted = view.reason === 'MarketClosed' && !view.gates[1]?.ok
  return <span className={`badge ${halted ? 'stop' : 'no'}`}>{halted ? 'halted' : 'closed'}</span>
}

const usd = (raw: bigint) => (Number(raw) / 10 ** QUOTE_DECIMALS).toFixed(2)

export default function Page() {
  const conn = useMemo(() => connection(), [])
  const { publicKey, signTransaction } = useWallet()
  const [views, setViews] = useState<SymbolView[]>([])
  const [orders, setOrders] = useState<BellOrder[]>([])
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
      const [v, o] = await Promise.all([
        loadAll(conn, publicKey ?? null, selected ?? undefined),
        loadOrders(conn, publicKey ?? undefined).catch(() => [] as BellOrder[]),
      ])
      setViews(v)
      setOrders(o)
      setUpdatedAt(new Date())
      setError(null)
    } catch (e) {
      // Losing the RPC is not permission to trade; say so rather than showing
      // a stale board that still reads "tradeable".
      setError((e as Error).message)
    }
    // `selected` is a dependency because it decides which symbol gets the
    // authoritative on-chain check rather than the derived one.
  }, [conn, publicKey, selected])

  useEffect(() => {
    void refresh()
    const id = setInterval(() => void refresh(), POLL_MS)
    return () => clearInterval(id)
  }, [refresh])

  const current = views.find((v) => v.listing.symbol === selected) ?? views[0]
  const tradeable = views.filter((v) => v.allowed).length

  const place = useCallback(async () => {
    if (!publicKey || !signTransaction || !current) return
    setBusy(true)
    setNotice(null)
    try {
      const { tx } = placeOrderTx({
        owner: publicKey,
        listing: current.listing,
        usd: Number(amount),
        nonce: BigInt(Date.now()),
        now: Math.floor(Date.now() / 1000),
        // Re-approve the whole book. One delegate slot, one amount, and SPL
        // `Approve` assigns rather than adds — so approving just this order
        // would quietly strand every earlier one.
        committed: committedOf(orders),
      })
      const sig = await submit(conn, tx, publicKey, signTransaction)
      setNotice({
        ok: true,
        text: `Queued $${amount} of ${current.listing.symbol}. Your funds never left your wallet — ${sig.slice(0, 16)}…`,
      })
      await refresh()
    } catch (e) {
      setNotice({ ok: false, text: (e as Error).message })
    } finally {
      setBusy(false)
    }
    // `orders` is load-bearing here, not incidental: it is what `committed` is
    // computed from, and a stale copy would under-approve and strand the very
    // orders this is meant to protect.
  }, [amount, conn, current, orders, publicKey, refresh, signTransaction])

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
        setNotice({ ok: false, text: (e as Error).message })
      } finally {
        setBusy(false)
      }
    },
    [conn, publicKey, refresh, signTransaction],
  )

  return (
    <div className="wrap">
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
                ? 'signing…'
                : !publicKey
                  ? 'Connect a wallet'
                  : current.allowed
                    ? `Buy ${current.listing.symbol} at market`
                    : `Queue it for the opening bell${
                        current.nextChangeAt > 0
                          ? ` · ${new Date(current.nextChangeAt * 1000).toLocaleString()}`
                          : ''
                      }`}
            </button>
          </div>

          {notice && (
            <div className={`notice ${notice.ok ? 'ok' : 'bad'}`}>{notice.text}</div>
          )}

          <div className="note">
            A refusal is never the end of it: the order parks and fills at the open, and cancelling is
            an SPL <code>revoke</code> from your own wallet that this program plays no part in.
          </div>
        </div>
      )}

      {publicKey && orders.length > 0 && (
        <div className="panel">
          <p className="verdict">Your bell orders</p>
          {orders.map((o) => (
            <div className="order" key={String(o.nonce)}>
              <span className="label">{o.symbol}</span>
              <span className="detail">
                ${usd(o.amountIn)} queued
                {o.filledIn > 0n ? ` · $${usd(o.filledIn)} filled` : ' · waiting for the bell'} ·
                slip ≤ {o.maxSlipBps}bps
              </span>
              <button className="mini" disabled={busy} onClick={() => void cancel(o)}>
                cancel
              </button>
            </div>
          ))}
          <div className="note">
            ${usd(committedOf(orders))} of your USDC is delegated against these orders and stays in
            your wallet until a fill. Cancelling sends <code>revoke</code> first and reclaims the
            rent second — the revoke alone makes the order unfillable, so it works even if this
            program never runs again, and it cancels <em>all</em> of them, because one token account
            has one delegate.
          </div>
        </div>
      )}
    </div>
  )
}
