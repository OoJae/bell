//! Night mode: an owner's opt-in to fills while the primary market is shut.
//!
//! By default a bell order fills only in session, where a wrong mark can be
//! arbitraged against a live market. At night nothing does that, so an owner
//! who wants night fills says so once, and every night fill then has to clear
//! more than a session fill does: the checker must agree the market is closed,
//! its reference must be recent, the mark must sit inside a tighter band of
//! it, and the fill must also clear a minimum set from the reference itself.

use anchor_lang::prelude::*;
use anchor_lang::Discriminator;

use crate::{constants::NIGHT_SEED, state::NightOptIn};

/// Consent to night fills, for every order this owner has or will place.
///
/// That includes orders already live, because an order placed from the web
/// carries `not_before: 0` and so is due whenever the gate allows. A client
/// must say so before the owner signs.
#[derive(Accounts)]
pub struct OptInNight<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        init,
        payer = owner,
        space = 8 + NightOptIn::INIT_SPACE,
        seeds = [NIGHT_SEED, owner.key().as_ref()],
        bump,
    )]
    pub night: Account<'info, NightOptIn>,
    pub system_program: Program<'info, System>,
}

pub fn handle_opt_in_night(ctx: Context<OptInNight>) -> Result<()> {
    let n = &mut ctx.accounts.night;
    n.owner = ctx.accounts.owner.key();
    n.created_at = Clock::get()?.unix_timestamp;
    n.bump = ctx.bumps.night;
    Ok(())
}

/// Withdraw consent, and take the rent back. Takes effect for every live
/// order at once, since a fill reads only whether the opt-in exists.
#[derive(Accounts)]
pub struct OptOutNight<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        mut,
        seeds = [NIGHT_SEED, owner.key().as_ref()],
        bump = night.bump,
        close = owner,
    )]
    pub night: Account<'info, NightOptIn>,
}

pub fn handle_opt_out_night(_ctx: Context<OptOutNight>) -> Result<()> {
    Ok(())
}

/// Whether the account a fill was handed is `owner`'s live opt-in.
///
/// Three questions, each answered by the account itself. Is it ours: only this
/// program can write an account it owns. Is it an opt-in: only `opt_in_night`
/// creates an account with this discriminator. Is it this owner's: that
/// instruction records its signer as `owner` and nothing ever rewrites it. So
/// an account that passes all three is the one at `[NIGHT_SEED, owner]`, and
/// the fill need not pay to derive that address. A closed opt-in belongs to
/// the system program with no data, and reads as no, as does a stranger's.
pub(crate) fn opted_in(night: &AccountInfo, owner: &Pubkey) -> bool {
    night.owner == &crate::ID
        && night
            .try_borrow_data()
            .map(|d| {
                d.starts_with(NightOptIn::DISCRIMINATOR)
                    && d.get(8..40) == Some(owner.as_ref())
            })
            .unwrap_or(false)
}
