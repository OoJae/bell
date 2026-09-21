use anchor_lang::prelude::*;

use crate::{
    constants::{SYMBOL_SEED, SYMBOL_LEN},
    state::{HaltState, HoursMode, SymbolState},
};

/// Bind a ticker to a specific mint, once.
///
/// The mint is pinned by address because look-alike mints of major tickers
/// already exist on Solana — there is a `JPMx` on a launchpad with more
/// liquidity than the real one. A symbol-keyed allowlist would route users
/// straight into it.
#[derive(Accounts)]
#[instruction(symbol: [u8; SYMBOL_LEN])]
pub struct RegisterSymbol<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        init,
        payer = payer,
        space = 8 + SymbolState::INIT_SPACE,
        seeds = [SYMBOL_SEED, symbol.as_ref()],
        bump,
    )]
    pub symbol_state: Account<'info, SymbolState>,
    pub system_program: Program<'info, System>,
}

pub fn handle_register_symbol(
    ctx: Context<RegisterSymbol>,
    symbol: [u8; SYMBOL_LEN],
    mint: Pubkey,
    exchange_mic: [u8; 4],
    hours_mode: HoursMode,
    attestor: Pubkey,
) -> Result<()> {
    let s = &mut ctx.accounts.symbol_state;
    s.symbol = symbol;
    s.mint = mint;
    s.exchange_mic = exchange_mic;
    s.hours_mode = hours_mode;
    // Registered closed and halted. A symbol is not tradeable until a fresh
    // session push says otherwise — the default must never be "open".
    s.halt = HaltState::Suspension;
    s.open_now = false;
    s.next_change_at = 0;
    s.observed_at = 0;
    s.attestor = attestor;
    s.bump = ctx.bumps.symbol_state;
    Ok(())
}
