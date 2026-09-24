//! # bell-session
//!
//! The equity market state oracle behind BELL.
//!
//! Tokenized equities trade on Solana 24/7 against markets that do not. Nothing
//! on-chain currently knows which session a security is in, whether its primary
//! exchange has halted it, or that a scheduled rebase is about to re-denominate
//! every balance in every pool. This program makes those facts readable, and
//! `assert_tradeable` makes them enforceable by CPI.
//!
//! The design rule throughout: **prove what you can, attest only what you must.**
//! Issuer powers and pending rebases are deserialized from the Token-2022 mint
//! itself, so they cannot be misreported. Only sessions and halts — facts that
//! genuinely live off-chain — are attested, and a stale attestation is treated
//! as a halt rather than as permission.

pub mod constants;
pub mod error;
pub mod instructions;
pub mod state;
pub mod tokens;

use anchor_lang::prelude::*;

pub use constants::*;
pub use instructions::*;
pub use state::*;

declare_id!("56AUPR1c1Tq5AgMvAa3PASax61YYo1KTdocwW6pR7Pdx");

#[program]
pub mod bell_session {
    use super::*;

    /// Bind a ticker to a specific mint. Pinned by address, never by symbol.
    pub fn register_symbol(
        ctx: Context<RegisterSymbol>,
        symbol: [u8; SYMBOL_LEN],
        mint: Pubkey,
        exchange_mic: [u8; 4],
        hours_mode: HoursMode,
        attestor: Pubkey,
    ) -> Result<()> {
        instructions::register_symbol::handle_register_symbol(
            ctx, symbol, mint, exchange_mic, hours_mode, attestor,
        )
    }

    /// Attest session and halt state for a symbol. The only trusted input.
    pub fn push_session(
        ctx: Context<PushSession>,
        symbol: [u8; SYMBOL_LEN],
        halt: HaltState,
        open_now: bool,
        next_change_at: i64,
        observed_at: i64,
    ) -> Result<()> {
        instructions::push_session::handle_push_session(
            ctx, symbol, halt, open_now, next_change_at, observed_at,
        )
    }

    /// Create the risk record for a mint, read from the mint. Permissionless.
    pub fn init_token_risk(ctx: Context<InitTokenRisk>, attestor: Pubkey) -> Result<()> {
        instructions::verify_token_risk::handle_init_token_risk(ctx, attestor)
    }

    /// Re-read issuer powers and pending rebases from the mint. Permissionless.
    pub fn refresh_token_risk(ctx: Context<RefreshTokenRisk>) -> Result<()> {
        instructions::verify_token_risk::handle_refresh_token_risk(ctx)
    }

    /// Record whether a pending multiplier change is a split or a dividend.
    pub fn classify_rebase(ctx: Context<ClassifyRebase>, kind: RebaseKind) -> Result<()> {
        instructions::classify_rebase::handle_classify_rebase(ctx, kind)
    }

    /// Create the price mark for a symbol.
    pub fn open_mark(
        ctx: Context<OpenMark>,
        symbol: [u8; SYMBOL_LEN],
        quote_mint: Pubkey,
    ) -> Result<()> {
        instructions::mark::handle_open_mark(ctx, symbol, quote_mint)
    }

    /// Attest a price. The one input that can move value rather than only stop it.
    #[allow(clippy::too_many_arguments)]
    pub fn push_mark(
        ctx: Context<PushMark>,
        symbol: [u8; SYMBOL_LEN],
        rate_q64: u128,
        px_num: u64,
        px_expo: i32,
        conf_bps: u16,
        source: MarkSource,
        observed_at: i64,
    ) -> Result<()> {
        instructions::mark::handle_push_mark(
            ctx, symbol, rate_q64, px_num, px_expo, conf_bps, source, observed_at,
        )
    }

    /// Park an intent to buy at the next open. Funds stay in the user's wallet.
    #[allow(clippy::too_many_arguments)]
    pub fn place_order(
        ctx: Context<PlaceOrder>,
        symbol: [u8; SYMBOL_LEN],
        nonce: u64,
        amount_in: u64,
        min_fill_in: u64,
        max_slip_bps: u16,
        max_conf_bps: u16,
        floor_rate_q64: u128,
        not_before: i64,
        expires_at: i64,
    ) -> Result<()> {
        instructions::queue::handle_place_order(
            ctx, symbol, nonce, amount_in, min_fill_in, max_slip_bps, max_conf_bps,
            floor_rate_q64, not_before, expires_at,
        )
    }

    /// Reclaim an order's rent. The real cancel is `spl_token::revoke`.
    pub fn cancel_order(ctx: Context<CancelOrder>) -> Result<()> {
        instructions::queue::handle_cancel_order(ctx)
    }

    /// Settle a due order. Permissionless; runs the same gate.
    pub fn fill_order(ctx: Context<FillOrder>, amount_in_leg: u64, amount_out: u64) -> Result<()> {
        instructions::fill::handle_fill_order(ctx, amount_in_leg, amount_out)
    }

    /// The gate. Succeeds silently, or fails with a machine-readable reason.
    pub fn assert_tradeable(
        ctx: Context<AssertTradeable>,
        symbol: [u8; SYMBOL_LEN],
        mode: Mode,
        expected_multiplier_bits: u64,
    ) -> Result<()> {
        instructions::assert_tradeable::handle_assert_tradeable(
            ctx, symbol, mode, expected_multiplier_bits,
        )
    }

    /// Park an intent to sell at the next open. The stock stays in the user's wallet.
    #[allow(clippy::too_many_arguments)]
    pub fn place_sell_order(
        ctx: Context<PlaceSellOrder>,
        symbol: [u8; SYMBOL_LEN],
        nonce: u64,
        amount_in: u64,
        min_fill_in: u64,
        max_slip_bps: u16,
        max_conf_bps: u16,
        floor_rate_q64: u128,
        not_before: i64,
        expires_at: i64,
    ) -> Result<()> {
        instructions::sell::handle_place_sell_order(
            ctx, symbol, nonce, amount_in, min_fill_in, max_slip_bps, max_conf_bps,
            floor_rate_q64, not_before, expires_at,
        )
    }

    /// Settle a due sell order: quote delivered first, then stock taken.
    pub fn fill_sell_order(
        ctx: Context<FillSellOrder>,
        amount_in_leg: u64,
        amount_out: u64,
    ) -> Result<()> {
        instructions::sell::handle_fill_sell_order(ctx, amount_in_leg, amount_out)
    }

    /// Reclaim a sell order's rent. The real cancel is `spl_token::revoke`.
    pub fn cancel_sell_order(ctx: Context<CancelSellOrder>) -> Result<()> {
        instructions::sell::handle_cancel_sell_order(ctx)
    }

    /// Create a symbol's check and name its checker. Upgrade authority only.
    pub fn open_check(
        ctx: Context<OpenCheck>,
        symbol: [u8; SYMBOL_LEN],
        checker: Pubkey,
    ) -> Result<()> {
        instructions::check::handle_open_check(ctx, symbol, checker)
    }

    /// The checker's view: is the market open, and the last sale's price.
    #[allow(clippy::too_many_arguments)]
    pub fn push_check(
        ctx: Context<PushCheck>,
        symbol: [u8; SYMBOL_LEN],
        open_now: bool,
        ref_rate_q64: u128,
        ref_px_num: u64,
        ref_px_expo: i32,
        ref_at: i64,
        observed_at: i64,
    ) -> Result<()> {
        instructions::check::handle_push_check(
            ctx, symbol, open_now, ref_rate_q64, ref_px_num, ref_px_expo, ref_at, observed_at,
        )
    }

    /// Consent to fills while the primary market is shut, for every order.
    pub fn opt_in_night(ctx: Context<OptInNight>) -> Result<()> {
        instructions::night::handle_opt_in_night(ctx)
    }

    /// Withdraw that consent and reclaim the rent. Applies to live orders too.
    pub fn opt_out_night(ctx: Context<OptOutNight>) -> Result<()> {
        instructions::night::handle_opt_out_night(ctx)
    }

    /// Settle a due buy against a due sell at the mark, with no filler spread.
    /// Permissionless, and in session only.
    pub fn cross_orders(ctx: Context<CrossOrders>) -> Result<()> {
        instructions::cross::handle_cross_orders(ctx)
    }
}
