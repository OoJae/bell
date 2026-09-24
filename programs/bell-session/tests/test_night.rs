//! Night mode: an owner's opt-in to fills while the primary market is shut.
//!
//! The harness is copied from `test_queue.rs` and `test_sell.rs` rather than
//! shared with them, so each suite stays readable on its own and a change to
//! one cannot quietly change what another tests. As there, token accounts are
//! written directly in the fixed SPL layout, and the stock is the **real
//! mainnet AAPLx mint**, so the gate reads genuine issuer state.
//!
//! A night fill here means: the attestor says the session is shut, the owner
//! has opted in, and the checker agrees the market is closed with a reference
//! taken at the close. Every test below changes one of those facts, or one of
//! the gates that must still hold at night, and shows the fill refuse for that
//! reason and no other.

use {
    anchor_lang::{
        prelude::Pubkey,
        solana_program::{
            bpf_loader_upgradeable,
            instruction::{AccountMeta, Instruction},
            system_program,
        },
        AccountDeserialize, Discriminator, InstructionData, ToAccountMetas,
    },
    anchor_lang::solana_program::clock::Clock,
    bell_session::{
        constants::{
            AUTH_SEED, CHECK_SEED, MARK_SEED, MAX_MARK_AGE_SECONDS, MAX_NIGHT_GAP_BPS,
            MAX_NIGHT_REF_AGE_SECONDS, NIGHT_SEED, ORDER_SEED, RISK_SEED, SELL_SEED, SYMBOL_LEN,
            SYMBOL_SEED,
        },
        error::BellError,
        state::{BellOrder, HaltState, HoursMode, MarkSource, NightOptIn, RebaseKind, SellOrder, TokenRisk},
    },
    litesvm::LiteSVM,
    solana_account::Account,
    solana_keypair::Keypair,
    solana_message::{Message, VersionedMessage},
    solana_signer::Signer,
    solana_transaction::versioned::VersionedTransaction,
    spl_token_2022::{
        extension::{transfer_hook::TransferHook, AccountType, BaseStateWithExtensions, ExtensionType, StateWithExtensions},
        state::{Account as SplAccount, Mint as SplMint, PackedSizeOf},
    },
    std::{
        mem::{offset_of, size_of},
        ops::Range,
    },
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
    /// The program's upgrade authority, as `Ctx::at` records it.
    authority: Keypair,
    /// The second signer named by the symbol's check.
    checker: Keypair,
}

impl Ctx {
    fn new() -> Self {
        Self::at(NOW)
    }

    /// A fresh ledger with the clock at `now` and the real AAPLx mint installed.
    fn at(now: i64) -> Self {
        let program_id = bell_session::id();
        let mut svm = LiteSVM::new();
        svm.add_program(
            program_id,
            include_bytes!(concat!(env!("CARGO_TARGET_TMPDIR"), "/../deploy/bell_session.so")),
        )
        .unwrap();
        let mut clock: Clock = svm.get_sysvar();
        clock.unix_timestamp = now;
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

        let mut ctx = Self { svm, payer, program_id, quote_mint, stock_mint: AAPLX.parse().unwrap(), attestor, user, filler, authority, checker };
        ctx.install_mint(include_bytes!("fixtures/aaplx.bin"));
        ctx
    }

    /// Put AAPLx at its mainnet address, as the given bytes. A test that arms
    /// the hook replaces it with a copy that differs in that one field.
    fn install_mint(&mut self, data: &[u8]) {
        self.svm
            .set_account(self.stock_mint, Account { lamports: 1_000_000_000, data: data.to_vec(), owner: token_2022(), executable: false, rent_epoch: 0 })
            .unwrap();
    }

    fn send(&mut self, ixs: &[Instruction], signers: &[&Keypair]) -> Result<(), String> {
        // A refused fill retried after a state change is byte-identical, so a
        // fresh blockhash keeps the runtime from treating it as a replay.
        self.svm.expire_blockhash();
        let bh = self.svm.latest_blockhash();
        let msg = Message::new_with_blockhash(ixs, Some(&self.payer.pubkey()), &bh);
        let mut all: Vec<&Keypair> = vec![&self.payer];
        all.extend_from_slice(signers);
        let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), &all).unwrap();
        self.svm.send_transaction(tx).map(|_| ()).map_err(|failed| format!("{:?}", failed.err))
    }

    /// `send`, returning the compute units the transaction consumed.
    fn send_cu(&mut self, ixs: &[Instruction], signers: &[&Keypair]) -> Result<u64, String> {
        self.svm.expire_blockhash();
        let bh = self.svm.latest_blockhash();
        let msg = Message::new_with_blockhash(ixs, Some(&self.payer.pubkey()), &bh);
        let mut all: Vec<&Keypair> = vec![&self.payer];
        all.extend_from_slice(signers);
        let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), &all).unwrap();
        self.svm.send_transaction(tx).map(|m| m.compute_units_consumed).map_err(|failed| format!("{:?}", failed.err))
    }

    fn warp(&mut self, to: i64) {
        let mut c: Clock = self.svm.get_sysvar();
        c.unix_timestamp = to;
        self.svm.set_sysvar(&c);
    }

    fn now(&self) -> i64 {
        self.svm.get_sysvar::<Clock>().unix_timestamp
    }

    fn pda(&self, seeds: &[&[u8]]) -> Pubkey {
        Pubkey::find_program_address(seeds, &self.program_id).0
    }
    fn sym_pda(&self) -> Pubkey { self.pda(&[SYMBOL_SEED, &sym()]) }
    fn risk_pda(&self) -> Pubkey { self.pda(&[RISK_SEED, self.stock_mint.as_ref()]) }
    fn mark_pda(&self) -> Pubkey { self.pda(&[MARK_SEED, &sym()]) }
    fn check_pda(&self) -> Pubkey { self.pda(&[CHECK_SEED, &sym()]) }
    fn auth_pda(&self) -> Pubkey { self.pda(&[AUTH_SEED, self.user.pubkey().as_ref()]) }
    fn night_of(&self, owner: &Pubkey) -> Pubkey { self.pda(&[NIGHT_SEED, owner.as_ref()]) }
    fn night_pda(&self) -> Pubkey { self.night_of(&self.user.pubkey()) }
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

    fn lamports(&self, key: &Pubkey) -> u64 {
        self.svm.get_account(key).map(|a| a.lamports).unwrap_or(0)
    }

    /// The opt-in at `key`, or `None` once it has been closed.
    fn opt_in_at(&self, key: &Pubkey) -> Option<NightOptIn> {
        self.svm
            .get_account(key)
            .filter(|a| !a.data.is_empty())
            .map(|a| NightOptIn::try_deserialize(&mut &a.data[..]).unwrap())
    }

    fn order(&self, nonce: u64) -> Option<BellOrder> {
        self.svm
            .get_account(&self.order_pda(nonce))
            .filter(|a| !a.data.is_empty())
            .map(|a| BellOrder::try_deserialize(&mut &a.data[..]).unwrap())
    }

    fn sell_order(&self, nonce: u64) -> Option<SellOrder> {
        self.svm
            .get_account(&self.sell_pda(nonce))
            .filter(|a| !a.data.is_empty())
            .map(|a| SellOrder::try_deserialize(&mut &a.data[..]).unwrap())
    }

    fn risk(&self) -> TokenRisk {
        let a = self.svm.get_account(&self.risk_pda()).unwrap();
        TokenRisk::try_deserialize(&mut &a.data[..]).unwrap()
    }
}

fn sym() -> [u8; SYMBOL_LEN] {
    let mut o = [b' '; SYMBOL_LEN];
    o[..5].copy_from_slice(b"AAPLx");
    o
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

/// Registered, risk-read, marked, checked and attested open: the session
/// baseline every night test starts from.
fn ready(ctx: &mut Ctx) {
    let p = ctx.payer.pubkey();
    let a = ctx.attestor.pubkey();
    let (sp, rp, mp, cp, pd) = (ctx.sym_pda(), ctx.risk_pda(), ctx.mark_pda(), ctx.check_pda(), ctx.program_data());
    let (sm, qm) = (ctx.stock_mint, ctx.quote_mint);
    let auth = ctx.authority.insecure_clone();

    ctx.send(&[Instruction::new_with_bytes(
        ctx.program_id,
        &bell_session::instruction::RegisterSymbol { symbol: sym(), mint: sm, exchange_mic: *b"XNAS", hours_mode: HoursMode::TwentyFourFive, attestor: a }.data(),
        bell_session::accounts::RegisterSymbol { payer: p, symbol_state: sp, system_program: system_program::ID }.to_account_metas(None),
    )], &[]).unwrap();
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
    ctx.send(&[Instruction::new_with_bytes(
        ctx.program_id,
        &bell_session::instruction::OpenCheck { symbol: sym(), checker: ctx.checker.pubkey() }.data(),
        bell_session::accounts::OpenCheck { payer: p, authority: auth.pubkey(), program_data: pd, symbol_state: sp, check: cp, system_program: system_program::ID }.to_account_metas(None),
    )], &[&auth]).unwrap();

    let now = ctx.now();
    push_session(ctx, HaltState::None, true, now);
    push_mark(ctx, aapl_rate(), now);
    push_check(ctx, true, aapl_rate(), now, now);
}

/// The primary market shut, with the attestor and the checker agreeing about
/// it, and the checker's reference taken at the close an hour ago. The mark
/// and the reference are the same rate.
fn night(ctx: &mut Ctx) {
    let now = ctx.now();
    push_session(ctx, HaltState::None, false, now);
    push_mark(ctx, aapl_rate(), now);
    push_check(ctx, false, aapl_rate(), now - 3_600, now);
}

/// Still night, a minute on: the session, the checker's close and the mark,
/// now at `rate`, all observed a minute later. A mark may move a whole step
/// only once a minute has passed since the last one, so a test that places the
/// mark away from the reference moves the clock with it.
fn mark_a_minute_on(ctx: &mut Ctx, rate: u128) {
    let t = ctx.now() + MAX_MARK_AGE_SECONDS;
    ctx.warp(t);
    push_session(ctx, HaltState::None, false, t);
    push_check(ctx, false, aapl_rate(), t - 3_600, t);
    push_mark(ctx, rate, t);
}

fn push_session(ctx: &mut Ctx, halt: HaltState, open_now: bool, observed_at: i64) {
    let a = ctx.attestor.insecure_clone();
    let sp = ctx.sym_pda();
    ctx.send(&[Instruction::new_with_bytes(
        ctx.program_id,
        &bell_session::instruction::PushSession { symbol: sym(), halt, open_now, next_change_at: observed_at + 3600, observed_at }.data(),
        bell_session::accounts::PushSession { attestor: a.pubkey(), symbol_state: sp }.to_account_metas(None),
    )], &[&a]).unwrap();
}

fn push_mark(ctx: &mut Ctx, rate_q64: u128, observed_at: i64) {
    let a = ctx.attestor.insecure_clone();
    let (sp, mp) = (ctx.sym_pda(), ctx.mark_pda());
    ctx.send(&[Instruction::new_with_bytes(
        ctx.program_id,
        &bell_session::instruction::PushMark { symbol: sym(), rate_q64, px_num: 33_400_000, px_expo: -5, conf_bps: 10, source: MarkSource::Backpack, observed_at }.data(),
        bell_session::accounts::PushMark { attestor: a.pubkey(), symbol_state: sp, mark: mp }.to_account_metas(None),
    )], &[&a]).unwrap();
}

fn push_check(ctx: &mut Ctx, open_now: bool, ref_rate_q64: u128, ref_at: i64, observed_at: i64) {
    let c = ctx.checker.insecure_clone();
    let cp = ctx.check_pda();
    ctx.send(&[Instruction::new_with_bytes(
        ctx.program_id,
        &bell_session::instruction::PushCheck { symbol: sym(), open_now, ref_rate_q64, ref_px_num: 33_400_000, ref_px_expo: -5, ref_at, observed_at }.data(),
        bell_session::accounts::PushCheck { checker: c.pubkey(), check: cp }.to_account_metas(None),
    )], &[&c]).unwrap();
}

fn refresh(ctx: &mut Ctx) {
    let ix = Instruction::new_with_bytes(
        ctx.program_id,
        &bell_session::instruction::RefreshTokenRisk {}.data(),
        bell_session::accounts::RefreshTokenRisk { mint: ctx.stock_mint, risk: ctx.risk_pda() }.to_account_metas(None),
    );
    ctx.send(&[ix], &[]).unwrap();
}

fn opt_in(ctx: &mut Ctx, owner: &Keypair) -> Result<(), String> {
    let o = owner.insecure_clone();
    let night = ctx.night_of(&o.pubkey());
    ctx.send(&[Instruction::new_with_bytes(
        ctx.program_id,
        &bell_session::instruction::OptInNight {}.data(),
        bell_session::accounts::OptInNight { owner: o.pubkey(), night, system_program: system_program::ID }.to_account_metas(None),
    )], &[&o])
}

/// `opt_out_night` signed by `signer`, naming `night` as the opt-in to close.
fn opt_out(ctx: &mut Ctx, signer: &Keypair, night: Pubkey) -> Result<(), String> {
    let s = signer.insecure_clone();
    ctx.send(&[Instruction::new_with_bytes(
        ctx.program_id,
        &bell_session::instruction::OptOutNight {}.data(),
        bell_session::accounts::OptOutNight { owner: s.pubkey(), night }.to_account_metas(None),
    )], &[&s])
}

// ------------------------------------------------ the program's pricing, restated

/// Stock raw a buy of `leg` quote raw is worth at `rate`, rounded down.
fn buy_fair(leg: u64, rate: u128) -> u128 {
    (leg as u128 * rate) >> 64
}

/// The least stock a buy of `leg` may deliver: `bps` below fair, rounded down.
fn buy_min(leg: u64, rate: u128, bps: u16) -> u64 {
    (buy_fair(leg, rate) * (10_000 - bps as u128) / 10_000) as u64
}

/// Quote raw a sale of `leg` stock raw is worth at `rate`, rounded up.
fn sell_fair(leg: u64, rate: u128) -> u128 {
    let num = (leg as u128) << 64;
    num / rate + u128::from(num % rate != 0)
}

/// The least quote a sale of `leg` may be paid: `bps` below fair, rounded up.
fn sell_min(leg: u64, rate: u128, bps: u16) -> u64 {
    let t = sell_fair(leg, rate) * (10_000 - bps as u128);
    (t / 10_000 + u128::from(t % 10_000 != 0)) as u64
}

// ------------------------------------------------------------------- orders

struct Legs { payer_in: Pubkey, payee_out: Pubkey, filler_in: Pubkey, filler_out: Pubkey }

/// A buy's accounts: the user's quote account delegated for `delegated`.
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

/// A sell's accounts: the user's stock account delegated for `delegated`.
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

/// A buy with `not_before: 0`, as the web places one: due at once.
fn place_buy(ctx: &mut Ctx, nonce: u64, legs: &Legs, amount_in: u64, min_fill_in: u64, slip_bps: u16) {
    let u = ctx.user.insecure_clone();
    let (sp, rp, mp, op) = (ctx.sym_pda(), ctx.risk_pda(), ctx.mark_pda(), ctx.order_pda(nonce));
    let expires_at = ctx.now() + 86_400;
    ctx.send(&[Instruction::new_with_bytes(
        ctx.program_id,
        &bell_session::instruction::PlaceOrder { symbol: sym(), nonce, amount_in, min_fill_in, max_slip_bps: slip_bps, max_conf_bps: 50, floor_rate_q64: 0, not_before: 0, expires_at }.data(),
        bell_session::accounts::PlaceOrder { owner: u.pubkey(), symbol_state: sp, risk: rp, mark: mp, order: op, payer_in: legs.payer_in, payee_out: legs.payee_out, system_program: system_program::ID }.to_account_metas(None),
    )], &[&u]).unwrap();
}

fn place_sell(ctx: &mut Ctx, nonce: u64, legs: &Legs, amount_in: u64, slip_bps: u16) {
    let u = ctx.user.insecure_clone();
    let (sp, rp, mp, op) = (ctx.sym_pda(), ctx.risk_pda(), ctx.mark_pda(), ctx.sell_pda(nonce));
    let expires_at = ctx.now() + 86_400;
    ctx.send(&[Instruction::new_with_bytes(
        ctx.program_id,
        &bell_session::instruction::PlaceSellOrder { symbol: sym(), nonce, amount_in, min_fill_in: amount_in, max_slip_bps: slip_bps, max_conf_bps: 50, floor_rate_q64: 0, not_before: 0, expires_at }.data(),
        bell_session::accounts::PlaceSellOrder { owner: u.pubkey(), symbol_state: sp, risk: rp, mark: mp, order: op, payer_in: legs.payer_in, payee_out: legs.payee_out, system_program: system_program::ID }.to_account_metas(None),
    )], &[&u]).unwrap();
}

/// `fill_order`'s seventeen accounts, with `night` as the opt-in account the
/// filler names, so a test can name someone else's.
fn buy_metas(ctx: &Ctx, nonce: u64, legs: &Legs, night: Pubkey) -> Vec<AccountMeta> {
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
        quote_token_program: TOKEN,
        stock_token_program: token_2022(),
        check: ctx.check_pda(),
        night,
    }
    .to_account_metas(None)
}

fn sell_metas(ctx: &Ctx, nonce: u64, legs: &Legs) -> Vec<AccountMeta> {
    bell_session::accounts::FillSellOrder {
        filler: ctx.filler.pubkey(),
        order: ctx.sell_pda(nonce),
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
        quote_token_program: TOKEN,
        stock_token_program: token_2022(),
        check: ctx.check_pda(),
        night: ctx.night_pda(),
    }
    .to_account_metas(None)
}

fn fill_buy(ctx: &mut Ctx, nonce: u64, legs: &Legs, amount_in_leg: u64, amount_out: u64) -> Result<(), String> {
    let night = ctx.night_pda();
    fill_buy_naming(ctx, nonce, legs, amount_in_leg, amount_out, night)
}

/// A buy fill that names `night` as the owner's opt-in.
fn fill_buy_naming(ctx: &mut Ctx, nonce: u64, legs: &Legs, amount_in_leg: u64, amount_out: u64, night: Pubkey) -> Result<(), String> {
    let metas = buy_metas(ctx, nonce, legs, night);
    let f = ctx.filler.insecure_clone();
    ctx.send(&[Instruction::new_with_bytes(ctx.program_id, &bell_session::instruction::FillOrder { amount_in_leg, amount_out }.data(), metas)], &[&f])
}

fn fill_sell(ctx: &mut Ctx, nonce: u64, legs: &Legs, amount_in_leg: u64, amount_out: u64) -> Result<(), String> {
    let metas = sell_metas(ctx, nonce, legs);
    let f = ctx.filler.insecure_clone();
    ctx.send(&[Instruction::new_with_bytes(ctx.program_id, &bell_session::instruction::FillSellOrder { amount_in_leg, amount_out }.data(), metas)], &[&f])
}

// ---------------------------------------------------------------- issuer bytes

/// The byte range of one extension's value inside a Token-2022 mint, found by
/// walking the TLV entries the way Token-2022 does. Copied from `test_gates.rs`.
fn extension_value(data: &[u8], want: ExtensionType) -> Range<usize> {
    let base = <SplAccount as PackedSizeOf>::SIZE_OF;
    assert_eq!(data[base], AccountType::Mint as u8, "not a Token-2022 mint with extensions");
    let mut at = base + 1;
    while at + 4 <= data.len() {
        let ty = u16::from_le_bytes([data[at], data[at + 1]]);
        let len = u16::from_le_bytes([data[at + 2], data[at + 3]]) as usize;
        if ty == ExtensionType::Uninitialized as u16 {
            break;
        }
        let value = at + 4..at + 4 + len;
        assert!(value.end <= data.len(), "TLV entry {ty} runs past the end of the account");
        if ty == want as u16 {
            return value;
        }
        at = value.end;
    }
    panic!("{want:?} is not among this mint's extensions");
}

/// A copy of `fixture` whose transfer-hook slot names `program`, read back
/// through Token-2022's own parser so the change is where the program looks.
fn with_hook(fixture: &[u8], program: &Pubkey) -> Vec<u8> {
    let mut data = fixture.to_vec();
    let v = extension_value(&data, ExtensionType::TransferHook);
    assert_eq!(v.len(), size_of::<TransferHook>(), "TransferHook entry has an unexpected length");
    let key = program.to_bytes();
    let slot = v.start + offset_of!(TransferHook, program_id);
    assert_eq!(data[slot..slot + key.len()], [0u8; 32], "fixture's hook slot should ship empty");
    data[slot..slot + key.len()].copy_from_slice(&key);
    let mint = StateWithExtensions::<SplMint>::unpack(&data).unwrap();
    assert_eq!(mint.get_extension::<TransferHook>().unwrap().program_id.0.to_bytes(), key);
    data
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
const STATE_STALE: u32 = code(BellError::StateStale);
const REBASE_PENDING: u32 = code(BellError::RebasePending);
const HOOK_ARMED: u32 = code(BellError::HookArmed);
const PRICE_OUT_OF_BAND: u32 = code(BellError::PriceOutOfBand);
const CHECK_STALE: u32 = code(BellError::CheckStale);
const CHECKER_DISAGREES: u32 = code(BellError::CheckerDisagrees);
const MARK_OFF_REFERENCE: u32 = code(BellError::MarkOffReference);
/// Anchor's own code for an account at an address its seeds do not produce.
const CONSTRAINT_SEEDS: u32 = anchor_lang::error::ErrorCode::ConstraintSeeds as u32;

// --------------------------------------------------------------------- tests

#[test]
fn an_owner_can_opt_in_and_out_and_gets_the_rent_back() {
    let mut ctx = Ctx::new();
    ready(&mut ctx);
    let (u, night) = (ctx.user.pubkey(), ctx.night_pda());
    let before = ctx.lamports(&u);
    assert!(ctx.opt_in_at(&night).is_none(), "nobody is opted in by default");

    let usr = ctx.user.insecure_clone();
    opt_in(&mut ctx, &usr).unwrap();
    let o = ctx.opt_in_at(&night).expect("the opt-in exists");
    assert_eq!(o.owner, u);
    assert_eq!(o.created_at, NOW);
    // The owner paid the rent and nothing else: the fee is the payer's.
    let rent = ctx.lamports(&night);
    assert!(rent > 0);
    assert_eq!(ctx.lamports(&u), before - rent);

    // Opting in twice is refused by the system program: the account exists.
    assert!(opt_in(&mut ctx, &usr).is_err(), "an opt-in is created once");

    opt_out(&mut ctx, &usr, night).unwrap();
    assert!(ctx.opt_in_at(&night).is_none(), "the opt-in is closed");
    assert_eq!(ctx.lamports(&u), before, "every lamport of rent came back");
}

#[test]
fn a_stranger_cannot_close_an_opt_in() {
    // Closing needs the owner's signature, because the account's address is
    // derived from the signer's key: a stranger signing names their own
    // address, not the owner's, and the seeds refuse the substitution.
    let mut ctx = Ctx::new();
    ready(&mut ctx);
    let usr = ctx.user.insecure_clone();
    opt_in(&mut ctx, &usr).unwrap();

    let stranger = ctx.filler.insecure_clone();
    let night = ctx.night_pda();
    assert_code(opt_out(&mut ctx, &stranger, night), CONSTRAINT_SEEDS, "a stranger naming the owner's opt-in");
    assert!(ctx.opt_in_at(&night).is_some(), "the opt-in survives");
}

#[test]
fn a_night_fill_without_opt_in_refuses_as_market_closed() {
    // Night mode is opt-in per owner. Without it, a shut market is exactly
    // what it was before night mode existed: gate 7, MarketClosed.
    let mut ctx = Ctx::new();
    ready(&mut ctx);
    let buy = fund_buy(&mut ctx, DOLLAR);
    place_buy(&mut ctx, 1, &buy, DOLLAR, DOLLAR, 30);
    let sell = fund_sell(&mut ctx, SHARE);
    place_sell(&mut ctx, 2, &sell, SHARE, 30);
    night(&mut ctx);

    assert_code(fill_buy(&mut ctx, 1, &buy, DOLLAR, buy_min(DOLLAR, aapl_rate(), 30)), MARKET_CLOSED, "buy at night, not opted in");
    assert_code(fill_sell(&mut ctx, 2, &sell, SHARE, sell_min(SHARE, aapl_rate(), 30)), MARKET_CLOSED, "sell at night, not opted in");
    assert_eq!(ctx.balance(&buy.payer_in), USER_QUOTE);
    assert_eq!(ctx.balance(&sell.payer_in), USER_STOCK);
}

#[test]
fn an_opted_in_buy_fills_at_night_inside_the_band() {
    let mut ctx = Ctx::new();
    ready(&mut ctx);
    let legs = fund_buy(&mut ctx, DOLLAR);
    place_buy(&mut ctx, 1, &legs, DOLLAR, DOLLAR, 30);
    let usr = ctx.user.insecure_clone();
    opt_in(&mut ctx, &usr).unwrap();
    night(&mut ctx);

    // The mark a full percent above the reference: inside the night gap.
    let mark = step(aapl_rate(), 100);
    mark_a_minute_on(&mut ctx, mark);
    // The order's own band at the mark is the higher minimum here.
    let min = buy_min(DOLLAR, mark, 30);
    assert!(min > buy_min(DOLLAR, aapl_rate(), MAX_NIGHT_GAP_BPS));

    assert_code(fill_buy(&mut ctx, 1, &legs, DOLLAR, min - 1), PRICE_OUT_OF_BAND, "one unit under the band");
    fill_buy(&mut ctx, 1, &legs, DOLLAR, min).unwrap();
    assert_eq!(ctx.balance(&legs.payee_out), min, "the user received the stock");
    assert_eq!(ctx.balance(&legs.payer_in), USER_QUOTE - DOLLAR);
    assert!(ctx.order(1).is_none(), "filled and closed");
}

#[test]
fn an_opted_in_sell_fills_at_night_inside_the_band() {
    let mut ctx = Ctx::new();
    ready(&mut ctx);
    let legs = fund_sell(&mut ctx, SHARE);
    place_sell(&mut ctx, 1, &legs, SHARE, 30);
    let usr = ctx.user.insecure_clone();
    opt_in(&mut ctx, &usr).unwrap();
    night(&mut ctx);

    // The mark a full percent below the reference: the stock a little dearer
    // than the close, still inside the night gap.
    let mark = step(aapl_rate(), -100);
    mark_a_minute_on(&mut ctx, mark);
    let min = sell_min(SHARE, mark, 30);
    assert!(min > sell_min(SHARE, aapl_rate(), MAX_NIGHT_GAP_BPS));

    assert_code(fill_sell(&mut ctx, 1, &legs, SHARE, min - 1), PRICE_OUT_OF_BAND, "one unit under the band");
    fill_sell(&mut ctx, 1, &legs, SHARE, min).unwrap();
    assert_eq!(ctx.balance(&legs.payee_out), min, "the user was paid");
    assert_eq!(ctx.balance(&legs.payer_in), USER_STOCK - SHARE);
    assert!(ctx.sell_order(1).is_none(), "filled and closed");
}

#[test]
fn a_night_fill_outside_the_band_is_refused() {
    // The night gap is half the session's: a mark 151 steps off the reference
    // would fill in session and does not at night.
    let mut ctx = Ctx::new();
    ready(&mut ctx);
    let legs = fund_buy(&mut ctx, DOLLAR);
    place_buy(&mut ctx, 1, &legs, DOLLAR, DOLLAR, 30);
    let usr = ctx.user.insecure_clone();
    opt_in(&mut ctx, &usr).unwrap();
    night(&mut ctx);

    for (bps, why) in [(151, "above the reference"), (-151, "below the reference")] {
        let mark = step(aapl_rate(), bps);
        mark_a_minute_on(&mut ctx, mark);
        assert_code(fill_buy(&mut ctx, 1, &legs, DOLLAR, buy_min(DOLLAR, mark, 30)), MARK_OFF_REFERENCE, why);
    }
    assert_eq!(ctx.balance(&legs.payer_in), USER_QUOTE, "nothing moved");
    assert_eq!(ctx.balance(&legs.payee_out), 0);

    // At the gap exactly, the same order fills.
    let mark = step(aapl_rate(), 150);
    mark_a_minute_on(&mut ctx, mark);
    fill_buy(&mut ctx, 1, &legs, DOLLAR, buy_min(DOLLAR, mark, 30)).unwrap();
}

#[test]
fn a_halt_still_refuses_a_night_fill() {
    // Guarded lifts gate 7 alone. A halt is gate 2 and binds every mode.
    let mut ctx = Ctx::new();
    ready(&mut ctx);
    let legs = fund_buy(&mut ctx, DOLLAR);
    place_buy(&mut ctx, 1, &legs, DOLLAR, DOLLAR, 30);
    let usr = ctx.user.insecure_clone();
    opt_in(&mut ctx, &usr).unwrap();
    night(&mut ctx);
    let min = buy_min(DOLLAR, aapl_rate(), 30);

    push_session(&mut ctx, HaltState::Luld, false, NOW);
    assert_code(fill_buy(&mut ctx, 1, &legs, DOLLAR, min), MARKET_CLOSED, "halted at night, opted in");
    assert_eq!(ctx.balance(&legs.payer_in), USER_QUOTE);

    // The halt lifted and nothing else changed, the same fill goes through:
    // the halt, not the hour, was the reason.
    push_session(&mut ctx, HaltState::None, false, NOW);
    fill_buy(&mut ctx, 1, &legs, DOLLAR, min).unwrap();
}

#[test]
fn a_rebase_window_still_refuses_a_night_fill() {
    // The real AAPLx mint carries a scheduled multiplier step. Find it on the
    // mint, then start a fresh ledger half an hour before it.
    let t = {
        let mut probe = Ctx::new();
        ready(&mut probe);
        probe.risk().activates_at
    };
    assert_ne!(t, 0, "the fixture should carry a multiplier activation");

    let mut ctx = Ctx::at(t - 1_800);
    ready(&mut ctx);
    assert_ne!(ctx.risk().pending_multiplier_bits, 0, "the step is pending half an hour out");
    // Classified, so gate 4b is not the reason for anything below.
    let p = ctx.payer.pubkey();
    let rp = ctx.risk_pda();
    ctx.send(&[Instruction::new_with_bytes(
        ctx.program_id,
        &bell_session::instruction::ClassifyRebase { kind: RebaseKind::Dividend }.data(),
        bell_session::accounts::ClassifyRebase { attestor: p, risk: rp }.to_account_metas(None),
    )], &[]).unwrap();

    let legs = fund_buy(&mut ctx, DOLLAR);
    place_buy(&mut ctx, 1, &legs, DOLLAR, DOLLAR / 4, 30);
    let usr = ctx.user.insecure_clone();
    opt_in(&mut ctx, &usr).unwrap();

    // Outside the window, a night fill goes through.
    night(&mut ctx);
    let min = buy_min(DOLLAR / 4, aapl_rate(), 30);
    fill_buy(&mut ctx, 1, &legs, DOLLAR / 4, min).unwrap();

    // Ten minutes before the step, inside the window: refused, at night as
    // in session.
    ctx.warp(t - 600);
    night(&mut ctx);
    refresh(&mut ctx);
    assert_code(fill_buy(&mut ctx, 1, &legs, DOLLAR / 4, min), REBASE_PENDING, "T-600 at night, opted in");
    assert_eq!(ctx.order(1).unwrap().filled_in, DOLLAR / 4, "only the first fill happened");
}

#[test]
fn an_armed_hook_still_refuses_a_night_fill() {
    let mut ctx = Ctx::new();
    ready(&mut ctx);
    let legs = fund_buy(&mut ctx, DOLLAR);
    place_buy(&mut ctx, 1, &legs, DOLLAR, DOLLAR, 30);
    let usr = ctx.user.insecure_clone();
    opt_in(&mut ctx, &usr).unwrap();
    night(&mut ctx);
    let min = buy_min(DOLLAR, aapl_rate(), 30);

    let real = include_bytes!("fixtures/aaplx.bin");
    ctx.install_mint(&with_hook(real, &Pubkey::new_unique()));
    refresh(&mut ctx);
    assert_code(fill_buy(&mut ctx, 1, &legs, DOLLAR, min), HOOK_ARMED, "hook armed, at night, opted in");
    assert_eq!(ctx.balance(&legs.payer_in), USER_QUOTE);

    // Disarmed and re-read, it fills.
    ctx.install_mint(real);
    refresh(&mut ctx);
    fill_buy(&mut ctx, 1, &legs, DOLLAR, min).unwrap();
}

#[test]
fn a_stale_session_still_refuses_a_night_fill() {
    // A shut market that nobody has attested lately is not evidence of
    // anything. Gate 1 refuses before the hour is even considered.
    let mut ctx = Ctx::new();
    ready(&mut ctx);
    let legs = fund_buy(&mut ctx, DOLLAR);
    place_buy(&mut ctx, 1, &legs, DOLLAR, DOLLAR, 30);
    let usr = ctx.user.insecure_clone();
    opt_in(&mut ctx, &usr).unwrap();
    night(&mut ctx);
    let min = buy_min(DOLLAR, aapl_rate(), 30);

    // The mark and the check stay fresh; only the session is 121s old.
    ctx.warp(NOW + 121);
    push_mark(&mut ctx, aapl_rate(), NOW + 121);
    push_check(&mut ctx, false, aapl_rate(), NOW - 3_600, NOW + 121);
    assert_code(fill_buy(&mut ctx, 1, &legs, DOLLAR, min), STATE_STALE, "session attested 121s ago");

    push_session(&mut ctx, HaltState::None, false, NOW + 121);
    fill_buy(&mut ctx, 1, &legs, DOLLAR, min).unwrap();
}

#[test]
fn a_night_fill_needs_the_checker_to_agree_the_market_is_closed() {
    // The attestor's "not open" also covers "no opinion" and "sources
    // conflict". Only the checker saying closed turns it into a night.
    let mut ctx = Ctx::new();
    ready(&mut ctx);
    let legs = fund_buy(&mut ctx, DOLLAR);
    place_buy(&mut ctx, 1, &legs, DOLLAR, DOLLAR, 30);
    let usr = ctx.user.insecure_clone();
    opt_in(&mut ctx, &usr).unwrap();
    night(&mut ctx);
    let min = buy_min(DOLLAR, aapl_rate(), 30);

    push_check(&mut ctx, true, aapl_rate(), NOW - 3_600, NOW);
    assert_code(fill_buy(&mut ctx, 1, &legs, DOLLAR, min), CHECKER_DISAGREES, "the checker says the market is open");
    assert_eq!(ctx.balance(&legs.payer_in), USER_QUOTE);

    push_check(&mut ctx, false, aapl_rate(), NOW - 3_600, NOW);
    fill_buy(&mut ctx, 1, &legs, DOLLAR, min).unwrap();
}

#[test]
fn a_night_fill_against_a_weekend_old_reference_is_refused() {
    // Friday's close is about sixty hours old by Monday morning. The check
    // itself is fresh; the price it carries is not.
    let mut ctx = Ctx::new();
    ready(&mut ctx);
    let legs = fund_buy(&mut ctx, DOLLAR);
    place_buy(&mut ctx, 1, &legs, DOLLAR, DOLLAR / 4, 30);
    let usr = ctx.user.insecure_clone();
    opt_in(&mut ctx, &usr).unwrap();
    night(&mut ctx);
    let min = buy_min(DOLLAR / 4, aapl_rate(), 30);

    push_check(&mut ctx, false, aapl_rate(), NOW - 60 * 3_600, NOW);
    assert_code(fill_buy(&mut ctx, 1, &legs, DOLLAR / 4, min), CHECK_STALE, "a reference sixty hours old");
    push_check(&mut ctx, false, aapl_rate(), NOW - MAX_NIGHT_REF_AGE_SECONDS - 1, NOW);
    assert_code(fill_buy(&mut ctx, 1, &legs, DOLLAR / 4, min), CHECK_STALE, "one second past twelve hours");
    assert_eq!(ctx.balance(&legs.payer_in), USER_QUOTE);

    // Twelve hours exactly is still tonight's close.
    push_check(&mut ctx, false, aapl_rate(), NOW - MAX_NIGHT_REF_AGE_SECONDS, NOW);
    fill_buy(&mut ctx, 1, &legs, DOLLAR / 4, min).unwrap();
}

#[test]
fn a_filler_cannot_pass_another_owners_opt_in() {
    // The opt-in records its owner, and a fill reads that owner, so a filler
    // cannot borrow a consenting stranger's: it reads as no consent at all.
    let mut ctx = Ctx::new();
    ready(&mut ctx);
    let legs = fund_buy(&mut ctx, DOLLAR);
    place_buy(&mut ctx, 1, &legs, DOLLAR, DOLLAR, 30);
    let stranger = Keypair::new();
    ctx.svm.airdrop(&stranger.pubkey(), 1_000_000_000).unwrap();
    opt_in(&mut ctx, &stranger).unwrap();
    night(&mut ctx);
    let min = buy_min(DOLLAR, aapl_rate(), 30);

    let theirs = ctx.night_of(&stranger.pubkey());
    assert!(ctx.opt_in_at(&theirs).is_some());
    assert_code(fill_buy_naming(&mut ctx, 1, &legs, DOLLAR, min, theirs), MARKET_CLOSED, "the stranger's opt-in");
    // Named correctly, the owner's own address holds nothing: closed market.
    assert_code(fill_buy(&mut ctx, 1, &legs, DOLLAR, min), MARKET_CLOSED, "the owner never opted in");
    assert_eq!(ctx.balance(&legs.payer_in), USER_QUOTE);

    // Once the owner consents, it is their own opt-in that fills, and the
    // stranger's still reads as nothing.
    let usr = ctx.user.insecure_clone();
    opt_in(&mut ctx, &usr).unwrap();
    assert_code(fill_buy_naming(&mut ctx, 1, &legs, DOLLAR, min, theirs), MARKET_CLOSED, "the stranger's opt-in, the owner opted in");
    fill_buy(&mut ctx, 1, &legs, DOLLAR, min).unwrap();
    assert_eq!(ctx.balance(&legs.payee_out), min);
}

#[test]
fn a_forged_opt_in_is_not_consent() {
    // A fill does not check the opt-in's address, so a filler may name any
    // account. Bytes that look like the owner's opt-in count only on an
    // account this program owns, and only `opt_in_night` can make one.
    let mut ctx = Ctx::new();
    ready(&mut ctx);
    let legs = fund_buy(&mut ctx, DOLLAR);
    place_buy(&mut ctx, 1, &legs, DOLLAR, DOLLAR, 30);
    night(&mut ctx);
    let min = buy_min(DOLLAR, aapl_rate(), 30);

    let mut data = vec![0u8; 8 + 57];
    data[..8].copy_from_slice(NightOptIn::DISCRIMINATOR);
    data[8..40].copy_from_slice(ctx.user.pubkey().as_ref());
    let forged = Pubkey::new_unique();
    for (holder, why) in [
        (system_program::ID, "held by the system program"),
        (TOKEN, "held by the token program"),
        (ctx.filler.pubkey(), "held by the filler's key"),
    ] {
        ctx.svm
            .set_account(forged, Account { lamports: 1_000_000_000, data: data.clone(), owner: holder, executable: false, rent_epoch: 0 })
            .unwrap();
        assert_code(fill_buy_naming(&mut ctx, 1, &legs, DOLLAR, min, forged), MARKET_CLOSED, why);
    }
    // And at the owner's own address, the same bytes under another program
    // are no more consent than they were anywhere else.
    let own = ctx.night_pda();
    ctx.svm
        .set_account(own, Account { lamports: 1_000_000_000, data, owner: system_program::ID, executable: false, rent_epoch: 0 })
        .unwrap();
    assert_code(fill_buy(&mut ctx, 1, &legs, DOLLAR, min), MARKET_CLOSED, "the owner's address, held by the system program");
    assert_eq!(ctx.balance(&legs.payer_in), USER_QUOTE);
}

#[test]
fn a_fill_costs_the_same_whoever_the_owner_is() {
    // The opt-in is read by what it records, not found by its address, so no
    // fill pays for a bump search whose length depends on the owner's key.
    // Two owners, one whose opt-in address has the first bump and one whose
    // has a late one, fill the same order at the same compute.
    let cost = |late: bool| -> u64 {
        let mut ctx = Ctx::new();
        let owner = loop {
            let k = Keypair::new();
            let bump = Pubkey::find_program_address(&[NIGHT_SEED, k.pubkey().as_ref()], &ctx.program_id).1;
            if (late && bump <= 250) || (!late && bump == 255) {
                break k;
            }
        };
        ctx.svm.airdrop(&owner.pubkey(), 10_000_000_000).unwrap();
        ctx.user = owner;
        ready(&mut ctx);
        let legs = fund_buy(&mut ctx, DOLLAR);
        place_buy(&mut ctx, 1, &legs, DOLLAR, DOLLAR, 30);
        let metas = buy_metas(&ctx, 1, &legs, ctx.night_pda());
        let min = buy_min(DOLLAR, aapl_rate(), 30);
        let f = ctx.filler.insecure_clone();
        let ix = Instruction::new_with_bytes(ctx.program_id, &bell_session::instruction::FillOrder { amount_in_leg: DOLLAR, amount_out: min }.data(), metas);
        ctx.send_cu(&[ix], &[&f]).unwrap()
    };
    assert_eq!(cost(false), cost(true), "a bump of 255 and one of 250 or less");
}

#[test]
fn opting_out_stops_night_fills_for_orders_already_placed() {
    // Consent is read at every fill, not copied onto the order, so it covers
    // orders placed before it was given and stops covering them the moment it
    // is withdrawn.
    let mut ctx = Ctx::new();
    ready(&mut ctx);
    let legs = fund_buy(&mut ctx, DOLLAR);
    place_buy(&mut ctx, 1, &legs, DOLLAR, DOLLAR / 4, 30);
    let usr = ctx.user.insecure_clone();

    night(&mut ctx);
    let leg = DOLLAR * 2 / 5;
    let min = buy_min(leg, aapl_rate(), 30);
    opt_in(&mut ctx, &usr).unwrap();
    fill_buy(&mut ctx, 1, &legs, leg, min).unwrap();
    assert_eq!(ctx.order(1).unwrap().filled_in, leg, "the order placed before the opt-in filled at night");

    let night = ctx.night_pda();
    opt_out(&mut ctx, &usr, night).unwrap();
    assert_code(fill_buy(&mut ctx, 1, &legs, leg, min), MARKET_CLOSED, "opted out, same order, same night");
    assert_eq!(ctx.order(1).unwrap().filled_in, leg);
    assert_eq!(ctx.balance(&legs.payer_in), USER_QUOTE - leg);
}

#[test]
fn the_night_reference_floor_binds_over_a_generous_band() {
    // An order may allow its filler 500bps. At night that allowance is capped
    // by the checker's reference: no fill below the reference less the night
    // gap, whatever the order's own band would accept.
    let mut ctx = Ctx::new();
    ready(&mut ctx);
    let buy = fund_buy(&mut ctx, DOLLAR);
    place_buy(&mut ctx, 1, &buy, DOLLAR, DOLLAR, 500);
    let sell = fund_sell(&mut ctx, SHARE);
    place_sell(&mut ctx, 2, &sell, SHARE, 500);
    let usr = ctx.user.insecure_clone();
    opt_in(&mut ctx, &usr).unwrap();
    night(&mut ctx);
    let r = aapl_rate();

    // Buy: stock rounded down, as the band is.
    let (by_band, by_ref) = (buy_min(DOLLAR, r, 500), buy_min(DOLLAR, r, MAX_NIGHT_GAP_BPS));
    assert_eq!((by_band, by_ref), (284_430, 294_909), "299,400 less 5%, and less 1.5%");
    assert_code(fill_buy(&mut ctx, 1, &buy, DOLLAR, by_band), PRICE_OUT_OF_BAND, "the band allows it, the reference does not");
    assert_code(fill_buy(&mut ctx, 1, &buy, DOLLAR, by_ref - 1), PRICE_OUT_OF_BAND, "one unit under the reference floor");
    fill_buy(&mut ctx, 1, &buy, DOLLAR, by_ref).unwrap();
    assert_eq!(ctx.balance(&buy.payee_out), by_ref);

    // Sell: quote rounded up, the ceiling form.
    let (by_band, by_ref) = (sell_min(SHARE, r, 500), sell_min(SHARE, r, MAX_NIGHT_GAP_BPS));
    assert_eq!((by_band, by_ref), (317_300_210, 328_990_218), "334,000,221 less 5%, and less 1.5%, rounded up");
    assert_code(fill_sell(&mut ctx, 2, &sell, SHARE, by_band), PRICE_OUT_OF_BAND, "the band allows it, the reference does not");
    assert_code(fill_sell(&mut ctx, 2, &sell, SHARE, by_ref - 1), PRICE_OUT_OF_BAND, "one unit under the reference floor");
    fill_sell(&mut ctx, 2, &sell, SHARE, by_ref).unwrap();
    assert_eq!(ctx.balance(&sell.payee_out), by_ref);
}
