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

    // --- queue. Appended, never reordered: the client decodes a custom error
    // --- by its offset from 6000, so inserting above would silently remap
    // --- every existing code.
    #[msg("The price mark is stale")]
    MarkStale,
    #[msg("The mark's uncertainty exceeds what this order accepts")]
    MarkTooWide,
    #[msg("Delivered less than the order's minimum acceptable output")]
    PriceOutOfBand,
    #[msg("The order is not yet due to fill")]
    NotYetDue,
    #[msg("The order has expired")]
    OrderExpired,
    #[msg("Fill exceeds the amount remaining on this order")]
    OverFill,
    #[msg("Fill is smaller than the order's minimum")]
    FillTooSmall,
    #[msg("The quote account is not delegated to this order's authority")]
    DelegationMissing,
    #[msg("Token account mint does not match")]
    QuoteMintMismatch,
    #[msg("Only the order owner may do this while the order is live")]
    NotOrderOwner,
    #[msg("Order amount is outside the permitted range")]
    AmountTooLarge,
    #[msg("Arithmetic overflow")]
    MathOverflow,
    #[msg("Parameter outside the permitted range")]
    BadParameters,
    #[msg("Token account owner does not match")]
    TokenOwnerMismatch,
}
