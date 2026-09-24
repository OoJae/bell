//! The opening cross: a due buy settled against a due sell, at the mark, with
//! no filler between them.
//!
//! The harness is copied from the other suites rather than shared with them,
//! so each stays readable on its own and a change to one cannot quietly change
//! what another tests. As there, token accounts are written directly in the
//! fixed SPL layout, and the stock is the **real mainnet AAPLx mint** (or
//! Backpack's PFE, for the six-decimal case), so the gate reads genuine
//! issuer state. Unlike them, there are two owners: a buyer, whose quote
//! account is delegated to their authority, and a seller, whose stock account
//! is delegated to theirs. The cranker is a third key that owns nothing the
//! cross touches.
//!
//! Every expected amount comes from `cross_amounts`, which restates the
//! program's quote-leads rounding in plain Rust, and several are also pinned
//! to numbers worked out by hand, so the restatement and the program cannot
//! drift together unnoticed.

use {
    anchor_lang::{
        prelude::Pubkey,
        solana_program::{
            bpf_loader_upgradeable,
            instruction::{AccountMeta, Instruction},
            system_program,
        },
        AccountDeserialize, AccountSerialize, AnchorDeserialize, Discriminator, InstructionData,
        ToAccountMetas,
    },
    anchor_lang::solana_program::clock::Clock,
    bell_session::{
        constants::{
            AUTH_SEED, CHECK_SEED, MARK_SEED, MAX_MARK_AGE_SECONDS, NIGHT_SEED, ORDER_SEED,
            RISK_SEED, SELL_SEED, SYMBOL_LEN, SYMBOL_SEED,
        },
        error::BellError,
        state::{
            BellOrder, HaltState, HoursMode, MarkSource, OrderFilled, OrdersCrossed, SellOrder,
            SellOrderFilled, TokenRisk,
        },
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
/// One dollar of the six-decimal quote, in raw units.
const DOLLAR: u64 = 1_000_000;
/// What a buyer's quote account holds before any cross takes from it: $1,000.
const BUYER_QUOTE: u64 = 1_000_000_000;
/// What a seller's stock account holds before any cross takes from it.
const SELLER_STOCK: u64 = 1_000_000_000;

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

fn ticker(t: &str) -> [u8; SYMBOL_LEN] {
    let mut o = [b' '; SYMBOL_LEN];
    o[..t.len()].copy_from_slice(t.as_bytes());
    o
}

struct Ctx {
    svm: LiteSVM,
    payer: Keypair,
    program_id: Pubkey,
    quote_mint: Pubkey,
    stock_mint: Pubkey,
    /// The ticker this context registers its stock under.
    sym: [u8; SYMBOL_LEN],
    attestor: Keypair,
    buyer: Keypair,
    seller: Keypair,
    /// Signs every cross. Owns nothing the cross moves.
    cranker: Keypair,
    /// The program's upgrade authority, as `Ctx::with_stock` records it.
    authority: Keypair,
    /// The second signer named by the symbol's check.
    checker: Keypair,
}

impl Ctx {
    /// The Apple xStock, eight decimals, at `NOW`.
    fn new() -> Self {
        Self::at(NOW)
    }

    fn at(now: i64) -> Self {
        Self::with_stock(now, AAPLX, include_bytes!("fixtures/aaplx.bin"), "AAPLx")
    }

    /// A fresh ledger with the clock at `now` and a real Token-2022 stock mint
    /// installed at its mainnet address.
    fn with_stock(now: i64, address: &str, fixture: &[u8], ticker_str: &str) -> Self {
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
        let buyer = Keypair::new();
        let seller = Keypair::new();
        let cranker = Keypair::new();
        let authority = Keypair::new();
        let checker = Keypair::new();
        for k in [&payer, &attestor, &buyer, &seller, &cranker, &authority, &checker] {
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

        let mut ctx = Self {
            svm,
            payer,
            program_id,
            quote_mint,
            stock_mint: address.parse().unwrap(),
            sym: ticker(ticker_str),
            attestor,
            buyer,
            seller,
            cranker,
            authority,
            checker,
        };
        ctx.install_mint(address, fixture);
        ctx
    }

    fn install_mint(&mut self, address: &str, fixture: &[u8]) -> Pubkey {
        let mint: Pubkey = address.parse().unwrap();
        self.svm
            .set_account(mint, Account { lamports: 1_000_000_000, data: fixture.to_vec(), owner: token_2022(), executable: false, rent_epoch: 0 })
            .unwrap();
        mint
    }

    fn send(&mut self, ixs: &[Instruction], signers: &[&Keypair]) -> Result<(), String> {
        self.send_logged(ixs, signers).0
    }

    /// `send`, keeping the program logs, which record every program invoked —
    /// including inside a transaction that was then rolled back.
    fn send_logged(&mut self, ixs: &[Instruction], signers: &[&Keypair]) -> (Result<(), String>, Vec<String>) {
        // A refused cross retried after a state change is byte-identical, so a
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

    fn now(&self) -> i64 {
        self.svm.get_sysvar::<Clock>().unix_timestamp
    }

    fn pda(&self, seeds: &[&[u8]]) -> Pubkey {
        Pubkey::find_program_address(seeds, &self.program_id).0
    }
    fn sym_pda_of(&self, sym: &[u8; SYMBOL_LEN]) -> Pubkey { self.pda(&[SYMBOL_SEED, sym]) }
    fn mark_pda_of(&self, sym: &[u8; SYMBOL_LEN]) -> Pubkey { self.pda(&[MARK_SEED, sym]) }
    fn risk_pda_of(&self, mint: &Pubkey) -> Pubkey { self.pda(&[RISK_SEED, mint.as_ref()]) }
    fn sym_pda(&self) -> Pubkey { self.sym_pda_of(&self.sym) }
    fn risk_pda(&self) -> Pubkey { self.risk_pda_of(&self.stock_mint) }
    fn mark_pda(&self) -> Pubkey { self.mark_pda_of(&self.sym) }
    fn check_pda(&self) -> Pubkey { self.pda(&[CHECK_SEED, &self.sym]) }
    fn auth_of(&self, owner: &Pubkey) -> Pubkey { self.pda(&[AUTH_SEED, owner.as_ref()]) }
    fn night_of(&self, owner: &Pubkey) -> Pubkey { self.pda(&[NIGHT_SEED, owner.as_ref()]) }
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

    /// What the delegate may still move out of a token account.
    fn delegated(&self, key: &Pubkey) -> u64 {
        let a = self.svm.get_account(key).unwrap();
        u64::from_le_bytes(a.data[121..129].try_into().unwrap())
    }

    fn lamports(&self, key: &Pubkey) -> u64 {
        self.svm.get_account(key).map(|a| a.lamports).unwrap_or(0)
    }

    /// The buy order, or `None` once it has been closed.
    fn buy_order(&self, side: &Side) -> Option<BellOrder> {
        self.svm
            .get_account(&side.order)
            .filter(|a| !a.data.is_empty())
            .map(|a| BellOrder::try_deserialize(&mut &a.data[..]).unwrap())
    }

    /// The sell order, or `None` once it has been closed.
    fn sell_order(&self, side: &Side) -> Option<SellOrder> {
        self.svm
            .get_account(&side.order)
            .filter(|a| !a.data.is_empty())
            .map(|a| SellOrder::try_deserialize(&mut &a.data[..]).unwrap())
    }

    fn risk(&self) -> TokenRisk {
        let a = self.svm.get_account(&self.risk_pda()).unwrap();
        TokenRisk::try_deserialize(&mut &a.data[..]).unwrap()
    }
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

/// Register `sym` for `mint`, with this context's attestor.
fn register(ctx: &mut Ctx, sym: [u8; SYMBOL_LEN], mint: Pubkey) {
    let (p, a, sp) = (ctx.payer.pubkey(), ctx.attestor.pubkey(), ctx.sym_pda_of(&sym));
    ctx.send(&[Instruction::new_with_bytes(
        ctx.program_id,
        &bell_session::instruction::RegisterSymbol { symbol: sym, mint, exchange_mic: *b"XNAS", hours_mode: HoursMode::TwentyFourFive, attestor: a }.data(),
        bell_session::accounts::RegisterSymbol { payer: p, symbol_state: sp, system_program: system_program::ID }.to_account_metas(None),
    )], &[]).unwrap();
}

fn init_risk(ctx: &mut Ctx, mint: Pubkey) {
    let (p, rp) = (ctx.payer.pubkey(), ctx.risk_pda_of(&mint));
    ctx.send(&[Instruction::new_with_bytes(
        ctx.program_id,
        &bell_session::instruction::InitTokenRisk { attestor: p }.data(),
        bell_session::accounts::InitTokenRisk { payer: p, mint, risk: rp, system_program: system_program::ID }.to_account_metas(None),
    )], &[]).unwrap();
}

fn open_mark(ctx: &mut Ctx, sym: [u8; SYMBOL_LEN]) {
    let (p, sp, mp, qm) = (ctx.payer.pubkey(), ctx.sym_pda_of(&sym), ctx.mark_pda_of(&sym), ctx.quote_mint);
    ctx.send(&[Instruction::new_with_bytes(
        ctx.program_id,
        &bell_session::instruction::OpenMark { symbol: sym, quote_mint: qm }.data(),
        bell_session::accounts::OpenMark { payer: p, symbol_state: sp, mark: mp, system_program: system_program::ID }.to_account_metas(None),
    )], &[]).unwrap();
}

/// Registered, risk-read, marked at `rate`, checked in agreement, and attested
/// open: the session baseline every test starts from.
fn ready_at(ctx: &mut Ctx, rate: u128) {
    let (sym, sm) = (ctx.sym, ctx.stock_mint);
    register(ctx, sym, sm);
    init_risk(ctx, sm);
    open_mark(ctx, sym);
    let (p, sp, cp, pd) = (ctx.payer.pubkey(), ctx.sym_pda(), ctx.check_pda(), ctx.program_data());
    let auth = ctx.authority.insecure_clone();
    ctx.send(&[Instruction::new_with_bytes(
        ctx.program_id,
        &bell_session::instruction::OpenCheck { symbol: sym, checker: ctx.checker.pubkey() }.data(),
        bell_session::accounts::OpenCheck { payer: p, authority: auth.pubkey(), program_data: pd, symbol_state: sp, check: cp, system_program: system_program::ID }.to_account_metas(None),
    )], &[&auth]).unwrap();

    let now = ctx.now();
    push_session(ctx, HaltState::None, true, now);
    push_mark(ctx, rate, now);
}

fn ready(ctx: &mut Ctx) {
    ready_at(ctx, aapl_rate());
}

fn push_session(ctx: &mut Ctx, halt: HaltState, open_now: bool, observed_at: i64) {
    let a = ctx.attestor.insecure_clone();
    let (sp, sym) = (ctx.sym_pda(), ctx.sym);
    ctx.send(&[Instruction::new_with_bytes(
        ctx.program_id,
        &bell_session::instruction::PushSession { symbol: sym, halt, open_now, next_change_at: observed_at + 3600, observed_at }.data(),
        bell_session::accounts::PushSession { attestor: a.pubkey(), symbol_state: sp }.to_account_metas(None),
    )], &[&a]).unwrap();
}

/// The attestor's mark alone, on `sym`.
fn push_mark_on(ctx: &mut Ctx, sym: [u8; SYMBOL_LEN], rate_q64: u128, observed_at: i64) {
    let a = ctx.attestor.insecure_clone();
    let (sp, mp) = (ctx.sym_pda_of(&sym), ctx.mark_pda_of(&sym));
    ctx.send(&[Instruction::new_with_bytes(
        ctx.program_id,
        &bell_session::instruction::PushMark { symbol: sym, rate_q64, px_num: 33_400_000, px_expo: -5, conf_bps: 10, source: MarkSource::Backpack, observed_at }.data(),
        bell_session::accounts::PushMark { attestor: a.pubkey(), symbol_state: sp, mark: mp }.to_account_metas(None),
    )], &[&a]).unwrap();
}

fn push_check(ctx: &mut Ctx, open_now: bool, ref_rate_q64: u128, ref_at: i64, observed_at: i64) {
    let c = ctx.checker.insecure_clone();
    let (cp, sym) = (ctx.check_pda(), ctx.sym);
    ctx.send(&[Instruction::new_with_bytes(
        ctx.program_id,
        &bell_session::instruction::PushCheck { symbol: sym, open_now, ref_rate_q64, ref_px_num: 33_400_000, ref_px_expo: -5, ref_at, observed_at }.data(),
        bell_session::accounts::PushCheck { checker: c.pubkey(), check: cp }.to_account_metas(None),
    )], &[&c]).unwrap();
}

/// Push the mark, and the checker's view alongside it: open, with the
/// reference at the same rate, so the checker agrees with every mark a test
/// pushes here.
fn push_mark(ctx: &mut Ctx, rate_q64: u128, observed_at: i64) {
    let sym = ctx.sym;
    push_mark_on(ctx, sym, rate_q64, observed_at);
    push_check(ctx, true, rate_q64, observed_at, observed_at);
}

/// Re-read the mint, so the risk record is fresh at the current clock.
fn refresh(ctx: &mut Ctx) {
    let (mint, rp) = (ctx.stock_mint, ctx.risk_pda());
    ctx.send(&[Instruction::new_with_bytes(
        ctx.program_id,
        &bell_session::instruction::RefreshTokenRisk {}.data(),
        bell_session::accounts::RefreshTokenRisk { mint, risk: rp }.to_account_metas(None),
    )], &[]).unwrap();
}

/// Everything fresh at the current clock, in session, marked at `rate`.
fn session_at(ctx: &mut Ctx, rate: u128) {
    let now = ctx.now();
    push_session(ctx, HaltState::None, true, now);
    push_mark(ctx, rate, now);
    refresh(ctx);
}

fn opt_in(ctx: &mut Ctx, owner: &Keypair) {
    let o = owner.insecure_clone();
    let night = ctx.night_of(&o.pubkey());
    ctx.send(&[Instruction::new_with_bytes(
        ctx.program_id,
        &bell_session::instruction::OptInNight {}.data(),
        bell_session::accounts::OptInNight { owner: o.pubkey(), night, system_program: system_program::ID }.to_account_metas(None),
    )], &[&o]).unwrap();
}

// ------------------------------------------------ the program's pricing, restated

/// Stock raw a buy of `leg` quote raw is worth at `rate`, rounded down: the
/// fair value a buy fill measures its band from.
fn buy_fair(leg: u128, rate: u128) -> u128 {
    (leg * rate) >> 64
}

/// Quote raw a sale of `leg` stock raw is worth at `rate`, rounded up: the
/// fair value a sell fill measures its band from.
fn sell_fair(leg: u64, rate: u128) -> u128 {
    let num = (leg as u128) << 64;
    num / rate + u128::from(num % rate != 0)
}

/// The least stock a filler could deliver on a buy of `leg`: `bps` below fair.
fn buy_min(leg: u64, rate: u128, bps: u16) -> u64 {
    (buy_fair(leg as u128, rate) * (10_000 - bps as u128) / 10_000) as u64
}

/// The least quote a filler could pay on a sale of `leg`: `bps` below fair.
fn sell_min(leg: u64, rate: u128, bps: u16) -> u64 {
    let t = sell_fair(leg, rate) * (10_000 - bps as u128);
    (t / 10_000 + u128::from(t % 10_000 != 0)) as u64
}

/// The cross's quote-leads rounding: `(q, x)`, the quote the buyer pays and
/// the stock the seller sells, for the two remainders at `rate`.
fn cross_amounts(b_rem: u64, s_rem: u64, rate: u128) -> (u64, u64) {
    let c = sell_fair(s_rem, rate);
    let q_s = if buy_fair(c, rate) > s_rem as u128 { c - 1 } else { c };
    let q = (b_rem as u128).min(q_s);
    (q as u64, buy_fair(q, rate) as u64)
}

// ------------------------------------------------------------------- orders

/// One side of a cross: the owner, their order, and the two token accounts
/// it pins. For a buy, `quote` is paid from and `stock` paid into; for a
/// sell, the reverse.
struct Side {
    owner: Pubkey,
    order: Pubkey,
    quote: Pubkey,
    stock: Pubkey,
}

/// What an order asks for. `expires_at: 0` means a day from the clock.
#[derive(Clone, Copy)]
struct Args {
    amount_in: u64,
    min_fill_in: u64,
    slip_bps: u16,
    floor: u128,
    not_before: i64,
    expires_at: i64,
}

/// Partial fills allowed down to one raw unit, a 30bps band, no floor, due at
/// once and good for a day: the order a web client places, with the order's
/// minimum fill relaxed so that the cross decides the size.
fn args(amount_in: u64) -> Args {
    Args { amount_in, min_fill_in: 1, slip_bps: 30, floor: 0, not_before: 0, expires_at: 0 }
}

/// A buy by `owner`: their quote account holds `BUYER_QUOTE`, delegated to
/// their authority for the order's amount; their stock account starts empty.
fn open_buy(ctx: &mut Ctx, owner: &Keypair, nonce: u64, o: Args) -> Result<Side, String> {
    let u = owner.insecure_clone();
    let (qm, sm, auth) = (ctx.quote_mint, ctx.stock_mint, ctx.auth_of(&u.pubkey()));
    let side = Side {
        owner: u.pubkey(),
        order: ctx.pda(&[ORDER_SEED, u.pubkey().as_ref(), &nonce.to_le_bytes()]),
        quote: Pubkey::new_unique(),
        stock: Pubkey::new_unique(),
    };
    ctx.set_token(side.quote, &qm, &u.pubkey(), BUYER_QUOTE, Some((&auth, o.amount_in)), TOKEN);
    ctx.set_token(side.stock, &sm, &u.pubkey(), 0, None, token_2022());
    let expires_at = if o.expires_at == 0 { ctx.now() + 86_400 } else { o.expires_at };
    let (sp, rp, mp, sym) = (ctx.sym_pda(), ctx.risk_pda(), ctx.mark_pda(), ctx.sym);
    ctx.send(&[Instruction::new_with_bytes(
        ctx.program_id,
        &bell_session::instruction::PlaceOrder { symbol: sym, nonce, amount_in: o.amount_in, min_fill_in: o.min_fill_in, max_slip_bps: o.slip_bps, max_conf_bps: 50, floor_rate_q64: o.floor, not_before: o.not_before, expires_at }.data(),
        bell_session::accounts::PlaceOrder { owner: u.pubkey(), symbol_state: sp, risk: rp, mark: mp, order: side.order, payer_in: side.quote, payee_out: side.stock, system_program: system_program::ID }.to_account_metas(None),
    )], &[&u])?;
    Ok(side)
}

/// A sell by `owner` of `sym`, whose stock is `mint`: their stock account
/// holds `SELLER_STOCK`, delegated to their authority for the order's amount;
/// their quote account starts empty.
fn open_sell_on(ctx: &mut Ctx, owner: &Keypair, nonce: u64, sym: [u8; SYMBOL_LEN], mint: Pubkey, o: Args) -> Result<Side, String> {
    let u = owner.insecure_clone();
    let (qm, auth) = (ctx.quote_mint, ctx.auth_of(&u.pubkey()));
    let side = Side {
        owner: u.pubkey(),
        order: ctx.pda(&[SELL_SEED, u.pubkey().as_ref(), &nonce.to_le_bytes()]),
        quote: Pubkey::new_unique(),
        stock: Pubkey::new_unique(),
    };
    ctx.set_token(side.stock, &mint, &u.pubkey(), SELLER_STOCK, Some((&auth, o.amount_in)), token_2022());
    ctx.set_token(side.quote, &qm, &u.pubkey(), 0, None, TOKEN);
    let expires_at = if o.expires_at == 0 { ctx.now() + 86_400 } else { o.expires_at };
    let (sp, rp, mp) = (ctx.sym_pda_of(&sym), ctx.risk_pda_of(&mint), ctx.mark_pda_of(&sym));
    ctx.send(&[Instruction::new_with_bytes(
        ctx.program_id,
        &bell_session::instruction::PlaceSellOrder { symbol: sym, nonce, amount_in: o.amount_in, min_fill_in: o.min_fill_in, max_slip_bps: o.slip_bps, max_conf_bps: 50, floor_rate_q64: o.floor, not_before: o.not_before, expires_at }.data(),
        bell_session::accounts::PlaceSellOrder { owner: u.pubkey(), symbol_state: sp, risk: rp, mark: mp, order: side.order, payer_in: side.stock, payee_out: side.quote, system_program: system_program::ID }.to_account_metas(None),
    )], &[&u])?;
    Ok(side)
}

fn open_sell(ctx: &mut Ctx, owner: &Keypair, nonce: u64, o: Args) -> Result<Side, String> {
    let (sym, mint) = (ctx.sym, ctx.stock_mint);
    open_sell_on(ctx, owner, nonce, sym, mint, o)
}

/// The context's own buyer and seller, each with one order.
fn pair(ctx: &mut Ctx, buy: Args, sell: Args) -> (Side, Side) {
    let (b, s) = (ctx.buyer.insecure_clone(), ctx.seller.insecure_clone());
    (open_buy(ctx, &b, 1, buy).unwrap(), open_sell(ctx, &s, 1, sell).unwrap())
}

/// `cross_orders`' nineteen accounts, in order, for `buy` against `sell`.
fn cross_metas(ctx: &Ctx, buy: &Side, sell: &Side) -> Vec<AccountMeta> {
    bell_session::accounts::CrossOrders {
        cranker: ctx.cranker.pubkey(),
        buy: buy.order,
        sell: sell.order,
        symbol_state: ctx.sym_pda(),
        risk: ctx.risk_pda(),
        mark: ctx.mark_pda(),
        check: ctx.check_pda(),
        buy_auth: ctx.auth_of(&buy.owner),
        sell_auth: ctx.auth_of(&sell.owner),
        buyer: buy.owner,
        seller: sell.owner,
        buyer_quote: buy.quote,
        buyer_stock: buy.stock,
        seller_stock: sell.stock,
        seller_quote: sell.quote,
        quote_mint: ctx.quote_mint,
        stock_mint: ctx.stock_mint,
        quote_token_program: TOKEN,
        stock_token_program: token_2022(),
    }
    .to_account_metas(None)
}

/// Send a cross with the given accounts, signed by the cranker alone.
fn cross_with(ctx: &mut Ctx, metas: Vec<AccountMeta>) -> (Result<(), String>, Vec<String>) {
    let c = ctx.cranker.insecure_clone();
    let ix = Instruction::new_with_bytes(ctx.program_id, &bell_session::instruction::CrossOrders {}.data(), metas);
    ctx.send_logged(&[ix], &[&c])
}

fn cross_logged(ctx: &mut Ctx, buy: &Side, sell: &Side) -> (Result<(), String>, Vec<String>) {
    let metas = cross_metas(ctx, buy, sell);
    cross_with(ctx, metas)
}

fn cross(ctx: &mut Ctx, buy: &Side, sell: &Side) -> Result<(), String> {
    cross_logged(ctx, buy, sell).0
}

/// Every token balance a cross could touch, so a refusal can be shown to have
/// moved nothing on either side.
fn balances(ctx: &Ctx, buy: &Side, sell: &Side) -> [u64; 4] {
    [ctx.balance(&buy.quote), ctx.balance(&buy.stock), ctx.balance(&sell.stock), ctx.balance(&sell.quote)]
}

/// The balances of a buy and a sell that have never been crossed.
const UNTOUCHED: [u64; 4] = [BUYER_QUOTE, 0, SELLER_STOCK, 0];

/// Every program invocation in the logs, in order.
fn calls(logs: &[String]) -> Vec<String> {
    logs.iter().filter(|l| l.starts_with("Program ") && l.contains(" invoke [")).cloned().collect()
}

/// The source file of the check that refused, from Anchor's
/// "AnchorError thrown in <file>:<line>" log.
fn thrown_in(logs: &[String]) -> Option<&str> {
    logs.iter().find_map(|l| {
        let rest = l.split_once("AnchorError thrown in ")?.1;
        Some(rest.split_once(':')?.0)
    })
}
const CROSS_RS: &str = "programs/bell-session/src/instructions/cross.rs";

/// Standard base64, decoded by hand: the event arrives as a
/// "Program data: <base64>" log, and adding a crate to the lockfile to read one
/// line would be a worse trade than these few.
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

/// Every event payload in the logs, discriminator first.
fn events(logs: &[String]) -> Vec<Vec<u8>> {
    logs.iter().filter_map(|l| l.strip_prefix("Program data: ")).map(b64).collect()
}

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
const MULTIPLIER_MOVED: u32 = code(BellError::MultiplierMoved);
const MINT_MISMATCH: u32 = code(BellError::MintMismatch);
const PRICE_OUT_OF_BAND: u32 = code(BellError::PriceOutOfBand);
const NOT_YET_DUE: u32 = code(BellError::NotYetDue);
const ORDER_EXPIRED: u32 = code(BellError::OrderExpired);
const FILL_TOO_SMALL: u32 = code(BellError::FillTooSmall);
const QUOTE_MINT_MISMATCH: u32 = code(BellError::QuoteMintMismatch);
const TOKEN_PROGRAM_MISMATCH: u32 = code(BellError::TokenProgramMismatch);
const CHECK_STALE: u32 = code(BellError::CheckStale);
const CHECKER_DISAGREES: u32 = code(BellError::CheckerDisagrees);
const MARK_OFF_REFERENCE: u32 = code(BellError::MarkOffReference);
const SELF_CROSS: u32 = code(BellError::SelfCross);
/// Anchor's own codes for an account that is not at the address its
/// constraint names, and a PDA that is not at the address its seeds derive.
const CONSTRAINT_ADDRESS: u32 = anchor_lang::error::ErrorCode::ConstraintAddress as u32;
const CONSTRAINT_SEEDS: u32 = anchor_lang::error::ErrorCode::ConstraintSeeds as u32;
/// SPL Token's and Token-2022's shared code for an authority that is neither
/// the account's owner nor its delegate: what a revoked delegation reads as.
const TOKEN_OWNER_MISMATCH: u32 = 4;

// --------------------------------------------------------------------- tests

#[test]
fn a_buy_and_a_sell_cross_at_the_mark_with_no_spread() {
    // One share for sale, and a buy of exactly what one share costs at the
    // mark, rounded up: 1e8 × 1e6 / 299,401 = 334,000,220.4 quote raw.
    let mut ctx = Ctx::new();
    ready(&mut ctx);
    let (b, s) = pair(&mut ctx, args(334_000_221), args(SHARE));
    let r = aapl_rate();
    assert_eq!(cross_amounts(334_000_221, SHARE, r), (334_000_221, SHARE));

    let (br, sr) = (ctx.lamports(&b.owner), ctx.lamports(&s.owner));
    cross(&mut ctx, &b, &s).unwrap();

    // Each side moved exactly its own leg, between the accounts its order pins.
    assert_eq!(balances(&ctx, &b, &s), [BUYER_QUOTE - 334_000_221, SHARE, SELLER_STOCK - SHARE, 334_000_221]);
    // The buyer got the whole of fill_order's fair value for what they paid,
    // and the seller the whole of fill_sell_order's: nothing went to a spread.
    assert_eq!(buy_fair(334_000_221, r), SHARE as u128);
    assert_eq!(sell_fair(SHARE, r), 334_000_221);
    // A filler at the orders' own 30bps band could have left each with less.
    assert!(SHARE > buy_min(334_000_221, r, 30));
    assert!(334_000_221 > sell_min(SHARE, r, 30));
    assert_eq!((buy_min(334_000_221, r, 30), sell_min(SHARE, r, 30)), (99_700_000, 332_998_221));

    // Both orders complete, so both close, each with its rent to its owner.
    assert!(ctx.buy_order(&b).is_none() && ctx.sell_order(&s).is_none());
    assert!(ctx.lamports(&b.owner) > br && ctx.lamports(&s.owner) > sr, "rent returned to both owners");
}

#[test]
fn a_larger_buy_is_partly_filled_and_the_sell_closes() {
    // $500 to spend against one share: the share is all there is, so the buy
    // takes it at the least quote that buys it, and keeps the rest.
    let mut ctx = Ctx::new();
    ready(&mut ctx);
    let (b, s) = pair(&mut ctx, args(500 * DOLLAR), args(SHARE));
    let (q, x) = cross_amounts(500 * DOLLAR, SHARE, aapl_rate());
    assert_eq!((q, x), (334_000_221, SHARE));

    let sr = ctx.lamports(&s.owner);
    cross(&mut ctx, &b, &s).unwrap();
    assert_eq!(balances(&ctx, &b, &s), [BUYER_QUOTE - q, x, SELLER_STOCK - x, q]);

    assert!(ctx.sell_order(&s).is_none(), "the sell completed and closed");
    assert!(ctx.lamports(&s.owner) > sr, "rent returned to the seller");
    let o = ctx.buy_order(&b).expect("the buy stays open for its remainder");
    assert_eq!(o.filled_in, q);
    assert_eq!(o.amount_in, 500 * DOLLAR, "a cross records progress; it does not resize the order");
    // The token program draws the delegation down by what it moved, leaving
    // exactly the remainder for the next cross or a fill.
    assert_eq!(ctx.delegated(&b.quote), 500 * DOLLAR - q);
}

#[test]
fn a_larger_sell_is_partly_filled_and_the_buy_closes() {
    // $100 against a whole share: the buyer's quote is all there is, and buys
    // 29,940,099 raw at the mark, a hair under 0.29940100 because the Q64
    // rate is truncated.
    let mut ctx = Ctx::new();
    ready(&mut ctx);
    let (b, s) = pair(&mut ctx, args(100 * DOLLAR), args(SHARE));
    let (q, x) = cross_amounts(100 * DOLLAR, SHARE, aapl_rate());
    assert_eq!((q, x), (100 * DOLLAR, 29_940_099));

    let br = ctx.lamports(&b.owner);
    cross(&mut ctx, &b, &s).unwrap();
    assert_eq!(balances(&ctx, &b, &s), [BUYER_QUOTE - q, x, SELLER_STOCK - x, q]);

    assert!(ctx.buy_order(&b).is_none(), "the buy completed and closed");
    assert!(ctx.lamports(&b.owner) > br, "rent returned to the buyer");
    let o = ctx.sell_order(&s).expect("the sell stays open for its remainder");
    assert_eq!(o.filled_in, x);
    assert_eq!(ctx.delegated(&s.stock), SHARE - x);
}

#[test]
fn a_self_cross_is_refused() {
    // One owner's buy against the same owner's sell would trade nothing and
    // use up both orders, so any cranker could cancel them. Refused before
    // anything else is looked at.
    //
    // NightNeedsLimit was optional and never added, so no code is reserved
    // after MarkOffReference: SelfCross is the very next one.
    assert_eq!((code(BellError::MarkOffReference), SELF_CROSS), (6032, 6033));
    let mut ctx = Ctx::new();
    ready(&mut ctx);
    let me = ctx.buyer.insecure_clone();
    let b = open_buy(&mut ctx, &me, 1, args(500 * DOLLAR)).unwrap();
    let s = open_sell(&mut ctx, &me, 1, args(SHARE)).unwrap();
    assert_code(cross(&mut ctx, &b, &s), SELF_CROSS, "the same owner on both sides");
    assert_eq!(balances(&ctx, &b, &s), UNTOUCHED);
    assert_eq!(ctx.buy_order(&b).unwrap().filled_in, 0);
    assert_eq!(ctx.sell_order(&s).unwrap().filled_in, 0);

    // Against someone else's sell, the same buy crosses.
    let other = ctx.seller.insecure_clone();
    let s2 = open_sell(&mut ctx, &other, 1, args(SHARE)).unwrap();
    cross(&mut ctx, &b, &s2).unwrap();
}

#[test]
fn a_cross_respects_the_buyers_limit() {
    // The buyer will take no less than 10bps more stock per dollar than the
    // mark gives. The band is always met at the mark, so it is the floor that
    // refuses, and nothing moves.
    let mut ctx = Ctx::new();
    ready(&mut ctx);
    let r = aapl_rate();
    let limit = step(r, 10);
    let (b, s) = pair(&mut ctx, Args { floor: limit, ..args(100 * DOLLAR) }, args(SHARE));
    let (q, x) = cross_amounts(100 * DOLLAR, SHARE, r);
    assert!(buy_fair(q as u128, limit) > x as u128, "the floor asks for more than the mark gives");

    let (r, logs) = cross_logged(&mut ctx, &b, &s);
    assert_code(r, PRICE_OUT_OF_BAND, "mark 10bps short of the buyer's limit");
    assert_eq!(calls(&logs), [format!("Program {} invoke [1]", ctx.program_id)], "refused before either leg was called");
    assert_eq!(balances(&ctx, &b, &s), UNTOUCHED);

    // With the mark at the limit exactly, the floor is met to the unit. The
    // mark moves a minute later, since a mark may not move at all in the
    // second it was last observed.
    ctx.warp(NOW + MAX_MARK_AGE_SECONDS);
    push_mark(&mut ctx, limit, NOW + MAX_MARK_AGE_SECONDS);
    let (q, x) = cross_amounts(100 * DOLLAR, SHARE, limit);
    assert_eq!(buy_fair(q as u128, limit), x as u128);
    cross(&mut ctx, &b, &s).unwrap();
    assert_eq!(balances(&ctx, &b, &s), [BUYER_QUOTE - q, x, SELLER_STOCK - x, q]);
}

#[test]
fn a_cross_respects_the_sellers_limit() {
    // The seller will take no less than $335 a share; the mark says $334.
    let mut ctx = Ctx::new();
    ready(&mut ctx);
    let floor = (335_000_000u128 << 64) / SHARE as u128;
    let (b, s) = pair(&mut ctx, args(500 * DOLLAR), Args { floor, ..args(SHARE) });
    let (q, _) = cross_amounts(500 * DOLLAR, SHARE, aapl_rate());
    assert_eq!(q, 334_000_221, "what the mark pays for the share");

    let (r, logs) = cross_logged(&mut ctx, &b, &s);
    assert_code(r, PRICE_OUT_OF_BAND, "mark under the seller's limit");
    assert_eq!(calls(&logs), [format!("Program {} invoke [1]", ctx.program_id)], "refused before either leg was called");
    assert_eq!(balances(&ctx, &b, &s), UNTOUCHED);

    // At $335 a share the same pair crosses, and the seller is paid at least
    // their limit.
    let at_limit = ((SHARE as u128) << 64) / 335_000_000;
    ctx.warp(NOW + MAX_MARK_AGE_SECONDS);
    push_mark(&mut ctx, at_limit, NOW + MAX_MARK_AGE_SECONDS);
    let (q, x) = cross_amounts(500 * DOLLAR, SHARE, at_limit);
    assert_eq!(x, SHARE);
    assert!(q >= 335_000_000);
    cross(&mut ctx, &b, &s).unwrap();
    assert_eq!(balances(&ctx, &b, &s), [BUYER_QUOTE - q, x, SELLER_STOCK - x, q]);
}

#[test]
fn a_cross_below_either_minimum_fill_is_refused() {
    let mut ctx = Ctx::new();
    ready(&mut ctx);
    let (bk, sk) = (ctx.buyer.insecure_clone(), ctx.seller.insecure_clone());

    // The buyer's minimum fill is $400; one share is worth $334.
    let b = open_buy(&mut ctx, &bk, 1, Args { min_fill_in: 400 * DOLLAR, ..args(500 * DOLLAR) }).unwrap();
    let s = open_sell(&mut ctx, &sk, 1, args(SHARE)).unwrap();
    assert_code(cross(&mut ctx, &b, &s), FILL_TOO_SMALL, "334,000,221 quote under the buyer's 400,000,000 minimum");
    assert_eq!(balances(&ctx, &b, &s), UNTOUCHED);

    // The seller's share is all-or-none; $100 buys 0.3 of it.
    let b2 = open_buy(&mut ctx, &bk, 2, args(100 * DOLLAR)).unwrap();
    let s2 = open_sell(&mut ctx, &sk, 2, Args { min_fill_in: SHARE, ..args(SHARE) }).unwrap();
    assert_code(cross(&mut ctx, &b2, &s2), FILL_TOO_SMALL, "29,940,099 stock under the seller's whole share");
    assert_eq!(balances(&ctx, &b2, &s2), UNTOUCHED);

    // One raw unit of quote buys no whole raw unit of stock at $334, and a
    // cross that moves nothing on one leg is not a trade.
    let b3 = open_buy(&mut ctx, &bk, 3, args(1)).unwrap();
    assert_eq!(cross_amounts(1, SHARE, aapl_rate()), (1, 0));
    assert_code(cross(&mut ctx, &b3, &s), FILL_TOO_SMALL, "one raw of quote buys zero stock");
    assert_eq!(balances(&ctx, &b3, &s), [BUYER_QUOTE, 0, SELLER_STOCK, 0]);

    // A buyer whose minimum one share does meet crosses with the same sell.
    let b4 = open_buy(&mut ctx, &bk, 4, Args { min_fill_in: 300 * DOLLAR, ..args(500 * DOLLAR) }).unwrap();
    cross(&mut ctx, &b4, &s).unwrap();
}

#[test]
fn a_cross_of_orders_not_due_or_expired_is_refused() {
    let mut ctx = Ctx::new();
    ready(&mut ctx);
    let (bk, sk) = (ctx.buyer.insecure_clone(), ctx.seller.insecure_clone());
    let later = Args { not_before: NOW + 3_600, ..args(500 * DOLLAR) };
    let b_later = open_buy(&mut ctx, &bk, 1, later).unwrap();
    let s_later = open_sell(&mut ctx, &sk, 1, Args { not_before: NOW + 3_600, ..args(SHARE) }).unwrap();
    let b_short = open_buy(&mut ctx, &bk, 2, Args { expires_at: NOW + 600, ..args(500 * DOLLAR) }).unwrap();
    let s_short = open_sell(&mut ctx, &sk, 2, Args { expires_at: NOW + 600, ..args(SHARE) }).unwrap();
    let b_now = open_buy(&mut ctx, &bk, 3, args(500 * DOLLAR)).unwrap();
    let s_now = open_sell(&mut ctx, &sk, 3, args(SHARE)).unwrap();

    // Either side not yet due refuses the pair.
    assert_code(cross(&mut ctx, &b_later, &s_now), NOT_YET_DUE, "the buy is not due for an hour");
    assert_code(cross(&mut ctx, &b_now, &s_later), NOT_YET_DUE, "the sell is not due for an hour");

    // Either side lapsed refuses it, with everything else fresh.
    ctx.warp(NOW + 600);
    session_at(&mut ctx, aapl_rate());
    assert_code(cross(&mut ctx, &b_short, &s_now), ORDER_EXPIRED, "the buy lapsed");
    assert_code(cross(&mut ctx, &b_now, &s_short), ORDER_EXPIRED, "the sell lapsed");
    assert_eq!(balances(&ctx, &b_now, &s_now), UNTOUCHED);

    // An hour on, the two late orders are due and cross each other.
    ctx.warp(NOW + 3_600);
    session_at(&mut ctx, aapl_rate());
    cross(&mut ctx, &b_later, &s_later).unwrap();
    assert!(ctx.sell_order(&s_later).is_none());
}

#[test]
fn a_cross_needs_both_multipliers_to_match() {
    // The real AAPLx mint carries a scheduled multiplier step. Find it on the
    // mint, then start a fresh ledger half an hour before it, place one buy
    // and one sell on the old multiplier, and one of each on the new one once
    // it is in force.
    let t = {
        let mut probe = Ctx::new();
        ready(&mut probe);
        probe.risk().activates_at
    };
    assert_ne!(t, 0, "the fixture should carry a multiplier activation");

    let mut ctx = Ctx::at(t - 1_800);
    ready(&mut ctx);
    let old_bits = ctx.risk().multiplier_bits;
    let (bk, sk) = (ctx.buyer.insecure_clone(), ctx.seller.insecure_clone());
    let b_old = open_buy(&mut ctx, &bk, 1, args(500 * DOLLAR)).unwrap();
    let s_old = open_sell(&mut ctx, &sk, 1, args(SHARE)).unwrap();

    // Past the step and clear of its guard window, with the mint re-read.
    ctx.warp(t + 901);
    session_at(&mut ctx, aapl_rate());
    let new_bits = ctx.risk().multiplier_bits;
    assert_ne!(old_bits, new_bits, "the multiplier stepped");
    let b_new = open_buy(&mut ctx, &bk, 2, args(500 * DOLLAR)).unwrap();
    let s_new = open_sell(&mut ctx, &sk, 2, args(SHARE)).unwrap();

    // Either side built on the old multiplier refuses the pair: each order is
    // admitted against its own snapshot, not only the buy's.
    assert_code(cross(&mut ctx, &b_old, &s_new), MULTIPLIER_MOVED, "the buy was built on the old multiplier");
    assert_code(cross(&mut ctx, &b_new, &s_old), MULTIPLIER_MOVED, "the sell was built on the old multiplier");
    assert_eq!(balances(&ctx, &b_new, &s_new), UNTOUCHED);

    // Both on the new one: they cross.
    cross(&mut ctx, &b_new, &s_new).unwrap();
}

#[test]
fn a_cross_at_night_is_refused_even_when_both_opted_in() {
    // Both owners consent to night fills, and the attestor and the checker
    // agree the market is shut. A cross still refuses: it has no filler on
    // the other side at its own risk, so it runs Strict, where the shut
    // session is gate 7's MarketClosed rather than a night fill.
    let mut ctx = Ctx::new();
    ready(&mut ctx);
    let (b, s) = pair(&mut ctx, args(500 * DOLLAR), args(SHARE));
    let (bk, sk) = (ctx.buyer.insecure_clone(), ctx.seller.insecure_clone());
    opt_in(&mut ctx, &bk);
    opt_in(&mut ctx, &sk);
    assert!(ctx.lamports(&ctx.night_of(&b.owner)) > 0 && ctx.lamports(&ctx.night_of(&s.owner)) > 0);

    let now = ctx.now();
    push_session(&mut ctx, HaltState::None, false, now);
    let sym = ctx.sym;
    push_mark_on(&mut ctx, sym, aapl_rate(), now);
    push_check(&mut ctx, false, aapl_rate(), now - 3_600, now);
    assert_code(cross(&mut ctx, &b, &s), MARKET_CLOSED, "night, both opted in, checker agrees it is shut");
    assert_eq!(balances(&ctx, &b, &s), UNTOUCHED);

    // In session, the same pair crosses.
    push_session(&mut ctx, HaltState::None, true, now);
    push_check(&mut ctx, true, aapl_rate(), now, now);
    cross(&mut ctx, &b, &s).unwrap();
}

#[test]
fn a_cross_needs_a_fresh_agreeing_checker() {
    let mut ctx = Ctx::new();
    ready(&mut ctx);
    let (b, s) = pair(&mut ctx, args(500 * DOLLAR), args(SHARE));
    let r = aapl_rate();

    // Two minutes and a second on, the session, the mark and the risk read
    // are fresh; only the check has aged past its bound.
    ctx.warp(NOW + 121);
    push_session(&mut ctx, HaltState::None, true, NOW + 121);
    let sym = ctx.sym;
    push_mark_on(&mut ctx, sym, r, NOW + 121);
    assert_code(cross(&mut ctx, &b, &s), CHECK_STALE, "check pushed 121s ago");

    // Fresh, but saying the market is shut while the attestor says open.
    push_check(&mut ctx, false, r, NOW + 121, NOW + 121);
    assert_code(cross(&mut ctx, &b, &s), CHECKER_DISAGREES, "the checker says closed in session");

    // Fresh and open, but its reference is 4% from the mark, past the 3%
    // session band.
    push_check(&mut ctx, true, step(r, 400), NOW + 121, NOW + 121);
    assert_code(cross(&mut ctx, &b, &s), MARK_OFF_REFERENCE, "mark 400bps from the reference");
    assert_eq!(balances(&ctx, &b, &s), UNTOUCHED);

    push_check(&mut ctx, true, r, NOW + 121, NOW + 121);
    cross(&mut ctx, &b, &s).unwrap();
}

#[test]
fn a_cross_of_different_symbols_is_refused() {
    let mut ctx = Ctx::new();
    ready(&mut ctx);
    let (bk, sk) = (ctx.buyer.insecure_clone(), ctx.seller.insecure_clone());
    let b = open_buy(&mut ctx, &bk, 1, args(500 * DOLLAR)).unwrap();

    // A second ticker on the very same mint. The mint matches, so only the
    // symbol tells the two apart.
    let (aapl2, aaplx) = (ticker("AAPL2"), ctx.stock_mint);
    register(&mut ctx, aapl2, aaplx);
    open_mark(&mut ctx, aapl2);
    push_mark_on(&mut ctx, aapl2, aapl_rate(), NOW);
    let s_twin = open_sell_on(&mut ctx, &sk, 1, aapl2, aaplx, args(SHARE)).unwrap();
    assert_eq!(ctx.sell_order(&s_twin).unwrap().mint, ctx.stock_mint);
    assert_code(cross(&mut ctx, &b, &s_twin), MINT_MISMATCH, "an AAPL2 sell against an AAPLx buy");

    // A different stock altogether.
    let pfe = ctx.install_mint(PFE_BACKPACK, include_bytes!("fixtures/pfe_backpack.bin"));
    let pfe_sym = ticker("PFE");
    register(&mut ctx, pfe_sym, pfe);
    init_risk(&mut ctx, pfe);
    open_mark(&mut ctx, pfe_sym);
    push_mark_on(&mut ctx, pfe_sym, (1u128 << 64) / 25, NOW);
    let s_pfe = open_sell_on(&mut ctx, &sk, 2, pfe_sym, pfe, args(10_000_000)).unwrap();
    assert_code(cross(&mut ctx, &b, &s_pfe), MINT_MISMATCH, "a PFE sell against an AAPLx buy");

    // The same symbol in a different quote asset. No instruction can make
    // one, since a symbol has one mark and an order takes its quote asset
    // from it, so the sell is written directly to prove the constraint holds
    // on its own.
    let s = open_sell(&mut ctx, &sk, 3, args(SHARE)).unwrap();
    let mut acc = ctx.svm.get_account(&s.order).unwrap();
    let mut o = SellOrder::try_deserialize(&mut &acc.data[..]).unwrap();
    o.quote_mint = Pubkey::new_unique();
    let mut data = Vec::new();
    o.try_serialize(&mut data).unwrap();
    acc.data[..data.len()].copy_from_slice(&data);
    ctx.svm.set_account(s.order, acc).unwrap();
    assert_code(cross(&mut ctx, &b, &s), QUOTE_MINT_MISMATCH, "a sell for another quote asset");

    assert_eq!([ctx.balance(&b.quote), ctx.balance(&b.stock)], [BUYER_QUOTE, 0]);
    for side in [&s_twin, &s_pfe, &s] {
        assert_eq!([ctx.balance(&side.stock), ctx.balance(&side.quote)], [SELLER_STOCK, 0]);
    }
}

#[test]
fn the_rounding_leaves_both_sides_at_or_above_their_own_fair_value() {
    // Three marks: the AAPLx rate (below one), an eight-decimal stock at
    // $25.37 (a rate above one, where one raw unit of quote buys several of
    // stock), and Backpack's six-decimal PFE at $25. At each, two crosses on
    // chain: one where the sell's remainder binds and one where the buy's
    // does. Each side's receipt is then compared with its own fill's fair
    // value, the buyer's rounded down and the seller's rounded up.
    struct Case {
        rate: u128,
        buy: u64,
        sell: u64,
        q: u64,
        x: u64,
    }
    let aapl = aapl_rate();
    let above_one = ((SHARE as u128) << 64) / 25_370_000;
    let pfe = (1u128 << 64) / 25;
    assert!(above_one > 1u128 << 64);

    let run = |ctx: &mut Ctx, cases: &[Case]| -> Vec<(Side, Side)> {
        let (bk, sk) = (ctx.buyer.insecure_clone(), ctx.seller.insecure_clone());
        let mut sides = Vec::new();
        for (i, c) in cases.iter().enumerate() {
            let nonce = 10 + i as u64;
            let b = open_buy(ctx, &bk, nonce, args(c.buy)).unwrap();
            let s = open_sell(ctx, &sk, nonce, args(c.sell)).unwrap();
            assert_eq!(cross_amounts(c.buy, c.sell, c.rate), (c.q, c.x), "the restatement agrees with the hand-worked numbers");
            cross(ctx, &b, &s).unwrap();
            let got_stock = ctx.balance(&b.stock);
            let got_quote = ctx.balance(&s.quote);
            assert_eq!((got_stock, got_quote), (c.x, c.q), "on chain");
            assert_eq!(BUYER_QUOTE - ctx.balance(&b.quote), c.q, "the buyer paid q");
            assert_eq!(SELLER_STOCK - ctx.balance(&s.stock), c.x, "the seller sold x");
            // The buyer receives exactly what a fill of q would call fair.
            assert_eq!(got_stock as u128, buy_fair(c.q as u128, c.rate));
            // The seller receives at least what a fill of x would call fair.
            assert!(got_quote as u128 >= sell_fair(c.x, c.rate));
            sides.push((b, s));
        }
        sides
    };

    let mut ctx = Ctx::new();
    ready_at(&mut ctx, aapl);
    let sides = run(&mut ctx, &[
        // The sell binds: one share, at the least quote that buys all of it.
        Case { rate: aapl, buy: 500 * DOLLAR, sell: SHARE, q: 334_000_221, x: SHARE },
        // The buy binds: $100.000001 buys 29,940,100 raw, and the seller is
        // paid exactly its rounded-up value.
        Case { rate: aapl, buy: 100_000_001, sell: 2 * SHARE, q: 100_000_001, x: 29_940_100 },
    ]);
    assert_eq!(sell_fair(29_940_100, aapl), 100_000_001);
    assert!(ctx.sell_order(&sides[0].1).is_none() && ctx.buy_order(&sides[1].0).is_none(), "the binding side closed");

    let mut ctx = Ctx::new();
    ready_at(&mut ctx, above_one);
    let sides = run(&mut ctx, &[
        // The sell binds, and the least quote that buys the whole share,
        // 25,370,001, would buy 100,000,003 raw: more than there is. One unit
        // less buys 99,999,999, and the share keeps one raw unit for later.
        Case { rate: above_one, buy: 100 * DOLLAR, sell: SHARE, q: 25_370_000, x: 99_999_999 },
        // The buy binds.
        Case { rate: above_one, buy: 10_000_003, sell: SHARE, q: 10_000_003, x: 39_416_645 },
    ]);
    assert_eq!(buy_fair(25_370_001, above_one), 100_000_003);
    // So neither side of the first cross completes: the sell keeps one raw
    // unit and the buy keeps what it did not spend, each for a later cross or
    // a fill.
    let (b0, s0) = &sides[0];
    assert_eq!(ctx.sell_order(s0).unwrap().filled_in, 99_999_999, "one raw unit left on the sell");
    assert_eq!(ctx.buy_order(b0).unwrap().filled_in, 25_370_000);

    let mut ctx = Ctx::with_stock(NOW, PFE_BACKPACK, include_bytes!("fixtures/pfe_backpack.bin"), "PFE");
    ready_at(&mut ctx, pfe);
    run(&mut ctx, &[
        // The sell binds: ten shares at a hair over $25 each, rounded up.
        Case { rate: pfe, buy: 500 * DOLLAR, sell: 10_000_000, q: 250_000_001, x: 10_000_000 },
        // The buy binds: $100.000007 buys exactly four shares, whose fair
        // value is 100,000,001; the six units a whole raw share cannot absorb
        // go to the seller rather than vanishing.
        Case { rate: pfe, buy: 100_000_007, sell: 10_000_000, q: 100_000_007, x: 4_000_000 },
    ]);
    assert_eq!(sell_fair(4_000_000, pfe), 100_000_001);

    // And across many remainders at each rate, the rounding keeps four
    // promises: the buyer gets exactly its fair value for what it pays, the
    // seller at least its own, neither order is overdrawn, and as much crosses
    // as the two remainders allow.
    let mut seed = 0x2545_f491_4f6c_dd1du64;
    let mut next = |m: u64| {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        seed % m + 1
    };
    for rate in [aapl, above_one, pfe, 4u128 << 64, (1u128 << 64) + 1, (1u128 << 64) - 1] {
        let mut pairs: Vec<(u64, u64)> = vec![(1, 1), (1, 3), (3, 1), (2, 7), (1_000_000_000, 1), (1, 1_000_000_000)];
        for _ in 0..2_000 {
            pairs.push((next(1_000_000_000), next(1_000_000_000)));
            pairs.push((next(1_000), next(1_000)));
        }
        for (b_rem, s_rem) in pairs {
            let (q, x) = cross_amounts(b_rem, s_rem, rate);
            assert_eq!(x as u128, buy_fair(q as u128, rate), "buyer at fair: {b_rem} {s_rem} {rate}");
            assert!(q as u128 >= sell_fair(x, rate), "seller at or above fair: {b_rem} {s_rem} {rate}");
            assert!(q <= b_rem && x <= s_rem, "neither overdrawn: {b_rem} {s_rem} {rate}");
            assert!(
                q == b_rem || x == s_rem || buy_fair(q as u128 + 1, rate) > s_rem as u128,
                "nothing left that could have crossed: {b_rem} {s_rem} {rate}"
            );
        }
    }
}

#[test]
fn a_revoked_side_moves_nothing() {
    let mut ctx = Ctx::new();
    ready(&mut ctx);
    let (b, s) = pair(&mut ctx, args(500 * DOLLAR), args(SHARE));
    let (qm, sm) = (ctx.quote_mint, ctx.stock_mint);
    let (b_auth, s_auth) = (ctx.auth_of(&b.owner), ctx.auth_of(&s.owner));

    // The seller revokes: the stock leg, first, is refused by Token-2022.
    ctx.set_token(s.stock, &sm, &s.owner, SELLER_STOCK, None, token_2022());
    assert_code(cross(&mut ctx, &b, &s), TOKEN_OWNER_MISMATCH, "the seller revoked");
    assert_eq!(balances(&ctx, &b, &s), UNTOUCHED);

    // The buyer revokes instead: the stock leg goes through, then the quote
    // leg is refused, and the whole cross rolls back with it.
    ctx.set_token(s.stock, &sm, &s.owner, SELLER_STOCK, Some((&s_auth, SHARE)), token_2022());
    ctx.set_token(b.quote, &qm, &b.owner, BUYER_QUOTE, None, TOKEN);
    let (r, logs) = cross_logged(&mut ctx, &b, &s);
    assert_code(r, TOKEN_OWNER_MISMATCH, "the buyer revoked");
    assert_eq!(
        calls(&logs),
        [
            format!("Program {} invoke [1]", ctx.program_id),
            format!("Program {} invoke [2]", token_2022()),
            format!("Program {} invoke [2]", TOKEN),
        ],
        "the stock moved before the quote leg failed",
    );
    assert_eq!(balances(&ctx, &b, &s), UNTOUCHED, "and the stock leg was rolled back");
    assert_eq!(ctx.delegated(&s.stock), SHARE, "the seller's delegation is intact");
    assert_eq!(ctx.buy_order(&b).unwrap().filled_in, 0);
    assert_eq!(ctx.sell_order(&s).unwrap().filled_in, 0);

    // Delegated again, the pair crosses.
    ctx.set_token(b.quote, &qm, &b.owner, BUYER_QUOTE, Some((&b_auth, 500 * DOLLAR)), TOKEN);
    cross(&mut ctx, &b, &s).unwrap();
}

#[test]
fn a_cross_cannot_be_redirected_to_a_strangers_account() {
    // The cranker holds accounts of both assets and tries to have each leg
    // paid to itself, to collect the rent, to have the seller's authority
    // sign the buyer's leg, and to call a program of its choosing with an
    // authority's signature. Each is refused before anything moves.
    let mut ctx = Ctx::new();
    ready(&mut ctx);
    let (b, s) = pair(&mut ctx, args(500 * DOLLAR), args(SHARE));
    let (me, qm, sm) = (ctx.cranker.pubkey(), ctx.quote_mint, ctx.stock_mint);
    let (my_stock, my_quote) = (Pubkey::new_unique(), Pubkey::new_unique());
    ctx.set_token(my_stock, &sm, &me, 0, None, token_2022());
    ctx.set_token(my_quote, &qm, &me, 0, None, TOKEN);

    // Positions in `cross_metas`: 7 buy_auth, 8 sell_auth, 9 buyer, 10 seller,
    // 12 buyer_stock, 14 seller_quote, 18 stock_token_program.
    let attempts: [(usize, Pubkey, u32, &str); 7] = [
        (12, my_stock, CONSTRAINT_ADDRESS, "the stock paid to the cranker"),
        (14, my_quote, CONSTRAINT_ADDRESS, "the quote paid to the cranker"),
        (9, me, CONSTRAINT_ADDRESS, "the buy's rent to the cranker"),
        (10, me, CONSTRAINT_ADDRESS, "the sell's rent to the cranker"),
        (7, ctx.auth_of(&s.owner), CONSTRAINT_SEEDS, "the seller's authority on the buyer's leg"),
        (8, ctx.auth_of(&b.owner), CONSTRAINT_SEEDS, "the buyer's authority on the seller's leg"),
        (18, memo(), TOKEN_PROGRAM_MISMATCH, "the stock leg under a program that is not a token program"),
    ];
    for (at, key, code, why) in attempts {
        let mut metas = cross_metas(&ctx, &b, &s);
        metas[at].pubkey = key;
        let (r, logs) = cross_with(&mut ctx, metas);
        assert_code(r, code, why);
        assert_eq!(calls(&logs), [format!("Program {} invoke [1]", ctx.program_id)], "{why}: nothing was called");
        if code == TOKEN_PROGRAM_MISMATCH {
            // From the up-front check in cross.rs, not from the owner check
            // a balance read would also have made.
            assert_eq!(thrown_in(&logs), Some(CROSS_RS), "{why}: refused up front");
        }
    }
    assert_eq!(balances(&ctx, &b, &s), UNTOUCHED);
    assert_eq!([ctx.balance(&my_stock), ctx.balance(&my_quote)], [0, 0]);

    cross(&mut ctx, &b, &s).unwrap();
    assert_eq!([ctx.balance(&my_stock), ctx.balance(&my_quote)], [0, 0], "the cranker gets nothing");

    // What lands is measured, not assumed. Here the buyer pinned a stock
    // account that has since passed to the seller, who then sold out of it,
    // so the stock leg is a transfer from that account into itself: the token
    // program accepts it and moves nothing. Every amount the program computed
    // clears both minimums; only the measurement sees that the buyer received
    // nothing, and the quote leg is never reached.
    let (bk, sk) = (ctx.buyer.insecure_clone(), ctx.seller.insecure_clone());
    let b2 = open_buy(&mut ctx, &bk, 2, args(500 * DOLLAR)).unwrap();
    let s_auth = ctx.auth_of(&sk.pubkey());
    ctx.set_token(b2.stock, &sm, &sk.pubkey(), SELLER_STOCK, Some((&s_auth, SHARE)), token_2022());
    let s2 = Side { owner: sk.pubkey(), order: ctx.pda(&[SELL_SEED, sk.pubkey().as_ref(), &2u64.to_le_bytes()]), quote: Pubkey::new_unique(), stock: b2.stock };
    ctx.set_token(s2.quote, &qm, &sk.pubkey(), 0, None, TOKEN);
    let (sp, rp, mp, sym) = (ctx.sym_pda(), ctx.risk_pda(), ctx.mark_pda(), ctx.sym);
    let expires_at = ctx.now() + 86_400;
    ctx.send(&[Instruction::new_with_bytes(
        ctx.program_id,
        &bell_session::instruction::PlaceSellOrder { symbol: sym, nonce: 2, amount_in: SHARE, min_fill_in: 1, max_slip_bps: 30, max_conf_bps: 50, floor_rate_q64: 0, not_before: 0, expires_at }.data(),
        bell_session::accounts::PlaceSellOrder { owner: sk.pubkey(), symbol_state: sp, risk: rp, mark: mp, order: s2.order, payer_in: s2.stock, payee_out: s2.quote, system_program: system_program::ID }.to_account_metas(None),
    )], &[&sk]).unwrap();
    let (r, logs) = cross_logged(&mut ctx, &b2, &s2);
    assert_code(r, PRICE_OUT_OF_BAND, "the buyer's pinned account received nothing");
    assert_eq!(
        calls(&logs),
        [format!("Program {} invoke [1]", ctx.program_id), format!("Program {} invoke [2]", token_2022())],
        "refused after the stock leg, before the quote leg",
    );
    assert_eq!([ctx.balance(&b2.quote), ctx.balance(&b2.stock), ctx.balance(&s2.quote)], [BUYER_QUOTE, SELLER_STOCK, 0]);
    assert_eq!(ctx.buy_order(&b2).unwrap().filled_in, 0);
}

#[test]
fn a_cross_emits_one_event_with_both_legs() {
    let mut ctx = Ctx::new();
    ready(&mut ctx);
    let (b, s) = pair(&mut ctx, args(500 * DOLLAR), args(SHARE));
    let (r, logs) = cross_logged(&mut ctx, &b, &s);
    r.unwrap();

    // Two token calls, the stock leg under Token-2022 and then the quote leg
    // under SPL Token, and no third party anywhere.
    assert_eq!(
        calls(&logs),
        [
            format!("Program {} invoke [1]", ctx.program_id),
            format!("Program {} invoke [2]", token_2022()),
            format!("Program {} invoke [2]", TOKEN),
        ],
    );

    let all = events(&logs);
    assert_eq!(all.len(), 1, "one event for the whole trade");
    assert!(all[0].starts_with(OrdersCrossed::DISCRIMINATOR));
    assert!(!all.iter().any(|d| d.starts_with(OrderFilled::DISCRIMINATOR) || d.starts_with(SellOrderFilled::DISCRIMINATOR)));
    let e = OrdersCrossed::deserialize(&mut &all[0][OrdersCrossed::DISCRIMINATOR.len()..]).unwrap();
    assert_eq!(e.symbol, ctx.sym);
    assert_eq!((e.buyer, e.seller), (b.owner, s.owner));
    assert_eq!((e.quote, e.stock), (334_000_221, SHARE));
    assert_eq!((e.px_num, e.px_expo, e.source, e.mark_observed_at), (33_400_000, -5, MarkSource::Backpack, NOW));
    // The legs it reports are the legs that moved.
    assert_eq!(ctx.balance(&s.quote), e.quote);
    assert_eq!(ctx.balance(&b.stock), e.stock);
}

#[test]
fn all_or_nothing_orders_cross_only_at_an_exact_size() {
    // On record, not a fix: the web and the scripts place both sides with the
    // minimum fill equal to the amount, all or nothing. Two such orders cross
    // only when the buy's whole amount buys exactly the sell's whole amount
    // at the mark, to the raw unit. At the AAPLx rate, one buy size in the
    // two thousand around the share's price crosses a whole share, and it is
    // not a round one. Every mark push moves it.
    let mut ctx = Ctx::new();
    ready(&mut ctx);
    let r = aapl_rate();
    let (bk, sk) = (ctx.buyer.insecure_clone(), ctx.seller.insecure_clone());
    let aon = |amount: u64| Args { min_fill_in: amount, ..args(amount) };

    let exact = |b: u64| cross_amounts(b, SHARE, r) == (b, SHARE);
    let (q, x) = cross_amounts(500 * DOLLAR, SHARE, r);
    assert_eq!((q, x), (334_000_221, SHARE), "what the mark pays for the share");
    let sizes: Vec<u64> = (q - 1_000..=q + 1_000).filter(|&b| exact(b)).collect();
    assert_eq!(sizes, [q], "the buy sizes within 1,000 raw that cross a whole share");

    // $334 and $335, all or nothing, against one share, all or nothing.
    for (nonce, amount, why) in [(1, 334 * DOLLAR, "$334 buys a little under the share"), (2, 335 * DOLLAR, "$335 is more than the share costs")] {
        let b = open_buy(&mut ctx, &bk, nonce, aon(amount)).unwrap();
        let s = open_sell(&mut ctx, &sk, nonce, aon(SHARE)).unwrap();
        assert_code(cross(&mut ctx, &b, &s), FILL_TOO_SMALL, why);
        assert_eq!(balances(&ctx, &b, &s), UNTOUCHED);
    }

    // The exact size crosses, and both orders complete.
    let b = open_buy(&mut ctx, &bk, 3, aon(q)).unwrap();
    let s = open_sell(&mut ctx, &sk, 3, aon(SHARE)).unwrap();
    cross(&mut ctx, &b, &s).unwrap();
    assert_eq!(balances(&ctx, &b, &s), [BUYER_QUOTE - q, SHARE, SELLER_STOCK - SHARE, q]);
}
