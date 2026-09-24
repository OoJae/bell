//! The one admission test every fill runs, before a single unit moves.
//!
//! A buy fill and a sell fill ask exactly the same questions of an order, the
//! gate, the mark and the check, so they ask them here, in one place, in one
//! order. Two copies of a safety check are two things to keep in sync, and the
//! second copy is where the bug lives. Kept out of line so both handlers share
//! one body in the binary rather than each carrying a copy.

use anchor_lang::prelude::*;

use crate::{
    constants::{
        MAX_CHECK_AGE_SECONDS, MAX_MARK_AGE_SECONDS, MAX_NIGHT_GAP_BPS, MAX_NIGHT_REF_AGE_SECONDS,
        MAX_SESSION_GAP_BPS, MAX_SESSION_REF_AGE_SECONDS,
    },
    error::BellError,
    instructions::{
        assert_tradeable::{check_tradeable, Mode},
        night::opted_in,
    },
    state::{SymbolCheck, SymbolMark, SymbolState, TokenRisk},
};

/// The parts of an order that admission reads. Both order types carry these
/// fields under the same names, so either one fills this in.
pub(crate) struct Terms {
    pub not_before: i64,
    pub expires_at: i64,
    pub expected_multiplier_bits: u64,
    pub quote_mint: Pubkey,
    pub max_conf_bps: u16,
}

/// Decide whether an order may fill now, and whether it fills as a night fill.
///
/// `night` is the account offered as the owner's opt-in, with the order's
/// owner, or `None` for a caller that never fills at night. With `None` the gate is always `Strict`, exactly as it was
/// before night mode existed. Returns `true` for a night fill, which the caller
/// must then hold to the reference-anchored minimum as well as its own.
///
/// The order of the checks is the order of the refusal a user sees, most
/// fundamental first: whether the order is due at all, then whether the market
/// may trade, then whether the price is usable, then whether the second signer
/// agrees with it.
#[inline(never)]
pub(crate) fn admit(
    t: &Terms,
    s: &SymbolState,
    r: &TokenRisk,
    mark: &SymbolMark,
    check: &SymbolCheck,
    night: Option<(&AccountInfo, &Pubkey)>,
    now: i64,
) -> Result<bool> {
    // 1. Due, and not yet lapsed.
    require!(now >= t.not_before, BellError::NotYetDue);
    require!(now < t.expires_at, BellError::OrderExpired);

    // 2. The identical gate assert_tradeable runs, so a refused fill and a
    //    refused swap decode the same way. A session fill is Strict: it fills
    //    only while the primary market is live, which is what keeps a wrong
    //    mark arbitrageable. Only an owner who opted in fills while it is shut,
    //    and then as Guarded, which lifts gate 7 alone: a halt, a stale
    //    session, a pause, a rebase window, a moved multiplier and an armed
    //    hook all refuse a night fill exactly as they refuse a session fill.
    let night = !s.open_now && night.is_some_and(|(n, owner)| opted_in(n, owner));
    check_tradeable(
        s,
        r,
        if night { Mode::Guarded } else { Mode::Strict },
        t.expected_multiplier_bits,
        now,
    )?;

    // 3. The mark: the right asset, recent, not held by the step limit, and no
    //    less certain than the order accepts. A held mark reports as held
    //    rather than as too wide, since its marker is also the widest value.
    require!(
        mark.quote_mint == t.quote_mint,
        BellError::QuoteMintMismatch
    );
    require!(
        now.saturating_sub(mark.observed_at) <= MAX_MARK_AGE_SECONDS,
        BellError::MarkStale
    );
    require!(mark.conf_bps != u16::MAX, BellError::MarkPaused);
    require!(mark.conf_bps <= t.max_conf_bps, BellError::MarkTooWide);

    // 4. The second signer. Recent enough to be a view of now.
    require!(
        now.saturating_sub(check.observed_at) <= MAX_CHECK_AGE_SECONDS,
        BellError::CheckStale
    );
    // Agreeing about the session: open for a session fill, closed for a night
    // fill. At night this is what separates "closed" from the attestor's "no
    // opinion" or "sources conflict", both of which also arrive as
    // `open_now: false` and neither of which means closed.
    require!(check.open_now != night, BellError::CheckerDisagrees);
    // The sale behind the reference has to be recent too. At night it is the
    // close, and it has to be tonight's close. In session it is the last sale
    // of a stock that trades every few seconds, so an old one means the
    // checker's feed has stopped even though its pushes have not.
    let ref_age = if night {
        MAX_NIGHT_REF_AGE_SECONDS
    } else {
        MAX_SESSION_REF_AGE_SECONDS
    };
    require!(
        now.saturating_sub(check.ref_at) <= ref_age,
        BellError::CheckStale
    );
    // A check that has never carried a price has nothing to agree with.
    require!(check.ref_rate_q64 > 0, BellError::CheckStale);
    // And agreeing about the price, inside a band that is tighter at night,
    // when no live market pulls a wrong mark back.
    let gap_bps = if night {
        MAX_NIGHT_GAP_BPS
    } else {
        MAX_SESSION_GAP_BPS
    };
    require!(
        mark.rate_q64.abs_diff(check.ref_rate_q64)
            <= (check.ref_rate_q64 / 10_000) * gap_bps as u128,
        BellError::MarkOffReference
    );

    Ok(night)
}
