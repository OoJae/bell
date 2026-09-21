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
    pub fn init_token_risk(ctx: Context<InitTokenRisk>) -> Result<()> {
        instructions::verify_token_risk::handle_init_token_risk(ctx)
    }

    /// Re-read issuer powers and pending rebases from the mint. Permissionless.
    pub fn refresh_token_risk(ctx: Context<RefreshTokenRisk>) -> Result<()> {
        instructions::verify_token_risk::handle_refresh_token_risk(ctx)
    }

    /// Record whether a pending multiplier change is a split or a dividend.
    pub fn classify_rebase(ctx: Context<ClassifyRebase>, kind: RebaseKind) -> Result<()> {
        instructions::classify_rebase::handle_classify_rebase(ctx, kind)
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
}
