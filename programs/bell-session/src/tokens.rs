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

use crate::error::BellError;

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

/// Deserialize a token account owned by either token program.
///
/// The owning program is checked by the caller against the program account it
/// will actually transfer through, so a token account cannot be read under one
/// program and moved under another.
pub fn read_token_account(info: &AccountInfo) -> Result<TokenAccountView> {
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

/// Balance only, for measuring a transfer's effect rather than trusting its
/// stated amount.
pub fn balance_of(info: &AccountInfo) -> Result<u64> {
    Ok(read_token_account(info)?.amount)
}
