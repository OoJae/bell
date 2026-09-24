//! Sell orders: the buy queue with its two legs swapped.
//!
//! The user delegates their **stock** account to the same per-owner authority a
//! buy uses, a filler delivers **quote** first, and only then is the stock
//! taken. Every rule of the buy side carries over — the same gate, the same
//! mark freshness, the same measure-don't-trust settlement, the same rent
//! discipline — and only the pricing direction changes. That one change is the
//! whole risk of this file, so it is stated once here:
//!
//! `SymbolMark.rate_q64` is stock raw per quote raw. A buy multiplies by it; a
//! sell divides by it. Every rounding choice below goes the seller's way, so a
//! filler can never satisfy a minimum by a unit the arithmetic dropped.

use anchor_lang::prelude::*;

use crate::{
    constants::{
        is_token_program, AUTH_SEED, CHECK_SEED, MARK_SEED, MAX_CONF_BPS, MAX_NIGHT_GAP_BPS,
        MAX_ORDER_IN, MAX_ORDER_LIFETIME_SECONDS, MAX_SLIP_BPS, RISK_SEED, SELL_SEED,
        SYMBOL_LEN, SYMBOL_SEED,
    },
    error::BellError,
    instructions::{
        admit::{admit, Terms},
        fill::{mint_decimals, move_leg},
    },
    state::{SellOrder, SellOrderFilled, SymbolCheck, SymbolMark, SymbolState, TokenRisk},
    tokens::read_token_account_any,
};

/// Quote raw units worth `a` stock raw units at `rate`, rounded **up**.
///
/// Up because the result is a minimum the seller must be paid: rounding down
/// would let a fill pass one unit short of fair on every leg. Written as a
/// quotient plus a remainder test rather than `(num + rate - 1) / rate`,
/// because `num` is already as wide as `u128` allows — `a << 64` — and adding
/// `rate - 1` to it overflows whenever the rate exceeds 2^64, which a stock
/// cheaper than its quote unit genuinely produces.
pub(crate) fn stock_to_quote_ceil(a: u64, rate: u128) -> Result<u128> {
    // A mark that has never been pushed carries a zero rate; there is no price
    // to divide by, and that is what "stale" means.
    require!(rate > 0, BellError::MarkStale);
    let num = (a as u128) << 64;
    Ok(num / rate + u128::from(num % rate != 0))
}

/// `a * q64 >> 64`, rounded **up**, refusing rather than wrapping.
///
/// The ceiling counterpart of `fill::mul_shr64`, for the user's floor: the
/// floor is the least the seller will accept, so a fractional unit of it is a
/// whole unit owed.
pub(crate) fn mul_shr64_ceil(a: u128, q64: u128) -> Result<u128> {
    let p = a.checked_mul(q64).ok_or(BellError::MathOverflow)?;
    Ok((p >> 64) + u128::from(p as u64 != 0))
}

/// `fair` less `bps` basis points, rounded **up**: the least a seller will
/// take when `fair` is what the stock is worth and `bps` is what they allow
/// below it. The band and the night reference minimum are both this, over
/// different rates and different allowances.
pub(crate) fn less_bps_ceil(fair: u128, bps: u16) -> Result<u128> {
    let t = fair
        .checked_mul(10_000u128 - bps as u128)
        .ok_or(BellError::MathOverflow)?;
    Ok(t / 10_000u128 + u128::from(t % 10_000u128 != 0))
}

/// The least quote a sale of `leg` stock raw may be paid at `rate`, and the
/// fair value it is measured from: `(fair, min_out)`.
///
/// The band below fair, or the owner's own floor, whichever is higher, each
/// rounded up. The sell side's counterpart of `fill::buy_min_out`, shared for
/// the same reason: a sell fill, a night fill's reference minimum and a cross
/// must all hold a seller to the identical number.
#[inline(never)]
pub(crate) fn sell_min_out(leg: u64, rate: u128, slip_bps: u16, floor_q64: u128) -> Result<(u128, u128)> {
    let fair = stock_to_quote_ceil(leg, rate)?;
    let by_band = less_bps_ceil(fair, slip_bps)?;
    let by_floor = mul_shr64_ceil(leg as u128, floor_q64)?;
    Ok((fair, by_band.max(by_floor)))
}

/// Park an intent to sell at the next open.
///
/// The client puts `approve_checked` on the **stock** account immediately
/// before this in the same transaction, so the user signs once for both. This
/// handler then verifies the delegation rather than creating it, exactly as a
/// buy does: a sell order cannot exist unless the stock to fill it is already
/// committed.
#[derive(Accounts)]
#[instruction(symbol: [u8; SYMBOL_LEN], nonce: u64)]
pub struct PlaceSellOrder<'info> {
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
        space = 8 + SellOrder::INIT_SPACE,
        seeds = [SELL_SEED, owner.key().as_ref(), &nonce.to_le_bytes()],
        bump,
    )]
    pub order: Account<'info, SellOrder>,
    /// CHECK: the user's stock account, validated below by unpacking it.
    pub payer_in: UncheckedAccount<'info>,
    /// CHECK: the user's quote account, validated below by unpacking it.
    pub payee_out: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[allow(clippy::too_many_arguments)]
pub fn handle_place_sell_order(
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
    let now = Clock::get()?.unix_timestamp;

    // `amount_in` is stock here, so `MAX_ORDER_IN` — a quote amount — cannot
    // bound it directly: 1e9 raw of an 8-decimal stock is ten shares, not
    // $1,000. The bound is applied to the order's value at the current mark
    // instead, below, once the mark is known to carry a price.
    require!(amount_in > 0, BellError::AmountTooLarge);
    require!(min_fill_in > 0 && min_fill_in <= amount_in, BellError::BadParameters);
    require!(max_slip_bps <= MAX_SLIP_BPS, BellError::BadParameters);
    require!(max_conf_bps <= MAX_CONF_BPS, BellError::BadParameters);
    require!(
        expires_at > now && expires_at.saturating_sub(now) <= MAX_ORDER_LIFETIME_SECONDS,
        BellError::BadParameters
    );

    // The value cap is the same blast-radius bound a buy has: what a malicious
    // upgrade could move is the delegated amount, so its value is capped at
    // `MAX_ORDER_IN` quote units. The value is truncated to whole quote units
    // before the comparison, so an order sized to exactly the cap at this mark
    // is never refused over a fraction of a unit, while one worth a whole quote
    // unit more always is. The mark only has to carry a price here, not a
    // fresh one: this sizes the delegation, and the fill is what refuses to
    // trade against a stale price.
    let rate = ctx.accounts.mark.rate_q64;
    require!(rate > 0, BellError::MarkStale);
    let value = ((amount_in as u128) << 64) / rate;
    require!(value <= MAX_ORDER_IN as u128, BellError::AmountTooLarge);

    // Every fill computes `leg * floor` with `leg <= amount_in`. A floor that
    // overflows at the full amount would make some fills refuse with
    // MathOverflow for the life of the order, so it is refused now, while the
    // user is present to correct it, rather than discovered at the open.
    require!(
        (amount_in as u128).checked_mul(floor_rate_q64).is_some(),
        BellError::BadParameters
    );

    let (auth, auth_bump) =
        Pubkey::find_program_address(&[AUTH_SEED, ctx.accounts.owner.key().as_ref()], ctx.program_id);

    // The stock leg must already be delegated to this owner's authority, for
    // at least the full order. The same authority a buy uses: it can only ever
    // move an account an order pins, so sharing it adds nothing a buy order
    // could reach.
    let pin = read_token_account_any(&ctx.accounts.payer_in.to_account_info())?;
    require!(pin.owner == ctx.accounts.owner.key(), BellError::TokenOwnerMismatch);
    require!(pin.mint == ctx.accounts.symbol_state.mint, BellError::MintMismatch);
    require!(!pin.frozen, BellError::IssuerPaused);
    require!(pin.delegate == Some(auth), BellError::DelegationMissing);
    require!(pin.delegated_amount >= amount_in, BellError::DelegationMissing);

    let pout = read_token_account_any(&ctx.accounts.payee_out.to_account_info())?;
    require!(pout.owner == ctx.accounts.owner.key(), BellError::TokenOwnerMismatch);
    require!(pout.mint == ctx.accounts.mark.quote_mint, BellError::QuoteMintMismatch);

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
    // Snapshot the multiplier now. A rebase before the fill changes what each
    // raw unit of stock is worth, and a sell sized in raw units would then be
    // a different trade from the one the user placed.
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

/// Settle a due sell order.
///
/// The same seventeen accounts as `fill_order`, with the same names in the
/// same order, so a filler builds both from one template. What each leg holds is
/// swapped: `payer_in` and `filler_in` hold stock, `payee_out` and
/// `filler_out` hold quote.
#[derive(Accounts)]
pub struct FillSellOrder<'info> {
    pub filler: Signer<'info>,
    #[account(
        mut,
        seeds = [SELL_SEED, order.owner.as_ref(), &order.nonce.to_le_bytes()],
        bump = order.bump,
    )]
    pub order: Box<Account<'info, SellOrder>>,
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
    /// CHECK: the user's stock account, pinned by the order.
    #[account(mut, address = order.payer_in)]
    pub payer_in: UncheckedAccount<'info>,
    /// CHECK: the user's quote account, pinned by the order.
    #[account(mut, address = order.payee_out)]
    pub payee_out: UncheckedAccount<'info>,
    /// CHECK: the filler's stock destination; the filler's own business.
    #[account(mut)]
    pub filler_in: UncheckedAccount<'info>,
    /// CHECK: the filler's quote source; the filler's own business.
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
    /// The second signer's view of this symbol, appended as on `fill_order`.
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

pub fn handle_fill_sell_order(
    ctx: Context<FillSellOrder>,
    amount_in_leg: u64,
    amount_out: u64,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let o = &ctx.accounts.order;

    // The same admission test as a buy, in the same order: due, the gate, the
    // mark and the check. Strict for the same reason as a buy, unless the
    // owner opted in to night fills and the market is shut. See `admit`.
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

    // The band, against the mark that exists now. Each step rounds up: the
    // fair value, the band edge below it, and the user's floor. Each is the
    // least the seller will accept, so a fraction of a unit in any of them is
    // a whole unit owed to the seller. A buy's band truncates instead, which
    // leaves that fraction of a raw stock unit with the filler; the sell side
    // deliberately does not repeat that.
    let (fair, mut min_out) =
        sell_min_out(amount_in_leg, mark.rate_q64, o.max_slip_bps, o.floor_rate_q64)?;

    // At night, a third minimum from the second signer's reference: the same
    // rounded-up band, over the reference rate with the night gap. It binds
    // when the order's own band is the more generous, so a night seller is
    // never paid less than the checker's price allows, whatever the mark says.
    // Both of its steps round up, so with the mark at the edge of the night
    // gap it can sit one quote raw above fair value at the mark: a filler then
    // pays that one unit more than a zero-spread fill would, and never less.
    // The buy side truncates, so its reference minimum never passes fair.
    if night {
        let (_, by_ref) =
            sell_min_out(amount_in_leg, ctx.accounts.check.ref_rate_q64, MAX_NIGHT_GAP_BPS, 0)?;
        min_out = min_out.max(by_ref);
    }

    // Both legs must move under a real token program, checked before either
    // leg's accounts are read or any program is called. Unconstrained, the
    // stock leg's program is a filler-chosen callee that `invoke_signed` would
    // hand the delegate authority's signature to.
    let quote_program = &ctx.accounts.quote_token_program.key();
    let stock_program = &ctx.accounts.stock_token_program.key();
    require!(is_token_program(quote_program), BellError::TokenProgramMismatch);
    require!(is_token_program(stock_program), BellError::TokenProgramMismatch);

    let quote_decimals = mint_decimals(&ctx.accounts.quote_mint.to_account_info())?;
    let stock_decimals = mint_decimals(&ctx.accounts.stock_mint.to_account_info())?;

    // Deliver the quote first, then take the stock. If the payment is short,
    // nothing is taken. Measure what landed, never the stated amount.
    let (_, delivered) = move_leg(
        &ctx.accounts.quote_token_program,
        &ctx.accounts.filler_out,
        &ctx.accounts.quote_mint,
        &ctx.accounts.payee_out,
        &ctx.accounts.filler,
        amount_out,
        quote_decimals,
        &[],
    )?;
    require!(delivered as u128 >= min_out, BellError::PriceOutOfBand);

    // The token program moves exactly what it is asked to, but the rule is
    // the same on both legs: the user's side is measured, not assumed.
    let owner = ctx.accounts.order.owner;
    let auth_bump = ctx.accounts.order.auth_bump;
    let (taken, _) = move_leg(
        &ctx.accounts.stock_token_program,
        &ctx.accounts.payer_in,
        &ctx.accounts.stock_mint,
        &ctx.accounts.filler_in,
        &ctx.accounts.auth,
        amount_in_leg,
        stock_decimals,
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

    emit!(SellOrderFilled {
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

/// Close a sell order and return its rent.
///
/// As with a buy, this is not the cancel: the cancel is `spl_token::revoke` on
/// the user's stock account. Anyone may close an order that has expired, or a
/// live one whose stock account no longer backs what remains of it, and the
/// rent always goes to the owner.
#[derive(Accounts)]
pub struct CancelSellOrder<'info> {
    pub signer: Signer<'info>,
    /// CHECK: rent destination, constrained to equal `order.owner`.
    #[account(mut, address = order.owner)]
    pub owner: UncheckedAccount<'info>,
    #[account(
        mut,
        seeds = [SELL_SEED, order.owner.as_ref(), &order.nonce.to_le_bytes()],
        bump = order.bump,
        close = owner,
    )]
    pub order: Account<'info, SellOrder>,
    /// CHECK: the delegated stock account, read to detect a revoke.
    #[account(address = order.payer_in)]
    pub payer_in: UncheckedAccount<'info>,
}

pub fn handle_cancel_sell_order(ctx: Context<CancelSellOrder>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let o = &ctx.accounts.order;

    // The same rule as `cancel_order`: expired means closable by anyone, and a
    // live order is closable by a stranger once its stock account no longer
    // backs the remainder — including when it no longer reads as a token
    // account at all.
    if ctx.accounts.signer.key() != o.owner && now < o.expires_at {
        let remaining = o.amount_in.saturating_sub(o.filled_in);
        let (auth, _) =
            Pubkey::find_program_address(&[AUTH_SEED, o.owner.as_ref()], ctx.program_id);
        let defunded = match read_token_account_any(&ctx.accounts.payer_in.to_account_info()) {
            Ok(p) => p.delegate != Some(auth) || p.delegated_amount < remaining,
            Err(_) => true,
        };
        require!(defunded, BellError::NotOrderOwner);
    }
    Ok(())
}
