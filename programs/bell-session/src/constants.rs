use anchor_lang::prelude::*;

#[constant]
pub const SYMBOL_SEED: &[u8] = b"sym";

#[constant]
pub const RISK_SEED: &[u8] = b"risk";

/// Ticker, space-padded. Long enough for the longest xStock symbol.
pub const SYMBOL_LEN: usize = 12;

/// Session state older than this is not evidence that the market is open.
/// The bound is deliberately tight: being wrong here means trading into a halt.
pub const MAX_STATE_AGE_SECONDS: i64 = 120;

/// No fills within this window either side of a rebase activation. Matches the
/// issuer's own guidance that venues pause around multiplier activation.
pub const REBASE_GUARD_SECONDS: i64 = 15 * 60;

#[constant]
pub const MARK_SEED: &[u8] = b"mark";

#[constant]
pub const ORDER_SEED: &[u8] = b"ord";

#[constant]
pub const AUTH_SEED: &[u8] = b"auth";

/// A price goes stale far faster than a session does.
///
/// This bound is also what makes "filled at a price that is sane *then*"
/// literally true rather than aspirational: Friday's mark is roughly sixty
/// hours old on Monday morning, so a weekend order cannot fill until a fresh
/// post-open mark lands. The gap is refused by arithmetic, not by judgement.
pub const MAX_MARK_AGE_SECONDS: i64 = 60;

/// Orders expire so the book cannot accumulate stale intent indefinitely.
pub const MAX_ORDER_LIFETIME_SECONDS: i64 = 7 * 24 * 3600;

/// Blast-radius bound while the program still carries an upgrade authority.
/// A malicious upgrade can move at most the delegated amount, and this caps it.
pub const MAX_ORDER_IN: u64 = 1_000_000_000;

/// Ceiling on the spread a client may authorise on the user's behalf.
pub const MAX_SLIP_BPS: u16 = 500;

/// Ceiling on the mark uncertainty a client may accept.
pub const MAX_CONF_BPS: u16 = 200;
