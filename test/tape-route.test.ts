/**
 * GET /api/tape, end to end over a stand-in RPC: who the public tape names.
 *
 * The public tape leaves every wallet off, and a request for one wallet's
 * receipts gets that wallet's rows only. Sells added a second party field, and
 * this is where forgetting to strip it would publish every seller's wallet, so
 * the route itself is run rather than the filter restated. A cross carries
 * both parties on one row, and each party's request must get it with its own
 * side only, never the counterparty's wallet.
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
const { CRANKER, CROSS_SIG, CROSS_TIME, SELLER, crossFill } = await import('./fixtures/cross-fill.ts')
const { readFileSync } = await import('node:fs')
const { default: idl } = await import('../src/chain/idl.json', { with: { type: 'json' } })
const { markPda } = await import('../src/chain/client.ts')
const { fromBase58 } = await import('../web/lib/tape.ts')

const SPYX_MIRROR = 'AFrGCsmPc3WeUAEM3jw8Ec3M6BrKrJGDQeX2g1Ctrrwx'
const MINT = JSON.parse(readFileSync(new URL('./fixtures/spyx-mirror-mint.json', import.meta.url), 'utf8')) as { data: string }
const SELL = sellFill()
/** The recorded buyer's order crossed against another wallet's sell, a minute after the sale. */
const CROSS = crossFill()
/**
 * The same cross sent by its seller rather than the crank, as anyone may: the
 * seller's wallet is then the row's `filler` as well as its seller.
 */
const SELF_SIG = '5SeLFxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'
const SELF_TIME = CROSS_TIME + 60
const SELF_CROSS = (() => {
  const t = structuredClone(CROSS)
  t.blockTime = SELF_TIME
  t.slot += 150
  t.transaction.signatures[0] = SELF_SIG
  const ix = t.transaction.message.instructions[1]!
  const names = (idl.instructions.find((i) => i.name === 'cross_orders')!.accounts as { name: string }[]).map((a) => a.name)
  ix.accounts[names.indexOf('cranker')] = ix.accounts[names.indexOf('seller')]!
  return t
})()

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
          { signature: SELF_SIG, err: null, blockTime: SELF_TIME },
          { signature: CROSS_SIG, err: null, blockTime: CROSS_TIME },
          { signature: SELL_SIG, err: null, blockTime: SELL_TIME },
          { signature: BUY_SIG, err: null, blockTime: BUY.blockTime },
        ]
      : []
  }
  if (method === 'getTransaction') {
    return params[0] === SELL_SIG ? SELL : params[0] === BUY_SIG ? BUY : params[0] === CROSS_SIG ? CROSS : params[0] === SELF_SIG ? SELF_CROSS : null
  }
  throw new Error(`unexpected ${method}`)
}

// An hour after the sell, fixed, so the thirty-day window holds all three
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
const only = (rows: Record<string, unknown>[], direction: string) => rows.filter((r) => r.direction === direction)
const bySig = (rows: Record<string, unknown>[], sig: string) => rows.filter((r) => r.signature === sig)

test('the public tape lists the buy, the sell and both crosses, and names no party to any of them', async () => {
  const rows = await rowsOf()
  assert.deepEqual(rows.map((r) => r.direction), ['cross', 'cross', 'sell', 'buy'], 'newest first')
  for (const r of rows) {
    assert.ok(!('buyer' in r), 'no buyer on the public tape')
    assert.ok(!('seller' in r), 'no seller on the public tape')
  }
  const body = await (await get()).text()
  assert.ok(!body.includes(OWNER), 'the wallet appears nowhere in the public JSON')
  assert.ok(!body.includes(SELLER), 'nor the cross’s seller')
  const csv = await (await get('?format=csv')).text()
  assert.ok(!csv.includes(OWNER), 'nor in the CSV')
  assert.ok(!csv.includes(SELLER))
  assert.match(csv, /,sell,SPYx,demo-USDC,/)
  assert.match(csv, /,cross,demo-USDC,SPYx,/)
})

test('a wallet asks for its purchases and its sales separately, or both', async () => {
  const publicBuy = only(await rowsOf(), 'buy')[0]!
  const publicSell = only(await rowsOf(), 'sell')[0]!

  // The wallet bought once by a fill and twice by a cross.
  const bought = await rowsOf(`?buyer=${OWNER}`)
  assert.deepEqual(bought.map((r) => r.direction), ['cross', 'cross', 'buy'])
  // The buy row is the public one with the asked-for wallet on it, and nothing else.
  assert.deepEqual(only(bought, 'buy'), [{ ...publicBuy, buyer: OWNER }])

  // A page that asks only for purchases is never handed a sale to render as one.
  const sold = await rowsOf(`?seller=${OWNER}`)
  assert.deepEqual(sold, [{ ...publicSell, seller: OWNER }])

  const both = await rowsOf(`?buyer=${OWNER}&seller=${OWNER}`)
  assert.deepEqual(both.map((r) => r.direction), ['cross', 'cross', 'sell', 'buy'])

  assert.deepEqual(await rowsOf('?buyer=11111111111111111111111111111111'), [])
  assert.deepEqual(await rowsOf('?seller=11111111111111111111111111111111'), [])
})

test('each party to a cross finds it, and sees its own side and never the counterparty', async () => {
  const publicCross = bySig(await rowsOf(), CROSS_SIG)[0]!
  assert.ok(publicCross)
  assert.equal(publicCross.filler, CRANKER, 'the crank sent it; it is neither party')

  // The buyer: its own wallet on the row, the seller's nowhere in the answer.
  const asBuyer = await get(`?buyer=${OWNER}`)
  const buyerText = await asBuyer.clone().text()
  assert.ok(!buyerText.includes(SELLER), 'the buyer is not told who sold')
  const buyerCross = bySig(((await asBuyer.json()) as { rows: Record<string, unknown>[] }).rows, CROSS_SIG)
  assert.deepEqual(buyerCross, [{ ...publicCross, buyer: OWNER }])

  // The seller: likewise, the other way round.
  const asSeller = await get(`?seller=${SELLER}`)
  const sellerText = await asSeller.clone().text()
  assert.ok(!sellerText.includes(OWNER), 'the seller is not told who bought')
  assert.deepEqual(bySig(((await asSeller.json()) as { rows: Record<string, unknown>[] }).rows, CROSS_SIG), [{ ...publicCross, seller: SELLER }])
  // Nor in its CSV.
  assert.ok(!(await (await get(`?seller=${SELLER}&format=csv`)).text()).includes(OWNER))

  // Asking for its purchases and its sales together, the seller gets the cross once, as the seller.
  assert.deepEqual(bySig(await rowsOf(`?buyer=${SELLER}&seller=${SELLER}`), CROSS_SIG), [{ ...publicCross, seller: SELLER }])
  // A wallet is found only on the side it was on.
  assert.deepEqual(await rowsOf(`?buyer=${SELLER}`), [])
  assert.deepEqual(only(await rowsOf(`?seller=${OWNER}`), 'cross'), [])
  // The crank sent it and is no party to it.
  assert.deepEqual(await rowsOf(`?buyer=${CRANKER}`), [])
  assert.deepEqual(await rowsOf(`?seller=${CRANKER}`), [])
})

test('a cross its seller sent itself names the seller nowhere but in its own answer, and not even as the filler', async () => {
  // The public row: every party field off, and the sender, a party, off too.
  const publicSelf = bySig(await rowsOf(), SELF_SIG)[0]!
  assert.equal(publicSelf.direction, 'cross')
  assert.equal(publicSelf.filler, '', 'the sender was a party, so it is not named as the filler')
  assert.ok(!('buyer' in publicSelf) && !('seller' in publicSelf))
  // The buyer is not told who sold, in JSON or CSV.
  assert.ok(!(await (await get(`?buyer=${OWNER}`)).text()).includes(SELLER))
  assert.ok(!(await (await get(`?buyer=${OWNER}&format=csv`)).text()).includes(SELLER))
  assert.deepEqual(bySig(await rowsOf(`?buyer=${OWNER}`), SELF_SIG), [{ ...publicSelf, buyer: OWNER }])
  // The seller sees its own side, and still not the buyer.
  assert.deepEqual(bySig(await rowsOf(`?seller=${SELLER}`), SELF_SIG), [{ ...publicSelf, seller: SELLER }])
  assert.ok(!(await (await get(`?seller=${SELLER}`)).text()).includes(OWNER))
})
