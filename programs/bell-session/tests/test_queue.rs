//! The bell-order queue: place, cancel, and fill.
//!
//! Token accounts are constructed directly rather than minted through CPIs —
//! the SPL layout is fixed and public, and building it here keeps every test a
//! single deterministic transaction with no setup chain to go wrong. The stock
//! leg still points at the **real mainnet AAPLx mint**, so the gate reads
//! genuine issuer state.

use {
    anchor_lang::{
        prelude::Pubkey,
        solana_program::{instruction::Instruction, system_program},
        AccountDeserialize, InstructionData, ToAccountMetas,
    },
    anchor_lang::solana_program::clock::Clock,
    bell_session::{
        constants::{AUTH_SEED, MARK_SEED, ORDER_SEED, RISK_SEED, SYMBOL_LEN, SYMBOL_SEED},
        error::BellError,
        state::{BellOrder, HaltState, HoursMode, MarkSource},
    },
    litesvm::LiteSVM,
    solana_account::Account,
    solana_keypair::Keypair,
    solana_message::{Message, VersionedMessage},
    solana_signer::Signer,
    solana_transaction::versioned::VersionedTransaction,
};

const NOW: i64 = 1_790_000_000;
const AAPLX: &str = "XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp";
const TOKEN: Pubkey = Pubkey::new_from_array([
    6, 221, 246, 225, 215, 101, 161, 147, 217, 203, 225, 70, 206, 235, 121, 172, 28, 180, 133, 237,
    95, 91, 55, 145, 58, 140, 245, 133, 126, 255, 0, 169,
]); // TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA

fn token_2022() -> Pubkey {
    Pubkey::new_from_array(spl_token_2022::ID.to_bytes())
}

/// SPL Memo v3, which LiteSVM loads by default. Stands in for "any program that
/// is not a token program": real and executable, so a refusal naming it cannot
/// be the runtime rejecting a call into an account that holds no code.
fn memo() -> Pubkey {
    "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr".parse().unwrap()
}

/// A 165-byte SPL token account. The layout is stable and documented; writing
/// it directly avoids a chain of setup transactions in every test.
fn token_account(mint: &Pubkey, owner: &Pubkey, amount: u64, delegate: Option<(&Pubkey, u64)>) -> Vec<u8> {
    let mut d = vec![0u8; 165];
    d[0..32].copy_from_slice(&mint.to_bytes());
    d[32..64].copy_from_slice(&owner.to_bytes());
    d[64..72].copy_from_slice(&amount.to_le_bytes());
    if let Some((del, amt)) = delegate {
        d[72..76].copy_from_slice(&1u32.to_le_bytes()); // COption::Some
        d[76..108].copy_from_slice(&del.to_bytes());
        d[121..129].copy_from_slice(&amt.to_le_bytes());
    }
    d[108] = 1; // AccountState::Initialized
    d
}

/// An 82-byte SPL mint.
fn mint_account(decimals: u8) -> Vec<u8> {
    let mut d = vec![0u8; 82];
    d[44] = decimals;
    d[45] = 1; // is_initialized
    d
}

struct Ctx {
    svm: LiteSVM,
    payer: Keypair,
    program_id: Pubkey,
    quote_mint: Pubkey,
    stock_mint: Pubkey,
    attestor: Keypair,
    user: Keypair,
    filler: Keypair,
}

impl Ctx {
    fn new() -> Self {
        let program_id = bell_session::id();
        let mut svm = LiteSVM::new();
        svm.add_program(
            program_id,
            include_bytes!(concat!(env!("CARGO_TARGET_TMPDIR"), "/../deploy/bell_session.so")),
        )
        .unwrap();
        let mut clock: Clock = svm.get_sysvar();
        clock.unix_timestamp = NOW;
        svm.set_sysvar(&clock);

        let payer = Keypair::new();
        let attestor = Keypair::new();
        let user = Keypair::new();
        let filler = Keypair::new();
        for k in [&payer, &attestor, &user, &filler] {
            svm.airdrop(&k.pubkey(), 10_000_000_000).unwrap();
        }

        // Quote leg: a plain 6-decimal mint, as USDC is.
        let quote_mint = Pubkey::new_unique();
        svm.set_account(
            quote_mint,
            Account { lamports: 1_000_000_000, data: mint_account(6), owner: TOKEN, executable: false, rent_epoch: 0 },
        )
        .unwrap();

        // Stock leg: the real Apple xStock mint, byte for byte.
        let stock_mint: Pubkey = AAPLX.parse().unwrap();
        svm.set_account(
            stock_mint,
            Account {
                lamports: 1_000_000_000,
                data: include_bytes!("fixtures/aaplx.bin").to_vec(),
                owner: token_2022(),
                executable: false,
                rent_epoch: 0,
            },
        )
        .unwrap();

        Self { svm, payer, program_id, quote_mint, stock_mint, attestor, user, filler }
    }

    fn send(&mut self, ixs: &[Instruction], signers: &[&Keypair]) -> Result<(), String> {
        self.send_logged(ixs, signers).0
    }

    /// `send`, keeping the program logs, which record every program invoked —
    /// including inside a transaction that was then rolled back.
    fn send_logged(&mut self, ixs: &[Instruction], signers: &[&Keypair]) -> (Result<(), String>, Vec<String>) {
        // Retrying the *same* instruction after changing chain state is normal
        // here — a fill refused for a stale mark and then retried against a
        // fresh one is byte-identical. Advance the blockhash so the runtime
        // sees a new transaction rather than a replay.
        self.svm.expire_blockhash();
        let bh = self.svm.latest_blockhash();
        let msg = Message::new_with_blockhash(ixs, Some(&self.payer.pubkey()), &bh);
        let mut all: Vec<&Keypair> = vec![&self.payer];
        all.extend_from_slice(signers);
        let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), &all).unwrap();
        match self.svm.send_transaction(tx) {
            Ok(meta) => (Ok(()), meta.logs),
            Err(failed) => (Err(format!("{:?}", failed.err)), failed.meta.logs),
        }
    }

    fn warp(&mut self, to: i64) {
        let mut c: Clock = self.svm.get_sysvar();
        c.unix_timestamp = to;
        self.svm.set_sysvar(&c);
    }

    fn pda(&self, seeds: &[&[u8]]) -> Pubkey {
        Pubkey::find_program_address(seeds, &self.program_id).0
    }
    fn sym_pda(&self) -> Pubkey { self.pda(&[SYMBOL_SEED, &sym()]) }
    fn risk_pda(&self) -> Pubkey { self.pda(&[RISK_SEED, self.stock_mint.as_ref()]) }
    fn mark_pda(&self) -> Pubkey { self.pda(&[MARK_SEED, &sym()]) }
    fn auth_pda(&self) -> Pubkey { self.pda(&[AUTH_SEED, self.user.pubkey().as_ref()]) }
    fn order_pda(&self, nonce: u64) -> Pubkey {
        self.pda(&[ORDER_SEED, self.user.pubkey().as_ref(), &nonce.to_le_bytes()])
    }

    fn set_token(&mut self, key: Pubkey, mint: &Pubkey, owner: &Pubkey, amount: u64, delegate: Option<(&Pubkey, u64)>, program: Pubkey) {
        self.svm
            .set_account(key, Account {
                lamports: 1_000_000_000,
                data: token_account(mint, owner, amount, delegate),
                owner: program,
                executable: false,
                rent_epoch: 0,
            })
            .unwrap();
    }

    fn balance(&self, key: &Pubkey) -> u64 {
        let a = self.svm.get_account(key).unwrap();
        u64::from_le_bytes(a.data[64..72].try_into().unwrap())
    }

    /// What the delegate may still move out of a token account.
    fn delegated(&self, key: &Pubkey) -> u64 {
        let a = self.svm.get_account(key).unwrap();
        u64::from_le_bytes(a.data[121..129].try_into().unwrap())
    }

    /// The order, or `None` once it has been closed.
    fn order(&self, nonce: u64) -> Option<BellOrder> {
        self.svm
            .get_account(&self.order_pda(nonce))
            .filter(|a| !a.data.is_empty())
            .map(|a| BellOrder::try_deserialize(&mut &a.data[..]).unwrap())
    }
}

fn sym() -> [u8; SYMBOL_LEN] {
    let mut o = [b' '; SYMBOL_LEN];
    o[..5].copy_from_slice(b"AAPLx");
    o
}

/// Registered, risk-read, attested open, and marked. The baseline.
fn ready(ctx: &mut Ctx) {
    let p = ctx.payer.pubkey();
    let a = ctx.attestor.pubkey();
    let (sp, rp, mp) = (ctx.sym_pda(), ctx.risk_pda(), ctx.mark_pda());
    let sm = ctx.stock_mint;
    let qm = ctx.quote_mint;

    ctx.send(&[Instruction::new_with_bytes(
        ctx.program_id,
        &bell_session::instruction::RegisterSymbol { symbol: sym(), mint: sm, exchange_mic: *b"XNAS", hours_mode: HoursMode::TwentyFourFive, attestor: a }.data(),
        bell_session::accounts::RegisterSymbol { payer: p, symbol_state: sp, system_program: system_program::ID }.to_account_metas(None),
    )], &[]).unwrap();

    ctx.send(&[Instruction::new_with_bytes(
        ctx.program_id,
        &bell_session::instruction::InitTokenRisk { attestor: ctx.payer.pubkey() }.data(),
        bell_session::accounts::InitTokenRisk { payer: p, mint: sm, risk: rp, system_program: system_program::ID }.to_account_metas(None),
    )], &[]).unwrap();

    ctx.send(&[Instruction::new_with_bytes(
        ctx.program_id,
        &bell_session::instruction::OpenMark { symbol: sym(), quote_mint: qm }.data(),
        bell_session::accounts::OpenMark { payer: p, symbol_state: sp, mark: mp, system_program: system_program::ID }.to_account_metas(None),
    )], &[]).unwrap();

    push_session(ctx, HaltState::None, true, NOW);
    push_mark(ctx, rate_q64(), NOW);
}

fn push_session(ctx: &mut Ctx, halt: HaltState, open_now: bool, observed_at: i64) {
    let a = ctx.attestor.pubkey();
    let sp = ctx.sym_pda();
    let att = ctx.attestor.insecure_clone();
    ctx.send(&[Instruction::new_with_bytes(
        ctx.program_id,
        &bell_session::instruction::PushSession { symbol: sym(), halt, open_now, next_change_at: observed_at + 3600, observed_at }.data(),
        bell_session::accounts::PushSession { attestor: a, symbol_state: sp }.to_account_metas(None),
    )], &[&att]).unwrap();
}

fn push_mark(ctx: &mut Ctx, rate_q64: u128, observed_at: i64) {
    let a = ctx.attestor.pubkey();
    let (sp, mp) = (ctx.sym_pda(), ctx.mark_pda());
    let att = ctx.attestor.insecure_clone();
    ctx.send(&[Instruction::new_with_bytes(
        ctx.program_id,
        &bell_session::instruction::PushMark { symbol: sym(), rate_q64, px_num: 33_400_000, px_expo: -5, conf_bps: 10, source: MarkSource::Backpack, observed_at }.data(),
        bell_session::accounts::PushMark { attestor: a, symbol_state: sp, mark: mp }.to_account_metas(None),
    )], &[&att]).unwrap();
}

/// 1 quote raw unit buys this many stock raw units, Q64.64.
///
/// Quote is 6dp, stock is 8dp, share price ~$334 — so $1 (1e6 raw) should buy
/// about 1/334 of a share (~299,401 raw at 8dp). Different decimals on the two
/// legs is exactly why the rate is raw-per-raw rather than a human price.
fn rate_q64() -> u128 {
    // 299_401 stock raw per 1_000_000 quote raw
    (299_401u128 << 64) / 1_000_000u128
}

/// Stock raw units the band treats as fair for `amount_in` quote raw units at
/// `rate_q64()` — the program's own `a * q64 >> 64`, so a test can deliver
/// exactly fair on any leg size without restating the rounding by hand.
fn fair(amount_in: u64) -> u64 {
    ((amount_in as u128 * rate_q64()) >> 64) as u64
}

/// The fill's accounts. The two token programs are the filler's choice, so they
/// are parameters rather than fixed: that choice is what AUDIT.md #3 and #4
/// are about.
fn accounts_for_fill(ctx: &Ctx, nonce: u64, legs: &Legs, quote_program: Pubkey, stock_program: Pubkey) -> Vec<anchor_lang::solana_program::instruction::AccountMeta> {
    bell_session::accounts::FillOrder {
        filler: ctx.filler.pubkey(),
        order: ctx.order_pda(nonce),
        symbol_state: ctx.sym_pda(),
        risk: ctx.risk_pda(),
        mark: ctx.mark_pda(),
        auth: ctx.auth_pda(),
        owner: ctx.user.pubkey(),
        payer_in: legs.payer_in,
        payee_out: legs.payee_out,
        filler_in: legs.filler_in,
        filler_out: legs.filler_out,
        quote_mint: ctx.quote_mint,
        stock_mint: ctx.stock_mint,
        quote_token_program: quote_program,
        stock_token_program: stock_program,
    }
    .to_account_metas(None)
}

struct Legs { payer_in: Pubkey, payee_out: Pubkey, filler_in: Pubkey, filler_out: Pubkey }

fn fund(ctx: &mut Ctx, delegated: u64) -> Legs {
    let (u, f, auth) = (ctx.user.pubkey(), ctx.filler.pubkey(), ctx.auth_pda());
    let (qm, sm) = (ctx.quote_mint, ctx.stock_mint);
    let legs = Legs { payer_in: Pubkey::new_unique(), payee_out: Pubkey::new_unique(), filler_in: Pubkey::new_unique(), filler_out: Pubkey::new_unique() };
    ctx.set_token(legs.payer_in, &qm, &u, 10_000_000, Some((&auth, delegated)), TOKEN);
    ctx.set_token(legs.payee_out, &sm, &u, 0, None, token_2022());
    ctx.set_token(legs.filler_in, &qm, &f, 0, None, TOKEN);
    ctx.set_token(legs.filler_out, &sm, &f, 1_000_000_000, None, token_2022());
    legs
}

/// An all-or-none order: `min_fill_in` equal to `amount_in`.
fn place(ctx: &mut Ctx, nonce: u64, legs: &Legs, amount_in: u64, slip_bps: u16, floor: u128, expires_at: i64) -> Result<(), String> {
    place_min(ctx, nonce, legs, amount_in, amount_in, slip_bps, floor, expires_at)
}

#[allow(clippy::too_many_arguments)]
fn place_min(ctx: &mut Ctx, nonce: u64, legs: &Legs, amount_in: u64, min_fill_in: u64, slip_bps: u16, floor: u128, expires_at: i64) -> Result<(), String> {
    let u = ctx.user.pubkey();
    let (sp, rp, mp, op) = (ctx.sym_pda(), ctx.risk_pda(), ctx.mark_pda(), ctx.order_pda(nonce));
    let usr = ctx.user.insecure_clone();
    ctx.send(&[Instruction::new_with_bytes(
        ctx.program_id,
        &bell_session::instruction::PlaceOrder { symbol: sym(), nonce, amount_in, min_fill_in, max_slip_bps: slip_bps, max_conf_bps: 50, floor_rate_q64: floor, not_before: 0, expires_at }.data(),
        bell_session::accounts::PlaceOrder { owner: u, symbol_state: sp, risk: rp, mark: mp, order: op, payer_in: legs.payer_in, payee_out: legs.payee_out, system_program: system_program::ID }.to_account_metas(None),
    )], &[&usr])
}

fn fill(ctx: &mut Ctx, nonce: u64, legs: &Legs, amount_in_leg: u64, amount_out: u64) -> Result<(), String> {
    fill_under(ctx, nonce, legs, amount_in_leg, amount_out, TOKEN, token_2022()).0
}

/// A fill naming its own token programs for the quote and stock legs, with the
/// transaction's logs.
fn fill_under(ctx: &mut Ctx, nonce: u64, legs: &Legs, amount_in_leg: u64, amount_out: u64, quote_program: Pubkey, stock_program: Pubkey) -> (Result<(), String>, Vec<String>) {
    let metas = accounts_for_fill(ctx, nonce, legs, quote_program, stock_program);
    let flr = ctx.filler.insecure_clone();
    ctx.send_logged(&[Instruction::new_with_bytes(
        ctx.program_id,
        &bell_session::instruction::FillOrder { amount_in_leg, amount_out }.data(),
        metas,
    )], &[&flr])
}

/// Every program invocation in the logs, in order. The runtime writes
/// "Program <id> invoke [<depth>]" for each call, top-level or CPI.
fn calls(logs: &[String]) -> Vec<String> {
    logs.iter().filter(|l| l.starts_with("Program ") && l.contains(" invoke [")).cloned().collect()
}

/// The source file of the check that refused, from Anchor's
/// "AnchorError thrown in <file>:<line>" log. Two checks here report the same
/// code — the up-front membership test in `fill.rs` and the ownership test in
/// `tokens.rs` — and on some inputs both would refuse before any transfer, so
/// the code and the call list alone cannot say which one did. The file is
/// compared, not the line, so that moving a check within its file is not a
/// test failure.
fn thrown_in(logs: &[String]) -> Option<&str> {
    logs.iter().find_map(|l| {
        let rest = l.split_once("AnchorError thrown in ")?.1;
        Some(rest.split_once(':')?.0)
    })
}
const FILL_RS: &str = "programs/bell-session/src/instructions/fill.rs";
const TOKENS_RS: &str = "programs/bell-session/src/tokens.rs";

/// Close an order as `signer`, who may or may not be its owner.
fn cancel_as(ctx: &mut Ctx, nonce: u64, legs: &Legs, signer: &Keypair) -> Result<(), String> {
    let u = ctx.user.pubkey();
    let op = ctx.order_pda(nonce);
    let s = signer.insecure_clone();
    ctx.send(&[Instruction::new_with_bytes(
        ctx.program_id,
        &bell_session::instruction::CancelOrder {}.data(),
        bell_session::accounts::CancelOrder { signer: s.pubkey(), owner: u, order: op, payer_in: legs.payer_in }.to_account_metas(None),
    )], &[&s])
}

/// `refresh_token_risk` for the stock mint — permissionless, no signer.
fn refresh_ix(ctx: &Ctx) -> Instruction {
    Instruction::new_with_bytes(
        ctx.program_id,
        &bell_session::instruction::RefreshTokenRisk {}.data(),
        bell_session::accounts::RefreshTokenRisk { mint: ctx.stock_mint, risk: ctx.risk_pda() }.to_account_metas(None),
    )
}

fn refresh(ctx: &mut Ctx) {
    let ix = refresh_ix(ctx);
    ctx.send(&[ix], &[]).unwrap();
}

/// A refresh and a fill in ONE transaction — how a filler that nobody else is
/// refreshing for still gets a fresh read of the mint at settlement.
fn refresh_and_fill(ctx: &mut Ctx, nonce: u64, legs: &Legs, amount_in_leg: u64, amount_out: u64) -> Result<(), String> {
    let metas = accounts_for_fill(ctx, nonce, legs, TOKEN, token_2022());
    let flr = ctx.filler.insecure_clone();
    let fill_ix = Instruction::new_with_bytes(
        ctx.program_id,
        &bell_session::instruction::FillOrder { amount_in_leg, amount_out }.data(),
        metas,
    );
    let ixs = [refresh_ix(ctx), fill_ix];
    ctx.send(&ixs, &[&flr])
}

/// Assert a refusal by its code, not merely that *something* failed. An
/// `is_err()` check is how a test keeps passing after its reason has changed.
fn assert_code(r: Result<(), String>, code: u32, why: &str) {
    match r {
        Ok(()) => panic!("expected Custom({code}) — {why} — but it succeeded"),
        Err(e) => assert!(e.contains(&format!("Custom({code})")), "expected Custom({code}) — {why} — got {e}"),
    }
}

/// Codes derived from the enum, never typed by hand: hand-typed codes were
/// off by one the first time, because counting variants by eye skipped one.
const fn code(e: BellError) -> u32 {
    anchor_lang::error::ERROR_CODE_OFFSET + e as u32
}
const MARKET_CLOSED: u32 = code(BellError::MarketClosed);
const MARK_STALE: u32 = code(BellError::MarkStale);
const PRICE_OUT_OF_BAND: u32 = code(BellError::PriceOutOfBand);
const ORDER_EXPIRED: u32 = code(BellError::OrderExpired);
const OVER_FILL: u32 = code(BellError::OverFill);
const FILL_TOO_SMALL: u32 = code(BellError::FillTooSmall);
const DELEGATION_MISSING: u32 = code(BellError::DelegationMissing);
const NOT_ORDER_OWNER: u32 = code(BellError::NotOrderOwner);
const TOKEN_PROGRAM_MISMATCH: u32 = code(BellError::TokenProgramMismatch);
const RISK_STALE: u32 = code(BellError::RiskStale);

// --------------------------------------------------------------------- tests

#[test]
fn an_order_cannot_be_placed_without_a_delegation() {
    // The order is verified to be fundable at placement, so the book can never
    // contain intent that was never backed.
    let mut ctx = Ctx::new();
    ready(&mut ctx);
    let (u, qm, sm) = (ctx.user.pubkey(), ctx.quote_mint, ctx.stock_mint);
    let legs = Legs { payer_in: Pubkey::new_unique(), payee_out: Pubkey::new_unique(), filler_in: Pubkey::new_unique(), filler_out: Pubkey::new_unique() };
    ctx.set_token(legs.payer_in, &qm, &u, 10_000_000, None, TOKEN); // no delegate
    ctx.set_token(legs.payee_out, &sm, &u, 0, None, token_2022());
    assert_code(place(&mut ctx, 1, &legs, 1_000_000, 30, 0, NOW + 86_400), DELEGATION_MISSING, "quote account delegates to nobody");

    // The two halves of the check, each alone: the right amount to the wrong
    // key, and the right key for one unit less than the order. Either one
    // passing would let an order into the book that no fill could complete.
    let (auth, other) = (ctx.auth_pda(), Pubkey::new_unique());
    ctx.set_token(legs.payer_in, &qm, &u, 10_000_000, Some((&other, 1_000_000)), TOKEN);
    assert_code(place(&mut ctx, 1, &legs, 1_000_000, 30, 0, NOW + 86_400), DELEGATION_MISSING, "delegated to someone else");
    ctx.set_token(legs.payer_in, &qm, &u, 10_000_000, Some((&auth, 999_999)), TOKEN);
    assert_code(place(&mut ctx, 1, &legs, 1_000_000, 30, 0, NOW + 86_400), DELEGATION_MISSING, "delegated one unit short");
    assert!(ctx.order(1).is_none(), "no order was created");

    // Delegated in full to this owner's authority, the same order places.
    ctx.set_token(legs.payer_in, &qm, &u, 10_000_000, Some((&auth, 1_000_000)), TOKEN);
    place(&mut ctx, 1, &legs, 1_000_000, 30, 0, NOW + 86_400).unwrap();
}

#[test]
fn a_delegated_order_is_placed_and_records_the_multiplier() {
    let mut ctx = Ctx::new();
    ready(&mut ctx);
    let legs = fund(&mut ctx, 1_000_000);
    place(&mut ctx, 1, &legs, 1_000_000, 30, 0, NOW + 86_400).unwrap();

    let acc = ctx.svm.get_account(&ctx.order_pda(1)).unwrap();
    let o = BellOrder::try_deserialize(&mut &acc.data[..]).unwrap();
    assert_eq!(o.owner, ctx.user.pubkey());
    assert_eq!(o.amount_in, 1_000_000);
    assert_eq!(o.filled_in, 0);
    // Snapshotted from the real Apple mint, not assumed.
    assert!(f64::from_bits(o.expected_multiplier_bits) > 1.0);
}

#[test]
fn the_owner_can_always_close_their_order() {
    let mut ctx = Ctx::new();
    ready(&mut ctx);
    let legs = fund(&mut ctx, 1_000_000);
    place(&mut ctx, 1, &legs, 1_000_000, 30, 0, NOW + 86_400).unwrap();

    let usr = ctx.user.insecure_clone();
    cancel_as(&mut ctx, 1, &legs, &usr).unwrap();
    assert!(ctx.order(1).is_none());
}

#[test]
fn a_stranger_cannot_close_a_live_funded_order() {
    let mut ctx = Ctx::new();
    ready(&mut ctx);
    let legs = fund(&mut ctx, 1_000_000);
    place(&mut ctx, 1, &legs, 1_000_000, 30, 0, NOW + 86_400).unwrap();

    let flr = ctx.filler.insecure_clone();
    assert_code(cancel_as(&mut ctx, 1, &legs, &flr), NOT_ORDER_OWNER, "live, fully delegated, and not the owner");
    assert!(ctx.order(1).is_some());
}

#[test]
fn revoking_the_delegation_lets_anyone_garbage_collect_the_order() {
    // The real cancel is spl_token::revoke, which this program has no part in.
    // Afterwards the order is dead weight, so anyone may reclaim its rent —
    // but the rent goes to the owner, so there is nothing to farm.
    let mut ctx = Ctx::new();
    ready(&mut ctx);
    let legs = fund(&mut ctx, 1_000_000);
    place(&mut ctx, 1, &legs, 1_000_000, 30, 0, NOW + 86_400).unwrap();

    let (u, qm) = (ctx.user.pubkey(), ctx.quote_mint);
    ctx.set_token(legs.payer_in, &qm, &u, 10_000_000, None, TOKEN); // revoked

    let before = ctx.svm.get_account(&u).unwrap().lamports;
    let flr = ctx.filler.insecure_clone();
    cancel_as(&mut ctx, 1, &legs, &flr).unwrap();
    assert!(ctx.svm.get_account(&u).unwrap().lamports > before, "rent returns to the owner");
}

#[test]
fn a_due_order_fills_while_the_market_is_open() {
    let mut ctx = Ctx::new();
    ready(&mut ctx);
    let legs = fund(&mut ctx, 1_000_000);
    place(&mut ctx, 1, &legs, 1_000_000, 30, 0, NOW + 86_400).unwrap();

    fill(&mut ctx, 1, &legs, 1_000_000, 299_401).unwrap();

    assert_eq!(ctx.balance(&legs.payee_out), 299_401, "user received the stock");
    assert_eq!(ctx.balance(&legs.filler_in), 1_000_000, "filler received the quote");
    assert_eq!(ctx.balance(&legs.payer_in), 9_000_000, "only the order amount moved");
}

#[test]
fn a_fill_below_the_band_is_refused_and_moves_nothing() {
    let mut ctx = Ctx::new();
    ready(&mut ctx);
    let legs = fund(&mut ctx, 1_000_000);
    place(&mut ctx, 1, &legs, 1_000_000, 30, 0, NOW + 86_400).unwrap();

    // Fair for this leg is 299,400 — the Q64 rate rounds down — and a 30bps
    // band below it leaves a floor of 298,501.
    assert_eq!(fair(1_000_000), 299_400);
    assert_code(fill(&mut ctx, 1, &legs, 1_000_000, 290_000), PRICE_OUT_OF_BAND, "290,000 delivered against a 298,501 floor");
    assert_eq!(ctx.balance(&legs.payer_in), 10_000_000, "quote untouched");
    assert_eq!(ctx.balance(&legs.payee_out), 0, "nothing delivered");
}

#[test]
fn a_closed_market_refuses_the_fill() {
    let mut ctx = Ctx::new();
    ready(&mut ctx);
    let legs = fund(&mut ctx, 1_000_000);
    place(&mut ctx, 1, &legs, 1_000_000, 30, 0, NOW + 86_400).unwrap();

    push_session(&mut ctx, HaltState::None, false, NOW); // bell rings
    // Gate 7: no halt, but fills are Strict and the session is not live.
    assert_code(fill(&mut ctx, 1, &legs, 1_000_000, 299_401), MARKET_CLOSED, "session closed, no halt");
    assert_eq!(ctx.balance(&legs.payer_in), 10_000_000);
}

#[test]
fn a_halt_refuses_the_fill() {
    let mut ctx = Ctx::new();
    ready(&mut ctx);
    let legs = fund(&mut ctx, 1_000_000);
    place(&mut ctx, 1, &legs, 1_000_000, 30, 0, NOW + 86_400).unwrap();

    push_session(&mut ctx, HaltState::Luld, true, NOW);
    // Gate 2, with the session attested open, so gate 7 cannot be the reason.
    assert_code(fill(&mut ctx, 1, &legs, 1_000_000, 299_401), MARKET_CLOSED, "LULD pause in an open session");
    assert_eq!(ctx.balance(&legs.payer_in), 10_000_000);
}

#[test]
fn a_stale_mark_refuses_the_fill() {
    // This is what makes a weekend order safe: Friday's mark is ~60 hours old
    // on Monday, so nothing can fill until a fresh one lands.
    let mut ctx = Ctx::new();
    ready(&mut ctx);
    let legs = fund(&mut ctx, 1_000_000);
    place(&mut ctx, 1, &legs, 1_000_000, 30, 0, NOW + 86_400).unwrap();

    ctx.warp(NOW + 3_600);
    push_session(&mut ctx, HaltState::None, true, NOW + 3_600); // session fresh
    // Re-read the mint too, so the only stale thing is the mark. Before the
    // TokenRisk age bound this test asserted a bare `is_err()`, and when the
    // bound arrived the failure silently became RiskStale — the test kept
    // "passing" for a reason it was not written to test.
    refresh(&mut ctx);
    assert_code(fill(&mut ctx, 1, &legs, 1_000_000, 299_401), MARK_STALE, "mark is an hour old");

    push_mark(&mut ctx, rate_q64(), NOW + 3_600);
    fill(&mut ctx, 1, &legs, 1_000_000, 299_401).unwrap();
}

#[test]
fn an_expired_order_cannot_fill() {
    let mut ctx = Ctx::new();
    ready(&mut ctx);
    let legs = fund(&mut ctx, 1_000_000);
    place(&mut ctx, 1, &legs, 1_000_000, 30, 0, NOW + 600).unwrap();

    ctx.warp(NOW + 601);
    push_session(&mut ctx, HaltState::None, true, NOW + 601);
    push_mark(&mut ctx, rate_q64(), NOW + 601);
    // Expiry is checked before the gate, so this stays OrderExpired even though
    // the risk record is also past its bound by now.
    assert_code(fill(&mut ctx, 1, &legs, 1_000_000, 299_401), ORDER_EXPIRED, "order lapsed at NOW+600");
}

#[test]
fn a_stale_risk_record_refuses_the_fill_until_it_is_re_read() {
    // Ten minutes without anyone re-reading the mint: the session and the mark
    // are both fresh, and the fill still refuses, because a pause, a scheduled
    // rebase or an armed hook could have appeared on the mint in that time.
    let mut ctx = Ctx::new();
    ready(&mut ctx);
    let legs = fund(&mut ctx, 1_000_000);
    place(&mut ctx, 1, &legs, 1_000_000, 30, 0, NOW + 86_400).unwrap();

    ctx.warp(NOW + 601);
    push_session(&mut ctx, HaltState::None, true, NOW + 601);
    push_mark(&mut ctx, rate_q64(), NOW + 601);
    assert_code(fill(&mut ctx, 1, &legs, 1_000_000, 299_401), RISK_STALE, "mint last read 601s ago");

    // Anyone can cure it, in the same transaction as their own fill.
    refresh_and_fill(&mut ctx, 1, &legs, 1_000_000, 299_401).unwrap();
}

#[test]
fn the_users_own_floor_overrides_a_generous_band() {
    // floor_rate_q64 is the user's own statement of the worst price they will
    // take, and it is meaningful at submit time precisely because it is theirs
    // rather than a quote that has since gone stale.
    let mut ctx = Ctx::new();
    ready(&mut ctx);
    let legs = fund(&mut ctx, 1_000_000);
    // A 500bps band would allow 284,430, but the floor demands the full amount.
    place(&mut ctx, 1, &legs, 1_000_000, 500, rate_q64(), NOW + 86_400).unwrap();
    assert_code(fill(&mut ctx, 1, &legs, 1_000_000, 290_000), PRICE_OUT_OF_BAND, "band would allow it, floor does not");
    fill(&mut ctx, 1, &legs, 1_000_000, 299_401).unwrap();
}

// --------------------------------------------- who owns a token account (AUDIT.md #3, #4)

#[test]
fn an_order_cannot_be_placed_against_an_account_no_token_program_owns() {
    // AUDIT.md #3. `read_token_account` used to take the bytes it was handed on
    // trust, so an account owned by a program the caller wrote could claim any
    // owner, mint and delegation it liked — and `place_order` decides whether
    // an order is funded from exactly those claims. Each forged account below
    // is byte for byte the genuine one from `fund`; only its owner differs.
    let mut ctx = Ctx::new();
    ready(&mut ctx);
    let legs = fund(&mut ctx, 1_000_000);
    let (u, auth, qm, sm) = (ctx.user.pubkey(), ctx.auth_pda(), ctx.quote_mint, ctx.stock_mint);
    let forger = Pubkey::new_unique();

    // A quote account claiming a full delegation to this user's authority.
    ctx.set_token(legs.payer_in, &qm, &u, 10_000_000, Some((&auth, 1_000_000)), forger);
    assert_code(place(&mut ctx, 1, &legs, 1_000_000, 30, 0, NOW + 86_400), TOKEN_PROGRAM_MISMATCH, "quote account owned by a non-token program");

    // The stock side is read through the same check.
    ctx.set_token(legs.payer_in, &qm, &u, 10_000_000, Some((&auth, 1_000_000)), TOKEN);
    ctx.set_token(legs.payee_out, &sm, &u, 0, None, forger);
    assert_code(place(&mut ctx, 1, &legs, 1_000_000, 30, 0, NOW + 86_400), TOKEN_PROGRAM_MISMATCH, "stock account owned by a non-token program");
    assert!(ctx.order(1).is_none(), "neither attempt created an order");

    // Owned by Token-2022 again, the same bytes place: the owner was the only reason.
    ctx.set_token(legs.payee_out, &sm, &u, 0, None, token_2022());
    place(&mut ctx, 1, &legs, 1_000_000, 30, 0, NOW + 86_400).unwrap();
}

#[test]
fn a_leg_is_read_under_the_token_program_it_moves_under() {
    // AUDIT.md #3, the pinned form. The filler names each leg's program, and
    // `fill_order` reads that leg's accounts under the program named, so an
    // account cannot be measured under one token program and moved under the
    // other. Both programs here are real token programs, so the membership
    // check of #4 passes and this is the ownership check alone.
    let mut ctx = Ctx::new();
    ready(&mut ctx);
    let legs = fund(&mut ctx, 1_000_000);
    place(&mut ctx, 1, &legs, 1_000_000, 30, 0, NOW + 86_400).unwrap();

    let bell = format!("Program {} invoke [1]", ctx.program_id);

    // Stock leg named as SPL Token; the user's AAPLx account is Token-2022.
    // Refused on the first read, before either transfer.
    let (r, logs) = fill_under(&mut ctx, 1, &legs, 1_000_000, 299_401, TOKEN, TOKEN);
    assert_code(r, TOKEN_PROGRAM_MISMATCH, "stock leg named under SPL Token");
    assert_eq!(thrown_in(&logs), Some(TOKENS_RS), "refused by the ownership check");
    assert_eq!(calls(&logs), [bell.as_str()], "no transfer was attempted");

    // Quote leg named as Token-2022; the user's quote account is SPL Token.
    // Refused between the two transfers: the stock is delivered first, the
    // quote read fails before anything is taken, and the delivery is rolled
    // back with the refusal.
    let (r, logs) = fill_under(&mut ctx, 1, &legs, 1_000_000, 299_401, token_2022(), token_2022());
    assert_code(r, TOKEN_PROGRAM_MISMATCH, "quote leg named under Token-2022");
    assert_eq!(thrown_in(&logs), Some(TOKENS_RS), "refused by the ownership check");
    let delivery = format!("Program {} invoke [2]", token_2022());
    assert_eq!(calls(&logs), [bell.as_str(), delivery.as_str()], "delivered, then refused before the take");
    assert_eq!(ctx.balance(&legs.payee_out), 0, "the delivery was undone with the refusal");
    assert_eq!(ctx.balance(&legs.payer_in), 10_000_000);

    // Named correctly, the same fill goes through.
    fill(&mut ctx, 1, &legs, 1_000_000, 299_401).unwrap();
}

#[test]
fn fill_order_refuses_a_leg_program_that_is_not_a_token_program() {
    // AUDIT.md #4. Each leg's program is an account the filler supplies, and
    // `fill_order` calls into it — for the quote leg, with the user's delegate
    // authority signing. Measuring the user's account afterwards bounds what
    // such a callee could take; the fix is that no call is made at all.
    //
    // The code alone cannot tell this fix from #3's: the ownership check inside
    // `balance_of` also reports TokenProgramMismatch, and would also stop Memo
    // before its own call. For the quote leg it would do so only after the
    // stock had been delivered, so an empty call list shows the up-front check
    // fired. For the stock leg it would fire on the very first read, before any
    // call, so there the call list cannot tell them apart and only the source
    // file of the refusal can.
    let mut ctx = Ctx::new();
    ready(&mut ctx);
    let legs = fund(&mut ctx, 1_000_000);
    place(&mut ctx, 1, &legs, 1_000_000, 30, 0, NOW + 86_400).unwrap();

    let only_bell = vec![format!("Program {} invoke [1]", ctx.program_id)];
    for (quote, stock, which) in [(memo(), token_2022(), "quote leg under Memo"), (TOKEN, memo(), "stock leg under Memo")] {
        let (r, logs) = fill_under(&mut ctx, 1, &legs, 1_000_000, 299_401, quote, stock);
        assert_code(r, TOKEN_PROGRAM_MISMATCH, which);
        assert_eq!(thrown_in(&logs), Some(FILL_RS), "{which}: refused up front in fill_order, not by the ownership check in balance_of");
        assert_eq!(calls(&logs), only_bell, "{which}: a cross-program call was made before the refusal");
    }
    assert_eq!(ctx.balance(&legs.payer_in), 10_000_000);
    assert_eq!(ctx.balance(&legs.payee_out), 0);

    // A control for the log check above: a fill under the real programs shows
    // both of them called from inside it, in the form `calls` reads.
    let (r, logs) = fill_under(&mut ctx, 1, &legs, 1_000_000, 299_401, TOKEN, token_2022());
    r.unwrap();
    assert_eq!(
        calls(&logs),
        [
            format!("Program {} invoke [1]", ctx.program_id),
            format!("Program {} invoke [2]", token_2022()), // deliver first
            format!("Program {} invoke [2]", TOKEN),        // then take
        ],
    );
}

// ---------------------------------------------------------------- partial fills
//
// `min_fill_in` below `amount_in` lets an order fill in pieces. Every piece
// must be at least the minimum, except that the last may be whatever remains,
// so an order can never be left holding a remainder no fill is allowed to take.

#[test]
fn a_partial_fill_leaves_the_order_open_and_still_fully_funded() {
    let mut ctx = Ctx::new();
    ready(&mut ctx);
    let legs = fund(&mut ctx, 1_000_000);
    place_min(&mut ctx, 1, &legs, 1_000_000, 250_000, 30, 0, NOW + 86_400).unwrap();

    fill(&mut ctx, 1, &legs, 400_000, fair(400_000)).unwrap();

    let o = ctx.order(1).expect("a partly filled order stays open");
    assert_eq!(o.filled_in, 400_000);
    assert_eq!(o.amount_in, 1_000_000, "a fill records progress; it does not resize the order");
    assert_eq!(ctx.balance(&legs.payer_in), 9_600_000, "exactly the leg was taken");
    assert_eq!(ctx.balance(&legs.filler_in), 400_000);
    assert_eq!(ctx.balance(&legs.payee_out), fair(400_000));

    // The token program draws the delegation down by what it moved, leaving
    // exactly the remainder, so the order still reads as funded and a stranger
    // still cannot collect it.
    assert_eq!(ctx.delegated(&legs.payer_in), 600_000);
    let flr = ctx.filler.insecure_clone();
    assert_code(cancel_as(&mut ctx, 1, &legs, &flr), NOT_ORDER_OWNER, "partly filled, remainder still delegated");
}

#[test]
fn a_fill_beyond_what_remains_is_refused_as_overfill() {
    let mut ctx = Ctx::new();
    ready(&mut ctx);
    let legs = fund(&mut ctx, 1_000_000);
    place_min(&mut ctx, 1, &legs, 1_000_000, 250_000, 30, 0, NOW + 86_400).unwrap();
    fill(&mut ctx, 1, &legs, 400_000, fair(400_000)).unwrap();

    // Within the order's size, one unit past what is left of it.
    assert_code(fill(&mut ctx, 1, &legs, 600_001, fair(600_001)), OVER_FILL, "600,001 against 600,000 remaining");
    assert_eq!(ctx.order(1).unwrap().filled_in, 400_000);
    assert_eq!(ctx.balance(&legs.payer_in), 9_600_000);

    // Exactly the remainder completes the order, and its rent goes home.
    let u = ctx.user.pubkey();
    let before = ctx.svm.get_account(&u).unwrap().lamports;
    fill(&mut ctx, 1, &legs, 600_000, fair(600_000)).unwrap();
    assert!(ctx.order(1).is_none(), "a complete order is closed");
    assert_eq!(ctx.balance(&legs.payer_in), 9_000_000);
    assert!(ctx.svm.get_account(&u).unwrap().lamports > before, "rent returns to the owner");
}

#[test]
fn a_fill_below_the_orders_minimum_is_refused_as_too_small() {
    let mut ctx = Ctx::new();
    ready(&mut ctx);
    let legs = fund(&mut ctx, 1_000_000);
    place_min(&mut ctx, 1, &legs, 1_000_000, 250_000, 30, 0, NOW + 86_400).unwrap();

    assert_code(fill(&mut ctx, 1, &legs, 249_999, fair(249_999)), FILL_TOO_SMALL, "one unit under min_fill_in");
    assert_eq!(ctx.balance(&legs.payer_in), 10_000_000);

    // At the minimum exactly, it fills.
    fill(&mut ctx, 1, &legs, 250_000, fair(250_000)).unwrap();
    assert_eq!(ctx.order(1).unwrap().filled_in, 250_000);
}

#[test]
fn the_last_fill_may_be_under_the_minimum_but_must_take_all_that_remains() {
    let mut ctx = Ctx::new();
    ready(&mut ctx);
    let legs = fund(&mut ctx, 1_000_000);
    place_min(&mut ctx, 1, &legs, 1_000_000, 400_000, 30, 0, NOW + 86_400).unwrap();

    // Leaves 300,000: less than the 400,000 minimum, so only a fill of all of
    // it can ever complete the order.
    fill(&mut ctx, 1, &legs, 700_000, fair(700_000)).unwrap();
    assert_code(fill(&mut ctx, 1, &legs, 299_999, fair(299_999)), FILL_TOO_SMALL, "a tail fill that leaves dust");

    fill(&mut ctx, 1, &legs, 300_000, fair(300_000)).unwrap();
    assert!(ctx.order(1).is_none(), "completed and closed");
    assert_eq!(ctx.balance(&legs.payer_in), 9_000_000);
}
