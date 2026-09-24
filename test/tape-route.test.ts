/**
 * GET /api/tape, end to end over a stand-in RPC: who the public tape names.
 *
 * The public tape leaves every wallet off, and a request for one wallet's
 * receipts gets that wallet's rows only. Sells added a second party field, and
 * this is where forgetting to strip it would publish every seller's wallet, so
 * the route itself is run rather than the filter restated.
 *
 * The route builds its tape when it is imported, reading the cluster from the
 * environment and the clock and transport from globals, so all three are set
 * before anything is loaded. Node gives each test file its own process, which
 * keeps these globals here.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

process.env.BELL_CLUSTER = 'devnet'
delete process.env.NEXT_PUBLIC_BELL_CLUSTER
const DEMO_USDC = '8QhSxevJerJq8khpNsfW69bUPvcBjMRTXPKrxYQAtAaX'
process.env.NEXT_PUBLIC_BELL_QUOTE_MINT = DEMO_USDC

const { BUY, BUY_SIG, OWNER, SELL_SIG, SELL_TIME, sellFill } = await import('./fixtures/sell-fill.ts')
const { readFileSync } = await import('node:fs')
const { markPda } = await import('../src/chain/client.ts')
const { fromBase58 } = await import('../web/lib/tape.ts')

const SPYX_MIRROR = 'AFrGCsmPc3WeUAEM3jw8Ec3M6BrKrJGDQeX2g1Ctrrwx'
const MINT = JSON.parse(readFileSync(new URL('./fixtures/spyx-mirror-mint.json', import.meta.url), 'utf8')) as { data: string }
const SELL = sellFill()

/** A SymbolMark account whose quote mint is `quote`; nothing else is read. */
function markAccount(quote: string): string {
  const b = new Uint8Array(8 + 12 + 32 + 32 + 16 + 8 + 4 + 2 + 1 + 8 + 1)
  b.set(fromBase58(quote), 8 + 12 + 32)
  return Buffer.from(b).toString('base64')
}

function answer(method: string, params: unknown[]): unknown {
  if (method === 'getMultipleAccounts') {
    return {
      value: (params[0] as string[]).map((k) =>
        k === markPda('SPYx').toBase58()
          ? { data: [markAccount(DEMO_USDC), 'base64'] }
          : k === SPYX_MIRROR
            ? { data: [MINT.data, 'base64'] }
            : null,
      ),
    }
  }
  if (method === 'getSignaturesForAddress') {
    return params[0] === DEMO_USDC
      ? [
          { signature: SELL_SIG, err: null, blockTime: SELL_TIME },
          { signature: BUY_SIG, err: null, blockTime: BUY.blockTime },
        ]
      : []
  }
  if (method === 'getTransaction') return params[0] === SELL_SIG ? SELL : params[0] === BUY_SIG ? BUY : null
  throw new Error(`unexpected ${method}`)
}

// An hour after the sell, fixed, so the thirty-day window holds both fills
// whenever this runs.
Date.now = () => (SELL_TIME + 3_600) * 1000
globalThis.fetch = (async (_url: string, init: RequestInit) => {
  const { method, params } = JSON.parse(String(init.body)) as { method: string; params: unknown[] }
  return Response.json({ jsonrpc: '2.0', id: 1, result: answer(method, params) })
}) as typeof fetch

const { GET } = await import('../web/app/api/tape/route.ts')
const get = async (query = '') => {
  const res = await GET(new Request(`http://bell.test/api/tape${query}`))
  assert.equal(res.status, 200)
  return res
}
const rowsOf = async (query = '') => ((await (await get(query)).json()) as { rows: Record<string, unknown>[] }).rows

test('the public tape lists the buy and the sell and names neither party', async () => {
  const rows = await rowsOf()
  assert.deepEqual(rows.map((r) => r.direction).sort(), ['buy', 'sell'])
  for (const r of rows) {
    assert.ok(!('buyer' in r), 'no buyer on the public tape')
    assert.ok(!('seller' in r), 'no seller on the public tape')
  }
  const body = await (await get()).text()
  assert.ok(!body.includes(OWNER), 'the wallet appears nowhere in the public JSON')
  const csv = await (await get('?format=csv')).text()
  assert.ok(!csv.includes(OWNER), 'nor in the CSV')
  assert.match(csv, /,sell,SPYx,demo-USDC,/)
})

test('a wallet asks for its purchases and its sales separately, or both', async () => {
  const bought = await rowsOf(`?buyer=${OWNER}`)
  assert.equal(bought.length, 1)
  assert.equal(bought[0]!.direction, 'buy')
  assert.equal(bought[0]!.buyer, OWNER)
  assert.ok(!('seller' in bought[0]!))

  // A page that asks only for purchases is never handed a sale to render as one.
  const sold = await rowsOf(`?seller=${OWNER}`)
  assert.equal(sold.length, 1)
  assert.equal(sold[0]!.direction, 'sell')
  assert.equal(sold[0]!.seller, OWNER)
  assert.ok(!('buyer' in sold[0]!))

  const both = await rowsOf(`?buyer=${OWNER}&seller=${OWNER}`)
  assert.deepEqual(both.map((r) => r.direction).sort(), ['buy', 'sell'])

  assert.deepEqual(await rowsOf('?buyer=11111111111111111111111111111111'), [])
  assert.deepEqual(await rowsOf('?seller=11111111111111111111111111111111'), [])
})
