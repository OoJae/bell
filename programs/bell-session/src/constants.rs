use anchor_lang::prelude::*;

#[constant]
pub const SYMBOL_SEED: &[u8] = b"sym";

#[constant]
pub const RISK_SEED: &[u8] = b"risk";

/// Ticker, space-padded. Long enough for the longest xStock symbol.
pub const SYMBOL_LEN: usize = 12;

/// Session state older than this is not evidence that the market is open.
/// The bound is deliberately tight: being wrong here means trading into a halt.
#[constant]
pub const MAX_STATE_AGE_SECONDS: i64 = 120;

/// No fills within this window either side of a rebase activation. Matches the
/// issuer's own guidance that venues pause around multiplier activation.
#[constant]
pub const REBASE_GUARD_SECONDS: i64 = 15 * 60;

/// A `TokenRisk` read from its mint longer ago than this is not evidence of the
/// mint's current state.
///
/// Gates 3-6 are proven from the mint — pause, rebase, multiplier, hook — but a
/// proof is only as current as the read it came from, and until this bound
/// existed nothing required the read to be recent. On the live deployment it
/// was not: for its first day nobody refreshed the record at all.
///
/// Why 600, from both sides:
/// - **At most `REBASE_GUARD_SECONDS`.** A record read before an activation can
///   then never still pass once the post-activation window closes — past T+900
///   it is more than 900s old, so it is stale. Gate 4's second half holds even
///   if every refresher stops.
/// - **At least `MAX_STATE_AGE_SECONDS`.** A keeper that dies stops both the
///   session push and the refresh; the session goes stale first and the refusal
///   reads `StateStale`. `RiskStale` appears only when attestations land but
///   refreshes do not — exactly the failure it exists to catch.
#[constant]
pub const MAX_RISK_AGE_SECONDS: i64 = 600;

// The two inequalities above, checked by the compiler rather than a comment.
const _: () = assert!(
    MAX_RISK_AGE_SECONDS <= REBASE_GUARD_SECONDS && MAX_RISK_AGE_SECONDS >= MAX_STATE_AGE_SECONDS
);

#[constant]
pub const MARK_SEED: &[u8] = b"mark";

#[constant]
pub const ORDER_SEED: &[u8] = b"ord";

#[constant]
pub const AUTH_SEED: &[u8] = b"auth";

/// Sell orders live under their own seed rather than sharing `ORDER_SEED`, so a
/// buy and a sell with the same nonce are two different accounts and neither
/// side's client has to know which nonces the other has used.
#[constant]
pub const SELL_SEED: &[u8] = b"sell";

/// A price goes stale far faster than a session does.
///
/// This bound is also what makes "filled at a price that is sane *then*"
/// literally true rather than aspirational: Friday's mark is roughly sixty
/// hours old on Monday morning, so a weekend order cannot fill until a fresh
/// post-open mark lands. The gap is refused by arithmetic, not by judgement.
#[constant]
pub const MAX_MARK_AGE_SECONDS: i64 = 60;

/// Orders expire so the book cannot accumulate stale intent indefinitely.
#[constant]
pub const MAX_ORDER_LIFETIME_SECONDS: i64 = 7 * 24 * 3600;

/// Blast-radius bound while the program still carries an upgrade authority.
/// A malicious upgrade can move at most the delegated amount, and this caps it.
pub const MAX_ORDER_IN: u64 = 1_000_000_000;

/// Ceiling on the spread a client may authorise on the user's behalf.
#[constant]
pub const MAX_SLIP_BPS: u16 = 500;

/// Ceiling on the mark uncertainty a client may accept.
#[constant]
pub const MAX_CONF_BPS: u16 = 200;

/// The only two programs a token leg may move under.
///
/// `fill_order` takes each leg's program as an account and hands it a CPI
/// signed by the per-owner delegate authority. An unconstrained program there
/// is an arbitrary callee holding one of this program's PDA signatures, which
/// is a primitive worth refusing to create even where the post-transfer
/// measurement already bounds what it could take.
pub const SPL_TOKEN: Pubkey = pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
pub const SPL_TOKEN_2022: Pubkey = pubkey!("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

/// True for the two token programs and nothing else.
pub fn is_token_program(k: &Pubkey) -> bool {
    *k == SPL_TOKEN || *k == SPL_TOKEN_2022
}
