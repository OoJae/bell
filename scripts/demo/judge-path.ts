/**
 * Walk the path a judge takes, in a real browser, against the live site.
 *
 *   node scripts/demo/judge-path.ts                       # connect, fund, queue $200 of SPYx
 *   node scripts/demo/judge-path.ts --symbol AAPLx --usd 50
 *   node scripts/demo/judge-path.ts --cancel              # cancel every order this wallet has
 *   node scripts/demo/judge-path.ts --look                # just connect and record the board
 *   node scripts/demo/judge-path.ts --watch 20            # record until this wallet's orders fill (≤20 min)
 *   --headed   watch it happen      --url <site>   a different deployment
 *
 * It uses a fresh-by-default scripted wallet (scripts/demo/wallet.ts) so it
 * exercises everything a new visitor hits: discovery through the Wallet
 * Standard, the devnet banner, the faucet, balances, the checks before signing,
 * and the order itself. Every run is recorded to `demo/recordings/` — these are
 * the film's raw footage, and the script is also the end-to-end test of the
 * judge path.
 *
 * The wallet key lives at ~/.config/solana/bell-demo-wallet.json, outside the
 * repo, and is created on first use.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { Connection, Keypair } from '@solana/web3.js'
import { chromium, type Page } from 'playwright'
import { readOrders } from '../../src/chain/client.ts'
import { attachWallet, signed, WALLET_NAME } from './wallet.ts'

const arg = (name: string, fallback?: string) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : fallback
}
const flag = (name: string) => process.argv.includes(`--${name}`)

const URL = arg('url', 'https://web-production-f46ca9.up.railway.app')!
const SYMBOL = arg('symbol', 'SPYx')!
const USD = arg('usd', '200')!
const RPC = process.env.BELL_RPC_URL ?? 'https://api.devnet.solana.com'
const KEY = arg('key', `${process.env.HOME}/.config/solana/bell-demo-wallet.json`)!
const OUT = 'demo/recordings'

function wallet(): Keypair {
  if (!existsSync(KEY)) writeFileSync(KEY, JSON.stringify(Array.from(Keypair.generate().secretKey)), { mode: 0o600 })
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(KEY, 'utf8'))))
}

const step = (s: string) => console.log(`  · ${s}`)

async function connect(page: Page) {
  step('connecting through the Wallet Standard')
  await page.getByRole('button', { name: /select wallet/i }).click()
  await page.getByRole('button', { name: new RegExp(WALLET_NAME, 'i') }).first().click()
  await page.locator('.bal').waitFor({ timeout: 30_000 })
}

/** The demo-USDC balance the page shows, or null for "no account yet". */
async function quoteShown(page: Page): Promise<number | null> {
  const t = (await page.locator('.bal strong').first().textContent())?.replace(/,/g, '') ?? '—'
  return t.trim() === '—' ? null : Number(t)
}

async function notice(page: Page): Promise<{ ok: boolean; text: string }> {
  const n = page.locator('.notice').first()
  await n.waitFor({ timeout: 90_000 })
  return { ok: (await n.getAttribute('class'))?.includes('ok') ?? false, text: (await n.textContent()) ?? '' }
}

async function main() {
  mkdirSync(OUT, { recursive: true })
  const kp = wallet()
  const conn = new Connection(RPC, 'confirmed')
  console.log(`judge path → ${URL}`)
  console.log(`  wallet ${kp.publicKey.toBase58()}`)

  const browser = await chromium.launch({ headless: !flag('headed') })
  // 16:9, because this is film footage: the edit is 1920x1080 and a 1280x860
  // capture would have to be cropped or letterboxed. Video is Playwright's webm
  // (soft); every state change also gets a 2x still, which is what the cut
  // leans on for anything that has to be read.
  const context = await browser.newContext({
    viewport: { width: 1600, height: 900 },
    deviceScaleFactor: 2,
    recordVideo: { dir: OUT, size: { width: 1600, height: 900 } },
  })
  await attachWallet(context, kp)
  const page = await context.newPage()
  let failed = false

  try {
    await page.goto(URL, { waitUntil: 'networkidle' })
    await page.getByText(/tradeable ·/).waitFor({ timeout: 60_000 })
    step(`board: ${(await page.locator('.sub').nth(1).textContent())?.split('·')[0].trim()}`)
    await connect(page)

    if (flag('look')) {
      await page.waitForTimeout(4_000)
    } else if (flag('watch')) {
      // The bell shot: sit on the board with the parked order in view and keep
      // recording until the filler settles it — the order line disappears and
      // a holding appears. Every state change is timestamped for the edit.
      const minutes = Number(arg('watch', '20'))
      await page.locator('.tile', { hasText: SYMBOL }).first().click()
      const deadline = Date.now() + minutes * 60_000
      let last = ''
      while (Date.now() < deadline) {
        const orders = await page.locator('.order').count()
        const holding = (await page.locator('.bal.holdings').textContent().catch(() => null))?.trim() ?? 'none'
        const verdict = (await page.locator('.verdict').first().textContent())?.trim() ?? ''
        const state = `${verdict} | orders ${orders} | ${holding}`
        if (state !== last) {
          const at = new Date().toISOString().slice(11, 19).replace(/:/g, '')
          step(`${at}Z  ${state}`)
          await page.screenshot({ path: `${OUT}/watch-${at}Z.png` })
          last = state
        }
        if (orders === 0 && (await readOrders(conn, kp.publicKey)).length === 0) {
          step('filled — the order is gone and the holding is on screen')
          await page.waitForTimeout(8_000)
          break
        }
        await page.waitForTimeout(5_000)
      }
    } else if (flag('cancel')) {
      const buttons = page.getByRole('button', { name: /^cancel$/i })
      const n = await buttons.count()
      step(`${n} order(s) to cancel`)
      for (let i = 0; i < n; i++) {
        await page.getByRole('button', { name: /^cancel$/i }).first().click()
        const r = await notice(page)
        step(`${r.ok ? 'cancelled' : 'FAILED'}: ${r.text}`)
        if (!r.ok) failed = true
        await page.waitForTimeout(2_000)
      }
    } else {
      const have = await quoteShown(page)
      if (have === null || have < Number(USD)) {
        step(`demo-USDC ${have ?? 'none'} — asking the faucet`)
        await page.getByRole('button', { name: /get demo funds/i }).click()
        const r = await notice(page)
        step(`faucet: ${r.text}`)
        if (!r.ok) throw new Error(`faucet refused: ${r.text}`)
        // Wait for the next poll to show the grant.
        for (let i = 0; i < 20 && ((await quoteShown(page)) ?? 0) < Number(USD); i++) {
          await page.waitForTimeout(3_000)
        }
      }
      step(`demo-USDC ${await quoteShown(page)}`)

      await page.locator('.tile', { hasText: SYMBOL }).first().click()
      await page.waitForTimeout(1_500)
      const verdict = (await page.locator('.verdict').first().textContent())?.trim()
      step(`${SYMBOL}: ${verdict}`)
      await page.getByLabel('amount in dollars').fill(USD)
      const act = page.locator('.buy .act')
      step(`clicking "${(await act.textContent())?.trim()}"`)
      await act.click()
      const r = await notice(page)
      step(`${r.ok ? 'order' : 'REFUSED'}: ${r.text}`)
      if (!r.ok) failed = true
      await page.waitForTimeout(4_000)
    }

    await page.screenshot({ path: `${OUT}/judge-path-${Date.now()}.png`, fullPage: true })
    const book = await readOrders(conn, kp.publicKey)
    step(`on chain: ${book.length} order(s) — ${book.map((o) => `${o.symbol} $${Number(o.amountIn) / 1e6}`).join(', ') || 'none'}`)
    step(`the wallet signed ${signed.length} transaction(s)`)
  } catch (e) {
    failed = true
    console.error(`  ✗ ${(e as Error).message.split('\n')[0]}`)
    await page.screenshot({ path: `${OUT}/judge-path-failed-${Date.now()}.png`, fullPage: true }).catch(() => {})
  } finally {
    const video = await page.video()?.path()
    await context.close()
    await browser.close()
    if (video) console.log(`  recording ${video}`)
  }
  process.exit(failed ? 1 : 0)
}

await main()
