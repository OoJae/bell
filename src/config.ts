/**
 * Cluster resolution for the allowlist.
 *
 * The addresses themselves live in `listings.ts`. This file decides which of
 * them apply to the cluster we are pointed at, and refuses rather than guesses.
 */
import mirrors from './mirrors.json' with { type: 'json' }
import { MAINNET_LISTINGS, type Listing } from './listings.ts'

export { MAINNET_LISTINGS, SYMBOL_LEN, symbolSeed, type Issuer, type Listing } from './listings.ts'

/**
 * Devnet stand-ins for the real mints.
 *
 * `scripts/mirror-mints.ts` **reads each real mainnet mint** and reproduces its
 * decimals and extension configuration — scaled-UI multiplier, pausable config,
 * permanent delegate, transfer-hook slot — so the parser meets the same shape it
 * meets on mainnet.
 *
 * It is a mirror, not the thing, and that is said here rather than hidden
 * behind an environment variable. The program tests parse real mainnet mint
 * bytes and `scripts/localnet.sh` clones the real accounts; only a devnet
 * deployment uses these.
 *
 * The generated file is **committed**: it is the devnet deployment record, and
 * `Dockerfile.keeper` copies `src/` into the image, so a hosted keeper would
 * otherwise boot with no mapping at all.
 */

const MIRRORS: Record<string, string> = mirrors

export const CLUSTER =
  process.env.NEXT_PUBLIC_BELL_CLUSTER ?? process.env.BELL_CLUSTER ?? 'mainnet'

/**
 * The allowlist, resolved for the cluster we are pointed at.
 *
 * Substitution happens once, here. A mint address resolved differently in two
 * places is exactly the bug the pinned-by-address rule exists to prevent.
 *
 * A missing devnet mirror is **fatal, never a fallback.** Quietly returning the
 * mainnet address instead would be the worst outcome available: `register_symbol`
 * accepts any pubkey without touching the mint account, so it would succeed and
 * weld a symbol permanently to an address that cannot exist on this cluster —
 * and there is no close instruction anywhere in the program to undo it. The
 * same silence would leave a hosted keeper pushing sessions happily while no
 * order could ever fill. Failing at import is the cheapest possible moment.
 */
function mintFor(l: Listing): string {
  if (CLUSTER !== 'devnet') return l.mainnetMint
  const mirror = MIRRORS[l.symbol]
  if (!mirror) {
    throw new Error(
      `BELL_CLUSTER=devnet but no mirror mint for ${l.symbol} in src/mirrors.json. ` +
        `Run scripts/mirror-mints.ts before anything that writes on-chain state — ` +
        `registering a symbol against a mainnet address on devnet is permanent.`,
    )
  }
  return mirror
}

export const ALLOWLIST: readonly Listing[] = MAINNET_LISTINGS.map((l) => ({
  ...l,
  mint: mintFor(l),
}))

export const byMint = new Map(ALLOWLIST.map((l) => [l.mint, l]))
export const bySymbol = new Map(ALLOWLIST.map((l) => [l.symbol, l]))
/** Look up by the real address, which is what the issuer feeds are keyed on. */
export const byMainnetMint = new Map(ALLOWLIST.map((l) => [l.mainnetMint, l]))
