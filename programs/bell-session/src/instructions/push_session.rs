use anchor_lang::prelude::*;

use crate::{
    constants::{SYMBOL_SEED, SYMBOL_LEN},
    error::BellError,
    state::{HaltState, SymbolState},
};

/// Attest the off-chain market facts: is the primary exchange open, and is this
/// security halted on it.
///
/// This is the only trusted input in the system, which is why it is this small.
/// Consumers do not trust it for long: `assert_tradeable` treats any record
/// older than `MAX_STATE_AGE_SECONDS` as a halt, so an attestor that stops
/// publishing fails the system closed rather than leaving it open.
#[derive(Accounts)]
#[instruction(symbol: [u8; SYMBOL_LEN])]
pub struct PushSession<'info> {
    pub attestor: Signer<'info>,
    #[account(
        mut,
        seeds = [SYMBOL_SEED, symbol.as_ref()],
        bump = symbol_state.bump,
        constraint = symbol_state.attestor == attestor.key() @ BellError::NotAttestor,
    )]
    pub symbol_state: Account<'info, SymbolState>,
}

pub fn handle_push_session(
    ctx: Context<PushSession>,
    _symbol: [u8; SYMBOL_LEN],
    halt: HaltState,
    open_now: bool,
    next_change_at: i64,
    observed_at: i64,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    // A future timestamp would extend the freshness window for free.
    require!(observed_at <= now, BellError::TimestampInFuture);

    let s = &mut ctx.accounts.symbol_state;
    s.halt = halt;
    s.open_now = open_now;
    s.next_change_at = next_change_at;
    s.observed_at = observed_at;
    Ok(())
}
