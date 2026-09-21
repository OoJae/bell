use anchor_lang::prelude::*;

use crate::{
    constants::{MARK_SEED, MAX_CONF_BPS, SYMBOL_LEN, SYMBOL_SEED},
    error::BellError,
    state::{MarkSource, SymbolMark, SymbolState},
};

/// Create the price mark for a symbol, binding it to that symbol's mint and to
/// the quote asset its rate will be denominated in.
#[derive(Accounts)]
#[instruction(symbol: [u8; SYMBOL_LEN])]
pub struct OpenMark<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        seeds = [SYMBOL_SEED, symbol.as_ref()],
        bump = symbol_state.bump,
    )]
    pub symbol_state: Account<'info, SymbolState>,
    #[account(
        init,
        payer = payer,
        space = 8 + SymbolMark::INIT_SPACE,
        seeds = [MARK_SEED, symbol.as_ref()],
        bump,
    )]
    pub mark: Account<'info, SymbolMark>,
    pub system_program: Program<'info, System>,
}

pub fn handle_open_mark(
    ctx: Context<OpenMark>,
    symbol: [u8; SYMBOL_LEN],
    quote_mint: Pubkey,
) -> Result<()> {
    let m = &mut ctx.accounts.mark;
    m.symbol = symbol;
    m.mint = ctx.accounts.symbol_state.mint;
    m.quote_mint = quote_mint;
    // Opens with no price and a zero timestamp, which every freshness check
    // reads as stale. A mark is not usable until one has actually been pushed.
    m.rate_q64 = 0;
    m.px_num = 0;
    m.px_expo = 0;
    m.conf_bps = u16::MAX;
    m.source = MarkSource::Jupiter;
    m.observed_at = 0;
    m.bump = ctx.bumps.mark;
    Ok(())
}

/// Attest a price.
///
/// Signed by the same key that attests sessions. That is a deliberate
/// simplification and also the system's sharpest edge: unlike a session, which
/// can only close trading, a price can move value. See `SymbolMark`.
#[derive(Accounts)]
#[instruction(symbol: [u8; SYMBOL_LEN])]
pub struct PushMark<'info> {
    pub attestor: Signer<'info>,
    #[account(
        seeds = [SYMBOL_SEED, symbol.as_ref()],
        bump = symbol_state.bump,
        constraint = symbol_state.attestor == attestor.key() @ BellError::NotAttestor,
    )]
    pub symbol_state: Account<'info, SymbolState>,
    #[account(
        mut,
        seeds = [MARK_SEED, symbol.as_ref()],
        bump = mark.bump,
        constraint = mark.mint == symbol_state.mint @ BellError::MintMismatch,
    )]
    pub mark: Account<'info, SymbolMark>,
}

pub fn handle_push_mark(
    ctx: Context<PushMark>,
    _symbol: [u8; SYMBOL_LEN],
    rate_q64: u128,
    px_num: u64,
    px_expo: i32,
    conf_bps: u16,
    source: MarkSource,
    observed_at: i64,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    // Same reasoning as push_session: a future timestamp would buy the attestor
    // free freshness.
    require!(observed_at <= now, BellError::TimestampInFuture);
    require!(rate_q64 > 0, BellError::BadParameters);
    require!(conf_bps <= MAX_CONF_BPS, BellError::MarkTooWide);

    let m = &mut ctx.accounts.mark;
    m.rate_q64 = rate_q64;
    m.px_num = px_num;
    m.px_expo = px_expo;
    m.conf_bps = conf_bps;
    m.source = source;
    m.observed_at = observed_at;
    Ok(())
}
