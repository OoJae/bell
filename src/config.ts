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
  /** The identifier. */
  mint: string
  /** Underlying ticker — the join key against Pyth's `Equity.US.<TICKER>/USD`. */
  underlying: string
  /** MIC of the primary listing exchange; the venue §II.H measures against. */
  exchangeMic: string
  issuer: Issuer
  /** Why this one is on the list, so nobody has to guess later. */
  note: string
}

export const ALLOWLIST: readonly Listing[] = [
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

  // Halted on NYSE Arca during the regular session. The §II.H case, live.
  {
    symbol: 'IWMx',
    mint: 'XsbELVbLGBkn7xfMfyYuUipKGt1iRUc2B7pYRvFTFu3',
    underlying: 'IWM',
    exchangeMic: 'ARCX',
    issuer: 'backed',
    note: 'halted on its primary exchange: one of only two conflicts in 928 listings',
  },
  {
    symbol: 'JPSTx',
    mint: 'XsCAXu7xTaZMG9b9KJhNWYapuvNjxPuE4SysZq8uvMq',
    underlying: 'JPST',
    exchangeMic: 'ARCX',
    issuer: 'backed',
    note: 'halted, and MarketHours-only — the other conflict',
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
  },
  {
    symbol: 'LMT',
    mint: 'LMT3i1BHgixFqPUgcyteJhnEz2dpy9i3cYy4pi9BoeV',
    underlying: 'LMT',
    exchangeMic: 'XNYS',
    issuer: 'backpack',
    note: 'second rights-bearing name',
  },
] as const

export const byMint = new Map(ALLOWLIST.map((l) => [l.mint, l]))
export const bySymbol = new Map(ALLOWLIST.map((l) => [l.symbol, l]))

/** Ticker padded into the fixed-width form the program uses as a PDA seed. */
export const SYMBOL_LEN = 12
export function symbolSeed(symbol: string): Uint8Array {
  if (symbol.length > SYMBOL_LEN) throw new Error(`symbol too long: ${symbol}`)
  const out = new Uint8Array(SYMBOL_LEN).fill(0x20) // space-padded
  out.set(new TextEncoder().encode(symbol))
  return out
}
