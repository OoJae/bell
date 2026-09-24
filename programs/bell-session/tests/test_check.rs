//! The checker: a second signer whose view every fill must agree with.
//!
//! The harness is copied from `test_queue.rs` and `test_sell.rs` rather than
//! shared with them, so each suite stays readable on its own. As there, token
//! accounts are written directly in the fixed SPL layout, and the stock is the
//! **real mainnet AAPLx mint**, so the gate reads genuine issuer state.
//!
//! Unlike the other suites, pushing the mark here does not also push the
//! check: the point of these tests is what happens when the two differ.

use {
    anchor_lang::{
        prelude::Pubkey,
        solana_program::{
            bpf_loader_upgradeable,
            instruction::{AccountMeta, Instruction},
            system_program,
        },
        AccountDeserialize, InstructionData, ToAccountMetas,
    },
    anchor_lang::solana_program::clock::Clock,
    bell_session::{
        constants::{AUTH_SEED, CHECK_SEED, MARK_SEED, MAX_MARK_AGE_SECONDS, MAX_SESSION_REF_AGE_SECONDS, NIGHT_SEED, ORDER_SEED, RISK_SEED, SELL_SEED, SYMBOL_LEN, SYMBOL_SEED},
        error::BellError,
        state::{HaltState, HoursMode, MarkSource, SymbolCheck, SymbolMark},
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

/// One share of an eight-decimal stock, in raw units.
const SHARE: u64 = 100_000_000;
/// What the user holds on each side before any test trades from it.
const USER_QUOTE: u64 = 10_000_000;
const USER_STOCK: u64 = 1_000_000_000;
/// What the filler holds on each side.
const FILLER_QUOTE: u64 = 10_000_000_000;
const FILLER_STOCK: u64 = 1_000_000_000;
/// A buy leg of $1.
const DOLLAR: u64 = 1_000_000;

fn token_2022() -> Pubkey {
    Pubkey::new_from_array(spl_token_2022::ID.to_bytes())
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
    /// The program's upgrade authority, as `Ctx::new` records it.
    authority: Keypair,
    /// The second signer named by the symbol's check.
    checker: Keypair,
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
        let authority = Keypair::new();
        let checker = Keypair::new();
        for k in [&payer, &attestor, &user, &filler, &authority, &checker] {
            svm.airdrop(&k.pubkey(), 10_000_000_000).unwrap();
        }

        // LiteSVM writes the ProgramData account with no upgrade authority.
        // Record one, in the loader's own layout, so `open_check` has an
        // authority to check against: option tag at byte 12, key at 13..45.
        let pd = Pubkey::find_program_address(&[program_id.as_ref()], &bpf_loader_upgradeable::ID).0;
        let mut acc = svm.get_account(&pd).unwrap();
        acc.data[12] = 1;
        acc.data[13..45].copy_from_slice(authority.pubkey().as_ref());
        svm.set_account(pd, acc).unwrap();

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
            Account { lamports: 1_000_000_000, data: include_bytes!("fixtures/aaplx.bin").to_vec(), owner: token_2022(), executable: false, rent_epoch: 0 },
        )
        .unwrap();

        Self { svm, payer, program_id, quote_mint, stock_mint, attestor, user, filler, authority, checker }
    }

    fn send(&mut self, ixs: &[Instruction], signers: &[&Keypair]) -> Result<(), String> {
        self.send_logged(ixs, signers).0
    }

    /// `send`, keeping the program logs, which record every program invoked —
    /// including inside a transaction that was then rolled back.
    fn send_logged(&mut self, ixs: &[Instruction], signers: &[&Keypair]) -> (Result<(), String>, Vec<String>) {
        // A refused fill retried after a state change is byte-identical, so a
        // fresh blockhash keeps the runtime from treating it as a replay.
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
    fn sym_pda(&self, s: &[u8; SYMBOL_LEN]) -> Pubkey { self.pda(&[SYMBOL_SEED, s]) }
    fn risk_pda(&self) -> Pubkey { self.pda(&[RISK_SEED, self.stock_mint.as_ref()]) }
    fn mark_pda(&self) -> Pubkey { self.pda(&[MARK_SEED, &sym()]) }
    fn check_pda(&self, s: &[u8; SYMBOL_LEN]) -> Pubkey { self.pda(&[CHECK_SEED, s]) }
    fn auth_pda(&self) -> Pubkey { self.pda(&[AUTH_SEED, self.user.pubkey().as_ref()]) }
    fn night_pda(&self) -> Pubkey { self.pda(&[NIGHT_SEED, self.user.pubkey().as_ref()]) }
    fn order_pda(&self, nonce: u64) -> Pubkey {
        self.pda(&[ORDER_SEED, self.user.pubkey().as_ref(), &nonce.to_le_bytes()])
    }
    fn sell_pda(&self, nonce: u64) -> Pubkey {
        self.pda(&[SELL_SEED, self.user.pubkey().as_ref(), &nonce.to_le_bytes()])
    }
    fn program_data(&self) -> Pubkey {
        Pubkey::find_program_address(&[self.program_id.as_ref()], &bpf_loader_upgradeable::ID).0
    }

    fn set_token(&mut self, key: Pubkey, mint: &Pubkey, owner: &Pubkey, amount: u64, delegate: Option<(&Pubkey, u64)>, program: Pubkey) {
        self.svm
            .set_account(key, Account { lamports: 1_000_000_000, data: token_account(mint, owner, amount, delegate), owner: program, executable: false, rent_epoch: 0 })
            .unwrap();
    }

    fn balance(&self, key: &Pubkey) -> u64 {
        let a = self.svm.get_account(key).unwrap();
        u64::from_le_bytes(a.data[64..72].try_into().unwrap())
    }

    fn mark_rate(&self) -> u128 {
        let a = self.svm.get_account(&self.mark_pda()).unwrap();
        SymbolMark::try_deserialize(&mut &a.data[..]).unwrap().rate_q64
    }

    fn check(&self, s: &[u8; SYMBOL_LEN]) -> Option<SymbolCheck> {
        self.svm
            .get_account(&self.check_pda(s))
            .filter(|a| !a.data.is_empty())
            .map(|a| SymbolCheck::try_deserialize(&mut &a.data[..]).unwrap())
    }
}

fn ticker(t: &str) -> [u8; SYMBOL_LEN] {
    let mut o = [b' '; SYMBOL_LEN];
    o[..t.len()].copy_from_slice(t.as_bytes());
    o
}

fn sym() -> [u8; SYMBOL_LEN] {
    ticker("AAPLx")
}

/// The same mark the other suites use: 299,401 stock raw per 1,000,000 quote
/// raw, Q64.64 — about $334 a share across 8 and 6 decimals.
fn aapl_rate() -> u128 {
    (299_401u128 << 64) / 1_000_000u128
}

/// `rate` moved by `bps` basis points of itself, in the program's own
/// arithmetic: a whole number of `rate / 10_000` steps.
fn step(rate: u128, bps: i64) -> u128 {
    let unit = rate / 10_000;
    if bps >= 0 { rate + unit * bps as u128 } else { rate - unit * (-bps) as u128 }
}

// ------------------------------------------------------------- setup and pushes

fn register(ctx: &mut Ctx, s: [u8; SYMBOL_LEN]) {
    let (p, a, sm) = (ctx.payer.pubkey(), ctx.attestor.pubkey(), ctx.stock_mint);
    let sp = ctx.sym_pda(&s);
    ctx.send(&[Instruction::new_with_bytes(
        ctx.program_id,
        &bell_session::instruction::RegisterSymbol { symbol: s, mint: sm, exchange_mic: *b"XNAS", hours_mode: HoursMode::TwentyFourFive, attestor: a }.data(),
        bell_session::accounts::RegisterSymbol { payer: p, symbol_state: sp, system_program: system_program::ID }.to_account_metas(None),
    )], &[]).unwrap();
}

/// Registered, risk-read, attested open and marked, with no check opened.
fn setup(ctx: &mut Ctx) {
    let p = ctx.payer.pubkey();
    let (sp, rp, mp) = (ctx.sym_pda(&sym()), ctx.risk_pda(), ctx.mark_pda());
    let (sm, qm) = (ctx.stock_mint, ctx.quote_mint);
    register(ctx, sym());
    ctx.send(&[Instruction::new_with_bytes(
        ctx.program_id,
        &bell_session::instruction::InitTokenRisk { attestor: p }.data(),
        bell_session::accounts::InitTokenRisk { payer: p, mint: sm, risk: rp, system_program: system_program::ID }.to_account_metas(None),
    )], &[]).unwrap();
    ctx.send(&[Instruction::new_with_bytes(
        ctx.program_id,
        &bell_session::instruction::OpenMark { symbol: sym(), quote_mint: qm }.data(),
        bell_session::accounts::OpenMark { payer: p, symbol_state: sp, mark: mp, system_program: system_program::ID }.to_account_metas(None),
    )], &[]).unwrap();
    push_session(ctx, HaltState::None, true, NOW);
    push_mark(ctx, aapl_rate(), NOW);
}

/// The baseline: everything above, with a check opened and pushed open at the
/// mark's own rate.
fn ready(ctx: &mut Ctx) {
    setup(ctx);
    let (auth, pd, checker) = (ctx.authority.insecure_clone(), ctx.program_data(), ctx.checker.pubkey());
    open_check(ctx, sym(), &auth, pd, checker).unwrap();
    push_check(ctx, true, aapl_rate(), NOW, NOW).unwrap();
}

/// `open_check` for `s`, signed by `authority`, naming `program_data` as this
/// program's ProgramData account.
fn open_check(ctx: &mut Ctx, s: [u8; SYMBOL_LEN], authority: &Keypair, program_data: Pubkey, checker: Pubkey) -> Result<(), String> {
    let p = ctx.payer.pubkey();
    let (sp, cp) = (ctx.sym_pda(&s), ctx.check_pda(&s));
    let a = authority.insecure_clone();
    ctx.send(&[Instruction::new_with_bytes(
        ctx.program_id,
        &bell_session::instruction::OpenCheck { symbol: s, checker }.data(),
        bell_session::accounts::OpenCheck { payer: p, authority: a.pubkey(), program_data, symbol_state: sp, check: cp, system_program: system_program::ID }.to_account_metas(None),
    )], &[&a])
}

fn push_session(ctx: &mut Ctx, halt: HaltState, open_now: bool, observed_at: i64) {
    let a = ctx.attestor.insecure_clone();
    let sp = ctx.sym_pda(&sym());
    ctx.send(&[Instruction::new_with_bytes(
        ctx.program_id,
        &bell_session::instruction::PushSession { symbol: sym(), halt, open_now, next_change_at: observed_at + 3600, observed_at }.data(),
        bell_session::accounts::PushSession { attestor: a.pubkey(), symbol_state: sp }.to_account_metas(None),
    )], &[&a]).unwrap();
}

/// The mark alone. The check is pushed separately, or not at all.
fn push_mark(ctx: &mut Ctx, rate_q64: u128, observed_at: i64) {
    let a = ctx.attestor.insecure_clone();
    let (sp, mp) = (ctx.sym_pda(&sym()), ctx.mark_pda());
    ctx.send(&[Instruction::new_with_bytes(
        ctx.program_id,
        &bell_session::instruction::PushMark { symbol: sym(), rate_q64, px_num: 33_400_000, px_expo: -5, conf_bps: 10, source: MarkSource::Backpack, observed_at }.data(),
        bell_session::accounts::PushMark { attestor: a.pubkey(), symbol_state: sp, mark: mp }.to_account_metas(None),
    )], &[&a]).unwrap();
}

/// A minute on from `at - MAX_MARK_AGE_SECONDS`: the session, the checker at
/// the usual reference, and the mark at `rate`, all observed at `at`. A mark
/// may move a whole step only once a minute has passed since the last one, so
/// a test that walks the mark around the reference takes a minute per push,
/// and refreshes everything else so that only the mark's distance differs.
fn mark_a_minute_on(ctx: &mut Ctx, rate: u128, at: i64) {
    ctx.warp(at);
    push_session(ctx, HaltState::None, true, at);
    push_check(ctx, true, aapl_rate(), at, at).unwrap();
    push_mark(ctx, rate, at);
    assert_eq!(ctx.mark_rate(), rate, "the mark was written, not held");
}

/// `push_check` for AAPLx, signed by `signer`.
fn push_check_as(ctx: &mut Ctx, signer: &Keypair, open_now: bool, ref_rate_q64: u128, ref_at: i64, observed_at: i64) -> Result<(), String> {
    let c = signer.insecure_clone();
    let cp = ctx.check_pda(&sym());
    ctx.send(&[Instruction::new_with_bytes(
        ctx.program_id,
        &bell_session::instruction::PushCheck { symbol: sym(), open_now, ref_rate_q64, ref_px_num: 33_400_000, ref_px_expo: -5, ref_at, observed_at }.data(),
        bell_session::accounts::PushCheck { checker: c.pubkey(), check: cp }.to_account_metas(None),
    )], &[&c])
}

fn push_check(ctx: &mut Ctx, open_now: bool, ref_rate_q64: u128, ref_at: i64, observed_at: i64) -> Result<(), String> {
    let c = ctx.checker.insecure_clone();
    push_check_as(ctx, &c, open_now, ref_rate_q64, ref_at, observed_at)
}

// ------------------------------------------------ the program's pricing, restated

/// The least stock a buy of `leg` may deliver: `bps` below fair, rounded down.
fn buy_min(leg: u64, rate: u128, bps: u16) -> u64 {
    (((leg as u128 * rate) >> 64) * (10_000 - bps as u128) / 10_000) as u64
}

/// The least quote a sale of `leg` may be paid: `bps` below fair, rounded up.
fn sell_min(leg: u64, rate: u128, bps: u16) -> u64 {
    let num = (leg as u128) << 64;
    let fair = num / rate + u128::from(num % rate != 0);
    let t = fair * (10_000 - bps as u128);
    (t / 10_000 + u128::from(t % 10_000 != 0)) as u64
}

// ------------------------------------------------------------------- orders

struct Legs { payer_in: Pubkey, payee_out: Pubkey, filler_in: Pubkey, filler_out: Pubkey }

fn fund_buy(ctx: &mut Ctx, delegated: u64) -> Legs {
    let (u, f, auth) = (ctx.user.pubkey(), ctx.filler.pubkey(), ctx.auth_pda());
    let (qm, sm) = (ctx.quote_mint, ctx.stock_mint);
    let legs = Legs { payer_in: Pubkey::new_unique(), payee_out: Pubkey::new_unique(), filler_in: Pubkey::new_unique(), filler_out: Pubkey::new_unique() };
    ctx.set_token(legs.payer_in, &qm, &u, USER_QUOTE, Some((&auth, delegated)), TOKEN);
    ctx.set_token(legs.payee_out, &sm, &u, 0, None, token_2022());
    ctx.set_token(legs.filler_in, &qm, &f, 0, None, TOKEN);
    ctx.set_token(legs.filler_out, &sm, &f, FILLER_STOCK, None, token_2022());
    legs
}

fn fund_sell(ctx: &mut Ctx, delegated: u64) -> Legs {
    let (u, f, auth) = (ctx.user.pubkey(), ctx.filler.pubkey(), ctx.auth_pda());
    let (qm, sm) = (ctx.quote_mint, ctx.stock_mint);
    let legs = Legs { payer_in: Pubkey::new_unique(), payee_out: Pubkey::new_unique(), filler_in: Pubkey::new_unique(), filler_out: Pubkey::new_unique() };
    ctx.set_token(legs.payer_in, &sm, &u, USER_STOCK, Some((&auth, delegated)), token_2022());
    ctx.set_token(legs.payee_out, &qm, &u, 0, None, TOKEN);
    ctx.set_token(legs.filler_in, &sm, &f, 0, None, token_2022());
    ctx.set_token(legs.filler_out, &qm, &f, FILLER_QUOTE, None, TOKEN);
    legs
}

fn place_buy(ctx: &mut Ctx, nonce: u64, legs: &Legs, amount_in: u64, min_fill_in: u64) {
    let u = ctx.user.insecure_clone();
    let (sp, rp, mp, op) = (ctx.sym_pda(&sym()), ctx.risk_pda(), ctx.mark_pda(), ctx.order_pda(nonce));
    ctx.send(&[Instruction::new_with_bytes(
        ctx.program_id,
        &bell_session::instruction::PlaceOrder { symbol: sym(), nonce, amount_in, min_fill_in, max_slip_bps: 30, max_conf_bps: 50, floor_rate_q64: 0, not_before: 0, expires_at: NOW + 86_400 }.data(),
        bell_session::accounts::PlaceOrder { owner: u.pubkey(), symbol_state: sp, risk: rp, mark: mp, order: op, payer_in: legs.payer_in, payee_out: legs.payee_out, system_program: system_program::ID }.to_account_metas(None),
    )], &[&u]).unwrap();
}

fn place_sell(ctx: &mut Ctx, nonce: u64, legs: &Legs, amount_in: u64) {
    let u = ctx.user.insecure_clone();
    let (sp, rp, mp, op) = (ctx.sym_pda(&sym()), ctx.risk_pda(), ctx.mark_pda(), ctx.sell_pda(nonce));
    ctx.send(&[Instruction::new_with_bytes(
        ctx.program_id,
        &bell_session::instruction::PlaceSellOrder { symbol: sym(), nonce, amount_in, min_fill_in: amount_in, max_slip_bps: 30, max_conf_bps: 50, floor_rate_q64: 0, not_before: 0, expires_at: NOW + 86_400 }.data(),
        bell_session::accounts::PlaceSellOrder { owner: u.pubkey(), symbol_state: sp, risk: rp, mark: mp, order: op, payer_in: legs.payer_in, payee_out: legs.payee_out, system_program: system_program::ID }.to_account_metas(None),
    )], &[&u]).unwrap();
}

/// `fill_order`'s seventeen accounts, naming `check` as the symbol's check so
/// a test can name another one.
fn buy_metas(ctx: &Ctx, nonce: u64, legs: &Legs, check: Pubkey) -> Vec<AccountMeta> {
    bell_session::accounts::FillOrder {
        filler: ctx.filler.pubkey(),
        order: ctx.order_pda(nonce),
        symbol_state: ctx.sym_pda(&sym()),
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
        quote_token_program: TOKEN,
        stock_token_program: token_2022(),
        check,
        night: ctx.night_pda(),
    }
    .to_account_metas(None)
}

fn sell_metas(ctx: &Ctx, nonce: u64, legs: &Legs) -> Vec<AccountMeta> {
    bell_session::accounts::FillSellOrder {
        filler: ctx.filler.pubkey(),
        order: ctx.sell_pda(nonce),
        symbol_state: ctx.sym_pda(&sym()),
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
        quote_token_program: TOKEN,
        stock_token_program: token_2022(),
        check: ctx.check_pda(&sym()),
        night: ctx.night_pda(),
    }
    .to_account_metas(None)
}

/// A fill instruction over `metas`, with the transaction's logs.
fn fill_with(ctx: &mut Ctx, data: Vec<u8>, metas: Vec<AccountMeta>) -> (Result<(), String>, Vec<String>) {
    let f = ctx.filler.insecure_clone();
    ctx.send_logged(&[Instruction::new_with_bytes(ctx.program_id, &data, metas)], &[&f])
}

fn fill_buy(ctx: &mut Ctx, nonce: u64, legs: &Legs, amount_in_leg: u64, amount_out: u64) -> Result<(), String> {
    let metas = buy_metas(ctx, nonce, legs, ctx.check_pda(&sym()));
    fill_with(ctx, bell_session::instruction::FillOrder { amount_in_leg, amount_out }.data(), metas).0
}

fn fill_sell(ctx: &mut Ctx, nonce: u64, legs: &Legs, amount_in_leg: u64, amount_out: u64) -> Result<(), String> {
    let metas = sell_metas(ctx, nonce, legs);
    fill_with(ctx, bell_session::instruction::FillSellOrder { amount_in_leg, amount_out }.data(), metas).0
}

/// Every program invocation in the logs, in order.
fn calls(logs: &[String]) -> Vec<String> {
    logs.iter().filter(|l| l.starts_with("Program ") && l.contains(" invoke [")).cloned().collect()
}

// ------------------------------------------------------------------ codes

/// Assert a refusal by its code, not merely that *something* failed.
fn assert_code(r: Result<(), String>, code: u32, why: &str) {
    match r {
        Ok(()) => panic!("expected Custom({code}) — {why} — but it succeeded"),
        Err(e) => assert!(e.contains(&format!("Custom({code})")), "expected Custom({code}) — {why} — got {e}"),
    }
}

/// Codes derived from the enum, never typed by hand.
const fn code(e: BellError) -> u32 {
    anchor_lang::error::ERROR_CODE_OFFSET + e as u32
}
const MARKET_CLOSED: u32 = code(BellError::MarketClosed);
const TIMESTAMP_IN_FUTURE: u32 = code(BellError::TimestampInFuture);
const BAD_PARAMETERS: u32 = code(BellError::BadParameters);
const NOT_AUTHORITY: u32 = code(BellError::NotAuthority);
const NOT_CHECKER: u32 = code(BellError::NotChecker);
const CHECK_STALE: u32 = code(BellError::CheckStale);
const CHECKER_DISAGREES: u32 = code(BellError::CheckerDisagrees);
const MARK_OFF_REFERENCE: u32 = code(BellError::MarkOffReference);
/// Anchor's own codes: an account at an address its seeds do not produce, an
/// instruction handed fewer accounts than it declares, and an account that
/// has never been created.
const CONSTRAINT_SEEDS: u32 = anchor_lang::error::ErrorCode::ConstraintSeeds as u32;
const ACCOUNT_NOT_ENOUGH_KEYS: u32 = anchor_lang::error::ErrorCode::AccountNotEnoughKeys as u32;
const ACCOUNT_NOT_INITIALIZED: u32 = anchor_lang::error::ErrorCode::AccountNotInitialized as u32;
/// The system program's `AccountAlreadyInUse`: what creating an account that
/// already exists returns.
const ALREADY_IN_USE: u32 = 0;

// --------------------------------------------------------------------- tests

#[test]
fn only_the_upgrade_authority_may_open_a_check() {
    let mut ctx = Ctx::new();
    setup(&mut ctx);
    let (auth, pd, checker) = (ctx.authority.insecure_clone(), ctx.program_data(), ctx.checker.pubkey());

    // A stranger signing as the authority.
    let stranger = ctx.filler.insecure_clone();
    assert_code(open_check(&mut ctx, sym(), &stranger, pd, checker), NOT_AUTHORITY, "not the upgrade authority");

    // The real authority, with a copy of the real ProgramData at another
    // address: the address is what makes it this program's.
    let copy = Pubkey::new_unique();
    let real = ctx.svm.get_account(&pd).unwrap();
    ctx.svm.set_account(copy, real.clone()).unwrap();
    assert_code(open_check(&mut ctx, sym(), &auth, copy, checker), NOT_AUTHORITY, "a forged ProgramData account");

    // A program made immutable has no authority at all, and nobody opens a
    // check on it.
    let mut none = real.clone();
    none.data[12] = 0;
    ctx.svm.set_account(pd, none).unwrap();
    assert_code(open_check(&mut ctx, sym(), &auth, pd, checker), NOT_AUTHORITY, "no upgrade authority recorded");
    ctx.svm.set_account(pd, real).unwrap();
    assert!(ctx.check(&sym()).is_none(), "no attempt created a check");

    open_check(&mut ctx, sym(), &auth, pd, checker).unwrap();
    let c = ctx.check(&sym()).unwrap();
    assert_eq!(c.checker, checker);
    assert_eq!(c.mint, ctx.stock_mint);
    assert_eq!(c.symbol, sym());
    // It opens saying nothing, which every fill reads as stale.
    assert!(!c.open_now);
    assert_eq!((c.ref_rate_q64, c.ref_at, c.observed_at), (0, 0, 0));
}

#[test]
fn a_check_must_name_a_checker_other_than_the_attestor() {
    let mut ctx = Ctx::new();
    setup(&mut ctx);
    let (auth, pd) = (ctx.authority.insecure_clone(), ctx.program_data());
    let attestor = ctx.attestor.pubkey();

    assert_code(open_check(&mut ctx, sym(), &auth, pd, attestor), BAD_PARAMETERS, "the attestor checking itself");
    assert_code(open_check(&mut ctx, sym(), &auth, pd, Pubkey::default()), BAD_PARAMETERS, "a key nobody holds");
    assert!(ctx.check(&sym()).is_none());

    let checker = ctx.checker.pubkey();
    open_check(&mut ctx, sym(), &auth, pd, checker).unwrap();
}

#[test]
fn a_check_can_be_opened_only_once() {
    // There is no rotation: a second open is a second create of the same
    // address, which the system program refuses, so the first checker stays.
    let mut ctx = Ctx::new();
    setup(&mut ctx);
    let (auth, pd, first) = (ctx.authority.insecure_clone(), ctx.program_data(), ctx.checker.pubkey());
    open_check(&mut ctx, sym(), &auth, pd, first).unwrap();

    let second = Keypair::new();
    assert_code(open_check(&mut ctx, sym(), &auth, pd, second.pubkey()), ALREADY_IN_USE, "a second open_check");
    assert_eq!(ctx.check(&sym()).unwrap().checker, first, "the first checker is still the checker");
    assert_code(push_check_as(&mut ctx, &second, true, aapl_rate(), NOW, NOW), NOT_CHECKER, "the would-be replacement");
}

#[test]
fn only_the_named_checker_may_push() {
    let mut ctx = Ctx::new();
    ready(&mut ctx);
    let (stranger, attestor) = (ctx.filler.insecure_clone(), ctx.attestor.insecure_clone());

    assert_code(push_check_as(&mut ctx, &stranger, false, aapl_rate(), NOW, NOW), NOT_CHECKER, "a stranger");
    assert_code(push_check_as(&mut ctx, &attestor, false, aapl_rate(), NOW, NOW), NOT_CHECKER, "the attestor");
    assert!(ctx.check(&sym()).unwrap().open_now, "neither push landed");

    push_check(&mut ctx, false, aapl_rate(), NOW, NOW).unwrap();
    assert!(!ctx.check(&sym()).unwrap().open_now);
}

#[test]
fn a_check_cannot_be_dated_in_the_future() {
    // A future time would buy the checker free freshness, as it would the
    // attestor.
    let mut ctx = Ctx::new();
    ready(&mut ctx);
    assert_code(push_check(&mut ctx, true, aapl_rate(), NOW, NOW + 1), TIMESTAMP_IN_FUTURE, "observed one second ahead");
    assert_eq!(ctx.check(&sym()).unwrap().observed_at, NOW);
}

#[test]
fn a_reference_later_than_its_observation_is_refused() {
    let mut ctx = Ctx::new();
    ready(&mut ctx);
    ctx.warp(NOW + 10);
    assert_code(push_check(&mut ctx, true, aapl_rate(), NOW + 10, NOW + 9), BAD_PARAMETERS, "a sale after the observation reporting it");
    // A reference with no price is not a reference either.
    assert_code(push_check(&mut ctx, true, 0, NOW + 9, NOW + 9), BAD_PARAMETERS, "a zero reference rate");
    assert_eq!(ctx.check(&sym()).unwrap().observed_at, NOW);

    // A sale at the observation's own second is fine.
    push_check(&mut ctx, true, aapl_rate(), NOW + 9, NOW + 9).unwrap();
    assert_eq!(ctx.check(&sym()).unwrap().ref_at, NOW + 9);
}

#[test]
fn the_old_fifteen_account_fill_is_refused_not_a_bypass() {
    // A filler built before the check existed sends the fifteen accounts it
    // always sent. The two new ones are appended, so what is missing is
    // exactly the check, and Anchor refuses for want of it before any
    // handler code runs: nothing is skipped and nothing moves.
    let mut ctx = Ctx::new();
    ready(&mut ctx);
    let buy = fund_buy(&mut ctx, DOLLAR);
    place_buy(&mut ctx, 1, &buy, DOLLAR, DOLLAR);
    let sell = fund_sell(&mut ctx, SHARE);
    place_sell(&mut ctx, 2, &sell, SHARE);
    let only_bell = vec![format!("Program {} invoke [1]", ctx.program_id)];

    let mut metas = buy_metas(&ctx, 1, &buy, ctx.check_pda(&sym()));
    assert_eq!(metas.len(), 17);
    metas.truncate(15);
    let (r, logs) = fill_with(&mut ctx, bell_session::instruction::FillOrder { amount_in_leg: DOLLAR, amount_out: buy_min(DOLLAR, aapl_rate(), 30) }.data(), metas);
    assert_code(r, ACCOUNT_NOT_ENOUGH_KEYS, "buy fill with the old fifteen accounts");
    assert_eq!(calls(&logs), only_bell, "no transfer was attempted");

    let mut metas = sell_metas(&ctx, 2, &sell);
    metas.truncate(15);
    let (r, logs) = fill_with(&mut ctx, bell_session::instruction::FillSellOrder { amount_in_leg: SHARE, amount_out: sell_min(SHARE, aapl_rate(), 30) }.data(), metas);
    assert_code(r, ACCOUNT_NOT_ENOUGH_KEYS, "sell fill with the old fifteen accounts");
    assert_eq!(calls(&logs), only_bell, "no transfer was attempted");

    assert_eq!(ctx.balance(&buy.payer_in), USER_QUOTE);
    assert_eq!(ctx.balance(&sell.payer_in), USER_STOCK);
    assert_eq!((ctx.balance(&buy.payee_out), ctx.balance(&sell.payee_out)), (0, 0));

    // With all seventeen, both fill.
    fill_buy(&mut ctx, 1, &buy, DOLLAR, buy_min(DOLLAR, aapl_rate(), 30)).unwrap();
    fill_sell(&mut ctx, 2, &sell, SHARE, sell_min(SHARE, aapl_rate(), 30)).unwrap();
}

#[test]
fn a_fill_naming_another_symbols_check_is_refused() {
    // A second ticker on the very same mint, with a checker that agrees with
    // everything. Its check passes the mint test, so only the address, fixed
    // by the order's own symbol, stands between it and the fill.
    let mut ctx = Ctx::new();
    ready(&mut ctx);
    let other = ticker("AAPL2");
    register(&mut ctx, other);
    let (auth, pd) = (ctx.authority.insecure_clone(), ctx.program_data());
    let lenient = Keypair::new();
    open_check(&mut ctx, other, &auth, pd, lenient.pubkey()).unwrap();
    let theirs = ctx.check_pda(&other);
    let cp = theirs;
    ctx.send(&[Instruction::new_with_bytes(
        ctx.program_id,
        &bell_session::instruction::PushCheck { symbol: other, open_now: true, ref_rate_q64: aapl_rate(), ref_px_num: 0, ref_px_expo: 0, ref_at: NOW, observed_at: NOW }.data(),
        bell_session::accounts::PushCheck { checker: lenient.pubkey(), check: cp }.to_account_metas(None),
    )], &[&lenient]).unwrap();
    assert_eq!(ctx.check(&other).unwrap().mint, ctx.stock_mint, "same mint as the order");

    let legs = fund_buy(&mut ctx, DOLLAR);
    place_buy(&mut ctx, 1, &legs, DOLLAR, DOLLAR);
    // The symbol's own check disagrees about the session, so the other one is
    // the only way this fill could pass.
    push_check(&mut ctx, false, aapl_rate(), NOW, NOW).unwrap();
    let min = buy_min(DOLLAR, aapl_rate(), 30);

    let metas = buy_metas(&ctx, 1, &legs, theirs);
    let (r, _) = fill_with(&mut ctx, bell_session::instruction::FillOrder { amount_in_leg: DOLLAR, amount_out: min }.data(), metas);
    assert_code(r, CONSTRAINT_SEEDS, "AAPL2's check on an AAPLx order");
    assert_code(fill_buy(&mut ctx, 1, &legs, DOLLAR, min), CHECKER_DISAGREES, "the order's own check");
    assert_eq!(ctx.balance(&legs.payer_in), USER_QUOTE);
}

#[test]
fn a_never_pushed_check_refuses_the_fill_as_stale() {
    let mut ctx = Ctx::new();
    setup(&mut ctx);
    let buy = fund_buy(&mut ctx, DOLLAR);
    place_buy(&mut ctx, 1, &buy, DOLLAR, DOLLAR);
    let sell = fund_sell(&mut ctx, SHARE);
    place_sell(&mut ctx, 2, &sell, SHARE);
    let (bmin, smin) = (buy_min(DOLLAR, aapl_rate(), 30), sell_min(SHARE, aapl_rate(), 30));

    // Before the check is even opened, which is every symbol's state between
    // the upgrade and its `open_check`, Anchor refuses the missing account.
    assert_code(fill_buy(&mut ctx, 1, &buy, DOLLAR, bmin), ACCOUNT_NOT_INITIALIZED, "no check opened yet");

    let (auth, pd, checker) = (ctx.authority.insecure_clone(), ctx.program_data(), ctx.checker.pubkey());
    open_check(&mut ctx, sym(), &auth, pd, checker).unwrap();
    assert_code(fill_buy(&mut ctx, 1, &buy, DOLLAR, bmin), CHECK_STALE, "buy against a check never pushed");
    assert_code(fill_sell(&mut ctx, 2, &sell, SHARE, smin), CHECK_STALE, "sell against a check never pushed");

    push_check(&mut ctx, true, aapl_rate(), NOW, NOW).unwrap();
    fill_buy(&mut ctx, 1, &buy, DOLLAR, bmin).unwrap();
    fill_sell(&mut ctx, 2, &sell, SHARE, smin).unwrap();
}

#[test]
fn a_stale_check_refuses_the_fill() {
    // The session and the mark are fresh throughout; only the check ages.
    let mut ctx = Ctx::new();
    ready(&mut ctx);
    let legs = fund_buy(&mut ctx, DOLLAR);
    place_buy(&mut ctx, 1, &legs, DOLLAR, DOLLAR / 4);
    let leg = DOLLAR / 4;
    let min = buy_min(leg, aapl_rate(), 30);

    // Exactly at the bound: still a view of now.
    ctx.warp(NOW + 120);
    push_session(&mut ctx, HaltState::None, true, NOW + 120);
    push_mark(&mut ctx, aapl_rate(), NOW + 120);
    fill_buy(&mut ctx, 1, &legs, leg, min).unwrap();

    // One second past it: refused.
    ctx.warp(NOW + 121);
    push_session(&mut ctx, HaltState::None, true, NOW + 121);
    push_mark(&mut ctx, aapl_rate(), NOW + 121);
    assert_code(fill_buy(&mut ctx, 1, &legs, leg, min), CHECK_STALE, "check pushed 121s ago");
    assert_eq!(ctx.balance(&legs.payer_in), USER_QUOTE - leg);

    push_check(&mut ctx, true, aapl_rate(), NOW + 121, NOW + 121).unwrap();
    fill_buy(&mut ctx, 1, &legs, leg, min).unwrap();
}

#[test]
fn a_session_fill_against_a_stuck_reference_is_refused() {
    // The checker goes on pushing, so its check is fresh, but the sale behind
    // its reference stopped moving: its feed is stuck. In session a listed
    // stock trades every few seconds, so a reference that old is refused, and
    // the checker cannot keep agreeing with the attestor about a stale price.
    let mut ctx = Ctx::new();
    ready(&mut ctx);
    let legs = fund_buy(&mut ctx, DOLLAR);
    place_buy(&mut ctx, 1, &legs, DOLLAR, DOLLAR / 4);
    let leg = DOLLAR / 4;
    let min = buy_min(leg, aapl_rate(), 30);

    // Exactly at the bound: the sale is still recent enough.
    push_check(&mut ctx, true, aapl_rate(), NOW - MAX_SESSION_REF_AGE_SECONDS, NOW).unwrap();
    fill_buy(&mut ctx, 1, &legs, leg, min).unwrap();

    // One second older, in a check pushed the same second: refused.
    ctx.warp(NOW + 1);
    push_session(&mut ctx, HaltState::None, true, NOW + 1);
    push_mark(&mut ctx, aapl_rate(), NOW + 1);
    push_check(&mut ctx, true, aapl_rate(), NOW - MAX_SESSION_REF_AGE_SECONDS, NOW + 1).unwrap();
    assert_code(fill_buy(&mut ctx, 1, &legs, leg, min), CHECK_STALE, "a fresh check over a sale 301s old");
    assert_eq!(ctx.balance(&legs.payer_in), USER_QUOTE - leg);

    // The feed moves again, and so do fills.
    push_check(&mut ctx, true, aapl_rate(), NOW + 1, NOW + 1).unwrap();
    fill_buy(&mut ctx, 1, &legs, leg, min).unwrap();
}

#[test]
fn the_checker_saying_closed_refuses_a_session_fill() {
    // The attestor says open; the checker says closed. A fill needs both.
    let mut ctx = Ctx::new();
    ready(&mut ctx);
    let buy = fund_buy(&mut ctx, DOLLAR);
    place_buy(&mut ctx, 1, &buy, DOLLAR, DOLLAR);
    let sell = fund_sell(&mut ctx, SHARE);
    place_sell(&mut ctx, 2, &sell, SHARE);
    let (bmin, smin) = (buy_min(DOLLAR, aapl_rate(), 30), sell_min(SHARE, aapl_rate(), 30));

    push_check(&mut ctx, false, aapl_rate(), NOW, NOW).unwrap();
    assert_code(fill_buy(&mut ctx, 1, &buy, DOLLAR, bmin), CHECKER_DISAGREES, "buy, the checker says closed");
    assert_code(fill_sell(&mut ctx, 2, &sell, SHARE, smin), CHECKER_DISAGREES, "sell, the checker says closed");
    assert_eq!((ctx.balance(&buy.payer_in), ctx.balance(&sell.payer_in)), (USER_QUOTE, USER_STOCK));

    push_check(&mut ctx, true, aapl_rate(), NOW, NOW).unwrap();
    fill_buy(&mut ctx, 1, &buy, DOLLAR, bmin).unwrap();
    fill_sell(&mut ctx, 2, &sell, SHARE, smin).unwrap();
}

#[test]
fn a_mark_outside_the_session_band_is_refused_and_moves_nothing() {
    // One step past 300bps either side of the checker's reference. Each mark
    // is pushed a minute after the last, inside the step limit, so it is
    // written, and it is the fill that refuses it.
    let mut ctx = Ctx::new();
    ready(&mut ctx);
    let buy = fund_buy(&mut ctx, DOLLAR);
    place_buy(&mut ctx, 1, &buy, DOLLAR, DOLLAR);
    let sell = fund_sell(&mut ctx, SHARE);
    place_sell(&mut ctx, 2, &sell, SHARE);

    let m = MAX_MARK_AGE_SECONDS;
    let high = step(aapl_rate(), 301);
    mark_a_minute_on(&mut ctx, high, NOW + m);
    assert_code(fill_buy(&mut ctx, 1, &buy, DOLLAR, buy_min(DOLLAR, high, 30)), MARK_OFF_REFERENCE, "mark 301 steps above the reference");

    // Back through the reference, so no single push steps too far.
    mark_a_minute_on(&mut ctx, aapl_rate(), NOW + 2 * m);
    let low = step(aapl_rate(), -301);
    mark_a_minute_on(&mut ctx, low, NOW + 3 * m);
    assert_code(fill_sell(&mut ctx, 2, &sell, SHARE, sell_min(SHARE, low, 30)), MARK_OFF_REFERENCE, "mark 301 steps below the reference");

    for (acc, want) in [
        (buy.payer_in, USER_QUOTE), (buy.payee_out, 0), (buy.filler_in, 0), (buy.filler_out, FILLER_STOCK),
        (sell.payer_in, USER_STOCK), (sell.payee_out, 0), (sell.filler_in, 0), (sell.filler_out, FILLER_QUOTE),
    ] {
        assert_eq!(ctx.balance(&acc), want, "nothing moved");
    }
}

#[test]
fn a_mark_exactly_at_the_band_edge_fills() {
    let mut ctx = Ctx::new();
    ready(&mut ctx);
    let buy = fund_buy(&mut ctx, DOLLAR);
    place_buy(&mut ctx, 1, &buy, DOLLAR, DOLLAR);
    let sell = fund_sell(&mut ctx, SHARE);
    place_sell(&mut ctx, 2, &sell, SHARE);

    let m = MAX_MARK_AGE_SECONDS;
    let high = step(aapl_rate(), 300);
    mark_a_minute_on(&mut ctx, high, NOW + m);
    let min = buy_min(DOLLAR, high, 30);
    fill_buy(&mut ctx, 1, &buy, DOLLAR, min).unwrap();
    assert_eq!(ctx.balance(&buy.payee_out), min);

    mark_a_minute_on(&mut ctx, aapl_rate(), NOW + 2 * m);
    let low = step(aapl_rate(), -300);
    mark_a_minute_on(&mut ctx, low, NOW + 3 * m);
    let min = sell_min(SHARE, low, 30);
    fill_sell(&mut ctx, 2, &sell, SHARE, min).unwrap();
    assert_eq!(ctx.balance(&sell.payee_out), min);
}

#[test]
fn a_halt_still_reports_as_a_halt_over_a_stale_check() {
    // The gate runs before the check, so a user sees the most fundamental
    // reason: the market is halted, not that a second opinion is late.
    let mut ctx = Ctx::new();
    ready(&mut ctx);
    let legs = fund_buy(&mut ctx, DOLLAR);
    place_buy(&mut ctx, 1, &legs, DOLLAR, DOLLAR);
    let min = buy_min(DOLLAR, aapl_rate(), 30);

    ctx.warp(NOW + 121);
    push_mark(&mut ctx, aapl_rate(), NOW + 121);
    push_session(&mut ctx, HaltState::Luld, true, NOW + 121);
    assert_code(fill_buy(&mut ctx, 1, &legs, DOLLAR, min), MARKET_CLOSED, "halted, and the check is 121s old");

    // Unhalted, the stale check is what remains.
    push_session(&mut ctx, HaltState::None, true, NOW + 121);
    assert_code(fill_buy(&mut ctx, 1, &legs, DOLLAR, min), CHECK_STALE, "the check is 121s old");
    assert_eq!(ctx.balance(&legs.payer_in), USER_QUOTE);
}
