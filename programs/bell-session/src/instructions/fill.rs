use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    instruction::{AccountMeta, Instruction},
    program::{invoke, invoke_signed},
};

use crate::{
    constants::{AUTH_SEED, MARK_SEED, MAX_MARK_AGE_SECONDS, ORDER_SEED, RISK_SEED, SYMBOL_SEED},
    error::BellError,
    instructions::assert_tradeable::{check_tradeable, Mode},
    state::{BellOrder, OrderFilled, SymbolMark, SymbolState, TokenRisk},
    tokens::{balance_of, read_token_account},
};

/// `a * q64 >> 64`, refusing rather than wrapping.
///
/// Deliberately `u128` with a checked multiply instead of reaching for wider
/// arithmetic: an overflow here means the inputs are nonsense, and refusing a
/// fill is always a safe answer.
fn mul_shr64(a: u128, q64: u128) -> Result<u128> {
    Ok(a.checked_mul(q64).ok_or(BellError::MathOverflow)? >> 64)
}

/// Build a `TransferChecked` instruction using anchor's own types.
///
/// spl-token-2022's builder returns *its* `Instruction`, which is a different
/// type from the one `invoke` wants, because the two crates depend on different
/// solana crate majors. The wire format is stable and tiny — discriminant 12,
/// a little-endian amount, a decimals byte — so building it here is both
/// shorter than bridging the types and immune to that skew.
///
/// The same layout serves SPL Token and Token-2022; only the program id differs.
fn transfer_checked_ix(
    token_program: &Pubkey,
    source: &Pubkey,
    mint: &Pubkey,
    destination: &Pubkey,
    authority: &Pubkey,
    amount: u64,
    decimals: u8,
) -> Instruction {
    let mut data = Vec::with_capacity(10);
    data.push(12u8); // TokenInstruction::TransferChecked
    data.extend_from_slice(&amount.to_le_bytes());
    data.push(decimals);
    Instruction {
        program_id: *token_program,
        accounts: vec![
            AccountMeta::new(*source, false),
            AccountMeta::new_readonly(*mint, false),
            AccountMeta::new(*destination, false),
            AccountMeta::new_readonly(*authority, true),
        ],
        data,
    }
}

fn mint_decimals(info: &AccountInfo) -> Result<u8> {
    use spl_token_2022::{extension::StateWithExtensions, state::Mint};
    let data = info.try_borrow_data()?;
    Ok(StateWithExtensions::<Mint>::unpack(&data)
        .map_err(|_| error!(BellError::NotToken2022))?
        .base
        .decimals)
}

/// Settle a due order.
///
/// Permissionless by design: any filler may settle, because the guarantee to
/// the user is enforced here rather than by trusting who called. The filler
/// sources the stock however it likes — its own swap, its own inventory, its
/// own risk — in its own transaction. This program never routes a trade; it
/// runs the same gate `assert_tradeable` runs and measures what actually landed
/// in the user's account.
#[derive(Accounts)]
pub struct FillOrder<'info> {
    pub filler: Signer<'info>,
    #[account(
        mut,
        seeds = [ORDER_SEED, order.owner.as_ref(), &order.nonce.to_le_bytes()],
        bump = order.bump,
    )]
    pub order: Account<'info, BellOrder>,
    #[account(
        seeds = [SYMBOL_SEED, order.symbol.as_ref()],
        bump = symbol_state.bump,
        constraint = symbol_state.mint == order.mint @ BellError::MintMismatch,
    )]
    pub symbol_state: Account<'info, SymbolState>,
    #[account(
        seeds = [RISK_SEED, order.mint.as_ref()],
        bump = risk.bump,
        constraint = risk.mint == order.mint @ BellError::MintMismatch,
    )]
    pub risk: Account<'info, TokenRisk>,
    #[account(
        seeds = [MARK_SEED, order.symbol.as_ref()],
        bump = mark.bump,
        constraint = mark.mint == order.mint @ BellError::MintMismatch,
    )]
    pub mark: Account<'info, SymbolMark>,
    /// CHECK: the per-owner delegate authority; never initialised, only signs.
    #[account(seeds = [AUTH_SEED, order.owner.as_ref()], bump = order.auth_bump)]
    pub auth: UncheckedAccount<'info>,
    /// CHECK: rent destination when the order completes. Constrained to the
    /// owner so a filler can never collect the user's rent as a bonus.
    #[account(mut, address = order.owner)]
    pub owner: UncheckedAccount<'info>,
    /// CHECK: the user's quote account, pinned by the order.
    #[account(mut, address = order.payer_in)]
    pub payer_in: UncheckedAccount<'info>,
    /// CHECK: the user's stock account, pinned by the order.
    #[account(mut, address = order.payee_out)]
    pub payee_out: UncheckedAccount<'info>,
    /// CHECK: the filler's quote destination; the filler's own business.
    #[account(mut)]
    pub filler_in: UncheckedAccount<'info>,
    /// CHECK: the filler's stock source; the filler's own business.
    #[account(mut)]
    pub filler_out: UncheckedAccount<'info>,
    /// CHECK: validated against the order.
    #[account(address = order.quote_mint)]
    pub quote_mint: UncheckedAccount<'info>,
    /// CHECK: validated against the order.
    #[account(address = order.mint)]
    pub stock_mint: UncheckedAccount<'info>,
    /// CHECK: the program the quote leg moves under.
    pub quote_token_program: UncheckedAccount<'info>,
    /// CHECK: the program the stock leg moves under.
    pub stock_token_program: UncheckedAccount<'info>,
}

pub fn handle_fill_order(
    ctx: Context<FillOrder>,
    amount_in_leg: u64,
    amount_out: u64,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let o = &ctx.accounts.order;

    require!(now >= o.not_before, BellError::NotYetDue);
    require!(now < o.expires_at, BellError::OrderExpired);

    // The identical gate assert_tradeable runs — the same function, so a
    // refused fill and a refused swap are indistinguishable to a client.
    // Strict by construction: a queued order fills only while the real primary
    // market is live, which is also what keeps a wrong mark arbitrageable.
    check_tradeable(
        &ctx.accounts.symbol_state,
        &ctx.accounts.risk,
        Mode::Strict,
        o.expected_multiplier_bits,
        now,
    )?;

    let mark = &ctx.accounts.mark;
    require!(mark.quote_mint == o.quote_mint, BellError::QuoteMintMismatch);
    require!(
        now.saturating_sub(mark.observed_at) <= MAX_MARK_AGE_SECONDS,
        BellError::MarkStale
    );
    require!(mark.conf_bps <= o.max_conf_bps, BellError::MarkTooWide);

    let remaining = o.amount_in.saturating_sub(o.filled_in);
    require!(amount_in_leg <= remaining, BellError::OverFill);
    require!(
        amount_in_leg >= o.min_fill_in.min(remaining),
        BellError::FillTooSmall
    );

    // The band, computed against the mark that exists *now*, not at placement.
    let fair = mul_shr64(amount_in_leg as u128, mark.rate_q64)?;
    let by_band = fair
        .checked_mul(10_000u128 - o.max_slip_bps as u128)
        .ok_or(BellError::MathOverflow)?
        / 10_000u128;
    let by_floor = mul_shr64(amount_in_leg as u128, o.floor_rate_q64)?;
    let min_out = by_band.max(by_floor);

    let quote_decimals = mint_decimals(&ctx.accounts.quote_mint.to_account_info())?;
    let stock_decimals = mint_decimals(&ctx.accounts.stock_mint.to_account_info())?;

    // Deliver first, then take. If the delivery is short, nothing is taken.
    let out_before = balance_of(&ctx.accounts.payee_out.to_account_info())?;
    let deliver = transfer_checked_ix(
        &ctx.accounts.stock_token_program.key(),
        &ctx.accounts.filler_out.key(),
        &ctx.accounts.stock_mint.key(),
        &ctx.accounts.payee_out.key(),
        &ctx.accounts.filler.key(),
        amount_out,
        stock_decimals,
    );
    invoke(
        &deliver,
        &[
            ctx.accounts.filler_out.to_account_info(),
            ctx.accounts.stock_mint.to_account_info(),
            ctx.accounts.payee_out.to_account_info(),
            ctx.accounts.filler.to_account_info(),
            ctx.accounts.stock_token_program.to_account_info(),
        ],
    )?;

    // Measure, do not trust. This covers transfer fees, hooks, rounding and any
    // Token-2022 behaviour not anticipated here — the same rule the program
    // already follows for issuer state: prove what you can.
    let delivered = balance_of(&ctx.accounts.payee_out.to_account_info())?
        .saturating_sub(out_before);
    require!(delivered as u128 >= min_out, BellError::PriceOutOfBand);

    let in_before = balance_of(&ctx.accounts.payer_in.to_account_info())?;
    let owner = ctx.accounts.order.owner;
    let auth_bump = ctx.accounts.order.auth_bump;
    let take = transfer_checked_ix(
        &ctx.accounts.quote_token_program.key(),
        &ctx.accounts.payer_in.key(),
        &ctx.accounts.quote_mint.key(),
        &ctx.accounts.filler_in.key(),
        &ctx.accounts.auth.key(),
        amount_in_leg,
        quote_decimals,
    );
    invoke_signed(
        &take,
        &[
            ctx.accounts.payer_in.to_account_info(),
            ctx.accounts.quote_mint.to_account_info(),
            ctx.accounts.filler_in.to_account_info(),
            ctx.accounts.auth.to_account_info(),
            ctx.accounts.quote_token_program.to_account_info(),
        ],
        &[&[AUTH_SEED, owner.as_ref(), &[auth_bump]]],
    )?;
    let taken = in_before.saturating_sub(balance_of(&ctx.accounts.payer_in.to_account_info())?);
    require!(taken <= amount_in_leg, BellError::OverFill);

    let realized_bps = if fair > 0 {
        (10_000u128.saturating_sub(delivered as u128 * 10_000 / fair)) as u16
    } else {
        0
    };

    let o = &mut ctx.accounts.order;
    o.filled_in = o.filled_in.saturating_add(amount_in_leg);
    let complete = o.filled_in >= o.amount_in;

    emit!(OrderFilled {
        symbol: o.symbol,
        owner,
        filler: ctx.accounts.filler.key(),
        amount_in: amount_in_leg,
        amount_out: delivered,
        px_num: mark.px_num,
        px_expo: mark.px_expo,
        source: mark.source,
        mark_observed_at: mark.observed_at,
        realized_bps,
    });

    if complete {
        // Rent returns to the user, never to whoever happened to fill.
        ctx.accounts.order.close(ctx.accounts.owner.to_account_info())?;
    }
    Ok(())
}
