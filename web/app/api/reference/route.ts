/**
 * GET /api/reference — the last US price of each listing's underlying.
 *
 * Display only: the page sets it beside the pool's price. No order, fill or
 * gate reads it. Cached for a minute in `lib/reference.ts`, so visitors never
 * multiply the upstream requests.
 */
import { references } from '../../../lib/reference.ts'
import { ALLOWLIST } from '../../../../src/config.ts'

export async function GET() {
  const refs = await references([...new Set(ALLOWLIST.map((l) => l.underlying))])
  return Response.json(refs, { headers: { 'cache-control': 'public, max-age=30, s-maxage=60' } })
}
