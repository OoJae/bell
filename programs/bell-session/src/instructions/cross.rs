//! The opening cross: a due buy settled directly against a due sell of the
//! same symbol, at the mark, with no filler between them.
//!
//! A fill puts a filler on the other side of every order, and the filler's
//! spread is the band the user signed for. When a buyer and a seller of the
//! same stock are both waiting for the open, each is the other's counterparty,
//! and neither needs to pay anyone's spread. This instruction trades one
//! against the other: the seller's stock goes to the buyer and the buyer's
//! quote goes to the seller, each moved by that owner's own delegate
//! authority, from the account that owner's order pins, to the account the
//! other owner's order pins.
//!
//! The mark is an executable ask, not a mid, so a cross at the mark is "no
//! filler spread", not "the fair price": relative to a mid, it gives the
//! pool's spread to the seller. Each side is still held to exactly the
//! minimums a fill would hold it to, so a cross never leaves either owner
//! worse off than the fill they already agreed to.
//!
//! Session only. Both orders are admitted as they would be by a fill with no
//! night opt-in, so the gate is Strict and the checker must say open. A wrong
//! mark in session can be arbitraged against a live market; at night, with no
//! filler taking the other side at its own risk, nothing would pull it back.

use anchor_lang::prelude::*;

use crate::{
    constants::{
        is_token_program, AUTH_SEED, CHECK_SEED, MARK_SEED, ORDER_SEED, RISK_SEED, SELL_SEED,
        SYMBOL_SEED,
    },
    error::BellError,
    instructions::{
        admit::{admit, Terms},
        fill::{buy_min_out, mint_decimals, move_leg, mul_shr64},
        sell::{sell_min_out, stock_to_quote_ceil},
    },
    state::{BellOrder, OrdersCrossed, SellOrder, SymbolCheck, SymbolMark, SymbolState, TokenRisk},
};

/// Cross a due buy against a due sell. Permissionless: anyone may crank it,
/// because what each owner receives is enforced here, measured, rather than
/// trusted to whoever called.
///
/// Every account the tokens move between is pinned by one of the two orders,
/// and each leg is signed by the authority of the owner it takes from, so a
/// cranker chooses only which two orders meet, never where anything goes.
/// The symbol's state, risk, mark and check are all found from the buy, and
/// the sell is required to be for the same symbol, mint and quote asset.
///
/// Those four carry their seeds and nothing more. Each address is derived from
/// the buy's symbol or mint; the buy's mint was copied from that symbol's state
/// when it was placed; and each of the four wrote its mint once, at creation,
/// from that same state or from the mint its own address is derived from. So
/// the mint comparison the fills also make could never fail here, and it is
/// left out rather than paid for in program size.
#[derive(Accounts)]
pub struct CrossOrders<'info> {
    pub cranker: Signer<'info>,
    #[account(
        mut,
        seeds = [ORDER_SEED, buy.owner.as_ref(), &buy.nonce.to_le_bytes()],
        bump = buy.bump,
    )]
    pub buy: Box<Account<'info, BellOrder>>,
    #[account(
        mut,
        seeds = [SELL_SEED, sell.owner.as_ref(), &sell.nonce.to_le_bytes()],
        bump = sell.bump,
        constraint = sell.owner != buy.owner @ BellError::SelfCross,
        constraint = sell.symbol == buy.symbol && sell.mint == buy.mint @ BellError::MintMismatch,
        constraint = sell.quote_mint == buy.quote_mint @ BellError::QuoteMintMismatch,
    )]
    pub sell: Box<Account<'info, SellOrder>>,
    #[account(
        seeds = [SYMBOL_SEED, buy.symbol.as_ref()],
        bump = symbol_state.bump,
    )]
    pub symbol_state: Box<Account<'info, SymbolState>>,
    #[account(
        seeds = [RISK_SEED, buy.mint.as_ref()],
        bump = risk.bump,
    )]
    pub risk: Box<Account<'info, TokenRisk>>,
    #[account(
        seeds = [MARK_SEED, buy.symbol.as_ref()],
        bump = mark.bump,
    )]
    pub mark: Box<Account<'info, SymbolMark>>,
    #[account(
        seeds = [CHECK_SEED, buy.symbol.as_ref()],
        bump = check.bump,
    )]
    pub check: Box<Account<'info, SymbolCheck>>,
    /// CHECK: the buyer's delegate authority; never initialised, only signs
    /// the quote leg.
    #[account(seeds = [AUTH_SEED, buy.owner.as_ref()], bump = buy.auth_bump)]
    pub buy_auth: UncheckedAccount<'info>,
    /// CHECK: the seller's delegate authority; never initialised, only signs
    /// the stock leg.
    #[account(seeds = [AUTH_SEED, sell.owner.as_ref()], bump = sell.auth_bump)]
    pub sell_auth: UncheckedAccount<'info>,
    /// CHECK: rent destination when the buy completes. Constrained to the
    /// owner so a cranker can never collect the user's rent.
    #[account(mut, address = buy.owner)]
    pub buyer: UncheckedAccount<'info>,
    /// CHECK: rent destination when the sell completes, likewise.
    #[account(mut, address = sell.owner)]
    pub seller: UncheckedAccount<'info>,
    /// CHECK: the buyer's quote account, pinned by the buy.
    #[account(mut, address = buy.payer_in)]
    pub buyer_quote: UncheckedAccount<'info>,
    /// CHECK: the buyer's stock account, pinned by the buy.
    #[account(mut, address = buy.payee_out)]
    pub buyer_stock: UncheckedAccount<'info>,
    /// CHECK: the seller's stock account, pinned by the sell.
    #[account(mut, address = sell.payer_in)]
    pub seller_stock: UncheckedAccount<'info>,
    /// CHECK: the seller's quote account, pinned by the sell.
    #[account(mut, address = sell.payee_out)]
    pub seller_quote: UncheckedAccount<'info>,
    /// CHECK: validated against the buy, and through it the sell.
    #[account(address = buy.quote_mint)]
    pub quote_mint: UncheckedAccount<'info>,
    /// CHECK: validated against the buy, and through it the sell.
    #[account(address = buy.mint)]
    pub stock_mint: UncheckedAccount<'info>,
    /// CHECK: the program the quote leg moves under.
    pub quote_token_program: UncheckedAccount<'info>,
    /// CHECK: the program the stock leg moves under.
    pub stock_token_program: UncheckedAccount<'info>,
}

pub fn handle_cross_orders(ctx: Context<CrossOrders>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let a = &ctx.accounts;
    let (b, s, mark) = (&a.buy, &a.sell, &a.mark);

    // Both orders run the admission test a fill runs, in the same order, one
    // after the other. With no night opt-in passed, each is Strict and needs
    // the checker to say open, so a cross happens only in session, whatever
    // either owner has opted in to.
    for t in [
        Terms {
            not_before: b.not_before,
            expires_at: b.expires_at,
            expected_multiplier_bits: b.expected_multiplier_bits,
            quote_mint: b.quote_mint,
            max_conf_bps: b.max_conf_bps,
        },
        Terms {
            not_before: s.not_before,
            expires_at: s.expires_at,
            expected_multiplier_bits: s.expected_multiplier_bits,
            quote_mint: s.quote_mint,
            max_conf_bps: s.max_conf_bps,
        },
    ] {
        admit(&t, &a.symbol_state, &a.risk, mark, &a.check, None, now)?;
    }

    // How much crosses. The quote leads: `q` quote raw from the buyer buys
    // exactly `x = floor(q·r)` stock raw, which is the stock a fill of `q`
    // would owe the buyer at the mark, with no spread taken from it.
    //
    // `q` is the buyer's whole remainder, unless that would buy more stock
    // than the seller has left. Then it is `c`, the least quote that buys all
    // of the seller's remainder, rounded up. When the rate is above one, a
    // unit of quote buys several raw units of stock, `c` can buy more than
    // there is, and one unit less is taken: the most that stays within it.
    //
    // The seller is then paid `q` for `x`, and since `x·2^64 <= q·r`, `q` is
    // at least `ceil(x/r)`, the rounded-up value a sell fill owes. So each
    // side's rounding goes its own way, and neither is paid for out of the
    // other's minimum.
    let r = mark.rate_q64;
    let b_rem = b.amount_in.saturating_sub(b.filled_in);
    let s_rem = s.amount_in.saturating_sub(s.filled_in);
    let c = stock_to_quote_ceil(s_rem, r)?;
    let q_s = if mul_shr64(c, r)? > s_rem as u128 { c - 1 } else { c };
    let q = (b_rem as u128).min(q_s);
    let x = mul_shr64(q, r)?;

    // Something must trade on both legs, and at least each order's own
    // minimum fill, or its whole remainder if that is less.
    require!(q > 0 && x > 0, BellError::FillTooSmall);
    require!(
        q >= b.min_fill_in.min(b_rem) as u128 && x >= s.min_fill_in.min(s_rem) as u128,
        BellError::FillTooSmall
    );
    // `q <= b_rem` and `x <= s_rem`, so both fit the order's own width.
    let (q, x) = (q as u64, x as u64);

    // Each side's minimum, by the function its own fill uses, so a cross can
    // never clear an owner at a number their fill would refuse. At the mark
    // with no spread, each band is met by construction; the owners' own
    // floors are what can refuse here, and they are checked before anything
    // moves.
    let (_, min_stock) = buy_min_out(q, r, b.max_slip_bps, b.floor_rate_q64)?;
    let (_, min_quote) = sell_min_out(x, r, s.max_slip_bps, s.floor_rate_q64)?;
    require!(
        x as u128 >= min_stock && q as u128 >= min_quote,
        BellError::PriceOutOfBand
    );

    // Both legs are signed by a delegate authority, so both programs must be
    // real token programs before either is called.
    let quote_program = &a.quote_token_program;
    let stock_program = &a.stock_token_program;
    require!(is_token_program(quote_program.key), BellError::TokenProgramMismatch);
    require!(is_token_program(stock_program.key), BellError::TokenProgramMismatch);

    let quote_decimals = mint_decimals(&a.quote_mint)?;
    let stock_decimals = mint_decimals(&a.stock_mint)?;

    // The stock leg, signed by the seller's authority. The buyer must have
    // received at least their minimum, and the seller must have lost no more
    // than was asked of them: measured, not assumed, on both sides.
    let (sent, received) = move_leg(
        stock_program,
        &a.seller_stock,
        &a.stock_mint,
        &a.buyer_stock,
        &a.sell_auth,
        x,
        stock_decimals,
        &[&[AUTH_SEED, s.owner.as_ref(), &[s.auth_bump]]],
    )?;
    require!(received as u128 >= min_stock, BellError::PriceOutOfBand);
    require!(sent <= x, BellError::OverFill);

    // The quote leg, signed by the buyer's authority, measured the same way.
    let (sent, received) = move_leg(
        quote_program,
        &a.buyer_quote,
        &a.quote_mint,
        &a.seller_quote,
        &a.buy_auth,
        q,
        quote_decimals,
        &[&[AUTH_SEED, b.owner.as_ref(), &[b.auth_bump]]],
    )?;
    require!(received as u128 >= min_quote, BellError::PriceOutOfBand);
    require!(sent <= q, BellError::OverFill);

    let event = OrdersCrossed {
        symbol: b.symbol,
        buyer: b.owner,
        seller: s.owner,
        quote: q,
        stock: x,
        px_num: mark.px_num,
        px_expo: mark.px_expo,
        source: mark.source,
        mark_observed_at: mark.observed_at,
    };

    let a = &mut *ctx.accounts;
    a.buy.filled_in = a.buy.filled_in.saturating_add(q);
    a.sell.filled_in = a.sell.filled_in.saturating_add(x);
    let buy_done = a.buy.filled_in >= a.buy.amount_in;
    let sell_done = a.sell.filled_in >= a.sell.amount_in;

    emit!(event);

    // Each completed order closes, with its rent to its own owner, never to
    // the cranker. An order with a remainder stays open for the next cross or
    // a fill. Usually one side completes; with a rate above one the stock
    // moves in steps of more than one raw unit, so both can keep a remainder.
    if buy_done {
        a.buy.close(a.buyer.to_account_info())?;
    }
    if sell_done {
        a.sell.close(a.seller.to_account_info())?;
    }
    Ok(())
}
