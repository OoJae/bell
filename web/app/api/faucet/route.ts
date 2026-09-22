/**
 * POST /api/faucet — demo funds for a fresh devnet wallet.
 *
 * The only server route BELL has. It gives test money and nothing else; no
 * order, fill or cancel ever passes through here. The logic and its bounds
 * live in `lib/faucet.ts`.
 */
import { grant } from '../../../lib/faucet.ts'

export async function POST(request: Request) {
  let body: { owner?: unknown }
  try {
    body = (await request.json()) as { owner?: unknown }
  } catch {
    return Response.json({ ok: false, message: 'Send JSON: {"owner": "<address>"}' }, { status: 400 })
  }
  // Railway's edge sets X-Real-IP; the first X-Forwarded-For entry is whatever
  // the client claims, so it is not used for rate limiting.
  const ip = request.headers.get('x-real-ip') ?? 'unknown'
  const r = await grant({ owner: body.owner, ip })
  return Response.json(r.body, {
    status: r.status,
    headers: r.retryAfter ? { 'Retry-After': String(r.retryAfter) } : {},
  })
}
