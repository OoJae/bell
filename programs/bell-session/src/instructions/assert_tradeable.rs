use anchor_lang::prelude::*;

use crate::{
    constants::{MAX_STATE_AGE_SECONDS, REBASE_GUARD_SECONDS, RISK_SEED, SYMBOL_SEED, SYMBOL_LEN},
    error::BellError,
    state::{HaltState, RebaseKind, SymbolState, TokenRisk},
};

/// How much off-hours risk the caller accepts.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum Mode {
    /// Will not trade unless the primary market is open.
    Strict,
    /// Will trade off-hours; the caller is expected to widen its own price
    /// bands to compensate for the absence of arbitrage.
    Guarded,
}

/// The gate itself, as a plain function.
///
/// Lifted out of the instruction handler so that `fill_order` runs *this exact
/// code* rather than an equivalent reimplementation. Two copies of a safety
/// check are two things to keep in sync, and the second one is where the bug
/// lives. Sharing it also keeps the error codes byte-identical, so a refused
/// fill decodes with the same client-side machinery as a refused swap.
///
/// `expected_multiplier_bits` is the multiplier the caller built its order
/// against. A rebase between quote and execution silently re-denominates the
/// trade, so a moved multiplier invalidates the order rather than filling it at
/// a different size than intended.
///
/// Checks run cheapest-and-most-categorical first, so a refusal names the most
/// fundamental reason rather than whichever happened to be tested first.
pub fn check_tradeable(
    s: &SymbolState,
    r: &TokenRisk,
    mode: Mode,
    expected_multiplier_bits: u64,
    now: i64,
) -> Result<()> {
    // 1. State we cannot vouch for is not a green light. An attestor that goes
    //    dark must close the venue, not leave it open.
    require!(
        now.saturating_sub(s.observed_at) <= MAX_STATE_AGE_SECONDS,
        BellError::StateStale
    );

    // 2. SEC Order 34-106402, II.H: "A TSV must stop trading in a Tokenized NMS
    //    Stock concurrently with any stoppage of trading in the underlying NMS
    //    stock on the primary listing exchange."
    require!(s.halt == HaltState::None, BellError::MarketClosed);

    // 3. Issuer-level freeze, proven from the mint.
    require!(!r.paused, BellError::IssuerPaused);

    // 4. A scheduled rebase re-denominates every balance at a known instant.
    if r.activates_at != 0 {
        let delta = r.activates_at.saturating_sub(now).abs();
        require!(delta > REBASE_GUARD_SECONDS, BellError::RebasePending);
        require!(r.rebase_kind != RebaseKind::Unknown, BellError::RebaseUnclassified);
    }

    // 5. The order must have been built against the multiplier in force now.
    require!(
        r.multiplier_bits == expected_multiplier_bits,
        BellError::MultiplierMoved
    );

    // 6. An armed transfer hook changes settlement semantics mid-flight.
    require!(r.hook.is_none(), BellError::HookArmed);

    // 7. Strict callers require a live primary market.
    if mode == Mode::Strict {
        require!(s.open_now, BellError::MarketClosed);
    }

    Ok(())
}

/// The gate as an instruction. Succeeds silently, or fails with the reason.
///
/// Callable by CPI, so the protection composes: a lending market, a vault or a
/// router inherits it by calling this rather than reimplementing it. It is also
/// composable without a CPI at all — put it first in a transaction and Solana's
/// atomicity aborts whatever follows.
#[derive(Accounts)]
#[instruction(symbol: [u8; SYMBOL_LEN])]
pub struct AssertTradeable<'info> {
    #[account(
        seeds = [SYMBOL_SEED, symbol.as_ref()],
        bump = symbol_state.bump,
    )]
    pub symbol_state: Account<'info, SymbolState>,
    #[account(
        seeds = [RISK_SEED, symbol_state.mint.as_ref()],
        bump = risk.bump,
        constraint = risk.mint == symbol_state.mint @ BellError::MintMismatch,
    )]
    pub risk: Account<'info, TokenRisk>,
}

pub fn handle_assert_tradeable(
    ctx: Context<AssertTradeable>,
    _symbol: [u8; SYMBOL_LEN],
    mode: Mode,
    expected_multiplier_bits: u64,
) -> Result<()> {
    check_tradeable(
        &ctx.accounts.symbol_state,
        &ctx.accounts.risk,
        mode,
        expected_multiplier_bits,
        Clock::get()?.unix_timestamp,
    )
}
