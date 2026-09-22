/**
 * Is the live deployment healthy? Read-only; exits non-zero naming every reason.
 *
 *   BELL_CLUSTER=devnet BELL_RPC_URL=https://api.devnet.solana.com \
 *   BELL_FAUCET=<pubkey> BELL_FILLER=<pubkey> BELL_QUOTE_MINT=<mint> \
 *   BELL_SITE_URL=https://… node scripts/health.ts
 *
 * Run every 15 minutes by `.github/workflows/health.yml`, so a failure emails
 * the owner instead of waiting for a judge to notice it. The venue fails
 * closed, which is right and also quiet: a dead keeper looks exactly like a
 * closed market unless something checks. It holds no keys and sends nothing.
 */
import { LAMPORTS_PER_SOL, PublicKey, SYSVAR_CLOCK_PUBKEY } from '@solana/web3.js'
import { connect, readBoard } from '../src/chain/client.ts'
import { MAX_RISK_AGE_SECONDS } from '../src/chain/codec.ts'
import { ataFor, decodeTokenAccount } from '../src/chain/spl.ts'
import { ALLOWLIST, CLUSTER } from '../src/config.ts'

/** Past this, the keeper has missed several ticks — not one slow one. */
const MAX_ATTESTATION_AGE = 300
const MIN_SOL = { faucet: 0.1, attestor: 0.05, filler: 0.02 }
/** Two grants' worth. */
const MIN_POOL_QUOTE = 2_000

const need = (k: string) => {
  const v = process.env[k]
  if (!v) throw new Error(`${k} unset`)
  return v
}

const conn = connect()
const faucet = new PublicKey(need('BELL_FAUCET'))
const filler = new PublicKey(need('BELL_FILLER'))
const quoteMint = new PublicKey(need('BELL_QUOTE_MINT'))
const site = process.env.BELL_SITE_URL

const failures: string[] = []
const report = (ok: boolean, line: string) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${line}`)
  if (!ok) failures.push(line)
}

const { symbols, extras } = await readBoard(conn, ALLOWLIST, [
  SYSVAR_CLOCK_PUBKEY,
  faucet,
  filler,
  ataFor(faucet, quoteMint),
])
const [clock, faucetInfo, fillerInfo, poolInfo] = extras
if (!clock) throw new Error('no clock — cannot judge ages')
const now = Number(new DataView(clock.data.buffer, clock.data.byteOffset).getBigInt64(32, true))
console.log(`health — ${CLUSTER} — chain time ${new Date(now * 1000).toISOString()}\n`)

// The keeper: every symbol attested recently, and every mint re-read.
let attestor: PublicKey | null = null
for (const l of ALLOWLIST) {
  const acc = symbols.get(l.symbol)
  if (!acc?.state || !acc.risk) {
    report(false, `${l.symbol} is not registered`)
    continue
  }
  attestor ??= acc.state.attestor
  const age = now - Number(acc.state.observedAt)
  const riskAge = now - Number(acc.risk.verifiedAt)
  report(
    age <= MAX_ATTESTATION_AGE && riskAge <= MAX_RISK_AGE_SECONDS,
    `${l.symbol.padEnd(6)} attested ${age}s ago, mint read ${riskAge}s ago`,
  )
}

// The wallets that keep it running.
const sol = (lamports: number | undefined) => (lamports ?? 0) / LAMPORTS_PER_SOL
const attestorSol = attestor ? sol(await conn.getBalance(attestor)) : 0
report(attestorSol >= MIN_SOL.attestor, `attestor ${attestor?.toBase58() ?? '?'} holds ${attestorSol.toFixed(4)} SOL`)
report(sol(fillerInfo?.lamports) >= MIN_SOL.filler, `filler holds ${sol(fillerInfo?.lamports).toFixed(4)} SOL`)
report(sol(faucetInfo?.lamports) >= MIN_SOL.faucet, `faucet holds ${sol(faucetInfo?.lamports).toFixed(4)} SOL`)
const pool = poolInfo ? Number(decodeTokenAccount(poolInfo.data).amount) / 1e6 : 0
report(pool >= MIN_POOL_QUOTE, `faucet pool holds ${pool.toLocaleString()} demo-USDC`)

// The page a judge opens.
if (site) {
  try {
    const res = await fetch(site, { signal: AbortSignal.timeout(20_000) })
    const body = await res.text()
    report(res.ok && body.includes('BELL'), `site ${site} answered ${res.status}`)
  } catch (e) {
    report(false, `site ${site} unreachable: ${(e as Error).message}`)
  }
}

console.log(failures.length ? `\n${failures.length} problem(s)` : '\nhealthy')
process.exit(failures.length ? 1 : 0)
