/**
 * Settle empirically what a Pyth key actually unlocks.
 *
 *   PYTH_API_KEY=... node scripts/check-pyth.ts
 *
 * The docs and the post-upgrade coverage disagree about whether a free Terminal
 * key can read prices, so ask the API instead of picking a side.
 */
const KEY = process.env.PYTH_API_KEY
const AAPL_EQUITY = '49f6b65cb1de6b10eaf75e7c03ca029c306d0357e91b5311b175084a5ad55688'
const AAPLX_24_7 = '978e6cc68a119ce066aa830017318563a9ed04ec3a0a6439010fc11296a58675'

async function probe(label: string, url: string, withKey: boolean) {
  const headers: Record<string, string> = { accept: 'application/json' }
  if (withKey && KEY) headers.authorization = `Bearer ${KEY}`
  try {
    const res = await fetch(url, { headers })
    const body = await res.text()
    const ok = res.ok ? 'OK ' : 'FAIL'
    console.log(`  ${ok} ${String(res.status).padEnd(4)} ${label}`)
    if (res.ok) {
      const parsed = JSON.parse(body) as { parsed?: Array<{ price?: { price: string; expo: number } }> }
      const p = parsed.parsed?.[0]?.price
      if (p) console.log(`         price = ${Number(p.price) * 10 ** p.expo}`)
    }
  } catch (e) {
    console.log(`  ERR       ${label}: ${(e as Error).message}`)
  }
}

console.log(`Pyth access check — key ${KEY ? 'present' : 'ABSENT (set PYTH_API_KEY)'}\n`)
console.log('metadata (expected public):')
await probe('feed list', 'https://hermes.pyth.network/v2/price_feeds?query=AAPL&asset_type=equity', false)

console.log('\nprices via public Hermes (expected 401 since 2026-08-26):')
await probe('Equity.US.AAPL/USD', `https://hermes.pyth.network/v2/updates/price/latest?ids[]=${AAPL_EQUITY}`, false)

console.log('\nprices via Pyth Pro endpoint, with key:')
await probe('Equity.US.AAPL/USD', `https://pyth.dourolabs.app/hermes/v2/updates/price/latest?ids[]=${AAPL_EQUITY}`, true)
await probe('Crypto.AAPLX/USD (24/7)', `https://pyth.dourolabs.app/hermes/v2/updates/price/latest?ids[]=${AAPLX_24_7}`, true)

console.log('\nfree fallback — Backpack stock tickers (no auth):')
const res = await fetch('https://api.backpack.exchange/api/v1/tickers')
const all = (await res.json()) as Array<{ symbol: string; lastPrice: string }>
const stocks = all.filter((t) => t.symbol.includes('.US_'))
console.log(`  OK   ${res.status}  ${stocks.length} stock markets`)
for (const t of stocks.slice(0, 5)) console.log(`         ${t.symbol.padEnd(22)} ${t.lastPrice}`)
