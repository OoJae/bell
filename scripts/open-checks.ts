/**
 * Open every registered symbol's check, naming its checker. Run by the
 * program's upgrade authority, once, after the upgrade that brought the checker.
 *
 *   node scripts/open-checks.ts <CHECKER_PUBKEY> --plan   # say what it would do, send nothing
 *   node scripts/open-checks.ts <CHECKER_PUBKEY>          # open each check that is missing
 *
 * The authority signs and pays the rent (about 0.002 SOL a check): the key at
 * BELL_AUTHORITY_KEYPAIR, by default the Solana CLI's ~/.config/solana/id.json,
 * which deployed the program. Nothing else can: `open_check` reads the upgrade
 * authority from the program's own ProgramData account, and refuses anyone
 * else as NotAuthority.
 *
 * Until a symbol's check is open, every fill of it on the upgraded program is
 * refused (AccountNotInitialized), and until the checker has pushed, refused as
 * CheckStale. So the order is the one check.rs gives: upgrade, this script,
 * start the checker (`BELL_CHECKER_ARM=1 node scripts/checker.ts`), then the
 * crank. There is no instruction to change a checker once named; only another
 * upgrade can. So the checker key given here is the one the venue lives with.
 *
 * Idempotent. A symbol already carrying a check is left alone and reported,
 * with the checker it names; one not registered here is skipped. Refuses before
 * any write when the checker is the symbol's attestor (the point is two keys,
 * and the program refuses it too), the upgrade authority itself (a deploy key
 * does not belong in a service that signs every minute), or the default key;
 * and when the key in hand is not the upgrade authority on chain.
 */
import { PublicKey } from '@solana/web3.js'
import {
  BPF_LOADER_UPGRADEABLE,
  checkPda,
  connect,
  errorName,
  ixOpenCheck,
  programDataPda,
  readBoard,
  send,
  simulate,
} from '../src/chain/client.ts'
import { PROGRAM_ID } from '../src/chain/codec.ts'
import { packInstructions, txBytes } from '../src/chain/keeper.ts'
import { loadKeypair } from '../src/chain/keys.ts'
import { ALLOWLIST, CLUSTER } from '../src/config.ts'

/**
 * The upgrade authority a ProgramData account names, or why it names none.
 * Read by bytes, as the program reads it: the variant tag 3 as a little-endian
 * u32, the deployment slot, then an optional authority whose tag is 1 when set.
 */
export function upgradeAuthorityOf(
  info: { owner: PublicKey; data: Uint8Array } | null,
): { authority: PublicKey } | { none: string } {
  if (!info) return { none: 'no ProgramData account: the program is not deployed upgradeable here' }
  if (!info.owner.equals(BPF_LOADER_UPGRADEABLE)) return { none: 'the ProgramData account is not the upgradeable loader’s' }
  const d = info.data
  if (d.length < 45 || d[0] !== 3 || d[1] !== 0 || d[2] !== 0 || d[3] !== 0) return { none: 'not a ProgramData account' }
  if (d[12] !== 1) return { none: 'the program is immutable: it has no upgrade authority, so no check can ever be opened' }
  return { authority: new PublicKey(d.subarray(13, 45)) }
}

/** What to do for one symbol. */
export type OpenStep =
  | { symbol: string; open: true }
  | { symbol: string; open: false; why: string; warn?: boolean }

/**
 * The plan, from the board as read: open a check where a registered symbol has
 * none; leave the rest, saying why. Throws, before anything is sent, when the
 * checker would be the attestor of any symbol it is about to be named for.
 */
export function planOpenChecks(
  listings: readonly { symbol: string }[],
  board: ReadonlyMap<string, { state: { attestor: PublicKey } | null; check: { checker: PublicKey } | null }>,
  checker: PublicKey,
): OpenStep[] {
  return listings.map((l): OpenStep => {
    const a = board.get(l.symbol)
    if (!a?.state) return { symbol: l.symbol, open: false, why: 'not registered on this cluster (scripts/register.ts first)' }
    if (a.check) {
      return a.check.checker.equals(checker)
        ? { symbol: l.symbol, open: false, why: 'already open, naming this checker' }
        : {
            symbol: l.symbol,
            open: false,
            warn: true,
            why: `already open, naming ${a.check.checker.toBase58()}, not the one given; no instruction changes it, only an upgrade`,
          }
    }
    if (a.state.attestor.equals(checker)) {
      throw new Error(`${checker.toBase58()} is ${l.symbol}'s attestor. The checker must be another key; the program refuses it too.`)
    }
    return { symbol: l.symbol, open: true }
  })
}

async function main() {
  const args = process.argv.slice(2)
  const planOnly = args.includes('--plan')
  const given = args.find((a) => !a.startsWith('--'))
  if (!given) throw new Error('usage: node scripts/open-checks.ts <CHECKER_PUBKEY> [--plan]')
  const checker = new PublicKey(given)
  if (checker.equals(PublicKey.default)) throw new Error('the default key cannot be a checker: nobody holds it, and its symbols would stay shut')

  const conn = connect()
  const authorityPath = process.env.BELL_AUTHORITY_KEYPAIR ?? `${process.env.HOME}/.config/solana/id.json`
  const authority = loadKeypair(authorityPath)
  if (checker.equals(authority.publicKey)) {
    throw new Error('the checker must be its own key, not the upgrade authority: the checker signs every minute from a hosted service')
  }

  console.log(`open-checks — ${CLUSTER} — ${planOnly ? 'PLAN, sends nothing' : 'SENDING'}`)
  console.log(`  program    ${PROGRAM_ID.toBase58()}`)
  console.log(`  authority  ${authority.publicKey.toBase58()} (signs and pays)`)
  console.log(`  checker    ${checker.toBase58()}`)

  // The key in hand must be the one the program will check, or every
  // open_check is NotAuthority: say so before anything is built.
  const pd = upgradeAuthorityOf(await conn.getAccountInfo(programDataPda()))
  if ('none' in pd) throw new Error(pd.none)
  if (!pd.authority.equals(authority.publicKey)) {
    throw new Error(`the upgrade authority on chain is ${pd.authority.toBase58()}, not this key (${authorityPath}). Set BELL_AUTHORITY_KEYPAIR.`)
  }
  console.log('  the upgrade authority on chain is this key')

  const { symbols } = await readBoard(conn, ALLOWLIST)
  const plan = planOpenChecks(ALLOWLIST, symbols, checker)
  for (const s of plan) {
    console.log(`  ${s.symbol.padEnd(7)} ${s.open ? `open_check -> ${checkPda(s.symbol).toBase58()}` : `${s.warn ? 'WARNING: ' : ''}${s.why}`}`)
  }
  const ixs = plan
    .filter((s) => s.open)
    .map((s) => ixOpenCheck({ payer: authority.publicKey, authority: authority.publicKey, symbol: s.symbol, checker }))
  if (ixs.length === 0) {
    console.log('nothing to open')
    return
  }

  // One simulation first, which is also how a program that predates the
  // checker is found out: it has no open_check (InstructionFallbackNotFound).
  const sim = await simulate(conn, [ixs[0]], authority.publicKey)
  if (sim.value.err) {
    const e = sim.value.err as { InstructionError?: [number, { Custom?: number }] }
    const code = e.InstructionError?.[1]?.Custom
    const name = code !== undefined ? errorName(code) : JSON.stringify(sim.value.err)
    const hint = name === 'InstructionFallbackNotFound' ? ': the deployed program has no open_check yet; upgrade it first' : ''
    throw new Error(`open_check refused in simulation: ${name}${hint}`)
  }

  const batches = packInstructions(ixs, authority.publicKey)
  console.log(`  ${ixs.length} check(s) in ${batches.length} transaction(s): ${batches.map((b) => txBytes(b, authority.publicKey)).join(' + ')} bytes`)
  const rent = await conn.getMinimumBalanceForRentExemption(162)
  console.log(`  rent ${(rent * ixs.length) / 1e9} SOL from the authority`)
  if (planOnly) {
    console.log('plan only: nothing sent')
    return
  }

  // A batch that lands opens its checks for good; a later one that fails
  // leaves the rest to a second run, which skips what is already open.
  for (const batch of batches) {
    const sig = await send(conn, batch, [authority])
    console.log(`  sent ${batch.length}  sig=${sig}`)
  }

  const after = (await readBoard(conn, ALLOWLIST)).symbols
  const wrong = plan.filter((s) => s.open && !after.get(s.symbol)?.check?.checker.equals(checker))
  if (wrong.length) throw new Error(`not open after sending: ${wrong.map((s) => s.symbol).join(', ')}`)
  console.log(`opened ${ixs.length} check(s), each naming ${checker.toBase58()}`)
  const balance = await conn.getBalance(checker)
  console.log(
    `the checker holds ${balance / 1e9} SOL; it pays about 0.00001 SOL a pass. ` +
      'Start it with BELL_CHECKER_ARM=1 and its key in BELL_KEY_CHECKER; until it pushes, fills refuse as CheckStale.',
  )
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(`open-checks: ${(e as Error).message}`)
    process.exit(1)
  })
}
