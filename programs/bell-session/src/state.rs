use anchor_lang::prelude::*;

use crate::constants::SYMBOL_LEN;

/// Which sessions an asset trades in. The universe is not uniform — all three
/// occur across the ~928 listings, so "is it tradeable now" is per-symbol.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum HoursMode {
    /// Trades around the clock on weekdays.
    TwentyFourFive,
    /// Regular session only.
    MarketHours,
    /// Regular session plus pre/post.
    Regular,
}

/// Why trading stopped. Distinguished because a volatility pause resumes on a
/// published schedule while a suspension does not.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum HaltState {
    None,
    /// Limit Up-Limit Down volatility pause.
    Luld,
    NewsPending,
    /// Market-wide circuit breaker.
    MarketWide,
    Suspension,
    /// Halted, kind unknown.
    ///
    /// The issuer feed exposes only a boolean, so most halts arrive without a
    /// reason code. Recording them as `Suspension` would assert something
    /// stronger than we know — a suspension implies no scheduled resume, while
    /// a volatility pause resumes in minutes. Appended last so the existing
    /// variants keep their encodings.
    Unspecified,
}

/// Off-chain market facts for one security.
///
/// This is the only part of the system that requires trust, so it is kept as
/// small as possible and every consumer treats a stale record as a halt.
#[account]
#[derive(InitSpace)]
pub struct SymbolState {
    /// Ticker of the tokenized security, space-padded.
    pub symbol: [u8; SYMBOL_LEN],
    /// The Token-2022 mint this symbol refers to. Pinned by address, never by
    /// ticker: look-alike mints of major tickers exist on Solana today.
    pub mint: Pubkey,
    /// MIC of the primary listing exchange, e.g. "XNAS". This is the venue that
    /// SEC Order 34-106402 II.H requires us to stop concurrently with.
    pub exchange_mic: [u8; 4],
    pub hours_mode: HoursMode,
    pub halt: HaltState,
    /// Issuer reports the primary market is open for this asset right now.
    pub open_now: bool,
    /// Unix seconds at which the session state next changes.
    pub next_change_at: i64,
    /// When this record was attested. Staleness is failure, not a warning.
    pub observed_at: i64,
    /// The only key permitted to push session state.
    pub attestor: Pubkey,
    pub bump: u8,
}

/// Which kind of corporate action a pending multiplier change represents.
///
/// A split leaves value-per-raw-unit invariant, so pools are unaffected. A
/// dividend steps value-per-raw-unit up at a known instant, leaving every pool
/// stale-low and drained in the first block after activation. The multiplier
/// alone cannot tell them apart, so `Unknown` is never tradeable.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum RebaseKind {
    None,
    Split,
    Dividend,
    Unknown,
}

/// Issuer powers and pending re-denominations, read directly from the mint.
///
/// Nothing here is attested: every field is deserialized from the Token-2022
/// extension data on-chain, so it cannot be misreported.
#[account]
#[derive(InitSpace)]
pub struct TokenRisk {
    pub mint: Pubkey,
    /// Token-2022 `PausableConfig` — the issuer can freeze all transfers.
    pub paused: bool,
    /// `ScaledUiAmountConfig.multiplier`, stored as raw bits.
    ///
    /// Held as bits rather than a float on purpose: the guard only ever tests
    /// it for equality against the value an order was built with, and exact
    /// comparison is the whole point. No arithmetic is done on it on-chain.
    pub multiplier_bits: u64,
    pub pending_multiplier_bits: u64,
    /// Unix seconds at which the pending multiplier takes effect; 0 if none.
    pub activates_at: i64,
    pub rebase_kind: RebaseKind,
    /// Transfer-hook program. `None` means the slot is armed but empty, which
    /// is how these mints ship today — arming it changes settlement semantics.
    pub hook: Option<Pubkey>,
    /// The issuer can seize tokens from any wallet. Recorded so that downstream
    /// protocols can price the risk instead of discovering it.
    pub permanent_delegate: Option<Pubkey>,
    /// When the mint was last read. Anyone may refresh this, permissionlessly.
    pub verified_at: i64,
    pub bump: u8,
}
