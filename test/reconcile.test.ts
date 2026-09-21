import { test } from 'node:test'
import assert from 'node:assert/strict'
import { reconcile, HaltState, type PythView, type IssuerView } from '../src/policy/reconcile.ts'

const openSession: PythView = { isOpen: true, nextOpen: 2_000, nextClose: 1_000 }
const shutSession: PythView = { isOpen: false, nextOpen: 1_000, nextClose: 2_000 }
const trading: IssuerView = { openNow: true, issuerHalted: false, nextChangeAt: null }

test('agreement that the market is open is confirmed and tradeable', () => {
  const v = reconcile({ pyth: openSession, issuer: trading })
  assert.equal(v.openNow, true)
  assert.equal(v.halt, HaltState.None)
  assert.equal(v.confidence, 'confirmed')
})

test('agreement that the market is shut is closed, but not a halt', () => {
  const v = reconcile({ pyth: shutSession, issuer: { ...trading, openNow: false } })
  assert.equal(v.openNow, false)
  assert.equal(v.halt, HaltState.None, 'closed is not halted')
  assert.equal(v.confidence, 'confirmed')
})

test('a session that is open while the issuer refuses is read as a halt', () => {
  // The safety net for a halt that arrives without anyone flagging it.
  const v = reconcile({ pyth: openSession, issuer: { ...trading, openNow: false } })
  assert.equal(v.halt, HaltState.Unspecified)
  assert.equal(v.openNow, false)
  assert.equal(v.confidence, 'conflict')
})

test('an exchange halt outranks everything and keeps its reason code', () => {
  // II.H is about the exchange halting the security. A LULD pause must survive
  // as a LULD pause, because it carries a resumption time that a suspension
  // does not.
  const v = reconcile({
    pyth: openSession,
    issuer: trading,
    exchangeHalt: { kind: HaltState.Luld, resumesAt: 9_999 },
  })
  assert.equal(v.halt, HaltState.Luld)
  assert.equal(v.openNow, false)
  assert.equal(v.nextChangeAt, 9_999)
})

test('an issuer withdrawing its token is not reported as an exchange halt', () => {
  // Measured 2026-09-21: Backed flagged IWMx and JPSTx while IWM and JPST were
  // absent from Nasdaq's feed, which does carry Arca halts. The ETF was not
  // halted — Backed had pulled its own wrapper. Both stop the trade; only one
  // is the II.H condition, and saying the wrong one would be a false claim.
  const v = reconcile({ pyth: openSession, issuer: { ...trading, issuerHalted: true } })
  assert.equal(v.openNow, false)
  assert.equal(v.halt, HaltState.Unspecified)
  assert.match(v.detail, /issuer has withdrawn/)
  // Must not claim the primary exchange halted it — that is the false claim.
  assert.doesNotMatch(v.detail, /halted on the primary listing exchange/)
})

test('an issuer withdrawal is never downgraded by an agreeing session', () => {
  const v = reconcile({
    pyth: shutSession,
    issuer: { openNow: false, issuerHalted: true, nextChangeAt: null },
  })
  assert.equal(v.halt, HaltState.Unspecified)
})

test('a 24/5 wrapper trading into a shut market is closed, not halted', () => {
  // The issuer is willing and the token keeps trading on-chain; the underlying
  // market is not open. That is the ordinary overnight case, not a halt.
  const v = reconcile({ pyth: shutSession, issuer: trading })
  assert.equal(v.openNow, false)
  assert.equal(v.halt, HaltState.None)
  assert.equal(v.confidence, 'conflict')
  assert.equal(v.nextChangeAt, 1_000, 'should point at the next open')
})

test('a non-US listing is single-sourced and says so', () => {
  const v = reconcile({ pyth: null, issuer: trading, nonUsListing: true })
  assert.equal(v.confidence, 'degraded')
  assert.equal(v.openNow, true)
})

test('a missing Pyth feed for a US name is unavailable, not degraded', () => {
  // Expected absence and unexpected absence are different problems.
  const v = reconcile({ pyth: null, issuer: trading })
  assert.equal(v.confidence, 'unavailable')
})

test('no issuer reading closes the symbol', () => {
  const v = reconcile({ pyth: openSession, issuer: null })
  assert.equal(v.openNow, false)
  assert.equal(v.halt, HaltState.Unspecified)
  assert.equal(v.confidence, 'unavailable')
})

test('every path that is not plainly open resolves to not-tradeable', () => {
  // Fail closed is the default, not the fallback. Enumerate the space.
  const pyths: Array<PythView | null> = [openSession, shutSession, null]
  const issuers: Array<IssuerView | null> = [
    trading,
    { ...trading, openNow: false },
    { ...trading, issuerHalted: true },
    null,
  ]
  for (const pyth of pyths) {
    for (const issuer of issuers) {
      const v = reconcile({ pyth, issuer, nonUsListing: pyth === null })
      const plainlyOpen =
        issuer !== null && !issuer.issuerHalted && issuer.openNow && (pyth === null || pyth.isOpen)
      assert.equal(v.openNow, plainlyOpen, `pyth=${JSON.stringify(pyth)} issuer=${JSON.stringify(issuer)}`)
      if (v.openNow) assert.equal(v.halt, HaltState.None, 'tradeable implies not halted')
    }
  }
})
