import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { markPda } from '../src/chain/client.ts'
import type { Listing } from '../src/listings.ts'
import {
  PROGRAM_ID,
  createTape,
  fillsOf,
  fromBase58,
  multiplierAt,
  scaledUiOf,
  tapeRows,
  toCsv,
  volume24h,
  type RowContext,
  type RpcTransaction,
} from '../web/lib/tape.ts'

// The hosted crank's fill of 23 September 2026, 09:35:24 ET, exactly as devnet's
// `getTransaction` (json encoding, finalized) returned it on 24 September.
const FILL = JSON.parse(
  readFileSync(new URL('./fixtures/fill-2026-09-23-5mj8qK.json', import.meta.url), 'utf8'),
) as RpcTransaction
const SIG = '5mj8qKbkZLz1M4e8i1cA8rJRuQGkwrzC1QEgfbTvMNcrXabGrT79U8SBVzLgtfEBTP9zURvZxVaaBeQE7EwMCFqt'

// The SPYx mirror mint's account bytes, read from devnet the same day.
const MINT = JSON.parse(readFileSync(new URL('./fixtures/spyx-mirror-mint.json', import.meta.url), 'utf8')) as {
  address: string
  data: string
}
const mintBytes = Uint8Array.from(Buffer.from(MINT.data, 'base64'))

const SPYX_MIRROR = 'AFrGCsmPc3WeUAEM3jw8Ec3M6BrKrJGDQeX2g1Ctrrwx'
const DEMO_USDC = '8QhSxevJerJq8khpNsfW69bUPvcBjMRTXPKrxYQAtAaX'
const FILLER = '4v5r4eSnB7kmnAmJ6ia9X1Mhu7tZKpznLb3x5PdMjtN2'
const ORDER = '4JyiXVzT7rc4Ny3NHqrbvwD9FkLwihfcC4JswaiGRG3A'

const spyx: Listing = {
  symbol: 'SPYx',
  mint: SPYX_MIRROR,
  mainnetMint: 'XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W',
  underlying: 'SPY',
  exchangeMic: 'ARCX',
  issuer: 'backed',
  note: 'test',
}

const ctx = (over: Partial<RowContext> = {}): RowContext => ({
  cluster: 'devnet',
  listing: (symbol, stockMint) => (symbol === 'SPYx' && stockMint === SPYX_MIRROR ? spyx : null),
  label: (mint) => (mint === DEMO_USDC ? 'demo-USDC' : mint),
  scaled: (mint) => (mint === SPYX_MIRROR ? scaledUiOf(mintBytes) : null),
  ...over,
})

const clone = (): RpcTransaction => structuredClone(FILL)

test('the 23 September fill decodes to 200 demo-USDC for 25,661,713 raw SPYx, tied to its order', () => {
  const fills = fillsOf(FILL)
  assert.equal(fills.length, 1)
  const [f] = fills
  assert.deepEqual(f.event, {
    symbol: 'SPYx',
    amountIn: 200_000_000n,
    amountOut: 25_661_713n,
    pxNum: 772_617_876n,
    pxExpo: -6,
    source: 'Jupiter',
    markObservedAt: 1790170506,
    realizedBps: 31,
  })
  assert.equal(f.order, ORDER)
  assert.equal(f.filler, FILLER)
  assert.equal(f.quoteMint, DEMO_USDC)
  assert.equal(f.stockMint, SPYX_MIRROR)

  // The event's own amounts agree with what the token balances say moved.
  const bal = (when: 'preTokenBalances' | 'postTokenBalances', i: number) =>
    BigInt((FILL.meta![when] as unknown as { accountIndex: number; uiTokenAmount: { amount: string } }[])
      .find((b) => b.accountIndex === i)!.uiTokenAmount.amount)
  assert.equal(bal('postTokenBalances', 7) - bal('preTokenBalances', 7), 25_661_713n)
  assert.equal(bal('preTokenBalances', 1) - bal('postTokenBalances', 1), 200_000_000n)
})

test('the fill becomes a §II.G row: symbol, pair, price, size, UTC time, direction, addresses', () => {
  const { rows, excluded } = tapeRows(FILL, ctx())
  assert.equal(excluded, 0)
  assert.equal(rows.length, 1)
  const r = rows[0]
  // 09:35:24 ET, five minutes after the bell, as the README says.
  assert.equal(r.time, '2026-09-23T13:35:24Z')
  assert.equal(r.symbol, 'SPYx')
  assert.equal(r.underlying, 'SPY')
  assert.equal(r.paired, 'demo-USDC')
  assert.equal(r.pairedMint, DEMO_USDC)
  assert.equal(r.direction, 'buy')
  assert.equal(r.contributed, 'demo-USDC')
  assert.equal(r.withdrawn, 'SPYx')
  assert.equal(r.notionalUsd, 200)
  assert.equal(r.stockRaw, '25661713')
  assert.equal(r.quoteRaw, '200000000')
  assert.equal(r.multiplier, 1.005714560286254)
  // 0.25661713 raw units at 8 decimals, times the multiplier, is the share count;
  // 200 dollars over it is the price per share.
  assert.equal(r.shares, 0.258083584)
  assert.equal(r.priceUsd, 774.942741)
  assert.equal(r.markPriceUsd, 772.617876)
  assert.equal(r.markSource, 'Jupiter')
  assert.equal(r.markObservedAt, '2026-09-23T13:35:06Z')
  assert.equal(r.realizedBps, 31)
  assert.equal(r.order, ORDER)
  assert.equal(r.program, PROGRAM_ID)
  assert.equal(r.program, '56AUPR1c1Tq5AgMvAa3PASax61YYo1KTdocwW6pR7Pdx')
  assert.equal(r.filler, FILLER)
  assert.equal(r.signature, SIG)
  assert.equal(r.explorer, `https://explorer.solana.com/tx/${SIG}?cluster=devnet`)
})

test('an event is only believed from BELL executing fill_order', () => {
  const payload = FILL.meta!.logMessages!.find((l) => l.startsWith('Program data: '))!

  // The same bytes logged inside BELL's refresh instruction are not a fill.
  const inRefresh = clone()
  const logs = inRefresh.meta!.logMessages!.filter((l) => l !== payload)
  logs.splice(2, 0, payload) // after "Instruction: RefreshTokenRisk", before its exit
  inRefresh.meta!.logMessages = logs
  assert.equal(fillsOf(inRefresh).length, 0)

  // Nor from another program in the same transaction.
  const forged = clone()
  const fake = 'Fake1111111111111111111111111111111111111111'
  forged.transaction.message.accountKeys.push(fake)
  forged.transaction.message.instructions.push({ programIdIndex: forged.transaction.message.accountKeys.length - 1, accounts: [], data: '' })
  forged.meta!.logMessages!.push(`Program ${fake} invoke [1]`, payload, `Program ${fake} success`)
  assert.equal(fillsOf(forged).length, 1, 'only the real one')
})

test('a failed transaction fills nothing, and unaligned or truncated logs are refused rather than guessed', () => {
  const failed = clone()
  failed.meta!.err = { InstructionError: [1, { Custom: 6000 }] }
  assert.deepEqual(fillsOf(failed), [])

  const unaligned = clone()
  unaligned.meta!.logMessages = unaligned.meta!.logMessages!.slice(4) // drop the refresh frame
  assert.throws(() => fillsOf(unaligned), /is not it|instruction/)

  const truncated = clone()
  truncated.meta!.logMessages!.push('Log truncated')
  assert.throws(() => fillsOf(truncated), /truncated/)
})

test('a fill of a symbol or mint BELL does not list stays off the tape and is counted', () => {
  const r = tapeRows(FILL, ctx({ listing: () => null }))
  assert.deepEqual(r, { rows: [], excluded: 1 })
})

test('with no multiplier the tape prints no price rather than a wrong one', () => {
  const [r] = tapeRows(FILL, ctx({ scaled: () => null })).rows
  assert.equal(r.priceUsd, null)
  assert.equal(r.shares, null)
  assert.equal(r.notionalUsd, 200)
})

test('the scaled-UI multiplier is read from real mint bytes, and switches at its effective time', () => {
  assert.deepEqual(scaledUiOf(mintBytes), {
    multiplier: 1.005714560286254,
    newMultiplier: 1.005714560286254,
    effectiveAt: 0,
  })
  // A plain SPL mint has no extension: raw units are shares.
  assert.deepEqual(scaledUiOf(new Uint8Array(82)), { multiplier: 1, newMultiplier: 1, effectiveAt: 0 })
  assert.equal(scaledUiOf(new Uint8Array(40)), null)

  const step = { multiplier: 1.0, newMultiplier: 1.02, effectiveAt: 1_000 }
  assert.equal(multiplierAt(step, 999), 1.0)
  assert.equal(multiplierAt(step, 1_000), 1.02)
  assert.equal(multiplierAt({ ...step, effectiveAt: 0 }, 5_000), 1.0)
})

test('CSV has one header and one line per row, quoting what needs it', () => {
  const [r] = tapeRows(FILL, ctx()).rows
  const csv = toCsv([r, { ...r, paired: 'a, b' }])
  const lines = csv.trimEnd().split('\r\n')
  assert.equal(lines.length, 3)
  assert.ok(lines[0].startsWith('time,symbol,underlying,paired,direction'))
  assert.ok(lines[1].startsWith('2026-09-23T13:35:24Z,SPYx,SPY,demo-USDC,buy,demo-USDC,SPYx,774.942741,'))
  assert.ok(lines[2].includes(',"a, b",'))
})

test('daily volume counts the 24 hours before publication, per pair', () => {
  const [r] = tapeRows(FILL, ctx()).rows
  const t = Date.parse(r.time) / 1000
  assert.deepEqual(volume24h([r, r], t + 3_600), [
    { symbol: 'SPYx', paired: 'demo-USDC', trades: 2, shares: 0.516167168, notionalUsd: 400 },
  ])
  assert.deepEqual(volume24h([r], t + 86_400), [])
})

// ----------------------------------------------------------------- the loader

/** A SymbolMark account whose quote mint is `quote`; nothing else is read. */
function markAccount(quote: string): string {
  const b = new Uint8Array(8 + 12 + 32 + 32 + 16 + 8 + 4 + 2 + 1 + 8 + 1)
  b.set(fromBase58(quote), 8 + 12 + 32)
  return Buffer.from(b).toString('base64')
}

function fakeRpc(opts: { signatures: (params: { before?: string }) => unknown[] }) {
  const calls: string[] = []
  const rpc = async (method: string, params: unknown[]) => {
    calls.push(method)
    if (method === 'getMultipleAccounts') {
      const keys = params[0] as string[]
      return {
        value: keys.map((k) =>
          k === markPda('SPYx').toBase58()
            ? { data: [markAccount(DEMO_USDC), 'base64'] }
            : k === SPYX_MIRROR
              ? { data: [MINT.data, 'base64'] }
              : null,
        ),
      }
    }
    if (method === 'getSignaturesForAddress') {
      assert.equal(params[0], DEMO_USDC, 'fills are found through the quote mint')
      return opts.signatures(params[1] as { before?: string })
    }
    if (method === 'getTransaction') return params[0] === SIG ? FILL : null
    throw new Error(`unexpected ${method}`)
  }
  return { rpc, calls }
}

test('the tape reads each transaction once, and asks the chain at most once a minute', async () => {
  let ms = (FILL.blockTime! + 3_600) * 1000
  const { rpc, calls } = fakeRpc({
    signatures: () => [
      { signature: SIG, err: null, blockTime: FILL.blockTime },
      // A failed transaction is never fetched: it filled nothing.
      { signature: 'failed-one', err: { InstructionError: [0, 'x'] }, blockTime: FILL.blockTime! - 60 },
    ],
  })
  const tape = createTape({ rpc, cluster: 'devnet', listings: [spyx], label: () => 'demo-USDC', clock: () => ms })

  const first = await tape()
  assert.equal(first.rows.length, 1)
  assert.equal(first.rows[0].priceUsd, 774.942741)
  assert.deepEqual(first.indexedBy, [DEMO_USDC])
  assert.equal(first.complete, true)
  assert.equal(first.pending, 0)
  assert.deepEqual(first.volume24h, [
    { symbol: 'SPYx', paired: 'demo-USDC', trades: 1, shares: 0.258083584, notionalUsd: 200 },
  ])
  assert.deepEqual(calls, ['getMultipleAccounts', 'getSignaturesForAddress', 'getTransaction'])

  // Inside the minute, nothing is asked.
  ms += 30_000
  await tape()
  assert.equal(calls.length, 3)

  // After it, the head of the history is re-read, meets a signature already
  // seen, and no transaction is fetched again.
  ms += 31_000
  const again = await tape()
  assert.equal(again.rows.length, 1)
  assert.deepEqual(calls.slice(3), ['getMultipleAccounts', 'getSignaturesForAddress'])
})

test('a failing RPC is not retried inside the minute, and the last good tape is served meanwhile', async () => {
  let ms = (FILL.blockTime! + 3_600) * 1000
  let down = false
  const { rpc: inner, calls } = fakeRpc({ signatures: () => [{ signature: SIG, err: null, blockTime: FILL.blockTime }] })
  const rpc = async (method: string, params: unknown[]) => {
    if (down) {
      calls.push(`${method} (refused)`)
      throw new Error('HTTP 429')
    }
    return inner(method, params)
  }
  const tape = createTape({ rpc, cluster: 'devnet', listings: [spyx], label: () => 'demo-USDC', clock: () => ms })
  await tape()
  down = true
  ms += 61_000
  const stale = await tape()
  assert.equal(stale.rows.length, 1)
  assert.equal(stale.error, 'HTTP 429')
  const n = calls.length
  ms += 10_000
  await tape()
  assert.equal(calls.length, n, 'no retry inside the minute')
})

test('a history longer than one refresh reads is paged in bounded steps and reported incomplete', async () => {
  const ms = (FILL.blockTime! + 3_600) * 1000
  // An endless run of failed transactions inside the window: every page is full.
  const page = (before?: string) => {
    const start = before ? Number(before.split('-')[1]) + 1 : 0
    return Array.from({ length: 1000 }, (_, i) => ({
      signature: `s-${start + i}`,
      err: { x: 1 },
      blockTime: FILL.blockTime,
    }))
  }
  let current = ms
  const { rpc, calls } = fakeRpc({ signatures: (p) => page(p.before) })
  const tape = createTape({ rpc, cluster: 'devnet', listings: [spyx], label: () => 'demo-USDC', clock: () => current })

  const first = await tape()
  assert.equal(calls.filter((c) => c === 'getSignaturesForAddress').length, 5)
  assert.equal(first.complete, false)

  // The next refresh finds nothing new at the head and spends the rest of its
  // pages where the last one stopped.
  current += 61_000
  const second = await tape()
  assert.equal(calls.filter((c) => c === 'getSignaturesForAddress').length, 10)
  assert.equal(second.complete, false)
  assert.equal(calls.filter((c) => c === 'getTransaction').length, 0)
})

test('each fill carries its buyer, for receipts, and it is the order owner', () => {
  // The 23 Sep overnight order was placed by the demo wallet the film uses.
  const [f] = fillsOf(FILL)
  assert.equal(f!.owner, '9wNeE9MRMa8SwH6BAmYw9cDnvwReGUgnEcxNmpsCbeEJ')
})
