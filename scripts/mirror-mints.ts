/**
 * Create devnet stand-ins for the real mints.
 *
 *   ./scripts/localnet.sh &     # clones the real mainnet accounts
 *   node scripts/register.ts    # so TokenRisk is populated from them
 *   node scripts/mirror-mints.ts
 *
 * None of these securities exist on devnet, so a deployment there needs mints
 * of our own. The point of this script is that the mirrors are **derived, not
 * described**: it reads each real mint's extension state out of the `TokenRisk`
 * account on localnet — which is to say, through the program's own audited
 * parser, the same code that guards a trade — and reproduces that shape on
 * devnet.
 *
 * What it reproduces: decimals, the scaled-UI multiplier, the pausable config,
 * the permanent delegate, and the transfer-hook slot. What it cannot: the
 * issuer's authority over them. We hold the mint authority on a mirror, which
 * is the one thing that makes a live rebase demo possible at all — Backed will
 * not schedule a dividend for our film.
 *
 * A mirror is not the thing, and nothing here pretends otherwise. The program
 * tests parse real mainnet mint bytes and `localnet.sh` clones the real
 * accounts; only a devnet deployment uses what this writes.
 */
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { Connection, PublicKey } from '@solana/web3.js'
import { readTokenRisk } from '../src/chain/client.ts'
import { multiplierOf } from '../src/chain/codec.ts'
import { MAINNET_LISTINGS } from '../src/config.ts'
import { fetchTokens } from '../src/sensor/jupiter.ts'

const SOURCE = process.env.BELL_MIRROR_SOURCE ?? 'http://127.0.0.1:8899'
const TARGET = process.env.BELL_MIRROR_TARGET ?? 'https://api.devnet.solana.com'
const OUT = 'src/mirrors.json'

const spl = (...args: string[]) =>
  execFileSync('spl-token', [...args, '--url', TARGET, '--output', 'json'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })

async function main() {
  const source = new Connection(SOURCE, 'confirmed')

  // Decimals come from the token list rather than the risk record, because the
  // program has no reason to store them — it reads them from the mint at fill
  // time. Keyed on the real address: that is what the list knows.
  const decimals = new Map(
    [...(await fetchTokens(MAINNET_LISTINGS.map((l) => l.mainnetMint)))].map(([m, t]) => [m, t.decimals]),
  )

  const mirrors: Record<string, string> = {}

  for (const listing of MAINNET_LISTINGS) {
    const risk = await readTokenRisk(source, new PublicKey(listing.mainnetMint))
    if (!risk) {
      throw new Error(
        `no TokenRisk for ${listing.symbol} on ${SOURCE}. ` +
          `Run scripts/localnet.sh and scripts/register.ts first — the mirrors are ` +
          `derived from the real mints, never hand-written.`,
      )
    }
    const d = decimals.get(listing.mainnetMint)
    if (d === undefined) throw new Error(`no decimals for ${listing.symbol}`)

    const multiplier = multiplierOf(risk.multiplierBits)

    // Every extension the gate actually reads. `--enable-transfer-hook` arms
    // the slot without naming a program, which is exactly how these mints ship
    // today and what gate 6 exists to notice if it ever changes.
    const args = [
      'create-token',
      '--program-2022',
      '--decimals',
      String(d),
      '--ui-amount-multiplier',
      String(multiplier),
      '--enable-pause',
      '--enable-transfer-hook',
    ]
    if (risk.permanentDelegate !== null) args.push('--enable-permanent-delegate')

    const created = JSON.parse(spl(...args)) as { commandOutput: { address: string } }
    const mint = created.commandOutput.address
    mirrors[listing.symbol] = mint

    console.log(
      `${listing.symbol.padEnd(6)} ${mint}\n` +
        `        decimals=${d} multiplier=${multiplier}` +
        ` pausable=yes hook=armed` +
        ` permanentDelegate=${risk.permanentDelegate !== null ? 'yes' : 'no'}` +
        `  (mirrors ${listing.mainnetMint})`,
    )
  }

  writeFileSync(OUT, `${JSON.stringify(mirrors, null, 2)}\n`)
  console.log(`\nwrote ${OUT} — ${Object.keys(mirrors).length} mirrors`)
  console.log('These are committed on purpose: they are the devnet deployment record.')
}

await main()
