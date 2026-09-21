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
        self.svm.send_transaction(tx).map(|_| ()).map_err(|e| format!("{:?}", e.err))
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
        &bell_session::instruction::InitTokenRisk {}.data(),
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

fn accounts_for_fill(ctx: &Ctx, nonce: u64, payer_in: Pubkey, payee_out: Pubkey, filler_in: Pubkey, filler_out: Pubkey) -> Vec<anchor_lang::solana_program::instruction::AccountMeta> {
    bell_session::accounts::FillOrder {
        filler: ctx.filler.pubkey(),
        order: ctx.order_pda(nonce),
        symbol_state: ctx.sym_pda(),
        risk: ctx.risk_pda(),
        mark: ctx.mark_pda(),
        auth: ctx.auth_pda(),
        owner: ctx.user.pubkey(),
        payer_in,
        payee_out,
        filler_in,
        filler_out,
        quote_mint: ctx.quote_mint,
        stock_mint: ctx.stock_mint,
        quote_token_program: TOKEN,
        stock_token_program: token_2022(),
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

#[allow(clippy::too_many_arguments)]
fn place(ctx: &mut Ctx, nonce: u64, legs: &Legs, amount_in: u64, slip_bps: u16, floor: u128, expires_at: i64) -> Result<(), String> {
    let u = ctx.user.pubkey();
    let (sp, rp, mp, op) = (ctx.sym_pda(), ctx.risk_pda(), ctx.mark_pda(), ctx.order_pda(nonce));
    let usr = ctx.user.insecure_clone();
    ctx.send(&[Instruction::new_with_bytes(
        ctx.program_id,
        &bell_session::instruction::PlaceOrder { symbol: sym(), nonce, amount_in, min_fill_in: amount_in, max_slip_bps: slip_bps, max_conf_bps: 50, floor_rate_q64: floor, not_before: 0, expires_at }.data(),
        bell_session::accounts::PlaceOrder { owner: u, symbol_state: sp, risk: rp, mark: mp, order: op, payer_in: legs.payer_in, payee_out: legs.payee_out, system_program: system_program::ID }.to_account_metas(None),
    )], &[&usr])
}

fn fill(ctx: &mut Ctx, nonce: u64, legs: &Legs, amount_in_leg: u64, amount_out: u64) -> Result<(), String> {
    let metas = accounts_for_fill(ctx, nonce, legs.payer_in, legs.payee_out, legs.filler_in, legs.filler_out);
    let flr = ctx.filler.insecure_clone();
    ctx.send(&[Instruction::new_with_bytes(
        ctx.program_id,
        &bell_session::instruction::FillOrder { amount_in_leg, amount_out }.data(),
        metas,
    )], &[&flr])
}

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
    assert!(place(&mut ctx, 1, &legs, 1_000_000, 30, 0, NOW + 86_400).is_err());
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

    let u = ctx.user.pubkey();
    let op = ctx.order_pda(1);
    let usr = ctx.user.insecure_clone();
    ctx.send(&[Instruction::new_with_bytes(
        ctx.program_id,
        &bell_session::instruction::CancelOrder {}.data(),
        bell_session::accounts::CancelOrder { signer: u, owner: u, order: op, payer_in: legs.payer_in }.to_account_metas(None),
    )], &[&usr]).unwrap();
    assert!(ctx.svm.get_account(&op).map(|a| a.data.is_empty()).unwrap_or(true));
}

#[test]
fn a_stranger_cannot_close_a_live_funded_order() {
    let mut ctx = Ctx::new();
    ready(&mut ctx);
    let legs = fund(&mut ctx, 1_000_000);
    place(&mut ctx, 1, &legs, 1_000_000, 30, 0, NOW + 86_400).unwrap();

    let (u, f) = (ctx.user.pubkey(), ctx.filler.pubkey());
    let op = ctx.order_pda(1);
    let flr = ctx.filler.insecure_clone();
    let r = ctx.send(&[Instruction::new_with_bytes(
        ctx.program_id,
        &bell_session::instruction::CancelOrder {}.data(),
        bell_session::accounts::CancelOrder { signer: f, owner: u, order: op, payer_in: legs.payer_in }.to_account_metas(None),
    )], &[&flr]);
    assert!(r.is_err());
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

    let (u, f, qm) = (ctx.user.pubkey(), ctx.filler.pubkey(), ctx.quote_mint);
    ctx.set_token(legs.payer_in, &qm, &u, 10_000_000, None, TOKEN); // revoked

    let before = ctx.svm.get_account(&u).unwrap().lamports;
    let op = ctx.order_pda(1);
    let flr = ctx.filler.insecure_clone();
    ctx.send(&[Instruction::new_with_bytes(
        ctx.program_id,
        &bell_session::instruction::CancelOrder {}.data(),
        bell_session::accounts::CancelOrder { signer: f, owner: u, order: op, payer_in: legs.payer_in }.to_account_metas(None),
    )], &[&flr]).unwrap();
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

    // 30bps band on 299,401 leaves a floor of 298,502.
    let err = fill(&mut ctx, 1, &legs, 1_000_000, 290_000).unwrap_err();
    assert!(err.contains("Custom"), "got {err}");
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
    assert!(fill(&mut ctx, 1, &legs, 1_000_000, 299_401).is_err());
    assert_eq!(ctx.balance(&legs.payer_in), 10_000_000);
}

#[test]
fn a_halt_refuses_the_fill() {
    let mut ctx = Ctx::new();
    ready(&mut ctx);
    let legs = fund(&mut ctx, 1_000_000);
    place(&mut ctx, 1, &legs, 1_000_000, 30, 0, NOW + 86_400).unwrap();

    push_session(&mut ctx, HaltState::Luld, true, NOW);
    assert!(fill(&mut ctx, 1, &legs, 1_000_000, 299_401).is_err());
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
    assert!(fill(&mut ctx, 1, &legs, 1_000_000, 299_401).is_err(), "mark is an hour old");

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
    assert!(fill(&mut ctx, 1, &legs, 1_000_000, 299_401).is_err());
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
    assert!(fill(&mut ctx, 1, &legs, 1_000_000, 290_000).is_err(), "band would allow it, floor does not");
    fill(&mut ctx, 1, &legs, 1_000_000, 299_401).unwrap();
}
