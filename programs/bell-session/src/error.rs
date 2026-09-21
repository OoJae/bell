use anchor_lang::prelude::*;

/// Every refusal is a distinct, machine-readable reason. Callers branch on
/// these; the human-facing explanation is built off-chain from the same code.
#[error_code]
pub enum BellError {
    #[msg("Primary listing exchange has halted or suspended this security")]
    MarketClosed,
    #[msg("Session state is stale; treated as halted")]
    StateStale,
    #[msg("Issuer has paused this mint")]
    IssuerPaused,
    #[msg("A scheduled rebase activates inside the guard window")]
    RebasePending,
    #[msg("Pending corporate action is neither a split nor a dividend")]
    RebaseUnclassified,
    #[msg("The multiplier changed after this order was built")]
    MultiplierMoved,
    #[msg("A transfer hook is armed on this mint")]
    HookArmed,
    #[msg("Mint is not owned by the Token-2022 program")]
    NotToken2022,
    #[msg("Symbol does not match the mint recorded for it")]
    MintMismatch,
    #[msg("Only the registered attestor may push session state")]
    NotAttestor,
    #[msg("Attested timestamp is in the future")]
    TimestampInFuture,
}
