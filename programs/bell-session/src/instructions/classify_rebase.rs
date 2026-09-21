use anchor_lang::prelude::*;

use crate::{
    constants::RISK_SEED,
    error::BellError,
    state::{RebaseKind, SymbolState, TokenRisk},
};

/// Record whether a pending multiplier change is a split or a dividend.
///
/// This cannot be derived from the mint alone: both arrive as a multiplier
/// change and the extension data is identical in shape. The distinction is
/// economic — a split moves the reference price proportionally and leaves
/// value-per-raw-unit invariant, a dividend does not — so it takes an outside
/// observation to establish.
///
/// It is therefore attested rather than proven, and the guard refuses to trade
/// anything still marked `Unknown`. Being unable to classify an event is a
/// reason not to trade, never a reason to proceed.
#[derive(Accounts)]
pub struct ClassifyRebase<'info> {
    pub attestor: Signer<'info>,
    #[account(
        constraint = symbol_state.mint == risk.mint @ BellError::MintMismatch,
        constraint = symbol_state.attestor == attestor.key() @ BellError::NotAttestor,
    )]
    pub symbol_state: Account<'info, SymbolState>,
    #[account(
        mut,
        seeds = [RISK_SEED, risk.mint.as_ref()],
        bump = risk.bump,
    )]
    pub risk: Account<'info, TokenRisk>,
}

pub fn handle_classify_rebase(ctx: Context<ClassifyRebase>, kind: RebaseKind) -> Result<()> {
    ctx.accounts.risk.rebase_kind = kind;
    Ok(())
}
