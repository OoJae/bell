use anchor_lang::prelude::*;

use crate::{
    constants::RISK_SEED,
    error::BellError,
    state::{RebaseKind, TokenRisk},
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
/// The authority is read from `TokenRisk` itself, not from a `SymbolState`.
///
/// It used to be taken from a `SymbolState` that carried no seed constraint,
/// which was exploitable: `register_symbol` is permissionless and takes both
/// the mint and the attestor as caller-supplied arguments, so anyone could
/// register an unused ticker naming a real mint with themselves as attestor,
/// and then write `rebase_kind` on that mint's shared `TokenRisk`. Setting
/// `Unknown` froze every symbol on the mint; clearing it to `Split` disarmed
/// gate 4 during exactly the corporate action the gate exists to refuse.
///
/// `TokenRisk` is per-mint and `rebase_kind` is a fact about the mint, so the
/// symbol was never the right place to look. Dropping the account removes the
/// crossover rather than constraining it.
#[derive(Accounts)]
pub struct ClassifyRebase<'info> {
    #[account(constraint = risk.attestor == attestor.key() @ BellError::NotAttestor)]
    pub attestor: Signer<'info>,
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
