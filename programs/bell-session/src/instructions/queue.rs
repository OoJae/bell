use anchor_lang::prelude::*;

use crate::{
    constants::{
        AUTH_SEED, MAX_CONF_BPS, MAX_ORDER_IN, MAX_ORDER_LIFETIME_SECONDS, MAX_SLIP_BPS,
        ORDER_SEED, SYMBOL_LEN, SYMBOL_SEED, RISK_SEED, MARK_SEED,
    },
    error::BellError,
    state::{BellOrder, SymbolMark, SymbolState, TokenRisk},
    tokens::read_token_account,
};

/// Park an intent to buy at the next open.
///
/// The client puts `approve_checked` immediately before this in the same
/// transaction, so the user signs once for both. This handler then *verifies*
/// the delegation rather than creating it — an order cannot exist unless it is
/// already fundable, which means the book never contains orders that were never
/// backed.
#[derive(Accounts)]
#[instruction(symbol: [u8; SYMBOL_LEN], nonce: u64)]
pub struct PlaceOrder<'info> {
    /// Only the owner may place an order in their own name.
    #[account(mut)]
    pub owner: Signer<'info>,
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
    #[account(
        seeds = [MARK_SEED, symbol.as_ref()],
        bump = mark.bump,
        constraint = mark.mint == symbol_state.mint @ BellError::MintMismatch,
    )]
    pub mark: Account<'info, SymbolMark>,
    #[account(
        init,
        payer = owner,
        space = 8 + BellOrder::INIT_SPACE,
        seeds = [ORDER_SEED, owner.key().as_ref(), &nonce.to_le_bytes()],
        bump,
    )]
    pub order: Account<'info, BellOrder>,
    /// CHECK: the user's quote account, validated below by unpacking it.
    pub payer_in: UncheckedAccount<'info>,
    /// CHECK: the user's stock account, validated below by unpacking it.
    pub payee_out: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[allow(clippy::too_many_arguments)]
pub fn handle_place_order(
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
    let now = Clock::get()?.unix_timestamp;

    require!(
        amount_in > 0 && amount_in <= MAX_ORDER_IN,
        BellError::AmountTooLarge
    );
    require!(min_fill_in > 0 && min_fill_in <= amount_in, BellError::BadParameters);
    require!(max_slip_bps <= MAX_SLIP_BPS, BellError::BadParameters);
    require!(max_conf_bps <= MAX_CONF_BPS, BellError::BadParameters);
    require!(
        expires_at > now && expires_at.saturating_sub(now) <= MAX_ORDER_LIFETIME_SECONDS,
        BellError::BadParameters
    );

    let (auth, auth_bump) =
        Pubkey::find_program_address(&[AUTH_SEED, ctx.accounts.owner.key().as_ref()], ctx.program_id);

    // The quote leg must already be delegated to this owner's authority, for at
    // least the full order. Checking here means an unfunded order is impossible
    // rather than merely unfillable.
    let pin = read_token_account(&ctx.accounts.payer_in.to_account_info())?;
    require!(pin.owner == ctx.accounts.owner.key(), BellError::TokenOwnerMismatch);
    require!(pin.mint == ctx.accounts.mark.quote_mint, BellError::QuoteMintMismatch);
    require!(!pin.frozen, BellError::IssuerPaused);
    require!(pin.delegate == Some(auth), BellError::DelegationMissing);
    require!(pin.delegated_amount >= amount_in, BellError::DelegationMissing);

    let pout = read_token_account(&ctx.accounts.payee_out.to_account_info())?;
    require!(pout.owner == ctx.accounts.owner.key(), BellError::TokenOwnerMismatch);
    require!(pout.mint == ctx.accounts.symbol_state.mint, BellError::MintMismatch);

    let o = &mut ctx.accounts.order;
    o.owner = ctx.accounts.owner.key();
    o.symbol = symbol;
    o.mint = ctx.accounts.symbol_state.mint;
    o.quote_mint = ctx.accounts.mark.quote_mint;
    o.payer_in = ctx.accounts.payer_in.key();
    o.payee_out = ctx.accounts.payee_out.key();
    o.amount_in = amount_in;
    o.filled_in = 0;
    o.min_fill_in = min_fill_in;
    // Snapshot the multiplier now. If a rebase activates before the fill, the
    // gate refuses with MultiplierMoved rather than filling a resized order.
    o.expected_multiplier_bits = ctx.accounts.risk.multiplier_bits;
    o.max_slip_bps = max_slip_bps;
    o.max_conf_bps = max_conf_bps;
    o.floor_rate_q64 = floor_rate_q64;
    o.not_before = not_before;
    o.expires_at = expires_at;
    o.nonce = nonce;
    o.created_at = now;
    o.bump = ctx.bumps.order;
    o.auth_bump = auth_bump;
    Ok(())
}

/// Close an order and return its rent.
///
/// Worth being clear about what this is *not*: it is not the cancel. The cancel
/// is `spl_token::revoke` on the user's own account, which needs no cooperation
/// from this program and works if it is frozen. This only reclaims rent.
///
/// Anyone may close an order that has expired or lost its funding, so the book
/// self-cleans after a revoke — but rent always returns to the owner, never to
/// the caller, so there is nothing to farm.
#[derive(Accounts)]
pub struct CancelOrder<'info> {
    pub signer: Signer<'info>,
    /// CHECK: rent destination, constrained to equal `order.owner`.
    #[account(mut, address = order.owner)]
    pub owner: UncheckedAccount<'info>,
    #[account(
        mut,
        seeds = [ORDER_SEED, order.owner.as_ref(), &order.nonce.to_le_bytes()],
        bump = order.bump,
        close = owner,
    )]
    pub order: Account<'info, BellOrder>,
    /// CHECK: the delegated quote account, read to detect a revoke.
    #[account(address = order.payer_in)]
    pub payer_in: UncheckedAccount<'info>,
}

pub fn handle_cancel_order(ctx: Context<CancelOrder>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let o = &ctx.accounts.order;

    if ctx.accounts.signer.key() != o.owner {
        let expired = now >= o.expires_at;
        let remaining = o.amount_in.saturating_sub(o.filled_in);
        let (auth, _) =
            Pubkey::find_program_address(&[AUTH_SEED, o.owner.as_ref()], ctx.program_id);
        let pin = read_token_account(&ctx.accounts.payer_in.to_account_info())?;
        let defunded = pin.delegate != Some(auth) || pin.delegated_amount < remaining;
        require!(expired || defunded, BellError::NotOrderOwner);
    }
    Ok(())
}
