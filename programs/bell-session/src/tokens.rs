//! Reading SPL token accounts without trusting anybody about them.
//!
//! The two sides of a trade live under different programs: the quote asset
//! (USDC) is plain SPL Token, while every tokenized security here is
//! Token-2022. `StateWithExtensions` reads both — a classic token account is
//! simply one with no extensions — so one helper covers both legs.

use anchor_lang::prelude::*;
use spl_token_2022::{
    extension::StateWithExtensions,
    state::{Account as SplAccount, AccountState},
};

use crate::{constants::is_token_program, error::BellError};

/// The fields of a token account this program cares about.
pub struct TokenAccountView {
    pub mint: Pubkey,
    pub owner: Pubkey,
    pub amount: u64,
    pub delegate: Option<Pubkey>,
    pub delegated_amount: u64,
    pub frozen: bool,
}

/// anchor-lang and spl-token-2022 carry different `Pubkey` types. Bridging by
/// bytes avoids naming either of them, which keeps this working across the
/// version skew between the two crates.
macro_rules! bridge {
    ($k:expr) => {
        Pubkey::new_from_array($k.to_bytes())
    };
}

/// Deserialize a token account, checking who owns it first.
///
/// The owner check is here rather than left to callers. The previous comment
/// claimed the caller verified it; no caller did, which meant every
/// owner/mint/delegate fact this function returns could be fabricated by
/// handing it an account owned by any program at all — including one written
/// for the purpose. A reader that the rest of the program trusts for
/// authorisation decisions has to establish that itself.
///
/// `expect` is the program the account will actually be moved under, so an
/// account cannot be read under one token program and transferred under
/// another.
pub fn read_token_account(info: &AccountInfo, expect: &Pubkey) -> Result<TokenAccountView> {
    require!(is_token_program(expect), BellError::TokenProgramMismatch);
    require_keys_eq!(*info.owner, *expect, BellError::TokenProgramMismatch);
    let data = info.try_borrow_data()?;
    let acc = StateWithExtensions::<SplAccount>::unpack(&data)
        .map_err(|_| error!(BellError::QuoteMintMismatch))?;
    let base = acc.base;
    // `COption`, whose inner type is the other crate's Pubkey. Converted
    // through inference so neither type has to be named — spl-token-2022 does
    // not re-export the crate `COption` comes from, and adding a dependency
    // just to spell a type would be a worse trade than this line.
    let delegate = if base.delegate.is_some() {
        Some(bridge!(base.delegate.unwrap()))
    } else {
        None
    };
    Ok(TokenAccountView {
        mint: bridge!(base.mint),
        owner: bridge!(base.owner),
        amount: base.amount,
        delegate,
        delegated_amount: base.delegated_amount,
        frozen: base.state == AccountState::Frozen,
    })
}

/// Read a token account without knowing in advance which token program holds
/// it, requiring only that it is genuinely one of the two.
///
/// Used where the leg's program is not an account in the context — placing and
/// cancelling an order — and the question is simply "is this a real token
/// account, owned by this user, of this mint". `fill_order` uses the pinned
/// form instead, because there the program is chosen by the filler and has to
/// match the account it is about to move.
pub fn read_token_account_any(info: &AccountInfo) -> Result<TokenAccountView> {
    require!(is_token_program(info.owner), BellError::TokenProgramMismatch);
    let expect = *info.owner;
    read_token_account(info, &expect)
}

/// Balance only, for measuring a transfer's effect rather than trusting its
/// stated amount.
pub fn balance_of(info: &AccountInfo, expect: &Pubkey) -> Result<u64> {
    Ok(read_token_account(info, expect)?.amount)
}
