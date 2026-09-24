use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    instruction::{AccountMeta, Instruction},
    program::invoke_signed,
};

use crate::{
    constants::{
        is_token_program, AUTH_SEED, CHECK_SEED, MARK_SEED, MAX_NIGHT_GAP_BPS,
        ORDER_SEED, RISK_SEED, SYMBOL_SEED,
    },
    error::BellError,
    instructions::admit::{admit, Terms},
    state::{BellOrder, OrderFilled, SymbolCheck, SymbolMark, SymbolState, TokenRisk},
    tokens::balance_of,
};

/// `a * q64 >> 64`, refusing rather than wrapping.
///
/// Deliberately `u128` with a checked multiply instead of reaching for wider
/// arithmetic: an overflow here means the inputs are nonsense, and refusing a
/// fill is always a safe answer.
pub(crate) fn mul_shr64(a: u128, q64: u128) -> Result<u128> {
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
pub(crate) fn transfer_checked_ix(
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

/// Move one leg and measure what it did to both sides: returns `(sent,
/// received)`, what left `from` and what arrived in `to`.
///
/// Every leg is the same steps: read both balances, call the token program,
/// read both again. A fill needs one side of each leg, the user's, but a cross
/// moves both legs between two users and has to measure both sides of each,
/// so both are always read and each caller keeps what it needs. One body in
/// the binary then serves every leg of every settlement. The balances are read
/// under `program`, the program the leg moves under, so an account cannot be
/// measured under one token program and moved under the other. A filler's
/// delivery passes no seeds and is signed by the filler; a take is signed by
/// the owner's delegate authority.
#[inline(never)]
#[allow(clippy::too_many_arguments)]
pub(crate) fn move_leg<'info>(
    program: &AccountInfo<'info>,
    from: &AccountInfo<'info>,
    mint: &AccountInfo<'info>,
    to: &AccountInfo<'info>,
    authority: &AccountInfo<'info>,
    amount: u64,
    decimals: u8,
    signer_seeds: &[&[&[u8]]],
) -> Result<(u64, u64)> {
    let from_before = balance_of(from, program.key)?;
    let to_before = balance_of(to, program.key)?;
    let ix = transfer_checked_ix(
        program.key,
        from.key,
        mint.key,
        to.key,
        authority.key,
        amount,
        decimals,
    );
    invoke_signed(
        &ix,
        &[from.clone(), mint.clone(), to.clone(), authority.clone(), program.clone()],
        signer_seeds,
    )?;
    let sent = from_before.saturating_sub(balance_of(from, program.key)?);
    let received = balance_of(to, program.key)?.saturating_sub(to_before);
    Ok((sent, received))
}

/// The least stock a buy leg of `leg` quote raw may receive at `rate`, and the
/// fair value it is measured from: `(fair, min_out)`.
///
/// The band below fair, or the owner's own floor, whichever is higher, each
/// rounded down as a buy always has been. One function rather than a copy in
/// each caller, because a buy fill, a night fill's reference minimum and a
/// cross must all hold a buyer to the identical number.
#[inline(never)]
pub(crate) fn buy_min_out(leg: u64, rate: u128, slip_bps: u16, floor_q64: u128) -> Result<(u128, u128)> {
    let fair = mul_shr64(leg as u128, rate)?;
    let by_band = fair
        .checked_mul(10_000u128 - slip_bps as u128)
        .ok_or(BellError::MathOverflow)?
        / 10_000u128;
    let by_floor = mul_shr64(leg as u128, floor_q64)?;
    Ok((fair, by_band.max(by_floor)))
}

pub(crate) fn mint_decimals(info: &AccountInfo) -> Result<u8> {
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
    pub order: Box<Account<'info, BellOrder>>,
    #[account(
        seeds = [SYMBOL_SEED, order.symbol.as_ref()],
        bump = symbol_state.bump,
        constraint = symbol_state.mint == order.mint @ BellError::MintMismatch,
    )]
    pub symbol_state: Box<Account<'info, SymbolState>>,
    #[account(
        seeds = [RISK_SEED, order.mint.as_ref()],
        bump = risk.bump,
        constraint = risk.mint == order.mint @ BellError::MintMismatch,
    )]
    pub risk: Box<Account<'info, TokenRisk>>,
    #[account(
        seeds = [MARK_SEED, order.symbol.as_ref()],
        bump = mark.bump,
        constraint = mark.mint == order.mint @ BellError::MintMismatch,
    )]
    pub mark: Box<Account<'info, SymbolMark>>,
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
    /// The second signer's view of this symbol. Appended after every existing
    /// account, so a filler built for the fifteen-account form fails for want
    /// of an account before any handler code runs, rather than skipping it.
    #[account(
        seeds = [CHECK_SEED, order.symbol.as_ref()],
        bump = check.bump,
        constraint = check.mint == order.mint @ BellError::MintMismatch,
    )]
    pub check: Box<Account<'info, SymbolCheck>>,
    /// The owner's night opt-in. Clients pass `[NIGHT_SEED, order.owner]`
    /// whether or not anything lives there. Read in `admit` by owning program,
    /// discriminator and the owner it records, not by address: checking the
    /// address would cost a bump search on every fill, priced by the owner's
    /// key, and the recorded owner already rules out another owner's consent.
    /// Any other account reads as no consent.
    /// CHECK: verified in `admit` by `night::opted_in`, never written.
    pub night: UncheckedAccount<'info>,
}

pub fn handle_fill_order(
    ctx: Context<FillOrder>,
    amount_in_leg: u64,
    amount_out: u64,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let o = &ctx.accounts.order;

    // Due, the gate, the mark and the check, in that order: the same test a
    // sell fill runs. See `admit`. Strict unless the owner opted in to night
    // fills and the market is shut.
    let night = admit(
        &Terms {
            not_before: o.not_before,
            expires_at: o.expires_at,
            expected_multiplier_bits: o.expected_multiplier_bits,
            quote_mint: o.quote_mint,
            max_conf_bps: o.max_conf_bps,
        },
        &ctx.accounts.symbol_state,
        &ctx.accounts.risk,
        &ctx.accounts.mark,
        &ctx.accounts.check,
        Some((ctx.accounts.night.as_ref(), &o.owner)),
        now,
    )?;

    let mark = &ctx.accounts.mark;
    let remaining = o.amount_in.saturating_sub(o.filled_in);
    require!(amount_in_leg <= remaining, BellError::OverFill);
    require!(
        amount_in_leg >= o.min_fill_in.min(remaining),
        BellError::FillTooSmall
    );

    // The band, computed against the mark that exists *now*, not at placement.
    let (fair, mut min_out) =
        buy_min_out(amount_in_leg, mark.rate_q64, o.max_slip_bps, o.floor_rate_q64)?;

    // At night, a third minimum from the second signer's reference, the band
    // formula again with the night gap in place of the order's slippage. The
    // mark already sits within that gap of the reference, so this binds when
    // the order's own band is the more generous: the filler's spread at night
    // is then bounded by the checker's price, not by the attestor's alone.
    if night {
        let (_, by_ref) =
            buy_min_out(amount_in_leg, ctx.accounts.check.ref_rate_q64, MAX_NIGHT_GAP_BPS, 0)?;
        min_out = min_out.max(by_ref);
    }

    // Both legs must move under a real token program. Unconstrained, these are
    // filler-chosen callees that `invoke_signed` would hand the delegate
    // authority's signature to; the post-transfer measurement bounds the damage
    // but the primitive should not exist in the first place.
    let quote_program = &ctx.accounts.quote_token_program.key();
    let stock_program = &ctx.accounts.stock_token_program.key();
    require!(is_token_program(quote_program), BellError::TokenProgramMismatch);
    require!(is_token_program(stock_program), BellError::TokenProgramMismatch);

    let quote_decimals = mint_decimals(&ctx.accounts.quote_mint.to_account_info())?;
    let stock_decimals = mint_decimals(&ctx.accounts.stock_mint.to_account_info())?;

    // Deliver first, then take. If the delivery is short, nothing is taken.
    //
    // Measure, do not trust. This covers transfer fees, hooks, rounding and any
    // Token-2022 behaviour not anticipated here — the same rule the program
    // already follows for issuer state: prove what you can.
    let (_, delivered) = move_leg(
        &ctx.accounts.stock_token_program,
        &ctx.accounts.filler_out,
        &ctx.accounts.stock_mint,
        &ctx.accounts.payee_out,
        &ctx.accounts.filler,
        amount_out,
        stock_decimals,
        &[],
    )?;
    require!(delivered as u128 >= min_out, BellError::PriceOutOfBand);

    let owner = ctx.accounts.order.owner;
    let auth_bump = ctx.accounts.order.auth_bump;
    let (taken, _) = move_leg(
        &ctx.accounts.quote_token_program,
        &ctx.accounts.payer_in,
        &ctx.accounts.quote_mint,
        &ctx.accounts.filler_in,
        &ctx.accounts.auth,
        amount_in_leg,
        quote_decimals,
        &[&[AUTH_SEED, owner.as_ref(), &[auth_bump]]],
    )?;
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
