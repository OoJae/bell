//! Ondo Global Markets mints against the deployed `bell-session` build.
//!
//! Proof before listing: nothing is added to the allowlist until the program
//! that is already on devnet (`target/deploy/bell_session.so`, not a rebuild)
//! has been shown to read each Ondo mint as it exists on mainnet today.
//!
//! The five fixtures are **real mainnet accounts**, byte for byte, pulled with
//! `getAccountInfo` on 2026-09-24. Ondo's extension set is not Backed's: it adds
//! `DefaultAccountState`, `ConfidentialTransferMint`, `MetadataPointer` and an
//! on-mint `TokenMetadata` entry whose length varies with the token's name, and
//! it has no `PermanentDelegate`. Its multipliers are written with the new value
//! already in force (`multiplier == newMultiplier`, the timestamp in the past),
//! which is the one way to rebase that gives the gate no advance notice.
//!
//! Where a gate needs issuer state no fixture carries — a pause, an armed hook —
//! the test changes that one field inside the real Ondo bytes, exactly as
//! `test_gates.rs` does for Backed, and leaves every other byte as Ondo wrote it.
//! The helpers are copied from there rather than shared, so each test binary
//! stands on its own.

use {
    anchor_lang::{
        prelude::Pubkey,
        solana_program::{clock::Clock, instruction::Instruction, system_program},
        AccountDeserialize, InstructionData, ToAccountMetas,
    },
    bell_session::{
        constants::{REBASE_GUARD_SECONDS, RISK_SEED, SYMBOL_LEN, SYMBOL_SEED},
        error::BellError,
        instructions::assert_tradeable::Mode,
        state::{HaltState, HoursMode, RebaseKind, TokenRisk},
    },
    litesvm::LiteSVM,
    solana_account::Account,
    solana_keypair::Keypair,
    solana_message::{Message, VersionedMessage},
    solana_signer::Signer,
    solana_transaction::versioned::VersionedTransaction,
    spl_token_2022::{
        extension::{
            default_account_state::DefaultAccountState, pausable::PausableConfig,
            scaled_ui_amount::ScaledUiAmountConfig, transfer_hook::TransferHook, AccountType,
            BaseStateWithExtensions, ExtensionType, StateWithExtensions,
        },
        state::{Account as SplAccount, AccountState, Mint as SplMint, PackedSizeOf},
    },
    std::{
        mem::{offset_of, size_of},
        ops::Range,
    },
};

/// anchor-lang and spl-token-2022 use different `Pubkey` types; bridge by bytes.
fn token_2022() -> Pubkey {
    Pubkey::new_from_array(spl_token_2022::ID.to_bytes())
}

/// Late September 2026, after every Ondo activation in the fixtures and more
/// than `REBASE_GUARD_SECONDS` clear of all of them, so the baseline is a mint
/// with nothing pending. The same instant `test_gates.rs` pins.
const NOW: i64 = 1_790_000_000;

/// Ondo's freeze authority and its mint/extension authority, the same on all five.
const FREEZE_AUTHORITY: &str = "51QVCuHfL1FeNjd8BDeffCKhCcAYoULnVB3yjNhShiuK";
const ONDO_AUTHORITY: &str = "9foMHsSDq7nMg4WPusSz9eY7tyxyukqborA8GyU5cUxD";

/// One real Ondo mint and what mainnet's own parser said about it when the
/// fixture was pulled. The multiplier is the decimal string `jsonParsed`
/// printed, which round-trips to the exact f64 the mint stores.
struct OndoMint {
    symbol: &'static str,
    address: &'static str,
    fixture: &'static [u8],
    multiplier: f64,
    effective_at: i64,
}

const ONDO: [OndoMint; 5] = [
    OndoMint {
        symbol: "SPYon",
        address: "k18WJUULWheRkSpSquYGdNNmtuE2Vbw1hpuUi92ondo",
        fixture: include_bytes!("fixtures/spy_ondo.bin"),
        multiplier: 1.0094730727840426,
        effective_at: 1_789_754_055,
    },
    OndoMint {
        symbol: "QQQon",
        address: "HrYNm6jTQ71LoFphjVKBTdAE4uja7WsmLG8VxB8ondo",
        fixture: include_bytes!("fixtures/qqq_ondo.bin"),
        multiplier: 1.0040824301802083,
        effective_at: 1_789_949_045,
    },
    OndoMint {
        symbol: "AAPLon",
        address: "123mYEnRLM2LLYsJW3K6oyYh8uP1fngj732iG638ondo",
        fixture: include_bytes!("fixtures/aapl_ondo.bin"),
        multiplier: 1.003376073740221,
        effective_at: 1_789_754_055,
    },
    OndoMint {
        symbol: "NVDAon",
        address: "gEGtLTPNQ7jcg25zTetkbmF7teoDLcrfTnQfmn2ondo",
        fixture: include_bytes!("fixtures/nvda_ondo.bin"),
        multiplier: 1.0017152487959897,
        effective_at: 1_788_998_645,
    },
    OndoMint {
        symbol: "TSLAon",
        address: "KeGv7bsfR4MheC1CkmnAVceoApjrkvBhHYjWb67ondo",
        fixture: include_bytes!("fixtures/tsla_ondo.bin"),
        // Tesla pays no dividend, yet its entry carries the same instant as
        // SPY's and Apple's: written in the same batch, at 1.0.
        multiplier: 1.0,
        effective_at: 1_789_754_055,
    },
];

fn program_bytes() -> &'static [u8] {
    include_bytes!(concat!(
        env!("CARGO_TARGET_TMPDIR"),
        "/../deploy/bell_session.so"
    ))
}

struct Ctx {
    svm: LiteSVM,
    payer: Keypair,
    program_id: Pubkey,
}

impl Ctx {
    fn new() -> Self {
        Self::at(NOW)
    }

    fn at(now: i64) -> Self {
        let program_id = bell_session::id();
        let mut svm = LiteSVM::new();
        svm.add_program(program_id, program_bytes()).unwrap();
        let mut clock: Clock = svm.get_sysvar();
        clock.unix_timestamp = now;
        svm.set_sysvar(&clock);
        let payer = Keypair::new();
        svm.airdrop(&payer.pubkey(), 10_000_000_000).unwrap();
        Self { svm, payer, program_id }
    }

    fn install_mint(&mut self, address: &str, fixture: &[u8]) -> Pubkey {
        let key: Pubkey = address.parse().unwrap();
        self.svm
            .set_account(
                key,
                Account {
                    lamports: 1_000_000_000,
                    data: fixture.to_vec(),
                    owner: token_2022(),
                    executable: false,
                    rent_epoch: 0,
                },
            )
            .unwrap();
        key
    }

    fn send(&mut self, ix: Instruction, extra: &[&Keypair]) -> Result<(), String> {
        self.svm.expire_blockhash();
        let blockhash = self.svm.latest_blockhash();
        let msg = Message::new_with_blockhash(&[ix], Some(&self.payer.pubkey()), &blockhash);
        let mut signers: Vec<&Keypair> = vec![&self.payer];
        signers.extend_from_slice(extra);
        let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), &signers).unwrap();
        self.svm
            .send_transaction(tx)
            .map(|_| ())
            .map_err(|e| format!("{:?}", e.err))
    }

    fn warp(&mut self, to: i64) {
        let mut c: Clock = self.svm.get_sysvar();
        c.unix_timestamp = to;
        self.svm.set_sysvar(&c);
    }

    fn now(&self) -> i64 {
        self.svm.get_sysvar::<Clock>().unix_timestamp
    }

    fn risk_pda(&self, mint: &Pubkey) -> Pubkey {
        Pubkey::find_program_address(&[RISK_SEED, mint.as_ref()], &self.program_id).0
    }

    fn symbol_pda(&self, symbol: &[u8; SYMBOL_LEN]) -> Pubkey {
        Pubkey::find_program_address(&[SYMBOL_SEED, symbol.as_ref()], &self.program_id).0
    }

    fn read_risk(&self, mint: &Pubkey) -> TokenRisk {
        let acc = self.svm.get_account(&self.risk_pda(mint)).unwrap();
        TokenRisk::try_deserialize(&mut &acc.data[..]).unwrap()
    }
}

fn sym(s: &str) -> [u8; SYMBOL_LEN] {
    let mut out = [b' '; SYMBOL_LEN];
    out[..s.len()].copy_from_slice(s.as_bytes());
    out
}

const fn code(e: BellError) -> u32 {
    anchor_lang::error::ERROR_CODE_OFFSET + e as u32
}
const MARKET_CLOSED: u32 = code(BellError::MarketClosed);
const ISSUER_PAUSED: u32 = code(BellError::IssuerPaused);
const REBASE_PENDING: u32 = code(BellError::RebasePending);
const MULTIPLIER_MOVED: u32 = code(BellError::MultiplierMoved);
const HOOK_ARMED: u32 = code(BellError::HookArmed);

fn assert_code(r: Result<(), String>, code: u32, why: &str) {
    match r {
        Ok(()) => panic!("expected Custom({code}) — {why} — but it passed"),
        Err(e) => assert!(e.contains(&format!("Custom({code})")), "expected Custom({code}) — {why} — got {e}"),
    }
}

fn ix_init_risk(ctx: &Ctx, mint: Pubkey) -> Instruction {
    Instruction::new_with_bytes(
        ctx.program_id,
        &bell_session::instruction::InitTokenRisk { attestor: ctx.payer.pubkey() }.data(),
        bell_session::accounts::InitTokenRisk {
            payer: ctx.payer.pubkey(),
            mint,
            risk: ctx.risk_pda(&mint),
            system_program: system_program::ID,
        }
        .to_account_metas(None),
    )
}

fn ix_refresh(ctx: &Ctx, mint: Pubkey) -> Instruction {
    Instruction::new_with_bytes(
        ctx.program_id,
        &bell_session::instruction::RefreshTokenRisk {}.data(),
        bell_session::accounts::RefreshTokenRisk { mint, risk: ctx.risk_pda(&mint) }.to_account_metas(None),
    )
}

fn ix_register(ctx: &Ctx, symbol: [u8; SYMBOL_LEN], mint: Pubkey, attestor: Pubkey) -> Instruction {
    Instruction::new_with_bytes(
        ctx.program_id,
        &bell_session::instruction::RegisterSymbol {
            symbol,
            mint,
            exchange_mic: *b"XNAS",
            hours_mode: HoursMode::MarketHours,
            attestor,
        }
        .data(),
        bell_session::accounts::RegisterSymbol {
            payer: ctx.payer.pubkey(),
            symbol_state: ctx.symbol_pda(&symbol),
            system_program: system_program::ID,
        }
        .to_account_metas(None),
    )
}

fn ix_push(ctx: &Ctx, symbol: [u8; SYMBOL_LEN], attestor: Pubkey, halt: HaltState, open_now: bool, observed_at: i64) -> Instruction {
    Instruction::new_with_bytes(
        ctx.program_id,
        &bell_session::instruction::PushSession {
            symbol,
            halt,
            open_now,
            next_change_at: observed_at + 3_600,
            observed_at,
        }
        .data(),
        bell_session::accounts::PushSession { attestor, symbol_state: ctx.symbol_pda(&symbol) }.to_account_metas(None),
    )
}

fn ix_assert(ctx: &Ctx, symbol: [u8; SYMBOL_LEN], mint: Pubkey, mode: Mode, expected_multiplier_bits: u64) -> Instruction {
    Instruction::new_with_bytes(
        ctx.program_id,
        &bell_session::instruction::AssertTradeable { symbol, mode, expected_multiplier_bits }.data(),
        bell_session::accounts::AssertTradeable {
            symbol_state: ctx.symbol_pda(&symbol),
            risk: ctx.risk_pda(&mint),
        }
        .to_account_metas(None),
    )
}

/// Registered, risk-verified and attested open, on one real Ondo mint.
fn open_market(ctx: &mut Ctx, m: &OndoMint) -> ([u8; SYMBOL_LEN], Pubkey, Keypair, u64) {
    let symbol = sym(m.symbol);
    let mint = ctx.install_mint(m.address, m.fixture);
    let attestor = Keypair::new();
    ctx.svm.airdrop(&attestor.pubkey(), 1_000_000_000).unwrap();
    ctx.send(ix_init_risk(ctx, mint), &[]).unwrap();
    ctx.send(ix_register(ctx, symbol, mint, attestor.pubkey()), &[]).unwrap();
    let now = ctx.now();
    ctx.send(ix_push(ctx, symbol, attestor.pubkey(), HaltState::None, true, now), &[&attestor]).unwrap();
    let bits = ctx.read_risk(&mint).multiplier_bits;
    (symbol, mint, attestor, bits)
}

// ------------------------------------------------ the fixtures are what we say

#[test]
fn the_fixtures_carry_ondos_extension_set_and_no_permanent_delegate() {
    // Pinned so that a re-pulled fixture with a different shape fails here,
    // loudly, rather than quietly changing what the tests below prove.
    let want = [
        ExtensionType::ScaledUiAmount,
        ExtensionType::MetadataPointer,
        ExtensionType::Pausable,
        ExtensionType::DefaultAccountState,
        ExtensionType::ConfidentialTransferMint,
        ExtensionType::TransferHook,
        ExtensionType::TokenMetadata,
    ];
    let freeze: Pubkey = FREEZE_AUTHORITY.parse().unwrap();
    let authority: Pubkey = ONDO_AUTHORITY.parse().unwrap();
    for m in &ONDO {
        let mint = StateWithExtensions::<SplMint>::unpack(m.fixture).unwrap();
        assert_eq!(mint.get_extension_types().unwrap(), want, "{} extension set", m.symbol);
        assert!(mint.get_extension::<spl_token_2022::extension::permanent_delegate::PermanentDelegate>().is_err(),
            "{} should have no permanent delegate", m.symbol);
        assert_eq!(mint.base.decimals, 9, "{} decimals", m.symbol);
        // `COption` of the other crate's Pubkey, compared by bytes so neither
        // type has to be named (the same bridge `tokens.rs` uses).
        let fa = mint.base.freeze_authority;
        assert!(fa.is_some() && fa.unwrap().to_bytes() == freeze.to_bytes(), "{} freeze authority", m.symbol);
        let ma = mint.base.mint_authority;
        assert!(ma.is_some() && ma.unwrap().to_bytes() == authority.to_bytes(), "{} mint authority", m.symbol);
        let das = mint.get_extension::<DefaultAccountState>().unwrap();
        assert_eq!(das.state, AccountState::Initialized as u8, "{} default account state", m.symbol);

        // The multiplier is written already in force: the outgoing and incoming
        // values are equal and the instant is in the past. See the rebase test.
        let s = mint.get_extension::<ScaledUiAmountConfig>().unwrap();
        assert_eq!(f64::from(s.multiplier), m.multiplier, "{} multiplier", m.symbol);
        assert_eq!(f64::from(s.new_multiplier), m.multiplier, "{} new_multiplier", m.symbol);
        assert_eq!(i64::from(s.new_multiplier_effective_timestamp), m.effective_at, "{} timestamp", m.symbol);
    }
}

// ------------------------------------------------------------- mint parsing

#[test]
fn init_and_refresh_read_every_real_ondo_mint() {
    let mut ctx = Ctx::new();
    for m in &ONDO {
        let mint = ctx.install_mint(m.address, m.fixture);
        ctx.send(ix_init_risk(&ctx, mint), &[]).unwrap_or_else(|e| panic!("init_token_risk refused {}: {e}", m.symbol));
        let risk = ctx.read_risk(&mint);
        assert_eq!(risk.mint, mint);
        assert!(!risk.paused, "{} is not paused on mainnet", m.symbol);
        assert_eq!(f64::from_bits(risk.multiplier_bits), m.multiplier, "{} multiplier", m.symbol);
        // Already in force, so nothing is pending and nothing needs classifying,
        // but the instant is kept: gate 4 measures its window from it.
        assert_eq!(risk.pending_multiplier_bits, 0, "{} pending", m.symbol);
        assert_eq!(risk.activates_at, m.effective_at, "{} activation instant", m.symbol);
        assert_eq!(risk.rebase_kind, RebaseKind::None);
        // The transfer-hook slot is present and empty, as on Backed's mints.
        assert!(risk.hook.is_none(), "{} hook", m.symbol);
        // Unlike Backed's, no issuer key can move a holder's tokens.
        assert!(risk.permanent_delegate.is_none(), "{} permanent delegate", m.symbol);
        assert_eq!(risk.verified_at, NOW);

        // The permissionless re-read the keeper sends every tick, a minute on.
        ctx.warp(NOW + 60);
        ctx.send(ix_refresh(&ctx, mint), &[]).unwrap_or_else(|e| panic!("refresh_token_risk refused {}: {e}", m.symbol));
        let again = ctx.read_risk(&mint);
        assert_eq!(again.verified_at, NOW + 60);
        assert_eq!(again.multiplier_bits, risk.multiplier_bits);
        assert_eq!(again.activates_at, risk.activates_at);
        assert!(!again.paused && again.hook.is_none() && again.permanent_delegate.is_none());
        ctx.warp(NOW);
    }
}

// ----------------------------------------------------------------- the gate

#[test]
fn an_open_ondo_market_passes_and_a_closed_one_does_not() {
    for m in &ONDO {
        let mut ctx = Ctx::new();
        let (symbol, mint, attestor, bits) = open_market(&mut ctx, m);
        ctx.send(ix_assert(&ctx, symbol, mint, Mode::Strict, bits), &[])
            .unwrap_or_else(|e| panic!("{} open and unpaused should pass: {e}", m.symbol));

        // Closed session, same as an xStock: strict refuses, guarded proceeds.
        let now = ctx.now();
        ctx.send(ix_push(&ctx, symbol, attestor.pubkey(), HaltState::None, false, now), &[&attestor]).unwrap();
        assert_code(ctx.send(ix_assert(&ctx, symbol, mint, Mode::Strict, bits), &[]), MARKET_CLOSED, m.symbol);
        ctx.send(ix_assert(&ctx, symbol, mint, Mode::Guarded, bits), &[]).unwrap();
    }
}

#[test]
fn an_order_built_on_another_multiplier_is_refused() {
    // TSLAon's multiplier is exactly 1.0, so an order built at 1.0 is right
    // for it; the other four have accrued dividends and it is wrong for them.
    for m in ONDO.iter().filter(|m| m.multiplier != 1.0) {
        let mut ctx = Ctx::new();
        let (symbol, mint, _a, _bits) = open_market(&mut ctx, m);
        assert_code(
            ctx.send(ix_assert(&ctx, symbol, mint, Mode::Strict, 1.0f64.to_bits()), &[]),
            MULTIPLIER_MOVED,
            m.symbol,
        );
    }
}

// ----------------------------- issuer powers, armed on Ondo's own bytes

/// The byte range of one extension's value inside a Token-2022 mint, found by
/// walking the TLV entries. Copied from `test_gates.rs`. Walking matters more
/// here than there: Ondo's entries are ordered differently from Backed's and
/// end in a variable-length `TokenMetadata`, so no offset taken from a Backed
/// mint would land on the same field.
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

fn paused(fixture: &[u8]) -> Vec<u8> {
    let mut data = fixture.to_vec();
    let v = extension_value(&data, ExtensionType::Pausable);
    assert_eq!(v.len(), size_of::<PausableConfig>());
    let flag = v.start + offset_of!(PausableConfig, paused);
    assert_eq!(data[flag], 0, "fixture should ship unpaused");
    data[flag] = 1;
    let mint = StateWithExtensions::<SplMint>::unpack(&data).unwrap();
    assert!(bool::from(mint.get_extension::<PausableConfig>().unwrap().paused));
    data
}

fn with_hook(fixture: &[u8], program: &Pubkey) -> Vec<u8> {
    let mut data = fixture.to_vec();
    let v = extension_value(&data, ExtensionType::TransferHook);
    assert_eq!(v.len(), size_of::<TransferHook>());
    let key = program.to_bytes();
    let slot = v.start + offset_of!(TransferHook, program_id);
    assert_eq!(data[slot..slot + key.len()], [0u8; 32], "fixture's hook slot should ship empty");
    data[slot..slot + key.len()].copy_from_slice(&key);
    let mint = StateWithExtensions::<SplMint>::unpack(&data).unwrap();
    assert_eq!(mint.get_extension::<TransferHook>().unwrap().program_id.0.to_bytes(), key);
    data
}

#[test]
fn ondo_places_pausable_where_backed_does_not() {
    // Keeps the walk above honest: if the layouts ever converge, this says so.
    let backed = &include_bytes!("fixtures/aaplx.bin")[..];
    for m in &ONDO {
        assert_ne!(
            extension_value(m.fixture, ExtensionType::Pausable).start,
            extension_value(backed, ExtensionType::Pausable).start,
            "{} should place Pausable differently from AAPLx",
            m.symbol
        );
    }
}

#[test]
fn an_ondo_pause_stops_the_trade() {
    // Gate 3, on each Ondo mint, seen by nothing but a re-read of the mint.
    for m in &ONDO {
        let mut ctx = Ctx::new();
        let (symbol, mint, _a, bits) = open_market(&mut ctx, m);
        ctx.install_mint(m.address, &paused(m.fixture));
        ctx.send(ix_refresh(&ctx, mint), &[]).unwrap();
        assert!(ctx.read_risk(&mint).paused, "{} refresh read the pause", m.symbol);
        assert_code(ctx.send(ix_assert(&ctx, symbol, mint, Mode::Guarded, bits), &[]), ISSUER_PAUSED, m.symbol);

        // Unpaused and re-read, it trades again: the flag was the reason.
        ctx.install_mint(m.address, m.fixture);
        ctx.send(ix_refresh(&ctx, mint), &[]).unwrap();
        ctx.send(ix_assert(&ctx, symbol, mint, Mode::Guarded, bits), &[]).unwrap();
    }
}

#[test]
fn an_armed_ondo_transfer_hook_stops_the_trade() {
    // Gate 6. Ondo ships the hook slot with no program, as Backed does.
    for m in &ONDO {
        let mut ctx = Ctx::new();
        let (symbol, mint, _a, bits) = open_market(&mut ctx, m);
        let hook_program = Pubkey::new_unique();
        ctx.install_mint(m.address, &with_hook(m.fixture, &hook_program));
        ctx.send(ix_refresh(&ctx, mint), &[]).unwrap();
        assert_eq!(ctx.read_risk(&mint).hook, Some(hook_program), "{}", m.symbol);
        assert_code(ctx.send(ix_assert(&ctx, symbol, mint, Mode::Guarded, bits), &[]), HOOK_ARMED, m.symbol);

        ctx.install_mint(m.address, m.fixture);
        ctx.send(ix_refresh(&ctx, mint), &[]).unwrap();
        assert_eq!(ctx.read_risk(&mint).hook, None);
        ctx.send(ix_assert(&ctx, symbol, mint, Mode::Guarded, bits), &[]).unwrap();
    }
}

// ------------------------------------------- Ondo's rebases give no notice

#[test]
fn an_ondo_multiplier_step_is_refused_only_after_it_lands() {
    // What the fixtures show about Ondo's multipliers: on all five,
    // `multiplier == new_multiplier` with the instant in the past. Token-2022
    // copies the new value into `multiplier` only when the write's instant has
    // already arrived, so for SPYon, AAPLon and the rest (values that moved,
    // unlike TSLAon's 1.0) the step was written to take effect at once. The
    // fixtures cannot say whether Ondo announced it anywhere else first; on the
    // mint, there was nothing to see before it landed. So gate 4 has no window
    // before the step and gate 4b nothing to classify. After it, the program
    // keeps the instant and refuses for REBASE_GUARD_SECONDS — the half of the
    // window in which a dividend's stale-low pool is drained.
    //
    // This is the case NOTICE.md item z already names: an issuer can make a
    // change take effect immediately. Gate 5 is what still protects a parked
    // order, because it was built on the old multiplier.
    //
    // First: an entry whose incoming and outgoing values are equal schedules
    // nothing, even read before its instant (TSLAon's no-op rewrite would look
    // like this if it had been dated ahead). Then the refusal after it.
    let m = &ONDO[0]; // SPYon
    let t = m.effective_at;

    let mut ctx = Ctx::at(t - 1);
    let (symbol, mint, attestor, bits) = open_market(&mut ctx, m);
    let r = ctx.read_risk(&mint);
    assert_eq!(r.activates_at, 0, "incoming == outgoing before the instant: nothing scheduled");
    assert_eq!(r.pending_multiplier_bits, 0);
    ctx.send(ix_assert(&ctx, symbol, mint, Mode::Strict, bits), &[]).unwrap();

    // A minute after: the keeper's next refresh sees the instant, and the
    // post-activation half of the window refuses.
    ctx.warp(t + 60);
    ctx.send(ix_push(&ctx, symbol, attestor.pubkey(), HaltState::None, true, t + 60), &[&attestor]).unwrap();
    ctx.send(ix_refresh(&ctx, mint), &[]).unwrap();
    assert_eq!(ctx.read_risk(&mint).activates_at, t);
    assert_code(ctx.send(ix_assert(&ctx, symbol, mint, Mode::Strict, bits), &[]), REBASE_PENDING, "SPYon, T+60");

    // Clear of the window, it trades again.
    let after = t + REBASE_GUARD_SECONDS + 1;
    ctx.warp(after);
    ctx.send(ix_push(&ctx, symbol, attestor.pubkey(), HaltState::None, true, after), &[&attestor]).unwrap();
    ctx.send(ix_refresh(&ctx, mint), &[]).unwrap();
    ctx.send(ix_assert(&ctx, symbol, mint, Mode::Strict, bits), &[]).unwrap();
}
