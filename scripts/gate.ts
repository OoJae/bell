/**
 * Ask the gate about every allowlisted symbol, without sending anything.
 *
 *   node scripts/gate.ts
 *
 * `assert_tradeable` either succeeds or fails, so simulation answers exactly as
 * execution would. This is the read-only guard API.
 */
import { PublicKey } from '@solana/web3.js'
import { checkGate, connect, loadKeypair, readSymbolState, readTokenRisk } from '../src/chain/client.ts'
import { Mode } from '../src/chain/codec.ts'
import { ALLOWLIST } from '../src/config.ts'

const PAYER_PATH = process.env.BELL_PAYER_KEYPAIR ?? `${process.env.HOME}/.config/solana/id.json`
const mode = process.argv.includes('--guarded') ? Mode.Guarded : Mode.Strict

const conn = connect()
const payer = loadKeypair(PAYER_PATH).publicKey

console.log(`gate check — ${mode === Mode.Strict ? 'STRICT' : 'GUARDED'}\n`)
let allowed = 0
for (const l of ALLOWLIST) {
  const mint = new PublicKey(l.mint)
  const risk = await readTokenRisk(conn, mint)
  const state = await readSymbolState(conn, l.symbol)
  if (!risk || !state) {
    console.log(`  ${l.symbol.padEnd(7)} not registered`)
    continue
  }
  const age = state.observedAt > 0n ? Math.floor(Date.now() / 1000) - Number(state.observedAt) : null
  const r = await checkGate(conn, payer, {
    symbol: l.symbol,
    mint,
    mode,
    expectedMultiplierBits: risk.multiplierBits,
  })
  if (r.allowed) allowed++
  console.log(
    `  ${l.symbol.padEnd(7)} ${r.allowed ? 'ALLOW' : 'REFUSE'.padEnd(6)} ` +
      `${(r.reason ?? '').padEnd(12)} age=${age === null ? 'never' : age + 's'}`,
  )
}
console.log(`\n${allowed} of ${ALLOWLIST.length} tradeable`)
