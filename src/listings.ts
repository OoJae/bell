/**
 * The allowlist.
 *
 * **Pinned by mint address, never by ticker.** There is a pump.fun token
 * calling itself `JPMx` with more on-chain liquidity than the real JPMorgan
 * xStock. A symbol-keyed allowlist would route users straight into it, so a
 * symbol here is a label for humans and the address is the identity.
 */

/** Which issuer minted the token, and therefore what the holder actually owns. */
export type Issuer =
  /** Backed: a Swiss tracker certificate. Synthetic exposure to the underlying. */
  | 'backed'
  /** Backpack Securities: a UCC Article 8 entitlement to the real share. */
  | 'backpack'

export interface Listing {
  /** Display label. Not an identifier. */
  symbol: string
  /**
   * The identifier **on the cluster we are pointed at**.
   *
   * Use this for anything on chain: PDA seeds, account reads, instruction
   * accounts. On mainnet and on localnet (which clones mainnet accounts) it is
   * the real address. On devnet it is a mirror we created, because none of
   * these securities exist there.
   */
  mint: string
  /**
   * The real mainnet address, always.
   *
   * Use this for anything describing the *real world*: the issuer's API, a
   * Jupiter quote, token metadata. Those services only know mainnet, and a
   * price is a fact about the security rather than about our cluster.
   *
   * The two fields exist so that every call site has to say which it means.
   * Collapsing them into one is how a devnet deployment ends up quoting a
   * mint that does not exist, or attesting to the wrong account, and neither
   * failure announces itself.
   */
  mainnetMint: string
  /** Underlying ticker — the join key against Pyth's `Equity.US.<TICKER>/USD`. */
  underlying: string
  /** MIC of the primary listing exchange; the venue §II.H measures against. */
  exchangeMic: string
  issuer: Issuer
  /** Why this one is on the list, so nobody has to guess later. */
  note: string
  /**
   * The issuer has stopped trading its own token. Not an exchange halt: the
   * underlying trades normally. Used to label the refusal truthfully and to
   * stop the page queueing an order that would wait on the issuer, not a bell.
   * The chain still decides — this only changes the words.
   */
  withdrawn?: boolean
  /**
   * Widest price disagreement, in bps, an order in this name will accept at
   * fill time. The keeper attests the spread it sees between sources; a thin
   * name routinely shows more than a deep one, and a cap tighter than its
   * normal spread silently refuses half its fills as MarkTooWide. Default 50;
   * the program's ceiling is 200.
   */
  maxConfBps?: number
}

const REAL: readonly Omit<Listing, 'mainnetMint'>[] = [
  // Deep enough that "the market is shut and it will still fill you" is a
  // claim about real money rather than a technicality.
  {
    symbol: 'SPYx',
    mint: 'XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W',
    underlying: 'SPY',
    exchangeMic: 'ARCX',
    issuer: 'backed',
    note: 'deepest pool on Solana, ~$8.5M — carries the session-gate demo',
  },
  {
    symbol: 'NVDAx',
    mint: 'Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh',
    underlying: 'NVDA',
    exchangeMic: 'XNAS',
    issuer: 'backed',
    note: 'most-held tokenized equity on Solana',
  },
  {
    symbol: 'QQQx',
    mint: 'Xs8S1uUs1zvS2p7iwtsG3b6fkhpvmwz4GYU3gWAmWHZ',
    underlying: 'QQQ',
    exchangeMic: 'XNAS',
    issuer: 'backed',
    note: 'index exposure, liquid',
  },
  {
    symbol: 'TSLAx',
    mint: 'XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB',
    underlying: 'TSLA',
    exchangeMic: 'XNAS',
    issuer: 'backed',
    note: 'liquid single name',
  },
  {
    symbol: 'AAPLx',
    mint: 'XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp',
    underlying: 'AAPL',
    exchangeMic: 'XNAS',
    issuer: 'backed',
    note: 'carries a live scaledUiAmount multiplier — exercises the rebase gate',
  },

  // Withdrawn by their issuer while the underlying trades normally — the two
  // conflicts in 928 listings. Not the §II.H case: IWM and JPST were never
  // halted on Arca (checked against Nasdaq's UTP feed, which carries Arca
  // halts). They stay on the board because refusing them *truthfully* — as a
  // withdrawal, not an exchange halt — is part of what the gate is for.
  {
    symbol: 'IWMx',
    mint: 'XsbELVbLGBkn7xfMfyYuUipKGt1iRUc2B7pYRvFTFu3',
    underlying: 'IWM',
    exchangeMic: 'ARCX',
    issuer: 'backed',
    note: 'Backed has withdrawn its wrapper; IWM itself is not halted. BELL refuses it as an issuer withdrawal, not an exchange halt',
    withdrawn: true,
  },
  {
    symbol: 'JPSTx',
    mint: 'XsCAXu7xTaZMG9b9KJhNWYapuvNjxPuE4SysZq8uvMq',
    underlying: 'JPST',
    exchangeMic: 'ARCX',
    issuer: 'backed',
    note: 'Backed has withdrawn its wrapper; JPST itself is not halted. MarketHours-only, the other conflict',
    withdrawn: true,
  },

  // Rights-bearing contrast. Same gates, a different legal instrument: the SEC
  // order of 2026-09-17 excludes synthetic wrappers from "Tokenized NMS Stock"
  // but not an entitlement to the real share. Also proves the guard is
  // issuer-agnostic rather than hard-wired to Backed.
  {
    symbol: 'PFE',
    mint: 'PFER6ENqP8r8NF3CqVt4mFowxsin3V5MLidBNQFCC3x',
    underlying: 'PFE',
    exchangeMic: 'XNYS',
    issuer: 'backpack',
    note: 'tradeable here at 0.58% while the Backed wrapper has no route at all',
    // Its attested spread exceeded 50bps in 17 of 31 samples.
    maxConfBps: 100,
  },
  {
    symbol: 'LMT',
    mint: 'LMT3i1BHgixFqPUgcyteJhnEz2dpy9i3cYy4pi9BoeV',
    underlying: 'LMT',
    exchangeMic: 'XNYS',
    issuer: 'backpack',
    note: 'second rights-bearing name',
    maxConfBps: 100,
  },
] as const

/**
 * The real mainnet allowlist. Pure data, no cluster resolution, never throws.
 *
 * Separate from `config.ts` on purpose. `config.ts` refuses to resolve a devnet
 * mint it has no mirror for, which is right — but `mirror-mints.ts` is the
 * script that *produces* those mirrors, so it cannot be made to require them.
 * Splitting the data from the resolution is what lets the resolution be strict.
 */
export const MAINNET_LISTINGS: readonly Listing[] = REAL.map((l) => ({
  ...l,
  mainnetMint: l.mint,
}))

/** Ticker padded into the fixed-width form the program uses as a PDA seed. */
export const SYMBOL_LEN = 12
export function symbolSeed(symbol: string): Uint8Array {
  if (symbol.length > SYMBOL_LEN) throw new Error(`symbol too long: ${symbol}`)
  const out = new Uint8Array(SYMBOL_LEN).fill(0x20) // space-padded
  out.set(new TextEncoder().encode(symbol))
  return out
}
