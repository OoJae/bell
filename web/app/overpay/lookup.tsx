'use client'

import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { useWallet } from '@solana/wallet-adapter-react'
// Types only: the module itself is server-side and never reaches the browser.
import type { Buy, Report } from '../../../src/overpay.ts'
import styles from './overpay.module.css'

type State =
  | { phase: 'idle' }
  | { phase: 'reading'; wallet: string }
  | { phase: 'done'; report: Report }
  | { phase: 'failed'; message: string }

const usd = (n: number) => `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
// Rounded before signed, so +0.4 reads "0 bps" rather than "+0 bps".
const bps = (x: number) => {
  const n = Math.round(x)
  return `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(n)} bps`
}
const shortSig = (s: string) => `${s.slice(0, 6)}…`

/** The lookup form and its results. The address in the box is also kept in the URL, so a result can be linked to. */
export function Lookup() {
  const { publicKey } = useWallet()
  const [wallet, setWallet] = useState('')
  const [state, setState] = useState<State>({ phase: 'idle' })

  const run = useCallback(async (address: string) => {
    const w = address.trim()
    if (!w) return
    setState({ phase: 'reading', wallet: w })
    window.history.replaceState(null, '', `?wallet=${encodeURIComponent(w)}`)
    try {
      const res = await fetch(`/api/overpay?wallet=${encodeURIComponent(w)}`)
      const body = (await res.json().catch(() => null)) as (Report & { message?: string }) | null
      if (!res.ok || !body || !Array.isArray(body.buys)) {
        setState({ phase: 'failed', message: body?.message ?? `The lookup failed (HTTP ${res.status}).` })
        return
      }
      setState({ phase: 'done', report: body })
    } catch {
      setState({ phase: 'failed', message: 'The lookup could not reach this site’s server.' })
    }
  }, [])

  // A link with ?wallet= runs at once. Read from the location rather than
  // useSearchParams, so the page itself stays static.
  useEffect(() => {
    const w = new URLSearchParams(window.location.search).get('wallet')
    if (w) {
      setWallet(w)
      void run(w)
    }
  }, [run])

  const submit = (e: FormEvent) => {
    e.preventDefault()
    void run(wallet)
  }

  return (
    <>
      <form className={styles.form} onSubmit={submit}>
        <input
          className={styles.input}
          value={wallet}
          onChange={(e) => setWallet(e.target.value)}
          placeholder="any Solana wallet address"
          aria-label="Solana wallet address"
          spellCheck={false}
          autoComplete="off"
        />
        <button className="act" type="submit" disabled={state.phase === 'reading' || !wallet.trim()}>
          {state.phase === 'reading' ? 'reading…' : 'check'}
        </button>
      </form>
      {publicKey && wallet !== publicKey.toBase58() && (
        <button
          type="button"
          className={`mini ${styles.mine}`}
          onClick={() => {
            setWallet(publicKey.toBase58())
            void run(publicKey.toBase58())
          }}
        >
          use my connected wallet
        </button>
      )}

      {state.phase === 'reading' && (
        <div className="note">
          Reading this wallet’s latest transactions from mainnet, a few at a time so the public RPC does not refuse
          us. This can take up to a minute.
        </div>
      )}
      {state.phase === 'failed' && <div className="notice bad">{state.message}</div>}
      {state.phase === 'done' && <Results report={state.report} />}
    </>
  )
}

function Results({ report }: { report: Report }) {
  const { summary: s, scanned } = report
  const oldest = scanned.oldest ? new Date(scanned.oldest).toISOString().slice(0, 10) : null
  const where =
    scanned.stockAccounts === 0
      ? `its own latest ${scanned.signatures}, since it holds no account of a listed stock now`
      : `first the latest of the ${scanned.stockAccounts === 1 ? 'one stock account' : `${scanned.stockAccounts} stock accounts`} it still holds, then its own latest ${scanned.signatures}`
  return (
    <>
      <p className="verdict" style={{ marginTop: 18 }}>
        {s.buys === 0
          ? 'No buys of a listed stock paid in USDC in these transactions.'
          : s.compared === 0
            ? `${s.buys} ${s.buys === 1 ? 'buy' : 'buys'}, none outside the session with a recorded open to compare.`
            : `Outside the session, the median buy paid ${bps(s.medianGapBps!)} against the next open.`}
      </p>
      <div className={styles.stats}>
        <span>
          <strong>{s.buys}</strong> {s.buys === 1 ? 'buy' : 'buys'}: {s.regular} in the regular session, {s.outside}{' '}
          outside{s.unknown > 0 ? `, ${s.unknown} before the calendar starts` : ''}
        </span>
        {s.compared > 0 && (
          <span>
            <strong>{s.paidMore}</strong> of {s.compared} compared paid more than the open
          </span>
        )}
        {s.worst && (
          <span>
            most over:{' '}
            <a href={s.worst.explorer} target="_blank" rel="noreferrer">
              {bps(s.worst.gapBps)} on {s.worst.symbol} ↗
            </a>
          </span>
        )}
        {s.notYetRecorded > 0 && <span>{s.notYetRecorded} waiting for an open not yet recorded</span>}
        {s.inexact > 0 && <span>{s.inexact} marked ≈ and left out: older than the token’s last multiplier step</span>}
      </div>

      {report.buys.length > 0 && (
        <div className={styles.scroll}>
          <table>
            <thead>
              <tr>
                <th>time (New York)</th>
                <th>stock</th>
                <th className={styles.num}>shares</th>
                <th className={styles.num}>USDC paid</th>
                <th className={styles.num}>per share</th>
                <th>next open</th>
                <th className={styles.num}>gap</th>
              </tr>
            </thead>
            <tbody>
              {report.buys.map((b) => (
                <Row key={`${b.signature}:${b.mint}`} b={b} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="note">
        Read {scanned.read} of this wallet’s transactions (at most {scanned.cap}){oldest ? `, back to ${oldest}` : ''}:{' '}
        {where}
        {scanned.failed > 0 ? `; ${scanned.failed} had failed and moved nothing` : ''}
        {scanned.unreadable > 0 ? `; ${scanned.unreadable} could not be read` : ''}
        {scanned.mixed > 0 ? `; ${scanned.mixed} moved another token too and are not priced` : ''}.
        {scanned.stopped ? ` Stopped early: ${scanned.stopped}.` : ''} The same answer as JSON:{' '}
        <a href={`/api/overpay?wallet=${report.wallet}`}>/api/overpay?wallet=…</a>
      </div>
    </>
  )
}

function Row({ b }: { b: Buy }) {
  // Priced with a multiplier that may be a step late; see `multiplierExact`.
  const approx = b.pricePerShare !== null && !b.multiplierExact ? '≈ ' : ''
  const open =
    b.session === 'regular'
      ? 'in session'
      : b.session === 'unknown'
        ? 'outside the calendar'
        : b.nextOpen === null
          ? '—'
          : b.nextOpen.price !== null
            ? `${usd(b.nextOpen.price)} · ${b.nextOpen.atEt.replace(/ \d{4} 09:30 ET$/, '')}`
            : `${b.nextOpen.status} · ${b.nextOpen.atEt.replace(/ \d{4} 09:30 ET$/, '')}`
  return (
    <tr>
      <td className={styles.when}>
        <a href={b.explorer} target="_blank" rel="noreferrer" title={`transaction ${shortSig(b.signature)} on Solana Explorer`}>
          {b.timeEt}
        </a>
        {b.window ? <div className="sub">{b.window}</div> : null}
      </td>
      <td>{b.symbol}</td>
      <td className={styles.num}>
        {b.shares === null ? '—' : b.shares.toLocaleString(undefined, { maximumFractionDigits: 6 })}
      </td>
      <td className={styles.num}>{usd(b.usdcPaid)}</td>
      <td className={styles.num}>{b.pricePerShare === null ? '—' : approx + usd(b.pricePerShare)}</td>
      <td>{open}</td>
      <td className={`${styles.num} ${b.gapBps === null ? '' : b.gapBps > 0 ? styles.more : styles.less}`}>
        {b.gapBps === null ? '—' : approx + bps(b.gapBps)}
      </td>
    </tr>
  )
}
