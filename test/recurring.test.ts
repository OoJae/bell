import assert from 'node:assert/strict'
import test from 'node:test'
import { Keypair, PublicKey } from '@solana/web3.js'
import { isRegularOpen, nextChange } from '../src/policy/calendar.ts'
import { upcomingOpens } from '../src/policy/order.ts'
import { LIMITS } from '../src/chain/codec.ts'
import { ALLOWLIST } from '../src/config.ts'
import { packTransactions, placeInstructions, recurringSlots } from '../web/lib/queue.ts'

const isOpenAt = (at: number) => isRegularOpen(new Date(at * 1000))
const nextChangeAfter = (at: number) => nextChange(new Date(at * 1000))
const HORIZON = LIMITS.MAX_ORDER_LIFETIME_SECONDS ?? 7 * 86_400
// New York wall time; daylight saving ends on 1 November 2026, so November is UTC-5.
const et = (iso: string) => Date.parse(`${iso}${iso < '2026-11-01T02' ? '-04:00' : '-05:00'}`) / 1000

test('a recurring buy placed on a Thursday night lands on the next five opens', () => {
  const opens = upcomingOpens(et('2026-09-24T23:00:00'), 5, isOpenAt, nextChangeAfter, HORIZON)
  assert.deepEqual(opens, [
    et('2026-09-25T09:30:00'),
    et('2026-09-28T09:30:00'),
    et('2026-09-29T09:30:00'),
    et('2026-09-30T09:30:00'),
    et('2026-10-01T09:30:00'),
  ])
})

test('it skips a holiday and stops at the program lifetime rather than overrunning it', () => {
  // Thanksgiving week 2026: Thu 26 Nov closed, Fri 27 Nov early close (opens at 09:30).
  const opens = upcomingOpens(et('2026-11-23T20:00:00'), 10, isOpenAt, nextChangeAfter, HORIZON)
  assert.ok(!opens.includes(et('2026-11-26T09:30:00')), 'Thanksgiving is not an open')
  assert.ok(opens.includes(et('2026-11-27T09:30:00')), 'the early-close day still opens')
  for (const o of opens) assert.ok(o <= et('2026-11-23T20:00:00') + HORIZON - 3_600)
  assert.ok(opens.length < 10)
})

test('each slot is held to its own open and lapses the same day', () => {
  const now = et('2026-09-24T23:00:00')
  const opens = upcomingOpens(now, 3, isOpenAt, nextChangeAfter, HORIZON)
  const slots = recurringSlots(now, 100n, opens)
  assert.deepEqual(
    slots.map((s) => s.nonce),
    [100n, 101n, 102n],
  )
  slots.forEach((s, i) => {
    assert.equal(s.notBefore, opens[i])
    assert.equal(s.expiresAt, opens[i]! + 6 * 3_600)
    // Lapses before the next slot may begin: a missed day is skipped, never doubled.
    if (i + 1 < slots.length) assert.ok(s.expiresAt < slots[i + 1]!.notBefore)
  })
})

test('five orders and their approval pack into transactions that each fit, in order', () => {
  const owner = Keypair.generate().publicKey
  const listing = ALLOWLIST.find((l) => l.symbol === 'SPYx')!
  const now = et('2026-09-24T23:00:00')
  const opens = upcomingOpens(now, 5, isOpenAt, nextChangeAfter, HORIZON)
  const { ixs, approved, amountIn } = placeInstructions(
    { owner, listing, usd: 20, nonce: 1n, now, committed: 5_000_000n, markRateQ64: 1n << 70n, markPx: { num: 767_000_000n, expo: -6 } },
    recurringSlots(now, 1n, opens),
  )
  assert.equal(approved, 5_000_000n + amountIn * 5n, 'one approval covers the book and every new order')
  const txs = packTransactions(ixs, owner)
  const flat = txs.flatMap((t) => t.instructions)
  assert.equal(flat.length, ixs.length)
  flat.forEach((ix, i) => assert.ok(ix.programId.equals(ixs[i]!.programId) && ix.data.equals(ixs[i]!.data), `ix ${i} moved`))
  for (const t of txs) {
    t.feePayer = owner
    t.recentBlockhash = PublicKey.default.toBase58()
    assert.ok(t.serializeMessage().length + 65 <= 1_232, `a transaction is ${t.serializeMessage().length + 65} bytes`)
  }
  // The approval is in the first transaction, ahead of every order.
  assert.equal(txs[0]!.instructions.length >= 3, true)
})
