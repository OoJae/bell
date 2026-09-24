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
    /// The only key permitted to set `rebase_kind`.
    ///
    /// Everything else in this account is *proven* from the mint, which is why
    /// refreshing is permissionless. `rebase_kind` is the single exception —
    /// split versus dividend cannot be read from the extension data, so it is
    /// attested. An attested field inside an otherwise-permissionless, shared
    /// account needs an authority of its own, or the weakest symbol referencing
    /// this mint becomes the authority for every symbol referencing it.
    pub attestor: Pubkey,
    pub bump: u8,
}

/// Where a price mark came from.
///
/// Recorded on the mark and echoed in the fill event, because the provenance of
/// a price is part of the evidence: Backpack's free tickers cover 21 markets,
/// and everything else falls back to an on-chain pool price, which is only
/// defensible once the market is open and the pool has been arbitraged.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum MarkSource {
    Backpack,
    Jupiter,
    Pyth,
    XStocksNav,
}

/// An attested price for one symbol.
///
/// Deliberately a separate account from `SymbolState`, for three reasons: it
/// leaves the session layout untouched, it gives the price its own freshness
/// clock (a mark goes stale in a minute, a session does not), and it keeps the
/// two trusted inputs separately auditable.
///
/// **This is the one place the queue adds trust the gate does not have.** The
/// gate can only refuse, so a broken attestor fails closed. A mark sets a
/// price, so a broken attestor fails *open*. Bounded by the order's own floor,
/// by `Mode::Strict` (a wrong mark is arbitrageable against a live market we do
/// not control), and by `MAX_MARK_AGE_SECONDS`. Also bounded by how fast a push
/// may move it (`MAX_MARK_STEP_BPS`) and, at every fill, by the band around a
/// second signer's reference (`SymbolCheck`).
#[account]
#[derive(InitSpace)]
pub struct SymbolMark {
    pub symbol: [u8; SYMBOL_LEN],
    /// Must equal `SymbolState.mint`; pinned at `open_mark`.
    pub mint: Pubkey,
    /// The denomination `rate_q64` is expressed in.
    pub quote_mint: Pubkey,
    /// **The binding value.** Stock raw units per quote raw unit, Q64.64, with
    /// the scaled-UI multiplier already folded in by the attestor.
    ///
    /// Raw-per-raw rather than a human price because it is the only form that
    /// needs no decimals arithmetic on-chain — and the decimals genuinely
    /// differ: SPYx is 8, Backpack's PFE is 6.
    pub rate_q64: u128,
    /// Descriptive only, never read by a check: `px_num * 10^px_expo` USD per
    /// share, so a human or an explorer can audit what the rate meant.
    pub px_num: u64,
    pub px_expo: i32,
    /// The attestor's own uncertainty about this mark.
    ///
    /// `u16::MAX` means the mark is held: its last push stepped too far and
    /// was not written. The attestor can never push that value itself, since a
    /// push is capped at `MAX_CONF_BPS`, so the marker needs no field of its
    /// own and the account's layout is unchanged.
    pub conf_bps: u16,
    pub source: MarkSource,
    pub observed_at: i64,
    pub bump: u8,
}

/// Emitted when a push moves the mark further than one step allows and the
/// mark is held instead of written. Carries both rates and both times, so an
/// operator can tell a genuine gap from a faulty attestor.
#[event]
pub struct MarkTripped {
    pub symbol: [u8; SYMBOL_LEN],
    pub held_rate_q64: u128,
    pub pushed_rate_q64: u128,
    pub held_observed_at: i64,
    pub pushed_observed_at: i64,
}

/// A second signer's view of one symbol: is the market open, and what did the
/// stock last trade at.
///
/// The mark is signed by the attestor alone, so on its own one key can price a
/// fill. The check is signed by a different key, drawing on different data,
/// and every fill requires the two to agree: on whether the market is open,
/// and on a price within a band of this reference. Neither signer alone can
/// then move value. The checker is named by the program's upgrade authority,
/// not by the attestor, so compromising the attestor does not also choose who
/// checks it.
#[account]
#[derive(InitSpace)]
pub struct SymbolCheck {
    pub symbol: [u8; SYMBOL_LEN],
    /// Copied from `SymbolState` at `open_check`, and required to equal the
    /// order's mint at every fill.
    pub mint: Pubkey,
    /// The only key permitted to push this check.
    pub checker: Pubkey,
    /// The checker's own view of whether the primary market is open now.
    pub open_now: bool,
    /// Stock raw per quote raw, Q64.64, with the scaled-UI multiplier folded
    /// in: the same convention as `SymbolMark.rate_q64`, so the two compare
    /// directly.
    pub ref_rate_q64: u128,
    /// Descriptive only, as on the mark.
    pub ref_px_num: u64,
    pub ref_px_expo: i32,
    /// When the sale behind the reference happened. At night this is the
    /// close, and its age is bounded separately from the push's.
    pub ref_at: i64,
    /// When this check was pushed. Zero until the first push, which every
    /// freshness test reads as stale.
    pub observed_at: i64,
    pub bump: u8,
    pub _reserved: [u8; 32],
}

/// An owner's standing consent to fills while the primary market is shut.
///
/// Its existence is the whole of its meaning: a fill reads only whether it is
/// there, and whose it is. Only `opt_in_night` can create one, and it records
/// the signer as `owner`, so a fill that finds its own discriminator on an
/// account this program owns, naming the order's owner, has found that owner's
/// consent and no one else's. It applies to every order the owner has,
/// including those already placed.
#[account]
#[derive(InitSpace)]
pub struct NightOptIn {
    pub owner: Pubkey,
    pub created_at: i64,
    pub bump: u8,
    pub _reserved: [u8; 16],
}

/// A standing intent to buy at the next open.
///
/// The user's funds are **not** held here. They stay in the user's own token
/// account under an SPL delegation, which means cancelling is
/// `spl_token::revoke` from their wallet — an instruction this program has no
/// part in, and which works even if this program is frozen and every server we
/// run is down. If no filler ever comes, nothing happened at all.
#[account]
#[derive(InitSpace)]
pub struct BellOrder {
    pub owner: Pubkey,
    pub symbol: [u8; SYMBOL_LEN],
    /// Stock mint, copied from `SymbolState` at placement.
    pub mint: Pubkey,
    /// Pinned at placement so a later mark change cannot retarget the order.
    pub quote_mint: Pubkey,
    /// The user's quote account, which carries the delegation.
    pub payer_in: Pubkey,
    /// Where the stock is delivered. Pinned rather than derived on-chain.
    pub payee_out: Pubkey,
    pub amount_in: u64,
    pub filled_in: u64,
    /// Smallest acceptable partial fill; equal to `amount_in` means all-or-none.
    /// Prevents dust fills leaving an order that can never close.
    pub min_fill_in: u64,
    /// Snapshotted at placement. A rebase between placing and filling
    /// invalidates the order rather than silently resizing it.
    pub expected_multiplier_bits: u64,
    /// The spread the user pays the filler. Every fill lands at the band edge,
    /// so this is a maximum cost, not a tolerance.
    pub max_slip_bps: u16,
    pub max_conf_bps: u16,
    /// The user's own worst acceptable price, out-raw per in-raw, Q64.64.
    /// Zero means none — a pure market-on-open order.
    pub floor_rate_q64: u128,
    pub not_before: i64,
    pub expires_at: i64,
    pub nonce: u64,
    pub created_at: i64,
    pub bump: u8,
    /// Bump for the per-owner delegate authority PDA.
    pub auth_bump: u8,
}

/// Emitted on every fill. Carries the mark that priced it, so a fill can be
/// audited against the price and source that justified it.
#[event]
pub struct OrderFilled {
    pub symbol: [u8; SYMBOL_LEN],
    pub owner: Pubkey,
    pub filler: Pubkey,
    pub amount_in: u64,
    pub amount_out: u64,
    pub px_num: u64,
    pub px_expo: i32,
    pub source: MarkSource,
    pub mark_observed_at: i64,
    /// Realised cost against the mark, in basis points.
    pub realized_bps: u16,
}

/// A standing intent to sell at the next open: the mirror image of `BellOrder`.
///
/// A separate account type rather than a direction flag on `BellOrder`, so that
/// nothing about the buy side's layout, discriminator or handlers changes, and
/// so that `fill_order` handed a sell order refuses it on the discriminator
/// before any of its own checks run. The fields are the same, in the same
/// order, with the two legs swapped: the user now pays in stock and is paid in
/// quote. As with a buy, the stock never leaves the user's wallet until a fill
/// pays for it, and the cancel is `spl_token::revoke` on the stock account.
#[account]
#[derive(InitSpace)]
pub struct SellOrder {
    pub owner: Pubkey,
    pub symbol: [u8; SYMBOL_LEN],
    /// Stock mint, copied from `SymbolState` at placement.
    pub mint: Pubkey,
    /// Pinned at placement so a later mark change cannot retarget the order.
    pub quote_mint: Pubkey,
    /// The user's stock account, which carries the delegation.
    pub payer_in: Pubkey,
    /// Where the quote is delivered. Pinned rather than derived on-chain.
    pub payee_out: Pubkey,
    /// In stock raw units. Bounded at placement by its quote value, not by its
    /// raw size, because `MAX_ORDER_IN` is a quote amount.
    pub amount_in: u64,
    pub filled_in: u64,
    /// Smallest acceptable partial fill, in stock raw units; equal to
    /// `amount_in` means all-or-none.
    pub min_fill_in: u64,
    /// Snapshotted at placement. A rebase between placing and filling
    /// invalidates the order rather than silently resizing it.
    pub expected_multiplier_bits: u64,
    /// The spread the user pays the filler. Every fill lands at the band edge,
    /// so this is a maximum cost, not a tolerance.
    pub max_slip_bps: u16,
    pub max_conf_bps: u16,
    /// The user's own worst acceptable price, quote raw per stock raw, Q64.64.
    /// Zero means none — a pure market-on-open order.
    pub floor_rate_q64: u128,
    pub not_before: i64,
    pub expires_at: i64,
    pub nonce: u64,
    pub created_at: i64,
    pub bump: u8,
    /// Bump for the per-owner delegate authority PDA, the same one a buy uses.
    pub auth_bump: u8,
}

/// Emitted on every sell fill, with the same fields as `OrderFilled` so a
/// reader decodes both with one layout and tells them apart by discriminator.
/// `amount_in` is the stock taken and `amount_out` the quote delivered.
#[event]
pub struct SellOrderFilled {
    pub symbol: [u8; SYMBOL_LEN],
    pub owner: Pubkey,
    pub filler: Pubkey,
    pub amount_in: u64,
    pub amount_out: u64,
    pub px_num: u64,
    pub px_expo: i32,
    pub source: MarkSource,
    pub mark_observed_at: i64,
    /// Realised cost against the mark, in basis points.
    pub realized_bps: u16,
}

/// Emitted once per cross, with both legs, so one event records the whole
/// trade. `quote` is what the buyer paid and the seller was paid; `stock` is
/// what the seller sold and the buyer bought. These are the amounts each
/// order is charged against its remainder; what landed was measured to at
/// least each side's minimum before this was emitted. The mark is echoed as
/// on a fill, since it is the price both legs were settled at.
#[event]
pub struct OrdersCrossed {
    pub symbol: [u8; SYMBOL_LEN],
    pub buyer: Pubkey,
    pub seller: Pubkey,
    pub quote: u64,
    pub stock: u64,
    pub px_num: u64,
    pub px_expo: i32,
    pub source: MarkSource,
    pub mark_observed_at: i64,
}
