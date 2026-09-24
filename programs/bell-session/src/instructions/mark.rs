use anchor_lang::prelude::*;

use crate::{
    constants::{
        MARK_SEED, MAX_CONF_BPS, MAX_MARK_AGE_SECONDS, MAX_MARK_STEP_AGE_SECONDS,
        MAX_MARK_STEP_BPS, SYMBOL_LEN, SYMBOL_SEED,
    },
    error::BellError,
    state::{MarkSource, MarkTripped, SymbolMark, SymbolState},
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
/// simplification and also the system's sharpest edge: a session opens and
/// closes trading but moves no value, while a price can. Each order's own
/// `floor_rate_q64` bounds what a wrong price can take, the mark may move only
/// as far as the time since its last observation allows, and every fill also
/// needs the mark to sit near a second signer's reference. See `SymbolMark` and
/// `SymbolCheck`.
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

    // An observation older than the one on record is ignored, not written and
    // not refused. Writing it would let a push backdate the mark, and a
    // backdated mark is one the step limit no longer anchors to, so the very
    // next push in the same transaction could land at any rate. Refusing it
    // would fail a keeper batch over a late retry.
    if observed_at < m.observed_at {
        return Ok(());
    }

    // The step limit applies only against a mark that is still evidence of the
    // price: one that has been pushed, and recently. Measured from the clock,
    // not from the pushed time, so no choice of `observed_at` can move a push
    // outside the window. A first push, or one after a gap, sets the price.
    let anchored = m.rate_q64 != 0
        && m.observed_at != 0
        && now.saturating_sub(m.observed_at) <= MAX_MARK_STEP_AGE_SECONDS;

    // How far this push may move the mark: a whole step once a mark's worth
    // of time (`MAX_MARK_AGE_SECONDS`) has passed since the observation on
    // record, and that share of a step before then. A step allowed per push
    // would be a step allowed per instruction: pushes at the same time, each
    // one step from the last, would walk the mark as far as the attestor liked
    // inside one transaction, and after a hold would walk it on to the very
    // rate that was held. Measured this way, a push at the time on record may
    // not move the rate at all, and since `observed_at` never goes backwards
    // and never passes the clock, the most the mark can drift is one step per
    // minute of real time, however the pushes are split. The keeper pushes
    // about once a minute, so its own pushes keep very nearly the whole step.
    // The product saturates rather than overflows; at a rate that large the
    // limit only gets tighter.
    let elapsed = observed_at
        .saturating_sub(m.observed_at)
        .clamp(0, MAX_MARK_AGE_SECONDS) as u128;
    let allowed = (m.rate_q64 / 10_000).saturating_mul(MAX_MARK_STEP_BPS as u128 * elapsed)
        / MAX_MARK_AGE_SECONDS as u128;

    // Too far for the time: hold. The rate, price, source and time stay as
    // they were, so the mark ages out as a stale mark would; only the marker
    // is set. Returning Ok rather than an error is what keeps one bad symbol
    // from failing the eight good ones pushed with it, and what makes the hold
    // stick: an error would roll the marker back with the push, and fills
    // would go on at the old rate as if nothing had been seen. The held time
    // is kept too, so the allowance for the next push keeps growing from it.
    if anchored && m.rate_q64.abs_diff(rate_q64) > allowed {
        m.conf_bps = u16::MAX;
        emit!(MarkTripped {
            symbol: m.symbol,
            held_rate_q64: m.rate_q64,
            pushed_rate_q64: rate_q64,
            held_observed_at: m.observed_at,
            pushed_observed_at: observed_at,
        });
        return Ok(());
    }

    // Inside the allowance, or unanchored: write every field, which also
    // clears a hold, since the pushed `conf_bps` can never be the marker.
    m.rate_q64 = rate_q64;
    m.px_num = px_num;
    m.px_expo = px_expo;
    m.conf_bps = conf_bps;
    m.source = source;
    m.observed_at = observed_at;
    Ok(())
}
