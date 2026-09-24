/**
 * GET /api/overpay?wallet=<address> — a wallet's recent mainnet buys of the
 * listed stocks, and for each one made outside the regular session, its price
 * per share against the underlying's next regular-session open.
 *
 * Read-only and mainnet only, whatever cluster the rest of this deployment
 * points at: it holds no key and signs nothing. The work is in
 * `src/overpay.ts`, which also bounds it: at most a hundred transactions per
 * wallet, a few at a time, forty-five seconds for every chain call and then at
 * most two seven-second asks of Nasdaq, each wallet's answer kept for five
 * minutes, and only a few wallets read at once.
 */
import { createOverpay, httpRpc, LookupError, OutOfTime, RateLimited } from '../../../../src/overpay.ts'
import { LISTINGS } from '../../../../src/listings.ts'

// Its own variable, not BELL_RPC_URL: that one points at the cluster the venue
// runs on, which is devnet, and none of these securities exist there.
const RPC_URL = process.env.BELL_MAINNET_RPC ?? 'https://api.mainnet-beta.solana.com'
// The public endpoint refuses a method's eleventh call in ten seconds, so the
// transport's default pace is set for it. Anything else is taken to be a keyed
// provider and given ten times the room.
const PUBLIC = RPC_URL.includes('api.mainnet-beta.solana.com')

// Module scope, so one cache and one limit on calls in flight serve every
// request. Every listing, not MAINNET_LISTINGS: that one leaves out a name this
// deployment's cluster has no mirror for, and this question is about mainnet
// whatever cluster the venue runs on.
const overpay = createOverpay({
  rpc: httpRpc(RPC_URL, { concurrency: PUBLIC ? 3 : 6, perWindow: PUBLIC ? 9 : 90 }),
  listings: LISTINGS,
})

export async function GET(request: Request) {
  const wallet = new URL(request.url).searchParams.get('wallet')?.trim() ?? ''
  try {
    const report = await overpay(wallet)
    // Private: the answer is about one wallet, and a shared cache would keep
    // serving it after the five minutes the server keeps it.
    return Response.json(report, { headers: { 'cache-control': 'private, max-age=60' } })
  } catch (e) {
    if (e instanceof LookupError) {
      return e.code === 'busy'
        ? Response.json({ ok: false, message: e.message }, { status: 429, headers: { 'Retry-After': '30' } })
        : Response.json({ ok: false, message: e.message }, { status: 400 })
    }
    // Anything else stays in the server's log. Its message can be a provider's
    // own words or a stack's, and neither is the visitor's business.
    const slow = e instanceof OutOfTime || e instanceof RateLimited
    if (!slow) console.error('overpay: lookup failed:', (e as Error)?.message ?? e)
    return Response.json(
      {
        ok: false,
        message: slow
          ? 'Mainnet is answering slowly just now, so this wallet could not be read. Try again in a minute.'
          : 'Mainnet could not be read just now. Try again in a minute.',
      },
      { status: 503, headers: { 'Retry-After': '60' } },
    )
  }
}
