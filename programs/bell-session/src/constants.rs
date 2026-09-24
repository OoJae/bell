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

/// The furthest a mark may move in `MAX_MARK_AGE_SECONDS` of observed time.
///
/// A price is the one attested input that moves value, so a push that jumps
/// the rate further than any real stock moves that quickly is treated as a
/// fault in the attestor rather than as news. The limit is on the rate of
/// movement, not on each push: a push may move the mark by the share of this
/// step that the time since the observation on record has earned, so splitting
/// a jump into many pushes, in one transaction or one second, gains nothing.
/// The push is held rather than refused: a refusal would fail the keeper's
/// whole batch of marks, and would be bypassable by anyone who could make the
/// transaction fail differently. The held mark carries `conf_bps == u16::MAX`,
/// which every fill refuses.
///
/// This catches a faulty push, and slows a compromised attestor to one step a
/// minute. It does not stop one: what stops a walked mark from pricing a fill
/// is the checker's reference, `MAX_SESSION_GAP_BPS` and `MAX_NIGHT_GAP_BPS`.
#[constant]
pub const MAX_MARK_STEP_BPS: u16 = 500;

/// How recent the mark on record must be for the step limit to apply to it.
///
/// A mark older than this is no longer evidence of where the price is, so the
/// next push is accepted at any rate. Without this, a real overnight move
/// larger than the step would hold the mark forever. At least
/// `MAX_MARK_AGE_SECONDS`, so a mark is never fresh enough to price a fill and
/// yet too old to anchor the next push.
#[constant]
pub const MAX_MARK_STEP_AGE_SECONDS: i64 = 300;

const _: () = assert!(MAX_MARK_STEP_AGE_SECONDS >= MAX_MARK_AGE_SECONDS);

/// A second signer's view of the same symbol, from independent data.
#[constant]
pub const CHECK_SEED: &[u8] = b"check";

/// A per-owner opt-in to fills while the primary market is shut.
#[constant]
pub const NIGHT_SEED: &[u8] = b"night";

/// A check older than this is not a second opinion about now. The same bound
/// as a session, since it answers the same question from a different source.
#[constant]
pub const MAX_CHECK_AGE_SECONDS: i64 = 120;

/// In session the reference is the last sale, and a listed stock trades every
/// few seconds while the market is open, so a reference minutes old means the
/// checker's feed has stopped, not that the stock has. Without this bound a
/// checker that goes on pushing a fresh `observed_at` over a stuck feed would
/// keep agreeing with the attestor about a price from before the feed stopped.
/// At least `MAX_CHECK_AGE_SECONDS`, since a reference can be no newer than the
/// check that carries it, and no more than the night bound, since the session
/// is the regime with a live market to compare against.
#[constant]
pub const MAX_SESSION_REF_AGE_SECONDS: i64 = 300;

/// At night the reference is the last sale, which stops moving at the close.
/// Twelve hours covers a weeknight from the close to the next pre-market, and
/// refuses a Friday close on Sunday night or on Monday morning.
#[constant]
pub const MAX_NIGHT_REF_AGE_SECONDS: i64 = 43_200;

const _: () = assert!(
    MAX_SESSION_REF_AGE_SECONDS >= MAX_CHECK_AGE_SECONDS
        && MAX_SESSION_REF_AGE_SECONDS <= MAX_NIGHT_REF_AGE_SECONDS
);

/// How far the mark may sit from the checker's reference while the market is
/// open. Wide enough for the spread between an executable ask and a last sale
/// in a moving market, narrow enough that one signer alone cannot price a fill.
#[constant]
pub const MAX_SESSION_GAP_BPS: u16 = 300;

/// The same distance at night, when nothing can arbitrage a wrong mark back.
/// Also the discount on the reference that sets a night fill's third minimum.
#[constant]
pub const MAX_NIGHT_GAP_BPS: u16 = 150;

// Night is the riskier regime, so its band can never be the wider one.
const _: () = assert!(MAX_NIGHT_GAP_BPS <= MAX_SESSION_GAP_BPS);

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
