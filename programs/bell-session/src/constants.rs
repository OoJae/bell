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
