/**
 * Generate token accounts for the local validator to load at startup.
 *
 * The filler needs stock inventory, and the stock mints are real — Backed holds
 * their mint authority, so there is no way to mint some for a test. Seeding the
 * account directly is the honest workaround: the *mint* stays byte-for-byte
 * real, and only the holding is fabricated.
 *
 *   node scripts/seed-accounts.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { PublicKey } from '@solana/web3.js'
import { ALLOWLIST } from '../src/config.ts'
import { loadKeypair } from '../src/chain/client.ts'

const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'
const OUT = 'localnet'

/** SPL token account layout, 165 bytes. Stable, documented, and easy to audit. */
function tokenAccount(mint: PublicKey, owner: PublicKey, amount: bigint): Buffer {
  const d = Buffer.alloc(165)
  mint.toBuffer().copy(d, 0)
  owner.toBuffer().copy(d, 32)
  d.writeBigUInt64LE(amount, 64)
  d[108] = 1 // AccountState::Initialized
  return d
}

function write(name: string, address: PublicKey, data: Buffer, owner: string) {
  writeFileSync(
    `${OUT}/${name}.json`,
    JSON.stringify(
      {
        pubkey: address.toBase58(),
        account: {
          lamports: 1_000_000_000,
          data: [data.toString('base64'), 'base64'],
          owner,
          executable: false,
          rentEpoch: 0,
        },
      },
      null,
      1,
    ),
  )
}

const filler = loadKeypair(process.env.BELL_FILLER_KEYPAIR ?? '.filler.json')
mkdirSync(OUT, { recursive: true })

const flags: string[] = []
for (const l of ALLOWLIST) {
  const mint = new PublicKey(l.mint)
  // Deterministic address per (filler, mint) so the flags are stable across runs.
  const addr = PublicKey.findProgramAddressSync(
    [Buffer.from('inv'), filler.publicKey.toBytes(), mint.toBytes()],
    new PublicKey('11111111111111111111111111111112'),
  )[0]
  write(`inv-${l.symbol}`, addr, tokenAccount(mint, filler.publicKey, 100_000_000_000n), TOKEN_2022)
  flags.push(`--account ${addr.toBase58()} localnet/inv-${l.symbol}.json`)
  console.log(`${l.symbol.padEnd(7)} filler inventory -> ${addr.toBase58()}`)
}

writeFileSync(`${OUT}/accounts.flags`, flags.join(' \\\n  ') + '\n')
console.log(`\n${flags.length} accounts -> localnet/*.json`)
