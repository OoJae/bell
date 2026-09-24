//! The mark's circuit breaker: one push may move the price one step at most.
//!
//! The harness is copied from `test_queue.rs` and `test_sell.rs` rather than
//! shared with them, so each suite stays readable on its own. As there, token
//! accounts are written directly in the fixed SPL layout, and the stock is the
//! **real mainnet AAPLx mint**, so the gate reads genuine issuer state.
//!
//! A whole step is allowed once a minute (`MAX_MARK_AGE_SECONDS`) has passed
//! since the observation on record, and that share of a step before then, so
//! the tests that take a whole step do so a minute apart.
//!
//! A push that steps too far is not refused: it is held. The transaction
//! succeeds, the mark keeps the rate it had, and its `conf_bps` becomes
//! `u16::MAX`, which every fill refuses as MarkPaused. Each test below reads
//! the mark account itself, because a push that "succeeded" says nothing about
//! whether it was written.

use {
    anchor_lang::{
        prelude::Pubkey,
        solana_program::{
            bpf_loader_upgradeable,
            instruction::{AccountMeta, Instruction},
            system_program,
        },
        AccountDeserialize, AnchorDeserialize, Discriminator, InstructionData, ToAccountMetas,
    },
    anchor_lang::solana_program::clock::Clock,
    bell_session::{
        constants::{
            AUTH_SEED, CHECK_SEED, MARK_SEED, MAX_MARK_AGE_SECONDS, MAX_MARK_STEP_AGE_SECONDS,
            MAX_MARK_STEP_BPS, NIGHT_SEED, ORDER_SEED, RISK_SEED, SELL_SEED, SYMBOL_LEN, SYMBOL_SEED,
        },
        error::BellError,
        state::{HaltState, HoursMode, MarkSource, MarkTripped, SymbolMark},
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
const PFE_BACKPACK: &str = "PFER6ENqP8r8NF3CqVt4mFowxsin3V5MLidBNQFCC3x";
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
/// What `push_mark` claims a push carries, other than its rate and time.
const PX_NUM: u64 = 33_400_000;
const CONF: u16 = 10;

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

    /// `send`, keeping the program logs, which carry any event emitted.
    fn send_logged(&mut self, ixs: &[Instruction], signers: &[&Keypair]) -> (Result<(), String>, Vec<String>) {
        // A push retried after a state change is byte-identical, so a fresh
        // blockhash keeps the runtime from treating it as a replay.
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
    fn mark_pda(&self, s: &[u8; SYMBOL_LEN]) -> Pubkey { self.pda(&[MARK_SEED, s]) }
    fn check_pda(&self) -> Pubkey { self.pda(&[CHECK_SEED, &sym()]) }
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

    fn mark_of(&self, s: &[u8; SYMBOL_LEN]) -> SymbolMark {
        let a = self.svm.get_account(&self.mark_pda(s)).unwrap();
        SymbolMark::try_deserialize(&mut &a.data[..]).unwrap()
    }

    fn mark(&self) -> SymbolMark {
        self.mark_of(&sym())
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

/// The largest move one push may make from `rate` a minute or more after the
/// mark on record, in rate units.
fn limit(rate: u128) -> u128 {
    rate / 10_000 * MAX_MARK_STEP_BPS as u128
}

/// The largest move a push `secs` seconds after the mark on record may make
/// from `rate`: that share of a minute's step, in the program's arithmetic.
fn allowance(rate: u128, secs: i64) -> u128 {
    rate / 10_000 * (MAX_MARK_STEP_BPS as u128 * secs.min(MAX_MARK_AGE_SECONDS) as u128) / MAX_MARK_AGE_SECONDS as u128
}

/// A minute on from NOW: long enough for a whole step.
const M: i64 = MAX_MARK_AGE_SECONDS;

// ------------------------------------------------------------- setup and pushes

/// Register `s` on `mint` and open its mark, with nothing pushed yet.
fn open_symbol(ctx: &mut Ctx, s: [u8; SYMBOL_LEN], mint: Pubkey) {
    let (p, a, qm) = (ctx.payer.pubkey(), ctx.attestor.pubkey(), ctx.quote_mint);
    let (sp, mp) = (ctx.sym_pda(&s), ctx.mark_pda(&s));
    ctx.send(&[Instruction::new_with_bytes(
        ctx.program_id,
        &bell_session::instruction::RegisterSymbol { symbol: s, mint, exchange_mic: *b"XNAS", hours_mode: HoursMode::TwentyFourFive, attestor: a }.data(),
        bell_session::accounts::RegisterSymbol { payer: p, symbol_state: sp, system_program: system_program::ID }.to_account_metas(None),
    )], &[]).unwrap();
    ctx.send(&[Instruction::new_with_bytes(
        ctx.program_id,
        &bell_session::instruction::OpenMark { symbol: s, quote_mint: qm }.data(),
        bell_session::accounts::OpenMark { payer: p, symbol_state: sp, mark: mp, system_program: system_program::ID }.to_account_metas(None),
    )], &[]).unwrap();
}

/// AAPLx registered, risk-read, checked and attested open, with its mark
/// opened but never pushed.
fn ready_unmarked(ctx: &mut Ctx) {
    let p = ctx.payer.pubkey();
    let (sp, rp, cp, pd, sm) = (ctx.sym_pda(&sym()), ctx.risk_pda(), ctx.check_pda(), ctx.program_data(), ctx.stock_mint);
    open_symbol(ctx, sym(), sm);
    ctx.send(&[Instruction::new_with_bytes(
        ctx.program_id,
        &bell_session::instruction::InitTokenRisk { attestor: p }.data(),
        bell_session::accounts::InitTokenRisk { payer: p, mint: sm, risk: rp, system_program: system_program::ID }.to_account_metas(None),
    )], &[]).unwrap();
    let auth = ctx.authority.insecure_clone();
    ctx.send(&[Instruction::new_with_bytes(
        ctx.program_id,
        &bell_session::instruction::OpenCheck { symbol: sym(), checker: ctx.checker.pubkey() }.data(),
        bell_session::accounts::OpenCheck { payer: p, authority: auth.pubkey(), program_data: pd, symbol_state: sp, check: cp, system_program: system_program::ID }.to_account_metas(None),
    )], &[&auth]).unwrap();
    push_session(ctx, HaltState::None, true, NOW);
}

/// The baseline: everything above, with the mark at `aapl_rate()` and the
/// checker agreeing with it.
fn ready(ctx: &mut Ctx) {
    ready_unmarked(ctx);
    push_mark(ctx, aapl_rate(), NOW).unwrap();
    push_check(ctx, aapl_rate(), NOW);
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

/// A `push_mark` instruction for `s`, so a test can batch several.
fn push_mark_ix(ctx: &Ctx, s: [u8; SYMBOL_LEN], rate_q64: u128, px_num: u64, source: MarkSource, observed_at: i64) -> Instruction {
    Instruction::new_with_bytes(
        ctx.program_id,
        &bell_session::instruction::PushMark { symbol: s, rate_q64, px_num, px_expo: -5, conf_bps: CONF, source, observed_at }.data(),
        bell_session::accounts::PushMark { attestor: ctx.attestor.pubkey(), symbol_state: ctx.sym_pda(&s), mark: ctx.mark_pda(&s) }.to_account_metas(None),
    )
}

/// Push AAPLx's mark alone, returning the logs so a test can look for a trip.
fn push_mark_logged(ctx: &mut Ctx, rate_q64: u128, observed_at: i64) -> (Result<(), String>, Vec<String>) {
    let ix = push_mark_ix(ctx, sym(), rate_q64, PX_NUM, MarkSource::Backpack, observed_at);
    let a = ctx.attestor.insecure_clone();
    ctx.send_logged(&[ix], &[&a])
}

fn push_mark(ctx: &mut Ctx, rate_q64: u128, observed_at: i64) -> Result<(), String> {
    push_mark_logged(ctx, rate_q64, observed_at).0
}

/// The checker, open, with its reference at `rate`.
fn push_check(ctx: &mut Ctx, rate: u128, observed_at: i64) {
    let c = ctx.checker.insecure_clone();
    let cp = ctx.check_pda();
    ctx.send(&[Instruction::new_with_bytes(
        ctx.program_id,
        &bell_session::instruction::PushCheck { symbol: sym(), open_now: true, ref_rate_q64: rate, ref_px_num: PX_NUM, ref_px_expo: -5, ref_at: observed_at, observed_at }.data(),
        bell_session::accounts::PushCheck { checker: c.pubkey(), check: cp }.to_account_metas(None),
    )], &[&c]).unwrap();
}

// -------------------------------------------------------------------- events

/// Standard base64, decoded by hand, as in `test_sell.rs`.
fn b64(s: &str) -> Vec<u8> {
    let val = |c: u8| -> u32 {
        match c {
            b'A'..=b'Z' => (c - b'A') as u32,
            b'a'..=b'z' => (c - b'a' + 26) as u32,
            b'0'..=b'9' => (c - b'0' + 52) as u32,
            b'+' => 62,
            b'/' => 63,
            _ => panic!("not base64: {c}"),
        }
    };
    let bytes: Vec<u8> = s.bytes().filter(|&c| c != b'=').collect();
    let mut out = Vec::with_capacity(bytes.len() * 3 / 4);
    for chunk in bytes.chunks(4) {
        let mut acc = 0u32;
        for (i, &c) in chunk.iter().enumerate() {
            acc |= val(c) << (18 - 6 * i);
        }
        let n = chunk.len() * 6 / 8;
        out.extend_from_slice(&acc.to_be_bytes()[1..1 + n]);
    }
    out
}

/// Every `MarkTripped` a transaction emitted, in order.
fn trips(logs: &[String]) -> Vec<MarkTripped> {
    logs.iter()
        .filter_map(|l| l.strip_prefix("Program data: "))
        .map(b64)
        .filter(|d| d.starts_with(MarkTripped::DISCRIMINATOR))
        .map(|d| MarkTripped::deserialize(&mut &d[MarkTripped::DISCRIMINATOR.len()..]).unwrap())
        .collect()
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

fn place_buy(ctx: &mut Ctx, nonce: u64, legs: &Legs, amount_in: u64) {
    let u = ctx.user.insecure_clone();
    let (sp, rp, mp, op) = (ctx.sym_pda(&sym()), ctx.risk_pda(), ctx.mark_pda(&sym()), ctx.order_pda(nonce));
    ctx.send(&[Instruction::new_with_bytes(
        ctx.program_id,
        &bell_session::instruction::PlaceOrder { symbol: sym(), nonce, amount_in, min_fill_in: amount_in, max_slip_bps: 30, max_conf_bps: 50, floor_rate_q64: 0, not_before: 0, expires_at: NOW + 86_400 }.data(),
        bell_session::accounts::PlaceOrder { owner: u.pubkey(), symbol_state: sp, risk: rp, mark: mp, order: op, payer_in: legs.payer_in, payee_out: legs.payee_out, system_program: system_program::ID }.to_account_metas(None),
    )], &[&u]).unwrap();
}

fn place_sell(ctx: &mut Ctx, nonce: u64, legs: &Legs, amount_in: u64) {
    let u = ctx.user.insecure_clone();
    let (sp, rp, mp, op) = (ctx.sym_pda(&sym()), ctx.risk_pda(), ctx.mark_pda(&sym()), ctx.sell_pda(nonce));
    ctx.send(&[Instruction::new_with_bytes(
        ctx.program_id,
        &bell_session::instruction::PlaceSellOrder { symbol: sym(), nonce, amount_in, min_fill_in: amount_in, max_slip_bps: 30, max_conf_bps: 50, floor_rate_q64: 0, not_before: 0, expires_at: NOW + 86_400 }.data(),
        bell_session::accounts::PlaceSellOrder { owner: u.pubkey(), symbol_state: sp, risk: rp, mark: mp, order: op, payer_in: legs.payer_in, payee_out: legs.payee_out, system_program: system_program::ID }.to_account_metas(None),
    )], &[&u]).unwrap();
}

fn buy_metas(ctx: &Ctx, nonce: u64, legs: &Legs) -> Vec<AccountMeta> {
    bell_session::accounts::FillOrder {
        filler: ctx.filler.pubkey(),
        order: ctx.order_pda(nonce),
        symbol_state: ctx.sym_pda(&sym()),
        risk: ctx.risk_pda(),
        mark: ctx.mark_pda(&sym()),
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
        check: ctx.check_pda(),
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
        mark: ctx.mark_pda(&sym()),
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
        check: ctx.check_pda(),
        night: ctx.night_pda(),
    }
    .to_account_metas(None)
}

fn fill_buy(ctx: &mut Ctx, nonce: u64, legs: &Legs, amount_in_leg: u64, amount_out: u64) -> Result<(), String> {
    let metas = buy_metas(ctx, nonce, legs);
    let f = ctx.filler.insecure_clone();
    ctx.send(&[Instruction::new_with_bytes(ctx.program_id, &bell_session::instruction::FillOrder { amount_in_leg, amount_out }.data(), metas)], &[&f])
}

fn fill_sell(ctx: &mut Ctx, nonce: u64, legs: &Legs, amount_in_leg: u64, amount_out: u64) -> Result<(), String> {
    let metas = sell_metas(ctx, nonce, legs);
    let f = ctx.filler.insecure_clone();
    ctx.send(&[Instruction::new_with_bytes(ctx.program_id, &bell_session::instruction::FillSellOrder { amount_in_leg, amount_out }.data(), metas)], &[&f])
}

/// The least stock a buy of `leg` may deliver at 30bps, rounded down.
fn buy_min(leg: u64, rate: u128) -> u64 {
    (((leg as u128 * rate) >> 64) * 9_970 / 10_000) as u64
}

/// The least quote a sale of `leg` may be paid at 30bps, rounded up.
fn sell_min(leg: u64, rate: u128) -> u64 {
    let num = (leg as u128) << 64;
    let fair = num / rate + u128::from(num % rate != 0);
    let t = fair * 9_970;
    (t / 10_000 + u128::from(t % 10_000 != 0)) as u64
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
const MARK_PAUSED: u32 = code(BellError::MarkPaused);

/// Assert the mark still says what it said: rate, time, price and source,
/// with only the held marker possibly set.
fn assert_held(ctx: &Ctx, rate: u128, observed_at: i64, why: &str) {
    let m = ctx.mark();
    assert_eq!(m.conf_bps, u16::MAX, "{why}: the mark is held");
    assert_eq!(m.rate_q64, rate, "{why}: the rate is the one before the push");
    assert_eq!(m.observed_at, observed_at, "{why}: and so is its time");
    assert_eq!(m.px_num, PX_NUM, "{why}: and its price");
    assert_eq!(m.source, MarkSource::Backpack, "{why}: and its source");
}

/// Assert the mark was written by the last push.
fn assert_written(ctx: &Ctx, rate: u128, observed_at: i64, why: &str) {
    let m = ctx.mark();
    assert_eq!((m.rate_q64, m.observed_at, m.conf_bps), (rate, observed_at, CONF), "{why}");
}

// --------------------------------------------------------------------- tests

#[test]
fn the_first_push_to_a_fresh_mark_is_accepted_at_any_rate() {
    // A mark that has never been pushed carries no price to step from. It
    // opens reading as held — `conf_bps` at the marker — and as stale, and
    // the first push sets it wherever the attestor says.
    let mut ctx = Ctx::new();
    ready_unmarked(&mut ctx);
    let m = ctx.mark();
    assert_eq!((m.rate_q64, m.observed_at, m.conf_bps), (0, 0, u16::MAX));

    let wild = aapl_rate() * 1_000;
    let (r, logs) = push_mark_logged(&mut ctx, wild, NOW);
    r.unwrap();
    assert_written(&ctx, wild, NOW, "the first push lands at a thousand times the usual rate");
    assert!(trips(&logs).is_empty(), "and trips nothing");
}

#[test]
fn a_step_within_the_limit_is_accepted() {
    let mut ctx = Ctx::new();
    ready(&mut ctx);

    ctx.warp(NOW + M);
    let up = step(aapl_rate(), 400);
    push_mark(&mut ctx, up, NOW + M).unwrap();
    assert_written(&ctx, up, NOW + M, "four percent up");

    ctx.warp(NOW + 2 * M);
    let down = step(up, -400);
    push_mark(&mut ctx, down, NOW + 2 * M).unwrap();
    assert_written(&ctx, down, NOW + 2 * M, "four percent back down");
}

#[test]
fn a_step_exactly_at_the_limit_is_accepted() {
    let mut ctx = Ctx::new();
    ready(&mut ctx);

    ctx.warp(NOW + M);
    let up = aapl_rate() + limit(aapl_rate());
    assert_eq!(up, step(aapl_rate(), MAX_MARK_STEP_BPS as i64));
    push_mark(&mut ctx, up, NOW + M).unwrap();
    assert_written(&ctx, up, NOW + M, "exactly one step up");

    // The limit is measured from the mark on record, which is now `up`.
    ctx.warp(NOW + 2 * M);
    let down = up - limit(up);
    push_mark(&mut ctx, down, NOW + 2 * M).unwrap();
    assert_written(&ctx, down, NOW + 2 * M, "exactly one step down");
}

#[test]
fn a_step_beyond_the_limit_trips_and_keeps_the_last_rate() {
    let mut ctx = Ctx::new();
    ready(&mut ctx);

    // One rate unit past the step, carrying a different price and source,
    // neither of which may land either.
    ctx.warp(NOW + M);
    let pushed = aapl_rate() + limit(aapl_rate()) + 1;
    let ix = push_mark_ix(&ctx, sym(), pushed, 99_900_000, MarkSource::Pyth, NOW + M);
    let a = ctx.attestor.insecure_clone();
    let (r, logs) = ctx.send_logged(&[ix], &[&a]);
    r.expect("a trip holds the mark; it does not fail the push");
    assert_held(&ctx, aapl_rate(), NOW, "one unit past the step");

    let t = trips(&logs);
    assert_eq!(t.len(), 1, "one MarkTripped");
    assert_eq!(t[0].symbol, sym());
    assert_eq!((t[0].held_rate_q64, t[0].pushed_rate_q64), (aapl_rate(), pushed));
    assert_eq!((t[0].held_observed_at, t[0].pushed_observed_at), (NOW, NOW + M));
}

#[test]
fn the_breaker_trips_in_both_directions() {
    let mut ctx = Ctx::new();
    ready(&mut ctx);

    ctx.warp(NOW + M);
    push_mark(&mut ctx, aapl_rate() + limit(aapl_rate()) + 1, NOW + M).unwrap();
    assert_held(&ctx, aapl_rate(), NOW, "a jump up");

    // Cleared by a push back inside the step, then a fall one unit too far.
    push_mark(&mut ctx, aapl_rate(), NOW + M).unwrap();
    assert_written(&ctx, aapl_rate(), NOW + M, "cleared");
    ctx.warp(NOW + 2 * M);
    let (r, logs) = push_mark_logged(&mut ctx, aapl_rate() - limit(aapl_rate()) - 1, NOW + 2 * M);
    r.unwrap();
    assert_held(&ctx, aapl_rate(), NOW + M, "a fall");
    assert_eq!(trips(&logs).len(), 1);
}

#[test]
fn a_tripped_mark_refuses_buy_and_sell_fills_as_mark_paused() {
    let mut ctx = Ctx::new();
    ready(&mut ctx);
    let buy = fund_buy(&mut ctx, DOLLAR);
    place_buy(&mut ctx, 1, &buy, DOLLAR);
    let sell = fund_sell(&mut ctx, SHARE);
    place_sell(&mut ctx, 2, &sell, SHARE);

    // Tripped in the same second, so the held mark is still fresh: the only
    // thing wrong with it is the hold.
    push_mark(&mut ctx, aapl_rate() * 2, NOW).unwrap();
    assert_held(&ctx, aapl_rate(), NOW, "doubled in one push");

    let (bmin, smin) = (buy_min(DOLLAR, aapl_rate()), sell_min(SHARE, aapl_rate()));
    assert_code(fill_buy(&mut ctx, 1, &buy, DOLLAR, bmin), MARK_PAUSED, "buy against a held mark");
    assert_code(fill_sell(&mut ctx, 2, &sell, SHARE, smin), MARK_PAUSED, "sell against a held mark");
    assert_eq!((ctx.balance(&buy.payer_in), ctx.balance(&sell.payer_in)), (USER_QUOTE, USER_STOCK));
    assert_eq!((ctx.balance(&buy.payee_out), ctx.balance(&sell.payee_out)), (0, 0));
}

#[test]
fn a_tripped_mark_clears_when_the_price_returns_inside_the_step() {
    let mut ctx = Ctx::new();
    ready(&mut ctx);
    let legs = fund_buy(&mut ctx, DOLLAR);
    place_buy(&mut ctx, 1, &legs, DOLLAR);

    ctx.warp(NOW + 30);
    push_mark(&mut ctx, aapl_rate() * 2, NOW + 30).unwrap();
    assert_held(&ctx, aapl_rate(), NOW, "doubled in one push");

    // Two percent from the held rate, thirty seconds after it, is inside the
    // half step those seconds allow: written, and the marker is gone with it.
    let back = step(aapl_rate(), 200);
    push_mark(&mut ctx, back, NOW + 30).unwrap();
    assert_written(&ctx, back, NOW + 30, "back inside the step");
    push_check(&mut ctx, back, NOW + 30);
    let min = buy_min(DOLLAR, back);
    fill_buy(&mut ctx, 1, &legs, DOLLAR, min).unwrap();
    assert_eq!(ctx.balance(&legs.payee_out), min);
}

#[test]
fn after_the_reset_window_any_rate_is_accepted() {
    // A mark five minutes old is no longer evidence of the price, so the next
    // push is not held to it. Without this a genuine overnight gap larger
    // than a step would hold the mark forever.
    let mut ctx = Ctx::new();
    ready(&mut ctx);
    let doubled = aapl_rate() * 2;

    ctx.warp(NOW + MAX_MARK_STEP_AGE_SECONDS);
    push_mark(&mut ctx, doubled, NOW + MAX_MARK_STEP_AGE_SECONDS).unwrap();
    assert_held(&ctx, aapl_rate(), NOW, "at exactly the window, still anchored");

    ctx.warp(NOW + MAX_MARK_STEP_AGE_SECONDS + 1);
    push_mark(&mut ctx, doubled, NOW + MAX_MARK_STEP_AGE_SECONDS + 1).unwrap();
    assert_written(&ctx, doubled, NOW + MAX_MARK_STEP_AGE_SECONDS + 1, "one second past it, set anew");
}

#[test]
fn an_older_observation_than_the_one_on_record_is_ignored() {
    let mut ctx = Ctx::new();
    ready(&mut ctx);

    ctx.warp(NOW + M + 10);
    let newer = step(aapl_rate(), 300);
    push_mark(&mut ctx, newer, NOW + M).unwrap();
    assert_written(&ctx, newer, NOW + M, "a newer observation lands");

    // Older than the record: the push succeeds and writes nothing, neither
    // the in-step rate nor, for the wild one, the held marker.
    for (rate, why) in [(aapl_rate(), "an older in-step rate"), (aapl_rate() * 3, "an older wild rate")] {
        let (r, logs) = push_mark_logged(&mut ctx, rate, NOW + 5);
        r.unwrap();
        assert_written(&ctx, newer, NOW + M, why);
        assert!(trips(&logs).is_empty(), "{why}: nothing tripped");
    }
}

#[test]
fn the_breaker_cannot_be_reset_by_backdating_in_the_same_transaction() {
    // The attack: in one transaction, first push something that makes the
    // mark look old, then push the wild rate while it looks unanchored. A
    // backdated push is ignored, and anchoring is measured from the clock, so
    // neither half works.
    let mut ctx = Ctx::new();
    ready(&mut ctx);
    ctx.warp(NOW + 10);
    let wild = aapl_rate() * 3;
    let old = NOW - MAX_MARK_STEP_AGE_SECONDS - 1;

    let ixs = [
        push_mark_ix(&ctx, sym(), aapl_rate(), PX_NUM, MarkSource::Backpack, old),
        push_mark_ix(&ctx, sym(), wild, PX_NUM, MarkSource::Backpack, NOW + 10),
    ];
    let a = ctx.attestor.insecure_clone();
    let (r, logs) = ctx.send_logged(&ixs, &[&a]);
    r.unwrap();
    assert_held(&ctx, aapl_rate(), NOW, "backdated first, then wild");
    assert_eq!(trips(&logs).len(), 1);

    // Tripped first, then an attempt to un-trip by backdating, then the wild
    // rate again: still held, at the same rate and time.
    let ixs = [
        push_mark_ix(&ctx, sym(), wild, PX_NUM, MarkSource::Backpack, NOW + 10),
        push_mark_ix(&ctx, sym(), wild, PX_NUM, MarkSource::Backpack, old),
        push_mark_ix(&ctx, sym(), wild, PX_NUM, MarkSource::Backpack, NOW + 10),
    ];
    let (r, logs) = ctx.send_logged(&ixs, &[&a]);
    r.unwrap();
    assert_held(&ctx, aapl_rate(), NOW, "wild, backdated, wild");
    assert_eq!(trips(&logs).len(), 2, "each in-time wild push trips; the backdated one is ignored");
}

#[test]
fn a_batch_with_one_tripped_symbol_still_updates_the_others() {
    // The keeper pushes every symbol's mark in one transaction. One symbol
    // stepping too far must not cost the others their update, which is why
    // a trip holds rather than fails.
    let mut ctx = Ctx::new();
    ready(&mut ctx);
    let pfe = ticker("PFE");
    open_symbol(&mut ctx, pfe, PFE_BACKPACK.parse().unwrap());
    let pfe_rate = (1u128 << 64) / 25;
    let a = ctx.attestor.insecure_clone();
    let ix = push_mark_ix(&ctx, pfe, pfe_rate, 2_500_000, MarkSource::Backpack, NOW);
    ctx.send(&[ix], &[&a]).unwrap();

    ctx.warp(NOW + 30);
    let pfe_next = step(pfe_rate, 100);
    let ixs = [
        push_mark_ix(&ctx, sym(), aapl_rate() * 2, PX_NUM, MarkSource::Backpack, NOW + 30),
        push_mark_ix(&ctx, pfe, pfe_next, 2_525_000, MarkSource::Backpack, NOW + 30),
    ];
    let (r, logs) = ctx.send_logged(&ixs, &[&a]);
    r.expect("the batch succeeds");
    assert_held(&ctx, aapl_rate(), NOW, "AAPLx doubled and was held");
    let p = ctx.mark_of(&pfe);
    assert_eq!((p.rate_q64, p.observed_at, p.conf_bps, p.px_num), (pfe_next, NOW + 30, CONF, 2_525_000), "PFE was written");
    let t = trips(&logs);
    assert_eq!(t.len(), 1);
    assert_eq!(t[0].symbol, sym(), "only AAPLx tripped");
}

#[test]
fn pushes_at_the_time_on_record_cannot_move_the_mark() {
    // The walk: in one transaction, ten pushes, each one step from the last
    // and all at the time on record. Each would pass a limit measured per
    // push, and together they would move the price by 63%. Measured against
    // the time elapsed, none of them may move the rate at all.
    let mut ctx = Ctx::new();
    ready(&mut ctx);
    let a = ctx.attestor.insecure_clone();

    let mut rate = aapl_rate();
    let mut ixs = Vec::new();
    for _ in 0..10 {
        rate = step(rate, MAX_MARK_STEP_BPS as i64);
        ixs.push(push_mark_ix(&ctx, sym(), rate, PX_NUM, MarkSource::Backpack, NOW));
    }
    let (r, logs) = ctx.send_logged(&ixs, &[&a]);
    r.expect("a walk holds the mark; it does not fail the batch");
    assert_held(&ctx, aapl_rate(), NOW, "ten steps at the time on record");
    assert_eq!(trips(&logs).len(), 10, "every push in the walk tripped");

    // Not even by one rate unit.
    push_mark(&mut ctx, aapl_rate() + 1, NOW).unwrap();
    assert_held(&ctx, aapl_rate(), NOW, "one unit at the time on record");

    // The same rate again is no move, so it is written, and clears the hold.
    push_mark(&mut ctx, aapl_rate(), NOW).unwrap();
    assert_written(&ctx, aapl_rate(), NOW, "the rate on record, re-pushed");
}

#[test]
fn the_step_allowed_grows_with_the_time_since_the_mark() {
    // Half a minute after the mark on record, half a step, exactly: one unit
    // more is held.
    let mut ctx = Ctx::new();
    ready(&mut ctx);
    let half = allowance(aapl_rate(), M / 2);
    assert_eq!(half, limit(aapl_rate()) / 2);

    ctx.warp(NOW + M / 2);
    push_mark(&mut ctx, aapl_rate() + half + 1, NOW + M / 2).unwrap();
    assert_held(&ctx, aapl_rate(), NOW, "a half step and one unit, after half a minute");
    push_mark(&mut ctx, aapl_rate() + half, NOW + M / 2).unwrap();
    assert_written(&ctx, aapl_rate() + half, NOW + M / 2, "a half step, after half a minute");
}

#[test]
fn a_walk_split_across_seconds_moves_no_faster_than_one_step_a_minute() {
    // Six whole steps, ten seconds apart, in one transaction: each is six
    // times what its ten seconds allow, so each is held.
    let mut ctx = Ctx::new();
    ready(&mut ctx);
    let a = ctx.attestor.insecure_clone();
    ctx.warp(NOW + M);

    let mut rate = aapl_rate();
    let mut ixs = Vec::new();
    for i in 1..=6 {
        rate = step(rate, MAX_MARK_STEP_BPS as i64);
        ixs.push(push_mark_ix(&ctx, sym(), rate, PX_NUM, MarkSource::Backpack, NOW + 10 * i));
    }
    let (r, logs) = ctx.send_logged(&ixs, &[&a]);
    r.unwrap();
    assert_held(&ctx, aapl_rate(), NOW, "six whole steps in a minute");
    assert_eq!(trips(&logs).len(), 6);

    // The same minute taken at the most each ten seconds allows: every push
    // lands, and the minute ends one compounded step up, not six.
    push_mark(&mut ctx, aapl_rate(), NOW).unwrap();
    let mut rate = aapl_rate();
    let mut ixs = Vec::new();
    for i in 1..=6 {
        rate += allowance(rate, 10);
        ixs.push(push_mark_ix(&ctx, sym(), rate, PX_NUM, MarkSource::Backpack, NOW + 10 * i));
    }
    let (r, logs) = ctx.send_logged(&ixs, &[&a]);
    r.unwrap();
    assert!(trips(&logs).is_empty(), "each push within its share");
    assert_written(&ctx, rate, NOW + M, "a minute of the most each push allows");
    let moved_bps = (rate - aapl_rate()) * 10_000 / aapl_rate();
    assert!(moved_bps <= MAX_MARK_STEP_BPS as u128 + 13, "about one step: {moved_bps}bps");

    // And not a unit further in the same second.
    push_mark(&mut ctx, rate + 1, NOW + M).unwrap();
    assert_held(&ctx, rate, NOW + M, "one unit more at the end of the minute");
}

#[test]
fn a_held_mark_cannot_be_walked_on_to_the_rate_that_tripped_it() {
    // Doubled a minute on, and held. Then, in one transaction at that same
    // time, fourteen pushes each one step from the last, towards the doubled
    // rate. The first is a minute after the held observation, so it may take
    // one step; every push after it is at the time it just set, and may take
    // none.
    let mut ctx = Ctx::new();
    ready(&mut ctx);
    let a = ctx.attestor.insecure_clone();
    ctx.warp(NOW + M);
    push_mark(&mut ctx, aapl_rate() * 2, NOW + M).unwrap();
    assert_held(&ctx, aapl_rate(), NOW, "doubled");

    let mut rate = aapl_rate();
    let mut ixs = Vec::new();
    for _ in 0..14 {
        rate = step(rate, MAX_MARK_STEP_BPS as i64);
        ixs.push(push_mark_ix(&ctx, sym(), rate, PX_NUM, MarkSource::Backpack, NOW + M));
    }
    let (r, logs) = ctx.send_logged(&ixs, &[&a]);
    r.unwrap();
    assert_held(&ctx, step(aapl_rate(), MAX_MARK_STEP_BPS as i64), NOW + M, "one step, then held");
    assert_eq!(trips(&logs).len(), 13, "every push after the first tripped");
}
