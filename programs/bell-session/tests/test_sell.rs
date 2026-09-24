//! Sell orders: place, fill and cancel, with the legs swapped.
//!
//! The harness is copied from `test_queue.rs` rather than shared with it, so
//! that the buy tests stay byte-for-byte what they were before sells existed.
//! As there, token accounts are written directly in the fixed SPL layout, and
//! the stock is the **real mainnet AAPLx mint** (or Backpack's PFE, for the
//! six-decimal case), so the gate reads genuine issuer state.
//!
//! Every expected amount below comes from `sell_min_out`, which restates the
//! program's round-up pricing in plain Rust. A few are also pinned to numbers
//! worked out by hand, so that the helper and the program cannot drift
//! together unnoticed.

use {
    anchor_lang::{
        prelude::Pubkey,
        solana_program::{bpf_loader_upgradeable, instruction::Instruction, system_program},
        AccountDeserialize, AnchorDeserialize, Discriminator, InstructionData, ToAccountMetas,
    },
    anchor_lang::solana_program::clock::Clock,
    bell_session::{
        constants::{AUTH_SEED, CHECK_SEED, MARK_SEED, NIGHT_SEED, ORDER_SEED, RISK_SEED, SELL_SEED, SYMBOL_LEN, SYMBOL_SEED},
        error::BellError,
        state::{BellOrder, HaltState, HoursMode, MarkSource, SellOrder, SellOrderFilled},
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
/// What the user holds on the stock side before any test sells from it.
const USER_STOCK: u64 = 1_000_000_000;
/// What the filler holds on the quote side: $10,000.
const FILLER_QUOTE: u64 = 10_000_000_000;

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
    /// The ticker this context registers its stock under.
    sym: [u8; SYMBOL_LEN],
    attestor: Keypair,
    user: Keypair,
    filler: Keypair,
    /// The program's upgrade authority, as `Ctx::with_stock` records it.
    authority: Keypair,
    /// The second signer named by the symbol's check.
    checker: Keypair,
}

impl Ctx {
    /// The Apple xStock, eight decimals.
    fn new() -> Self {
        Self::with_stock(AAPLX, include_bytes!("fixtures/aaplx.bin"), "AAPLx")
    }

    /// Any real Token-2022 stock mint, installed at its mainnet address.
    fn with_stock(address: &str, fixture: &[u8], ticker: &str) -> Self {
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

        let stock_mint: Pubkey = address.parse().unwrap();
        svm.set_account(
            stock_mint,
            Account { lamports: 1_000_000_000, data: fixture.to_vec(), owner: token_2022(), executable: false, rent_epoch: 0 },
        )
        .unwrap();

        let mut sym = [b' '; SYMBOL_LEN];
        sym[..ticker.len()].copy_from_slice(ticker.as_bytes());

        Self { svm, payer, program_id, quote_mint, stock_mint, sym, attestor, user, filler, authority, checker }
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
    fn sym_pda(&self) -> Pubkey { self.pda(&[SYMBOL_SEED, &self.sym]) }
    fn risk_pda(&self) -> Pubkey { self.pda(&[RISK_SEED, self.stock_mint.as_ref()]) }
    fn mark_pda(&self) -> Pubkey { self.pda(&[MARK_SEED, &self.sym]) }
    fn check_pda(&self) -> Pubkey { self.pda(&[CHECK_SEED, &self.sym]) }
    fn night_pda(&self) -> Pubkey { self.pda(&[NIGHT_SEED, self.user.pubkey().as_ref()]) }
    fn program_data(&self) -> Pubkey {
        Pubkey::find_program_address(&[self.program_id.as_ref()], &bpf_loader_upgradeable::ID).0
    }
    fn auth_pda(&self) -> Pubkey { self.pda(&[AUTH_SEED, self.user.pubkey().as_ref()]) }
    fn sell_pda(&self, nonce: u64) -> Pubkey {
        self.pda(&[SELL_SEED, self.user.pubkey().as_ref(), &nonce.to_le_bytes()])
    }
    fn buy_pda(&self, nonce: u64) -> Pubkey {
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

    /// Replace an account with what a closed one reads as: no lamports, no
    /// data, owned by the system program.
    fn close_account(&mut self, key: Pubkey) {
        self.svm
            .set_account(key, Account { lamports: 0, data: vec![], owner: system_program::ID, executable: false, rent_epoch: 0 })
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

    /// The sell order, or `None` once it has been closed.
    fn sell_order(&self, nonce: u64) -> Option<SellOrder> {
        self.svm
            .get_account(&self.sell_pda(nonce))
            .filter(|a| !a.data.is_empty())
            .map(|a| SellOrder::try_deserialize(&mut &a.data[..]).unwrap())
    }

    fn buy_order(&self, nonce: u64) -> Option<BellOrder> {
        self.svm
            .get_account(&self.buy_pda(nonce))
            .filter(|a| !a.data.is_empty())
            .map(|a| BellOrder::try_deserialize(&mut &a.data[..]).unwrap())
    }
}

/// Registered, risk-read and attested open, with a mark and a check opened but
/// never pushed — so the mark's rate is still zero.
fn ready_unmarked(ctx: &mut Ctx) {
    let p = ctx.payer.pubkey();
    let a = ctx.attestor.pubkey();
    let (sp, rp, mp) = (ctx.sym_pda(), ctx.risk_pda(), ctx.mark_pda());
    let (sm, qm, sym) = (ctx.stock_mint, ctx.quote_mint, ctx.sym);

    ctx.send(&[Instruction::new_with_bytes(
        ctx.program_id,
        &bell_session::instruction::RegisterSymbol { symbol: sym, mint: sm, exchange_mic: *b"XNAS", hours_mode: HoursMode::TwentyFourFive, attestor: a }.data(),
        bell_session::accounts::RegisterSymbol { payer: p, symbol_state: sp, system_program: system_program::ID }.to_account_metas(None),
    )], &[]).unwrap();

    ctx.send(&[Instruction::new_with_bytes(
        ctx.program_id,
        &bell_session::instruction::InitTokenRisk { attestor: ctx.payer.pubkey() }.data(),
        bell_session::accounts::InitTokenRisk { payer: p, mint: sm, risk: rp, system_program: system_program::ID }.to_account_metas(None),
    )], &[]).unwrap();

    ctx.send(&[Instruction::new_with_bytes(
        ctx.program_id,
        &bell_session::instruction::OpenMark { symbol: sym, quote_mint: qm }.data(),
        bell_session::accounts::OpenMark { payer: p, symbol_state: sp, mark: mp, system_program: system_program::ID }.to_account_metas(None),
    )], &[]).unwrap();

    let (auth, cp, pd) = (ctx.authority.insecure_clone(), ctx.check_pda(), ctx.program_data());
    ctx.send(&[Instruction::new_with_bytes(
        ctx.program_id,
        &bell_session::instruction::OpenCheck { symbol: sym, checker: ctx.checker.pubkey() }.data(),
        bell_session::accounts::OpenCheck { payer: p, authority: auth.pubkey(), program_data: pd, symbol_state: sp, check: cp, system_program: system_program::ID }.to_account_metas(None),
    )], &[&auth]).unwrap();

    push_session(ctx, HaltState::None, true, NOW);
}

/// The baseline: everything above, marked at `rate`.
fn ready_at(ctx: &mut Ctx, rate: u128) {
    ready_unmarked(ctx);
    push_mark(ctx, rate, NOW);
}

fn ready(ctx: &mut Ctx) {
    ready_at(ctx, aapl_rate());
}

fn push_session(ctx: &mut Ctx, halt: HaltState, open_now: bool, observed_at: i64) {
    let a = ctx.attestor.pubkey();
    let (sp, sym) = (ctx.sym_pda(), ctx.sym);
    let att = ctx.attestor.insecure_clone();
    ctx.send(&[Instruction::new_with_bytes(
        ctx.program_id,
        &bell_session::instruction::PushSession { symbol: sym, halt, open_now, next_change_at: observed_at + 3600, observed_at }.data(),
        bell_session::accounts::PushSession { attestor: a, symbol_state: sp }.to_account_metas(None),
    )], &[&att]).unwrap();
}

/// Push the mark, and the checker's view alongside it: open, with the
/// reference at the same rate, so the checker agrees with every mark a test
/// pushes here.
fn push_mark(ctx: &mut Ctx, rate_q64: u128, observed_at: i64) {
    let a = ctx.attestor.pubkey();
    let (sp, mp, cp, sym) = (ctx.sym_pda(), ctx.mark_pda(), ctx.check_pda(), ctx.sym);
    let att = ctx.attestor.insecure_clone();
    let chk = ctx.checker.insecure_clone();
    ctx.send(&[
        Instruction::new_with_bytes(
            ctx.program_id,
            &bell_session::instruction::PushMark { symbol: sym, rate_q64, px_num: 33_400_000, px_expo: -5, conf_bps: 10, source: MarkSource::Backpack, observed_at }.data(),
            bell_session::accounts::PushMark { attestor: a, symbol_state: sp, mark: mp }.to_account_metas(None),
        ),
        Instruction::new_with_bytes(
            ctx.program_id,
            &bell_session::instruction::PushCheck { symbol: sym, open_now: true, ref_rate_q64: rate_q64, ref_px_num: 33_400_000, ref_px_expo: -5, ref_at: observed_at, observed_at }.data(),
            bell_session::accounts::PushCheck { checker: chk.pubkey(), check: cp }.to_account_metas(None),
        ),
    ], &[&att, &chk]).unwrap();
}

/// The same mark `test_queue.rs` uses: 299,401 stock raw per 1,000,000 quote
/// raw, Q64.64 — about $334 a share across 8 and 6 decimals.
fn aapl_rate() -> u128 {
    (299_401u128 << 64) / 1_000_000u128
}

// ------------------------------------------------ the program's pricing, restated
//
// Mirrors of `stock_to_quote_ceil`, `mul_shr64_ceil` and the band in
// `fill_sell_order`. Each rounds up, as the program does: every one of these
// is a minimum the seller is owed.

fn stock_to_quote_ceil(a: u64, rate: u128) -> u128 {
    let num = (a as u128) << 64;
    num / rate + u128::from(num % rate != 0)
}

fn mul_shr64_ceil(a: u128, q: u128) -> u128 {
    let p = a.checked_mul(q).unwrap();
    (p >> 64) + u128::from(p as u64 != 0)
}

/// Fair quote for `leg` stock raw at `rate`.
fn fair(leg: u64, rate: u128) -> u64 {
    stock_to_quote_ceil(leg, rate) as u64
}

/// The least quote a fill of `leg` may deliver.
fn sell_min_out(leg: u64, rate: u128, slip_bps: u16, floor: u128) -> u64 {
    let t = stock_to_quote_ceil(leg, rate) * (10_000 - slip_bps as u128);
    let by_band = t / 10_000 + u128::from(t % 10_000 != 0);
    by_band.max(mul_shr64_ceil(leg as u128, floor)) as u64
}

/// The quote value placement caps, rounded down as the program rounds it.
fn placement_value(amount_in: u64, rate: u128) -> u128 {
    ((amount_in as u128) << 64) / rate
}

// ------------------------------------------------------------------- legs

struct Legs { payer_in: Pubkey, payee_out: Pubkey, filler_in: Pubkey, filler_out: Pubkey }

/// The user's stock account delegated to their authority for `delegated`, an
/// empty quote account to be paid into, and the filler's two accounts.
fn fund(ctx: &mut Ctx, delegated: u64) -> Legs {
    let (u, f, auth) = (ctx.user.pubkey(), ctx.filler.pubkey(), ctx.auth_pda());
    let (qm, sm) = (ctx.quote_mint, ctx.stock_mint);
    let legs = Legs { payer_in: Pubkey::new_unique(), payee_out: Pubkey::new_unique(), filler_in: Pubkey::new_unique(), filler_out: Pubkey::new_unique() };
    ctx.set_token(legs.payer_in, &sm, &u, USER_STOCK, Some((&auth, delegated)), token_2022());
    ctx.set_token(legs.payee_out, &qm, &u, 0, None, TOKEN);
    ctx.set_token(legs.filler_in, &sm, &f, 0, None, token_2022());
    ctx.set_token(legs.filler_out, &qm, &f, FILLER_QUOTE, None, TOKEN);
    legs
}

/// An all-or-none sell: `min_fill_in` equal to `amount_in`.
fn place_sell(ctx: &mut Ctx, nonce: u64, legs: &Legs, amount_in: u64, slip_bps: u16, floor: u128, expires_at: i64) -> Result<(), String> {
    place_sell_min(ctx, nonce, legs, amount_in, amount_in, slip_bps, floor, expires_at)
}

#[allow(clippy::too_many_arguments)]
fn place_sell_min(ctx: &mut Ctx, nonce: u64, legs: &Legs, amount_in: u64, min_fill_in: u64, slip_bps: u16, floor: u128, expires_at: i64) -> Result<(), String> {
    let u = ctx.user.pubkey();
    let (sp, rp, mp, op, sym) = (ctx.sym_pda(), ctx.risk_pda(), ctx.mark_pda(), ctx.sell_pda(nonce), ctx.sym);
    let usr = ctx.user.insecure_clone();
    ctx.send(&[Instruction::new_with_bytes(
        ctx.program_id,
        &bell_session::instruction::PlaceSellOrder { symbol: sym, nonce, amount_in, min_fill_in, max_slip_bps: slip_bps, max_conf_bps: 50, floor_rate_q64: floor, not_before: 0, expires_at }.data(),
        bell_session::accounts::PlaceSellOrder { owner: u, symbol_state: sp, risk: rp, mark: mp, order: op, payer_in: legs.payer_in, payee_out: legs.payee_out, system_program: system_program::ID }.to_account_metas(None),
    )], &[&usr])
}

/// `fill_sell_order`'s seventeen accounts. `order` is a parameter so a test can
/// hand it an account of the wrong kind.
fn sell_fill_metas(ctx: &Ctx, order: Pubkey, legs: &Legs, quote_program: Pubkey, stock_program: Pubkey) -> Vec<anchor_lang::solana_program::instruction::AccountMeta> {
    bell_session::accounts::FillSellOrder {
        filler: ctx.filler.pubkey(),
        order,
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
        check: ctx.check_pda(),
        night: ctx.night_pda(),
    }
    .to_account_metas(None)
}

fn fill_sell(ctx: &mut Ctx, nonce: u64, legs: &Legs, amount_in_leg: u64, amount_out: u64) -> Result<(), String> {
    fill_sell_under(ctx, nonce, legs, amount_in_leg, amount_out, TOKEN, token_2022()).0
}

/// A sell fill naming its own token programs for the quote and stock legs,
/// with the transaction's logs.
fn fill_sell_under(ctx: &mut Ctx, nonce: u64, legs: &Legs, amount_in_leg: u64, amount_out: u64, quote_program: Pubkey, stock_program: Pubkey) -> (Result<(), String>, Vec<String>) {
    let metas = sell_fill_metas(ctx, ctx.sell_pda(nonce), legs, quote_program, stock_program);
    let flr = ctx.filler.insecure_clone();
    ctx.send_logged(&[Instruction::new_with_bytes(
        ctx.program_id,
        &bell_session::instruction::FillSellOrder { amount_in_leg, amount_out }.data(),
        metas,
    )], &[&flr])
}

/// Close a sell order as `signer`, who may or may not be its owner.
fn cancel_sell_as(ctx: &mut Ctx, nonce: u64, legs: &Legs, signer: &Keypair) -> Result<(), String> {
    let u = ctx.user.pubkey();
    let op = ctx.sell_pda(nonce);
    let s = signer.insecure_clone();
    ctx.send(&[Instruction::new_with_bytes(
        ctx.program_id,
        &bell_session::instruction::CancelSellOrder {}.data(),
        bell_session::accounts::CancelSellOrder { signer: s.pubkey(), owner: u, order: op, payer_in: legs.payer_in }.to_account_metas(None),
    )], &[&s])
}

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
const SELL_RS: &str = "programs/bell-session/src/instructions/sell.rs";

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

/// The one `SellOrderFilled` a successful fill emitted, found by its
/// discriminator among the transaction's data logs.
fn sell_event(logs: &[String]) -> SellOrderFilled {
    let mut found = logs
        .iter()
        .filter_map(|l| l.strip_prefix("Program data: "))
        .map(b64)
        .filter(|d| d.starts_with(SellOrderFilled::DISCRIMINATOR));
    let d = found.next().expect("no SellOrderFilled in the logs");
    assert!(found.next().is_none(), "more than one SellOrderFilled");
    SellOrderFilled::deserialize(&mut &d[SellOrderFilled::DISCRIMINATOR.len()..]).unwrap()
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
const MARK_STALE: u32 = code(BellError::MarkStale);
const PRICE_OUT_OF_BAND: u32 = code(BellError::PriceOutOfBand);
const ORDER_EXPIRED: u32 = code(BellError::OrderExpired);
const OVER_FILL: u32 = code(BellError::OverFill);
const FILL_TOO_SMALL: u32 = code(BellError::FillTooSmall);
const DELEGATION_MISSING: u32 = code(BellError::DelegationMissing);
const MINT_MISMATCH: u32 = code(BellError::MintMismatch);
const NOT_ORDER_OWNER: u32 = code(BellError::NotOrderOwner);
const AMOUNT_TOO_LARGE: u32 = code(BellError::AmountTooLarge);
const BAD_PARAMETERS: u32 = code(BellError::BadParameters);
const TOKEN_PROGRAM_MISMATCH: u32 = code(BellError::TokenProgramMismatch);
/// Anchor's own code for an account whose discriminator is not the type the
/// instruction expects — how a buy instruction refuses a sell order.
const DISCRIMINATOR_MISMATCH: u32 = anchor_lang::error::ErrorCode::AccountDiscriminatorMismatch as u32;

// --------------------------------------------------------------------- tests

#[test]
fn the_pricing_helpers_match_numbers_worked_by_hand() {
    // One AAPLx share at 299,401 stock raw per 1,000,000 quote raw is
    // 1e8 × 1e6 / 299,401 = 334,000,220.4 quote raw. The ceiling owes the
    // seller the fraction: 334,000,221.
    assert_eq!(fair(SHARE, aapl_rate()), 334_000_221);
    // 30bps below that is 332,998,220.37, which rounds up to 332,998,221.
    assert_eq!(sell_min_out(SHARE, aapl_rate(), 30, 0), 332_998_221);
    // A floor of exactly $334 a share, quote raw per stock raw: 3.34 in Q64.
    let floor = (334_000_000u128 << 64) / SHARE as u128;
    assert_eq!(mul_shr64_ceil(SHARE as u128, floor), 334_000_000);
}

#[test]
fn a_sell_order_is_placed_and_records_what_it_sells() {
    let mut ctx = Ctx::new();
    ready(&mut ctx);
    let legs = fund(&mut ctx, SHARE);
    place_sell(&mut ctx, 1, &legs, SHARE, 30, 0, NOW + 86_400).unwrap();

    let o = ctx.sell_order(1).unwrap();
    assert_eq!(o.owner, ctx.user.pubkey());
    assert_eq!(o.mint, ctx.stock_mint);
    assert_eq!(o.quote_mint, ctx.quote_mint);
    assert_eq!(o.payer_in, legs.payer_in, "the stock account carries the delegation");
    assert_eq!(o.payee_out, legs.payee_out, "the quote account is paid");
    assert_eq!(o.amount_in, SHARE);
    assert_eq!(o.filled_in, 0);
    // Snapshotted from the real Apple mint, not assumed.
    assert!(f64::from_bits(o.expected_multiplier_bits) > 1.0);
    // Nothing moved at placement: the stock is still in the user's wallet.
    assert_eq!(ctx.balance(&legs.payer_in), USER_STOCK);
}

#[test]
fn a_due_sell_fills_while_the_market_is_open() {
    let mut ctx = Ctx::new();
    ready(&mut ctx);
    let legs = fund(&mut ctx, SHARE);
    place_sell(&mut ctx, 1, &legs, SHARE, 30, 0, NOW + 86_400).unwrap();

    let u = ctx.user.pubkey();
    let rent_before = ctx.lamports(&u);
    let pay = sell_min_out(SHARE, aapl_rate(), 30, 0);
    let (r, logs) = fill_sell_under(&mut ctx, 1, &legs, SHARE, pay, TOKEN, token_2022());
    r.unwrap();

    assert_eq!(ctx.balance(&legs.payee_out), pay, "user was paid");
    assert_eq!(ctx.balance(&legs.filler_in), SHARE, "filler received the stock");
    assert_eq!(ctx.balance(&legs.payer_in), USER_STOCK - SHARE, "only the order amount moved");
    assert_eq!(ctx.balance(&legs.filler_out), FILLER_QUOTE - pay);
    assert!(ctx.sell_order(1).is_none(), "a complete order is closed");
    assert!(ctx.lamports(&u) > rent_before, "rent returns to the owner");

    // Quote delivered first, under SPL Token; stock taken second, under
    // Token-2022 — the reverse of a buy.
    assert_eq!(
        calls(&logs),
        [
            format!("Program {} invoke [1]", ctx.program_id),
            format!("Program {} invoke [2]", TOKEN),
            format!("Program {} invoke [2]", token_2022()),
        ],
    );

    // The event carries the measured amounts, and at the band edge the
    // realised cost never reads above the band the user signed for.
    let e = sell_event(&logs);
    assert_eq!(e.owner, u);
    assert_eq!(e.filler, ctx.filler.pubkey());
    assert_eq!(e.symbol, ctx.sym);
    assert_eq!(e.amount_in, SHARE);
    assert_eq!(e.amount_out, pay);
    assert_eq!(e.mark_observed_at, NOW);
    assert_eq!(e.realized_bps, 30);
}

#[test]
fn a_sell_below_the_band_is_refused_and_moves_nothing() {
    let mut ctx = Ctx::new();
    ready(&mut ctx);
    let legs = fund(&mut ctx, SHARE);
    place_sell(&mut ctx, 1, &legs, SHARE, 30, 0, NOW + 86_400).unwrap();

    let min = sell_min_out(SHARE, aapl_rate(), 30, 0);
    assert_code(fill_sell(&mut ctx, 1, &legs, SHARE, min - 1), PRICE_OUT_OF_BAND, "one quote unit under the band edge");
    assert_eq!(ctx.balance(&legs.payer_in), USER_STOCK, "stock untouched");
    assert_eq!(ctx.delegated(&legs.payer_in), SHARE, "delegation untouched");
    assert_eq!(ctx.balance(&legs.payee_out), 0, "the short payment was rolled back");
    assert_eq!(ctx.balance(&legs.filler_out), FILLER_QUOTE);
    assert_eq!(ctx.sell_order(1).unwrap().filled_in, 0);

    // At the edge exactly, it fills.
    fill_sell(&mut ctx, 1, &legs, SHARE, min).unwrap();
}

#[test]
fn the_sellers_own_floor_overrides_a_generous_band() {
    // The user will take no less than $334 a share whatever the band allows.
    let mut ctx = Ctx::new();
    ready(&mut ctx);
    let legs = fund(&mut ctx, SHARE);
    let floor = (334_000_000u128 << 64) / SHARE as u128;
    place_sell(&mut ctx, 1, &legs, SHARE, 500, floor, NOW + 86_400).unwrap();

    let by_band = sell_min_out(SHARE, aapl_rate(), 500, 0);
    let by_floor = sell_min_out(SHARE, aapl_rate(), 500, floor);
    assert_eq!((by_band, by_floor), (317_300_210, 334_000_000), "the floor binds, not the band");

    assert_code(fill_sell(&mut ctx, 1, &legs, SHARE, by_band), PRICE_OUT_OF_BAND, "the band would allow it, the floor does not");
    assert_code(fill_sell(&mut ctx, 1, &legs, SHARE, by_floor - 1), PRICE_OUT_OF_BAND, "one unit under the floor");
    assert_eq!(ctx.balance(&legs.payer_in), USER_STOCK, "stock untouched");
    assert_eq!(ctx.balance(&legs.payee_out), 0);

    fill_sell(&mut ctx, 1, &legs, SHARE, by_floor).unwrap();
    assert_eq!(ctx.balance(&legs.payee_out), by_floor);
}

#[test]
fn overfill_and_undersized_sell_fills_are_refused() {
    let mut ctx = Ctx::new();
    ready(&mut ctx);
    let legs = fund(&mut ctx, SHARE);
    place_sell_min(&mut ctx, 1, &legs, SHARE, SHARE / 4, 30, 0, NOW + 86_400).unwrap();

    let rate = aapl_rate();
    assert_code(fill_sell(&mut ctx, 1, &legs, SHARE + 1, sell_min_out(SHARE + 1, rate, 30, 0)), OVER_FILL, "one raw past the order");
    assert_code(fill_sell(&mut ctx, 1, &legs, SHARE / 4 - 1, sell_min_out(SHARE / 4 - 1, rate, 30, 0)), FILL_TOO_SMALL, "one raw under min_fill_in");
    assert_eq!(ctx.balance(&legs.payer_in), USER_STOCK);
    assert_eq!(ctx.balance(&legs.payee_out), 0);
    assert_eq!(ctx.sell_order(1).unwrap().filled_in, 0);
}

#[test]
fn a_partial_sell_leaves_the_delegation_equal_to_the_remainder() {
    let mut ctx = Ctx::new();
    ready(&mut ctx);
    let legs = fund(&mut ctx, SHARE);
    place_sell_min(&mut ctx, 1, &legs, SHARE, SHARE / 4, 30, 0, NOW + 86_400).unwrap();

    let rate = aapl_rate();
    let (first, rest) = (SHARE * 2 / 5, SHARE * 3 / 5);
    let pay_first = sell_min_out(first, rate, 30, 0);
    fill_sell(&mut ctx, 1, &legs, first, pay_first).unwrap();

    let o = ctx.sell_order(1).expect("a partly filled order stays open");
    assert_eq!(o.filled_in, first);
    assert_eq!(o.amount_in, SHARE, "a fill records progress; it does not resize the order");
    assert_eq!(ctx.balance(&legs.payer_in), USER_STOCK - first, "exactly the leg was taken");
    assert_eq!(ctx.balance(&legs.payee_out), pay_first);

    // Token-2022 draws the delegation down by what it moved, leaving exactly
    // the remainder: the order still reads as funded, so a stranger still
    // cannot collect it.
    assert_eq!(ctx.delegated(&legs.payer_in), rest);
    let flr = ctx.filler.insecure_clone();
    assert_code(cancel_sell_as(&mut ctx, 1, &legs, &flr), NOT_ORDER_OWNER, "partly filled, remainder still delegated");

    // One raw past the remainder is an overfill; the remainder itself closes it.
    assert_code(fill_sell(&mut ctx, 1, &legs, rest + 1, sell_min_out(rest + 1, rate, 30, 0)), OVER_FILL, "past what remains");
    let pay_rest = sell_min_out(rest, rate, 30, 0);
    fill_sell(&mut ctx, 1, &legs, rest, pay_rest).unwrap();
    assert!(ctx.sell_order(1).is_none(), "completed and closed");
    assert_eq!(ctx.balance(&legs.payer_in), USER_STOCK - SHARE);
    assert_eq!(ctx.balance(&legs.payee_out), pay_first + pay_rest);
    // Two ceilings can owe one unit more than one ceiling over the whole; the
    // seller is never owed less for having been filled in pieces.
    assert!(pay_first + pay_rest >= sell_min_out(SHARE, rate, 30, 0));
}

#[test]
fn fill_sell_order_refuses_a_leg_program_that_is_not_a_token_program() {
    // The stock leg's program is called with the delegate authority's
    // signature, so a filler-chosen callee there must be refused before it is
    // ever called. The quote leg is refused the same way for symmetry. Both
    // must fire from the up-front check in sell.rs, not from the ownership
    // check inside `balance_of`, and before any cross-program call.
    let mut ctx = Ctx::new();
    ready(&mut ctx);
    let legs = fund(&mut ctx, SHARE);
    place_sell(&mut ctx, 1, &legs, SHARE, 30, 0, NOW + 86_400).unwrap();

    let pay = sell_min_out(SHARE, aapl_rate(), 30, 0);
    let only_bell = vec![format!("Program {} invoke [1]", ctx.program_id)];
    for (quote, stock, which) in [(memo(), token_2022(), "quote leg under Memo"), (TOKEN, memo(), "stock leg under Memo")] {
        let (r, logs) = fill_sell_under(&mut ctx, 1, &legs, SHARE, pay, quote, stock);
        assert_code(r, TOKEN_PROGRAM_MISMATCH, which);
        assert_eq!(thrown_in(&logs), Some(SELL_RS), "{which}: refused up front in fill_sell_order");
        assert_eq!(calls(&logs), only_bell, "{which}: a cross-program call was made before the refusal");
    }
    assert_eq!(ctx.balance(&legs.payer_in), USER_STOCK);
    assert_eq!(ctx.balance(&legs.payee_out), 0);

    // Named correctly, the same fill goes through.
    fill_sell(&mut ctx, 1, &legs, SHARE, pay).unwrap();
}

#[test]
fn the_value_cap_is_a_quote_amount_and_binds_at_exactly_1000_dollars() {
    // `MAX_ORDER_IN` is $1,000 of quote. At this mark 299,401,000 raw of AAPLx
    // — 2.99401 shares — is worth exactly that, and one raw more is worth
    // $1,000.000003.
    let mut ctx = Ctx::new();
    ready(&mut ctx);
    let at_cap = 299_401_000u64;
    assert_eq!(placement_value(at_cap, aapl_rate()), 1_000_000_000);
    assert_eq!(placement_value(at_cap + 1, aapl_rate()), 1_000_000_003);

    let legs = fund(&mut ctx, at_cap + 1);
    assert_code(place_sell(&mut ctx, 1, &legs, at_cap + 1, 30, 0, NOW + 86_400), AMOUNT_TOO_LARGE, "one raw over $1,000");
    assert!(ctx.sell_order(1).is_none());
    place_sell(&mut ctx, 1, &legs, at_cap, 30, 0, NOW + 86_400).unwrap();

    // The raw count alone is not what is capped: 1e9 raw passes a buy's
    // bound, and as stock it is ten shares, over $3,000.
    let legs = fund(&mut ctx, 1_000_000_000);
    assert_code(place_sell(&mut ctx, 2, &legs, 1_000_000_000, 30, 0, NOW + 86_400), AMOUNT_TOO_LARGE, "ten shares");
    assert_code(place_sell(&mut ctx, 2, &legs, 0, 30, 0, NOW + 86_400), AMOUNT_TOO_LARGE, "nothing");
}

#[test]
fn a_floor_that_would_overflow_at_fill_is_refused_at_placement() {
    let mut ctx = Ctx::new();
    ready(&mut ctx);
    let legs = fund(&mut ctx, SHARE);
    // SHARE × floor exceeds u128 by one step: every fill of the full order
    // would refuse with MathOverflow, so the order is refused now instead.
    let floor = u128::MAX / SHARE as u128 + 1;
    assert_code(place_sell(&mut ctx, 1, &legs, SHARE, 30, floor, NOW + 86_400), BAD_PARAMETERS, "floor overflows amount_in × floor");
    place_sell(&mut ctx, 1, &legs, SHARE, 30, floor - 1, NOW + 86_400).unwrap();
}

#[test]
fn a_mark_that_was_never_pushed_refuses_the_sell() {
    // A freshly opened mark carries a zero rate. A sell's value cap divides by
    // it, so there is nothing to size the order against.
    let mut ctx = Ctx::new();
    ready_unmarked(&mut ctx);
    let legs = fund(&mut ctx, SHARE);
    assert_code(place_sell(&mut ctx, 1, &legs, SHARE, 30, 0, NOW + 86_400), MARK_STALE, "rate is still zero");
    assert!(ctx.sell_order(1).is_none());

    push_mark(&mut ctx, aapl_rate(), NOW);
    place_sell(&mut ctx, 1, &legs, SHARE, 30, 0, NOW + 86_400).unwrap();
}

#[test]
fn a_sell_cannot_be_placed_without_a_stock_delegation() {
    let mut ctx = Ctx::new();
    ready(&mut ctx);
    let legs = fund(&mut ctx, SHARE);
    let (u, auth, other, sm, qm) = (ctx.user.pubkey(), ctx.auth_pda(), Pubkey::new_unique(), ctx.stock_mint, ctx.quote_mint);

    ctx.set_token(legs.payer_in, &sm, &u, USER_STOCK, None, token_2022());
    assert_code(place_sell(&mut ctx, 1, &legs, SHARE, 30, 0, NOW + 86_400), DELEGATION_MISSING, "stock account delegates to nobody");
    ctx.set_token(legs.payer_in, &sm, &u, USER_STOCK, Some((&other, SHARE)), token_2022());
    assert_code(place_sell(&mut ctx, 1, &legs, SHARE, 30, 0, NOW + 86_400), DELEGATION_MISSING, "delegated to someone else");
    ctx.set_token(legs.payer_in, &sm, &u, USER_STOCK, Some((&auth, SHARE - 1)), token_2022());
    assert_code(place_sell(&mut ctx, 1, &legs, SHARE, 30, 0, NOW + 86_400), DELEGATION_MISSING, "delegated one raw short");

    // A buy's delegation — the quote account approved, handed in as the
    // stock — is the wrong asset, whatever it is delegated for.
    let swapped = Legs { payer_in: legs.payee_out, payee_out: legs.payer_in, filler_in: legs.filler_in, filler_out: legs.filler_out };
    ctx.set_token(swapped.payer_in, &qm, &u, 10_000_000_000, Some((&auth, SHARE)), TOKEN);
    assert_code(place_sell(&mut ctx, 1, &swapped, SHARE, 30, 0, NOW + 86_400), MINT_MISMATCH, "a quote account offered as the stock");
    assert!(ctx.sell_order(1).is_none(), "no attempt created an order");

    ctx.set_token(legs.payee_out, &qm, &u, 0, None, TOKEN);
    ctx.set_token(legs.payer_in, &sm, &u, USER_STOCK, Some((&auth, SHARE)), token_2022());
    place_sell(&mut ctx, 1, &legs, SHARE, 30, 0, NOW + 86_400).unwrap();
}

#[test]
fn a_buy_and_a_sell_with_the_same_nonce_are_different_orders() {
    // One wallet, one quote account and one stock account, each delegated to
    // the same authority: the quote for a buy, the stock for a sell. The two
    // orders share a nonce and still live at different addresses.
    let mut ctx = Ctx::new();
    ready(&mut ctx);
    let sell = fund(&mut ctx, SHARE);
    let (u, auth, qm) = (ctx.user.pubkey(), ctx.auth_pda(), ctx.quote_mint);
    ctx.set_token(sell.payee_out, &qm, &u, 10_000_000, Some((&auth, 1_000_000)), TOKEN);
    let buy = Legs { payer_in: sell.payee_out, payee_out: sell.payer_in, filler_in: Pubkey::new_unique(), filler_out: Pubkey::new_unique() };
    let (f, sm) = (ctx.filler.pubkey(), ctx.stock_mint);
    ctx.set_token(buy.filler_in, &qm, &f, 0, None, TOKEN);
    ctx.set_token(buy.filler_out, &sm, &f, USER_STOCK, None, token_2022());

    let usr = ctx.user.insecure_clone();
    let (sp, rp, mp, bp) = (ctx.sym_pda(), ctx.risk_pda(), ctx.mark_pda(), ctx.buy_pda(7));
    ctx.send(&[Instruction::new_with_bytes(
        ctx.program_id,
        &bell_session::instruction::PlaceOrder { symbol: ctx.sym, nonce: 7, amount_in: 1_000_000, min_fill_in: 1_000_000, max_slip_bps: 30, max_conf_bps: 50, floor_rate_q64: 0, not_before: 0, expires_at: NOW + 86_400 }.data(),
        bell_session::accounts::PlaceOrder { owner: u, symbol_state: sp, risk: rp, mark: mp, order: bp, payer_in: buy.payer_in, payee_out: buy.payee_out, system_program: system_program::ID }.to_account_metas(None),
    )], &[&usr]).unwrap();
    place_sell(&mut ctx, 7, &sell, SHARE, 30, 0, NOW + 86_400).unwrap();
    assert_ne!(ctx.buy_pda(7), ctx.sell_pda(7));
    assert!(ctx.buy_order(7).is_some() && ctx.sell_order(7).is_some());

    // `fill_order` handed the sell order refuses it on the discriminator,
    // before any of its own checks run, and nothing moves.
    let flr = ctx.filler.insecure_clone();
    let buy_metas = |ctx: &Ctx, order: Pubkey| {
        bell_session::accounts::FillOrder {
            filler: ctx.filler.pubkey(), order, symbol_state: ctx.sym_pda(), risk: ctx.risk_pda(), mark: ctx.mark_pda(),
            auth: ctx.auth_pda(), owner: ctx.user.pubkey(), payer_in: buy.payer_in, payee_out: buy.payee_out,
            filler_in: buy.filler_in, filler_out: buy.filler_out, quote_mint: ctx.quote_mint, stock_mint: ctx.stock_mint,
            quote_token_program: TOKEN, stock_token_program: token_2022(),
            check: ctx.check_pda(), night: ctx.night_pda(),
        }
        .to_account_metas(None)
    };
    let buy_fill = |ctx: &Ctx, order: Pubkey| {
        Instruction::new_with_bytes(ctx.program_id, &bell_session::instruction::FillOrder { amount_in_leg: 1_000_000, amount_out: 299_401 }.data(), buy_metas(ctx, order))
    };
    let ix = buy_fill(&ctx, ctx.sell_pda(7));
    assert_code(ctx.send(&[ix], &[&flr]), DISCRIMINATOR_MISMATCH, "fill_order given a SellOrder");

    // And the other way round.
    let metas = sell_fill_metas(&ctx, ctx.buy_pda(7), &sell, TOKEN, token_2022());
    let ix = Instruction::new_with_bytes(ctx.program_id, &bell_session::instruction::FillSellOrder { amount_in_leg: SHARE, amount_out: sell_min_out(SHARE, aapl_rate(), 30, 0) }.data(), metas);
    assert_code(ctx.send(&[ix], &[&flr]), DISCRIMINATOR_MISMATCH, "fill_sell_order given a BellOrder");
    assert_eq!(ctx.balance(&sell.payer_in), USER_STOCK);
    assert_eq!(ctx.balance(&buy.payer_in), 10_000_000);

    // Each through its own instruction, both fill; neither touches the
    // other's delegation.
    let ix = buy_fill(&ctx, ctx.buy_pda(7));
    ctx.send(&[ix], &[&flr]).unwrap();
    assert_eq!(ctx.delegated(&sell.payer_in), SHARE, "the buy left the sell's delegation alone");
    let pay = sell_min_out(SHARE, aapl_rate(), 30, 0);
    fill_sell(&mut ctx, 7, &sell, SHARE, pay).unwrap();
    assert!(ctx.buy_order(7).is_none() && ctx.sell_order(7).is_none());
    // Bought 299,401 raw into the stock account, sold a share out of it.
    assert_eq!(ctx.balance(&sell.payer_in), USER_STOCK + 299_401 - SHARE);
    // Paid $1 out of the quote account, and was paid for the share into it.
    assert_eq!(ctx.balance(&buy.payer_in), 10_000_000 - 1_000_000 + pay);
}

#[test]
fn a_stranger_may_close_an_expired_or_defunded_sell() {
    let mut ctx = Ctx::new();
    ready(&mut ctx);
    let (u, sm) = (ctx.user.pubkey(), ctx.stock_mint);
    let flr = ctx.filler.insecure_clone();

    // Live and fully delegated: only the owner may close it.
    let live = fund(&mut ctx, SHARE);
    place_sell(&mut ctx, 1, &live, SHARE, 30, 0, NOW + 86_400).unwrap();
    assert_code(cancel_sell_as(&mut ctx, 1, &live, &flr), NOT_ORDER_OWNER, "live, fully delegated, and not the owner");
    assert!(ctx.sell_order(1).is_some());

    // Revoked: dead weight, so anyone may reclaim the rent — for the owner.
    ctx.set_token(live.payer_in, &sm, &u, USER_STOCK, None, token_2022());
    let before = ctx.lamports(&u);
    cancel_sell_as(&mut ctx, 1, &live, &flr).unwrap();
    assert!(ctx.sell_order(1).is_none());
    assert!(ctx.lamports(&u) > before, "rent returns to the owner");

    // Stock account closed outright while the order is live: it no longer
    // reads as a token account at all, which is as defunded as it gets.
    let closed = fund(&mut ctx, SHARE);
    place_sell(&mut ctx, 2, &closed, SHARE, 30, 0, NOW + 86_400).unwrap();
    ctx.close_account(closed.payer_in);
    cancel_sell_as(&mut ctx, 2, &closed, &flr).unwrap();
    assert!(ctx.sell_order(2).is_none());

    // Expired and still fully delegated: anyone may close it, without the
    // stock account being consulted at all.
    let expiring = fund(&mut ctx, SHARE);
    place_sell(&mut ctx, 3, &expiring, SHARE, 30, 0, NOW + 600).unwrap();
    assert_code(cancel_sell_as(&mut ctx, 3, &expiring, &flr), NOT_ORDER_OWNER, "not yet expired");
    ctx.warp(NOW + 600);
    cancel_sell_as(&mut ctx, 3, &expiring, &flr).unwrap();
    assert!(ctx.sell_order(3).is_none());

    // And the owner can always close their own, live and funded.
    let own = fund(&mut ctx, SHARE);
    place_sell(&mut ctx, 4, &own, SHARE, 30, 0, NOW + 86_400).unwrap();
    let usr = ctx.user.insecure_clone();
    cancel_sell_as(&mut ctx, 4, &own, &usr).unwrap();
    assert!(ctx.sell_order(4).is_none());
}

#[test]
fn the_sell_fill_runs_the_same_gate_and_freshness_checks() {
    let mut ctx = Ctx::new();
    ready(&mut ctx);
    let legs = fund(&mut ctx, SHARE);
    place_sell(&mut ctx, 1, &legs, SHARE, 30, 0, NOW + 3_000).unwrap();
    let pay = sell_min_out(SHARE, aapl_rate(), 30, 0);

    // Strict: a closed session refuses, with no halt in play.
    push_session(&mut ctx, HaltState::None, false, NOW);
    assert_code(fill_sell(&mut ctx, 1, &legs, SHARE, pay), MARKET_CLOSED, "session closed");
    push_session(&mut ctx, HaltState::Luld, true, NOW);
    assert_code(fill_sell(&mut ctx, 1, &legs, SHARE, pay), MARKET_CLOSED, "LULD pause in an open session");
    push_session(&mut ctx, HaltState::None, true, NOW);

    // A minute and a second later the mark is stale, with everything else fresh.
    ctx.warp(NOW + 61);
    push_session(&mut ctx, HaltState::None, true, NOW + 61);
    assert_code(fill_sell(&mut ctx, 1, &legs, SHARE, pay), MARK_STALE, "mark is 61s old");

    // Past expiry, checked before the gate.
    ctx.warp(NOW + 3_000);
    push_session(&mut ctx, HaltState::None, true, NOW + 3_000);
    push_mark(&mut ctx, aapl_rate(), NOW + 3_000);
    assert_code(fill_sell(&mut ctx, 1, &legs, SHARE, pay), ORDER_EXPIRED, "order lapsed");
    assert_eq!(ctx.balance(&legs.payer_in), USER_STOCK);
    assert_eq!(ctx.balance(&legs.payee_out), 0);
}

#[test]
fn a_six_decimal_stock_sells_at_the_same_rounding() {
    // Backpack's PFE carries 6 decimals, the same as the quote, so a share is
    // 1,000,000 raw on both sides of the mark. At $25 the rate is 1/25, and
    // Q64 truncation leaves it a hair under that — which makes ten shares
    // worth a hair over $250, and the ceiling owes the seller the whole unit.
    let mut ctx = Ctx::with_stock(PFE_BACKPACK, include_bytes!("fixtures/pfe_backpack.bin"), "PFE");
    let rate = (1u128 << 64) / 25;
    ready_at(&mut ctx, rate);
    let ten = 10_000_000u64;
    assert_eq!(fair(ten, rate), 250_000_001);
    let min = sell_min_out(ten, rate, 30, 0);
    assert_eq!(min, 249_250_001, "250,000,001 × 0.997 = 249,250,000.997, rounded up");

    let legs = fund(&mut ctx, ten);
    place_sell(&mut ctx, 1, &legs, ten, 30, 0, NOW + 86_400).unwrap();
    assert!((f64::from_bits(ctx.sell_order(1).unwrap().expected_multiplier_bits) - 1.0).abs() < f64::EPSILON);

    assert_code(fill_sell(&mut ctx, 1, &legs, ten, min - 1), PRICE_OUT_OF_BAND, "one unit under, where rounding down would have let it through");
    fill_sell(&mut ctx, 1, &legs, ten, min).unwrap();
    assert_eq!(ctx.balance(&legs.payee_out), min);
    assert_eq!(ctx.balance(&legs.filler_in), ten);
    assert_eq!(ctx.balance(&legs.payer_in), USER_STOCK - ten);
}

#[test]
fn a_stock_under_a_hundred_dollars_prices_through_a_rate_above_one() {
    // An 8-decimal stock at $25 is four stock raw per quote raw: a rate above
    // 2^64, the case `stock_to_quote_ceil` is written as a quotient and a
    // remainder for. One share is worth exactly $25 here, with no remainder.
    let mut ctx = Ctx::new();
    let rate = 4u128 << 64;
    ready_at(&mut ctx, rate);
    assert_eq!(fair(SHARE, rate), 25_000_000);
    let min = sell_min_out(SHARE, rate, 30, 0);
    assert_eq!(min, 24_925_000);

    let legs = fund(&mut ctx, SHARE);
    place_sell(&mut ctx, 1, &legs, SHARE, 30, 0, NOW + 86_400).unwrap();
    assert_code(fill_sell(&mut ctx, 1, &legs, SHARE, min - 1), PRICE_OUT_OF_BAND, "one unit under");
    fill_sell(&mut ctx, 1, &legs, SHARE, min).unwrap();
    assert_eq!(ctx.balance(&legs.payee_out), min);
}

#[test]
fn a_filler_aiming_the_stock_at_the_users_own_account_pays_for_nothing() {
    // `filler_in` is the filler's own business, so nothing stops a filler
    // naming the user's stock account as its destination. The take is then a
    // transfer from that account to itself: the token program validates it
    // and moves nothing, and — because the account is its own destination —
    // leaves the delegation where it was. The program requires only that the
    // user lost no more than the leg (`taken <= leg`), which holds at zero.
    //
    // The outcome is the filler's loss alone: the user is paid in full and
    // keeps the stock. The order is recorded as filled and closes. What it
    // leaves behind is the user's approval on the stock account, still
    // standing; nothing can use it, because the only instructions that sign as
    // the authority take from an account a live order pins, and none pins
    // this one now. The client's revoke clears it like any other.
    let mut ctx = Ctx::new();
    ready(&mut ctx);
    let legs = fund(&mut ctx, SHARE);
    place_sell(&mut ctx, 1, &legs, SHARE, 30, 0, NOW + 86_400).unwrap();

    let pay = sell_min_out(SHARE, aapl_rate(), 30, 0);
    let aimed = Legs { payer_in: legs.payer_in, payee_out: legs.payee_out, filler_in: legs.payer_in, filler_out: legs.filler_out };
    fill_sell(&mut ctx, 1, &aimed, SHARE, pay).unwrap();

    assert_eq!(ctx.balance(&legs.payee_out), pay, "the user was paid");
    assert_eq!(ctx.balance(&legs.payer_in), USER_STOCK, "and kept every share");
    assert_eq!(ctx.balance(&legs.filler_out), FILLER_QUOTE - pay, "the filler paid");
    assert_eq!(ctx.balance(&legs.filler_in), 0, "and received nothing");
    assert_eq!(ctx.delegated(&legs.payer_in), SHARE, "a self-transfer does not draw the delegation down");
    assert!(ctx.sell_order(1).is_none(), "the order is recorded as filled and closed");
}

#[test]
fn neither_cancel_closes_the_other_kind_of_order() {
    // A stranger's route around the defunded rule would be to hand a live,
    // funded order to the other side's cancel, whose rule reads a different
    // account. Each cancel refuses the other's order on the discriminator, so
    // no such route exists, and both orders survive every attempt.
    let mut ctx = Ctx::new();
    ready(&mut ctx);
    let sell = fund(&mut ctx, SHARE);
    let (u, auth, qm) = (ctx.user.pubkey(), ctx.auth_pda(), ctx.quote_mint);
    ctx.set_token(sell.payee_out, &qm, &u, 10_000_000, Some((&auth, 1_000_000)), TOKEN);
    let usr = ctx.user.insecure_clone();
    let (sp, rp, mp, bp) = (ctx.sym_pda(), ctx.risk_pda(), ctx.mark_pda(), ctx.buy_pda(3));
    ctx.send(&[Instruction::new_with_bytes(
        ctx.program_id,
        &bell_session::instruction::PlaceOrder { symbol: ctx.sym, nonce: 3, amount_in: 1_000_000, min_fill_in: 1_000_000, max_slip_bps: 30, max_conf_bps: 50, floor_rate_q64: 0, not_before: 0, expires_at: NOW + 86_400 }.data(),
        bell_session::accounts::PlaceOrder { owner: u, symbol_state: sp, risk: rp, mark: mp, order: bp, payer_in: sell.payee_out, payee_out: sell.payer_in, system_program: system_program::ID }.to_account_metas(None),
    )], &[&usr]).unwrap();
    place_sell(&mut ctx, 3, &sell, SHARE, 30, 0, NOW + 86_400).unwrap();

    let flr = ctx.filler.insecure_clone();
    // The sell order handed to `cancel_order`, with an account that is not a
    // token account at all as its `payer_in`, which that rule would count as
    // defunded if it ever got that far.
    let unreadable = Pubkey::new_unique();
    let ix = Instruction::new_with_bytes(
        ctx.program_id,
        &bell_session::instruction::CancelOrder {}.data(),
        bell_session::accounts::CancelOrder { signer: flr.pubkey(), owner: u, order: ctx.sell_pda(3), payer_in: unreadable }.to_account_metas(None),
    );
    assert_code(ctx.send(&[ix], &[&flr]), DISCRIMINATOR_MISMATCH, "cancel_order given a SellOrder");
    let ix = Instruction::new_with_bytes(
        ctx.program_id,
        &bell_session::instruction::CancelSellOrder {}.data(),
        bell_session::accounts::CancelSellOrder { signer: flr.pubkey(), owner: u, order: ctx.buy_pda(3), payer_in: unreadable }.to_account_metas(None),
    );
    assert_code(ctx.send(&[ix], &[&flr]), DISCRIMINATOR_MISMATCH, "cancel_sell_order given a BellOrder");

    // Nor can the right cancel be pointed at a substitute account that would
    // read as defunded: `payer_in` is pinned to the order, so the substitute
    // is refused before the rule runs.
    let ix = Instruction::new_with_bytes(
        ctx.program_id,
        &bell_session::instruction::CancelSellOrder {}.data(),
        bell_session::accounts::CancelSellOrder { signer: flr.pubkey(), owner: u, order: ctx.sell_pda(3), payer_in: unreadable }.to_account_metas(None),
    );
    assert_code(ctx.send(&[ix], &[&flr]), anchor_lang::error::ErrorCode::ConstraintAddress as u32, "a sell's payer_in is pinned");
    assert!(ctx.buy_order(3).is_some() && ctx.sell_order(3).is_some());
}
