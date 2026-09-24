/**
 * Devnet mirrors for the five Ondo listings, and nothing else.
 *
 *   node scripts/mirror-ondo.ts            # print the spl-token commands; send nothing
 *   node scripts/mirror-ondo.ts --plan     # the same
 *   node scripts/mirror-ondo.ts --write    # create them on devnet and add them to src/mirrors.json
 *   node scripts/mirror-ondo.ts --create   # create them on a local validator; record nothing
 *
 * Creating and recording are one step on devnet, on purpose. A devnet mirror
 * that is made but not recorded is rent locked for good (no close authority)
 * and invites a second, duplicate mirror on the next run. So nothing is sent
 * without a flag, `--write` is the only way to create on devnet, and it only
 * runs against devnet: `src/mirrors.json` is the devnet deployment record, and
 * a local validator's mint written there would weld a devnet symbol to an
 * address that does not exist on devnet. `--create` is for a throwaway local
 * validator, and refuses devnet.
 *
 * Not `mirror-mints.ts`. That script mints a fresh mirror for every listing and
 * rewrites the whole file, and the nine devnet mirrors are permanent: each is
 * welded to a registered symbol, and there is no instruction to undo that. This
 * one only adds, never replaces: a listing that already has a mirror is skipped.
 *
 * Each mirror is derived from the real mint, read from mainnet (read-only), and
 * reproduces its extension set as closely as `spl-token` can:
 *
 *   decimals                 9, as on the real mint
 *   scaled UI amount         the multiplier in force on the real mint now
 *   pausable                 present, unpaused
 *   transfer hook            the slot present, no program: how Ondo ships it
 *   default account state    initialized, which needs a freeze authority
 *   confidential transfers   manual approval, no auditor, as Ondo's
 *   metadata pointer         to the mint itself, with on-mint metadata
 *
 * What it cannot reproduce: Ondo's authorities. Every authority here is the
 * deploy key (Dqp6…), which is what lets a demo pause a mirror or step its
 * multiplier. The metadata names the token as a mirror and points at the real
 * mint, rather than copying Ondo's name and URI onto a token Ondo did not
 * issue. No permanent delegate, because the real mints have none.
 *
 * A mirror is a snapshot. A pause or a multiplier step on the real mint after
 * this runs is not copied; on devnet, Ondo's own status (`sensor/ondo.ts`) is
 * what still closes a paused name.
 *
 * After `--write`, commit src/mirrors.json and run scripts/register.ts on
 * devnet. Until register.ts has run, the keeper leaves the new names out of
 * its pushes rather than failing them (see `TickResult.unregistered`).
 *
 * Environment, all optional:
 *   BELL_MIRROR_TARGET   where to create them (default devnet). Never mainnet.
 *   BELL_MIRROR_SOURCE   where to read the real mints (default mainnet, read-only)
 *   BELL_PAYER_KEYPAIR   the deploy key file (default ~/.config/solana/id.json)
 *   BELL_DEPLOY_PUBKEY   the key it must be (default Dqp6…, the one the page names)
 *   SPL_TOKEN            the spl-token binary (default: spl-token on PATH)
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Connection, PublicKey, type ParsedAccountData } from '@solana/web3.js'
import { loadKeypair } from '../src/chain/keys.ts'
import { LISTINGS, type Listing } from '../src/listings.ts'

const TARGET = process.env.BELL_MIRROR_TARGET ?? 'https://api.devnet.solana.com'
const SOURCE = process.env.BELL_MIRROR_SOURCE ?? 'https://api.mainnet-beta.solana.com'
const KEYPAIR = process.env.BELL_PAYER_KEYPAIR ?? `${process.env.HOME}/.config/solana/id.json`
/** The key web/lib/bell.ts names as the devnet mirrors' authority. */
const DEPLOY_KEY = process.env.BELL_DEPLOY_PUBKEY ?? 'Dqp6DbUh6j5Jddff9VHPAK1UpByo85NhLVw83S58Ziqs'
const SPL_TOKEN = process.env.SPL_TOKEN ?? 'spl-token'
/** Resolved from this file, not the working directory, so a run from elsewhere cannot write a stray copy. */
const OUT = fileURLToPath(new URL('../src/mirrors.json', import.meta.url))
const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'

const MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'
const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG'

const WRITE = process.argv.includes('--write')
const CREATE = process.argv.includes('--create')
/** Sending anything takes a flag that says so; the default only prints. */
const PLAN = !WRITE && !CREATE

/** The extensions a mirror carries, by the names `jsonParsed` gives them. */
const MIRRORED = [
  'scaledUiAmountConfig',
  'metadataPointer',
  'pausableConfig',
  'defaultAccountState',
  'confidentialTransferMint',
  'transferHook',
  'tokenMetadata',
] as const

interface Ext {
  extension: string
  state?: Record<string, unknown>
}

interface RealMint {
  decimals: number
  /** As `jsonParsed` prints it, which round-trips to the exact f64 on the mint. */
  multiplier: string
  extensions: Map<string, Record<string, unknown>>
}

async function parsedMint(conn: Connection, address: string): Promise<RealMint | null> {
  const acc = await conn.getParsedAccountInfo(new PublicKey(address), 'confirmed')
  const v = acc.value
  if (!v) return null
  if (v.owner.toBase58() !== TOKEN_2022) throw new Error(`${address} is not a Token-2022 account`)
  const info = (v.data as ParsedAccountData).parsed?.info as { decimals: number; extensions?: Ext[] }
  const extensions = new Map((info.extensions ?? []).map((e) => [e.extension, e.state ?? {}]))
  const s = extensions.get('scaledUiAmountConfig')
  let multiplier = '1'
  if (s) {
    // The value in force now: `multiplier` stops being it once the step's
    // instant has passed, which is the trap the program's own parser avoids.
    const at = Number(s.newMultiplierEffectiveTimestamp ?? 0)
    multiplier = String(at !== 0 && Date.now() / 1000 >= at ? s.newMultiplier : s.multiplier)
  }
  return { decimals: info.decimals, multiplier, extensions }
}

/** Why this real mint cannot be mirrored faithfully, or null. */
function refusal(real: RealMint): string | null {
  const ext = real.extensions
  if (ext.get('pausableConfig')?.paused) return 'the real mint is paused; a mirror would start unpaused'
  if (ext.get('transferHook')?.programId) return 'the real mint has a transfer-hook program, which a mirror cannot run'
  if (ext.has('permanentDelegate')) return 'the real mint has a permanent delegate, which Ondo mints did not when this was written'
  if (ext.get('defaultAccountState')?.accountState !== 'initialized') return 'the real mint freezes new accounts by default'
  const missing = MIRRORED.filter((e) => !ext.has(e))
  if (missing.length) return `the real mint lacks ${missing.join(', ')}; re-check what Ondo ships before mirroring`
  const extra = [...ext.keys()].filter((e) => !(MIRRORED as readonly string[]).includes(e))
  if (extra.length) return `the real mint carries ${extra.join(', ')}, which this script does not reproduce`
  if (!(Number(real.multiplier) > 0)) return `unusable multiplier ${real.multiplier}`
  return null
}

function createArgs(real: RealMint): string[] {
  const ct = real.extensions.get('confidentialTransferMint')
  return [
    'create-token',
    '--program-2022',
    '--decimals',
    String(real.decimals),
    '--ui-amount-multiplier',
    real.multiplier,
    '--enable-pause',
    // The slot without a program: gate 6 notices if one is ever set.
    '--enable-transfer-hook',
    // DefaultAccountState needs a freeze authority; the real mints have one.
    '--enable-freeze',
    '--default-account-state',
    'initialized',
    '--enable-confidential-transfers',
    ct?.autoApproveNewAccounts ? 'auto' : 'manual',
    '--enable-metadata',
    '--mint-authority',
    DEPLOY_KEY,
    '--fee-payer',
    KEYPAIR,
  ]
}

function metadataArgs(l: Listing, mint: string): string[] {
  return [
    'initialize-metadata',
    mint,
    `${l.symbol} devnet mirror (BELL)`,
    l.symbol,
    `https://explorer.solana.com/address/${l.mainnetMint}`,
    '--program-2022',
    '--mint-authority',
    KEYPAIR,
    '--update-authority',
    DEPLOY_KEY,
    '--fee-payer',
    KEYPAIR,
  ]
}

const spl = (args: string[]): string =>
  execFileSync(SPL_TOKEN, [...args, '--url', TARGET, '--output', 'json'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })

/** Read the new mint back and check it carries what was asked for. */
async function verify(conn: Connection, mint: string, real: RealMint): Promise<string[]> {
  const got = await parsedMint(conn, mint)
  if (!got) return ['not found after creation']
  const wrong: string[] = []
  if (got.decimals !== real.decimals) wrong.push(`decimals ${got.decimals}`)
  if (Number(got.multiplier) !== Number(real.multiplier)) wrong.push(`multiplier ${got.multiplier}`)
  for (const e of MIRRORED) if (!got.extensions.has(e)) wrong.push(`no ${e}`)
  if (got.extensions.has('permanentDelegate')) wrong.push('a permanent delegate')
  if (got.extensions.get('transferHook')?.programId) wrong.push('a hook program')
  if (got.extensions.get('pausableConfig')?.paused) wrong.push('paused')
  return wrong
}

function readMirrors(): Record<string, string> {
  return JSON.parse(readFileSync(OUT, 'utf8')) as Record<string, string>
}

async function main() {
  // Refuse mainnet by name and by genesis hash, before anything else: this
  // script mints tokens, and a mirror of a security on mainnet is a token
  // impersonating it.
  if (/mainnet/i.test(TARGET)) throw new Error(`refusing: BELL_MIRROR_TARGET looks like mainnet (${TARGET})`)
  const target = new Connection(TARGET, 'confirmed')
  const genesis = await target.getGenesisHash()
  if (genesis === MAINNET_GENESIS) throw new Error(`refusing: ${TARGET} is mainnet-beta (genesis ${genesis})`)
  const isDevnet = genesis === DEVNET_GENESIS
  const where = isDevnet ? 'devnet' : `a non-devnet cluster (genesis ${genesis})`
  if (WRITE && CREATE) throw new Error('refusing: pass --write (devnet, recorded) or --create (local, unrecorded), not both')
  if (WRITE && !isDevnet) {
    throw new Error(`refusing --write: ${TARGET} is ${where}, and ${OUT} records devnet mirrors only`)
  }
  if (CREATE && isDevnet) {
    throw new Error('refusing --create on devnet: a devnet mirror is made with --write, so it is recorded as it is made')
  }

  const deployer = loadKeypair(KEYPAIR).publicKey.toBase58()
  if (deployer !== DEPLOY_KEY) {
    throw new Error(
      `refusing: ${KEYPAIR} is ${deployer}, not the deploy key ${DEPLOY_KEY}. ` +
        'Every authority on a mirror is the deploy key, and the page names it as such.',
    )
  }

  const ondo = LISTINGS.filter((l) => l.issuer === 'ondo')
  const existing = readMirrors()
  const todo = ondo.filter((l) => !existing[l.symbol])
  for (const l of ondo) if (existing[l.symbol]) console.log(`${l.symbol.padEnd(7)} already mirrored: ${existing[l.symbol]}; left alone`)
  if (todo.length === 0) return

  console.log(`${PLAN ? 'plan for' : 'creating on'} ${where}, every authority ${DEPLOY_KEY}\n`)
  const source = new Connection(SOURCE, 'confirmed')
  const made: Record<string, string> = {}

  for (const l of todo) {
    const real = await parsedMint(source, l.mainnetMint)
    if (!real) throw new Error(`${l.symbol}: ${l.mainnetMint} not found on ${SOURCE}`)
    const why = refusal(real)
    if (why) throw new Error(`${l.symbol}: not mirrored, ${why}`)

    if (PLAN) {
      console.log(`${l.symbol}  (mirrors ${l.mainnetMint}, multiplier ${real.multiplier})`)
      console.log(`  ${SPL_TOKEN} ${createArgs(real).join(' ')} --url ${TARGET}`)
      console.log(`  ${SPL_TOKEN} ${metadataArgs(l, '<MINT>').map((a) => (a.includes(' ') ? `'${a}'` : a)).join(' ')} --url ${TARGET}\n`)
      continue
    }

    const created = JSON.parse(spl(createArgs(real))) as { commandOutput: { address: string } }
    const mint = created.commandOutput.address
    // A mint that exists but failed a later step is never recorded as a
    // mirror, and never silently forgotten either: it is named on the way out.
    try {
      spl(metadataArgs(l, mint))
      const wrong = await verify(target, mint, real)
      if (wrong.length) throw new Error(`came out with ${wrong.join(', ')}`)
    } catch (e) {
      const recorded = Object.entries(made).map(([s, m]) => `${s} ${m}`).join(', ') || 'none'
      throw new Error(`${l.symbol}: mirror ${mint} is on ${where} but unfinished (${(e as Error).message}). Mirrors finished before it: ${recorded}`)
    }
    made[l.symbol] = mint

    // One file write per mint, so a failure part-way still records what exists.
    if (WRITE) {
      const current = readMirrors()
      if (!current[l.symbol]) writeFileSync(OUT, `${JSON.stringify({ ...current, [l.symbol]: mint }, null, 2)}\n`)
    }
    console.log(
      `${l.symbol.padEnd(7)} ${mint}\n` +
        `        decimals=${real.decimals} multiplier=${real.multiplier} pausable hook=slot-only ` +
        `defaultState=initialized confidential=manual metadata=on-mint permanentDelegate=no` +
        `  (mirrors ${l.mainnetMint})`,
    )
  }

  if (PLAN) return
  if (WRITE) console.log(`\nadded ${Object.keys(made).length} to ${OUT}. Commit it, then run scripts/register.ts on devnet.`)
  else console.log(`\nnot recorded (--create, ${where}):\n${JSON.stringify(made, null, 2)}`)
}

main().catch((e) => {
  console.error((e as Error).message)
  process.exit(1)
})
