use anchor_lang::prelude::*;

/// Every refusal is a distinct, machine-readable reason. Callers branch on
/// these; the human-facing explanation is built off-chain from the same code.
#[error_code]
pub enum BellError {
    /// Covers a shut session, an exchange halt and an issuer withdrawal alike;
    /// the attested `HaltState` says which. The message used to claim an
    /// exchange halt for all three — including SPYx on any weeknight.
    #[msg("Market is closed or trading in this security is stopped")]
    MarketClosed,
    #[msg("Session state is stale; treated as closed")]
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
    #[msg("Account is not owned by the token program it is claimed to belong to")]
    TokenProgramMismatch,
    /// Appended last so every existing code keeps its number.
    #[msg("The issuer's mint state has not been read recently enough to trust")]
    RiskStale,

    // --- the second opinion and night fills. Appended after RiskStale for the
    // --- same reason as above: every code before this line keeps its number.
    /// The last push moved the rate further than one step allows, so the mark
    /// is held at the rate before it until a push lands back inside the step.
    #[msg("The price mark is held: its last push moved further than one step allows")]
    MarkPaused,
    #[msg("Only the program's upgrade authority may do this")]
    NotAuthority,
    #[msg("Only the symbol's named checker may push its check")]
    NotChecker,
    #[msg("The checker's view is missing or too old to rely on")]
    CheckStale,
    #[msg("The checker disagrees about whether the market is open")]
    CheckerDisagrees,
    #[msg("The mark is too far from the checker's reference price")]
    MarkOffReference,

    // --- the opening cross. Appended after MarkOffReference for the same
    // --- reason; no code is reserved between the two, so this is 6033.
    /// A cross is a trade between two owners. An owner's buy crossed against
    /// their own sell trades nothing, yet would use up both orders, so any
    /// cranker could cancel a pair of one owner's orders by crossing them.
    #[msg("A buy and a sell of the same owner cannot cross")]
    SelfCross,
}
