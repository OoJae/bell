//! The checker: a second signer, with independent data, that every fill needs
//! to agree with the mark.
//!
//! The attestor signs both the session and the price, so without this one key
//! could open the market and set the rate a fill settles at. The check is a
//! second opinion on the same two questions, from a different key and a
//! different source: is the primary market open, and roughly what is the stock
//! worth. A fill goes ahead only when the two agree. See `admit`.
//!
//! Every fill and every cross fails closed until a symbol's check exists and
//! is being pushed, and only the upgrade authority can open one. So the order
//! of the rollout is part of the design, not a detail of it:
//!
//! 1. Upgrade the program. From here the fifteen-account fills fail with
//!    3005, so the clients below ship with it.
//! 2. `open_check` for every registered symbol, while the authority can still
//!    sign: the deploy key, or the multisig once the authority has moved there.
//! 3. Start the checker, from its own key and its own price source.
//! 4. Ship the seventeen-account fills and the cross builder.
//! 5. Only then move or burn the authority.
//!
//! Burning the authority freezes the set of checkers for good: there is no
//! rotation instruction, and one gated on the authority would stop working at
//! the same moment. A symbol whose check was never opened, or whose checker
//! key is lost or turns hostile after the burn, stays shut for good. Before a
//! burn, every checker key has to be one the operators are content to live
//! with forever. Until then, the remedy for a lost or hostile checker is an
//! upgrade.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::bpf_loader_upgradeable;

use crate::{
    constants::{CHECK_SEED, SYMBOL_LEN, SYMBOL_SEED},
    error::BellError,
    state::{SymbolCheck, SymbolState},
};

/// Create the check for a symbol and name its checker, once.
///
/// Only the program's upgrade authority may do this. The attestor must not be
/// the one to choose who checks it, and the authority is the one key already
/// trusted more than the attestor, since it can replace the program outright.
/// There is no instruction to rotate the checker: changing it takes the same
/// authority, through an upgrade, in public.
#[derive(Accounts)]
#[instruction(symbol: [u8; SYMBOL_LEN])]
pub struct OpenCheck<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub authority: Signer<'info>,
    /// CHECK: this program's ProgramData account, verified in the handler by
    /// address, owner and contents rather than deserialized, which keeps the
    /// loader's state type out of the binary.
    pub program_data: UncheckedAccount<'info>,
    #[account(
        seeds = [SYMBOL_SEED, symbol.as_ref()],
        bump = symbol_state.bump,
    )]
    pub symbol_state: Account<'info, SymbolState>,
    #[account(
        init,
        payer = payer,
        space = 8 + SymbolCheck::INIT_SPACE,
        seeds = [CHECK_SEED, symbol.as_ref()],
        bump,
    )]
    pub check: Account<'info, SymbolCheck>,
    pub system_program: Program<'info, System>,
}

pub fn handle_open_check(
    ctx: Context<OpenCheck>,
    symbol: [u8; SYMBOL_LEN],
    checker: Pubkey,
) -> Result<()> {
    // The ProgramData account is the one place the upgrade authority is
    // recorded. It is found by its address, derived from this program's id
    // under the upgradeable loader, so no other account can stand in for it,
    // and it must still belong to that loader.
    let pd = &ctx.accounts.program_data;
    let (expected, _) =
        Pubkey::find_program_address(&[crate::ID.as_ref()], &bpf_loader_upgradeable::ID);
    require!(
        pd.key() == expected && *pd.owner == bpf_loader_upgradeable::ID,
        BellError::NotAuthority
    );

    // Read by bytes: the ProgramData variant tag (3) as a little-endian u32,
    // the deployment slot, then an optional authority whose tag is 1 when one
    // is set. A program made immutable has no authority, so nobody can open a
    // check on it, which is the right answer for a program nobody controls.
    let data = pd.try_borrow_data()?;
    require!(
        data.len() >= 45
            && data[0..4] == [3, 0, 0, 0]
            && data[12] == 1
            && data[13..45] == ctx.accounts.authority.key().to_bytes(),
        BellError::NotAuthority
    );

    // The whole value of a second signer is that it is a different key. The
    // default key is refused too, since nobody holds it and a check that can
    // never be pushed would hold the symbol shut for good.
    let s = &ctx.accounts.symbol_state;
    require!(
        checker != s.attestor && checker != Pubkey::default(),
        BellError::BadParameters
    );

    let c = &mut ctx.accounts.check;
    c.symbol = symbol;
    c.mint = s.mint;
    c.checker = checker;
    // Opens saying nothing: closed, no reference, never observed. Every fill
    // reads that as stale until the checker has actually pushed.
    c.open_now = false;
    c.ref_rate_q64 = 0;
    c.ref_px_num = 0;
    c.ref_px_expo = 0;
    c.ref_at = 0;
    c.observed_at = 0;
    c.bump = ctx.bumps.check;
    Ok(())
}

/// Push the checker's view of a symbol.
#[derive(Accounts)]
#[instruction(symbol: [u8; SYMBOL_LEN])]
pub struct PushCheck<'info> {
    pub checker: Signer<'info>,
    #[account(
        mut,
        seeds = [CHECK_SEED, symbol.as_ref()],
        bump = check.bump,
        constraint = check.checker == checker.key() @ BellError::NotChecker,
    )]
    pub check: Account<'info, SymbolCheck>,
}

#[allow(clippy::too_many_arguments)]
pub fn handle_push_check(
    ctx: Context<PushCheck>,
    _symbol: [u8; SYMBOL_LEN],
    open_now: bool,
    ref_rate_q64: u128,
    ref_px_num: u64,
    ref_px_expo: i32,
    ref_at: i64,
    observed_at: i64,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    // The same rule as every attested time: a future one would buy free
    // freshness.
    require!(observed_at <= now, BellError::TimestampInFuture);
    // A sale cannot be later than the observation that reports it, and a
    // reference with no price is not a reference.
    require!(ref_at <= observed_at, BellError::BadParameters);
    require!(ref_rate_q64 > 0, BellError::BadParameters);

    // An older observation than the one on record is ignored, as on the mark,
    // so a late retry can neither roll the check back nor fail a batch.
    let c = &mut ctx.accounts.check;
    if observed_at < c.observed_at {
        return Ok(());
    }
    c.open_now = open_now;
    c.ref_rate_q64 = ref_rate_q64;
    c.ref_px_num = ref_px_num;
    c.ref_px_expo = ref_px_expo;
    c.ref_at = ref_at;
    c.observed_at = observed_at;
    Ok(())
}
