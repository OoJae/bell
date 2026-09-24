/**
 * GET /api/tape — every BELL fill of the last thirty days, as JSON.
 * GET /api/tape?format=csv — the same rows as CSV.
 *
 * Read-only: it reads finalized transactions from the RPC and holds no key.
 * The rows are built in `lib/tape.ts`, which also bounds how often the chain is
 * asked — at most once a minute, however many people read this.
 */
import { createTape, quoteLabel, toCsv, type Tape } from '../../../lib/tape.ts'
import { ALLOWLIST, CLUSTER } from '../../../../src/config.ts'

const RPC_URL = process.env.BELL_RPC_URL ?? process.env.NEXT_PUBLIC_BELL_RPC ?? 'https://api.devnet.solana.com'
const QUOTE_MINT = process.env.NEXT_PUBLIC_BELL_QUOTE_MINT

let id = 0
async function rpc(method: string, params: unknown[]): Promise<unknown> {
  const res = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
    signal: AbortSignal.timeout(20_000),
  })
  if (!res.ok) throw new Error(`${method}: HTTP ${res.status}`)
  const body = (await res.json()) as { result?: unknown; error?: { message?: string } }
  if (body.error) throw new Error(`${method}: ${body.error.message ?? 'RPC error'}`)
  return body.result
}

// Module scope, so one cache serves every request this server handles.
const tape = createTape({
  rpc,
  cluster: CLUSTER,
  listings: ALLOWLIST,
  label: (mint) => quoteLabel(mint, QUOTE_MINT),
})

export async function GET(request: Request) {
  let t: Tape
  try {
    t = await tape()
  } catch (e) {
    return Response.json(
      { ok: false, message: `The tape could not be read from the chain: ${(e as Error).message}` },
      { status: 503, headers: { 'Retry-After': '60' } },
    )
  }
  // Public data, so any origin may read it. The completeness flags ride in
  // headers too, because the CSV has no other place to say that rows are still
  // being read, and a reader of the CSV alone would take a partial tape as whole.
  const headers = {
    'cache-control': 'public, max-age=30, s-maxage=60',
    'access-control-allow-origin': '*',
    'access-control-expose-headers': 'x-tape-complete, x-tape-pending, x-tape-generated-at',
    'x-tape-complete': String(t.complete),
    'x-tape-pending': String(t.pending),
    'x-tape-generated-at': t.generatedAt,
  }
  const params = new URL(request.url).searchParams
  // The public tape leaves buyers off. A request for one buyer's own fills
  // gets exactly those rows, buyer included — how the page shows receipts.
  const buyer = params.get('buyer')
  const rows = buyer ? t.rows.filter((r) => r.buyer === buyer) : t.rows.map(({ buyer: _, ...r }) => r)
  const body = { ...t, rows }
  if (params.get('format') === 'csv') {
    return new Response(toCsv(rows), {
      headers: {
        ...headers,
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': 'inline; filename="bell-tape.csv"',
      },
    })
  }
  return Response.json(body, { headers })
}
