//! Gate tests for `bell-session`.
//!
//! The mint fixtures in `tests/fixtures/` are **real mainnet accounts**, byte
//! for byte, pulled with `getAccountInfo`. Testing extension parsing against a
//! synthetic mint would only prove we can read a mint we built ourselves; these
//! prove we read Apple, Netflix, SPY and a Backpack entitlement as they
//! actually exist on chain today. Where a gate needs issuer state that no
//! fixture carries today — a pause, an armed hook — the test changes that one
//! field inside a real mint rather than building a mint of its own.

use {
    anchor_lang::{
        prelude::Pubkey,
        solana_program::{instruction::Instruction, system_program},
        AccountDeserialize, InstructionData, ToAccountMetas,
    },
    bell_session::{
        constants::{RISK_SEED, SYMBOL_SEED, SYMBOL_LEN},
        error::BellError,
        instructions::assert_tradeable::Mode,
        state::{HaltState, HoursMode, RebaseKind, SymbolState, TokenRisk},
    },
    anchor_lang::solana_program::clock::Clock,
    litesvm::LiteSVM,
    solana_account::Account,
    solana_keypair::Keypair,
    solana_message::{Message, VersionedMessage},
    solana_signer::Signer,
    solana_transaction::versioned::VersionedTransaction,
    spl_token_2022::{
        extension::{
            pausable::PausableConfig, transfer_hook::TransferHook, AccountType,
            BaseStateWithExtensions, ExtensionType, StateWithExtensions,
        },
        state::{Account as SplAccount, Mint as SplMint, PackedSizeOf},
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

/// A fixed, plausible "now" (late September 2026) so tests are deterministic.
const NOW: i64 = 1_790_000_000;

// Real mainnet mints matching the fixtures.
const AAPLX: &str = "XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp";
const NFLXX: &str = "XsEH7wWfJJu2ZT3UCFeVfALnVA6CP5ur7Ee11KmzVpL";
const PFE_BACKPACK: &str = "PFER6ENqP8r8NF3CqVt4mFowxsin3V5MLidBNQFCC3x";

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
        let program_id = bell_session::id();
        let mut svm = LiteSVM::new();
        svm.add_program(program_id, program_bytes()).unwrap();
        // The test ledger starts near genesis, which would make every real
        // activation timestamp look like it is still in the future. Pin the
        // clock to a plausible present so the fixtures are read the way mainnet
        // reads them.
        let mut clock: Clock = svm.get_sysvar();
        clock.unix_timestamp = NOW;
        svm.set_sysvar(&clock);

        let payer = Keypair::new();
        svm.airdrop(&payer.pubkey(), 10_000_000_000).unwrap();
        Self { svm, payer, program_id }
    }

    /// Drop a mint account into the test ledger at its real address, owned by
    /// Token-2022. The bytes are a mainnet fixture, unchanged unless a test has
    /// deliberately altered one field of it (see `paused` and `with_hook`).
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
        // A gate asked the same question twice, before and after the clock or
        // the record changes, is a byte-identical transaction; a fresh
        // blockhash keeps the runtime from rejecting it as a replay.
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
        self.svm.get_sysvar::<anchor_lang::solana_program::clock::Clock>().unix_timestamp
    }

    fn risk_pda(&self, mint: &Pubkey) -> Pubkey {
        Pubkey::find_program_address(&[RISK_SEED, mint.as_ref()], &self.program_id).0
    }

    fn symbol_pda(&self, symbol: &[u8; SYMBOL_LEN]) -> Pubkey {
        Pubkey::find_program_address(&[SYMBOL_SEED, symbol.as_ref()], &self.program_id).0
    }

    fn read_risk(&self, pda: &Pubkey) -> TokenRisk {
        let acc = self.svm.get_account(pda).unwrap();
        TokenRisk::try_deserialize(&mut &acc.data[..]).unwrap()
    }

    fn read_symbol(&self, pda: &Pubkey) -> SymbolState {
        let acc = self.svm.get_account(pda).unwrap();
        SymbolState::try_deserialize(&mut &acc.data[..]).unwrap()
    }
}

fn sym(s: &str) -> [u8; SYMBOL_LEN] {
    let mut out = [b' '; SYMBOL_LEN];
    out[..s.len()].copy_from_slice(s.as_bytes());
    out
}

/// Codes derived from the enum, never typed by hand: hand-typed codes were
/// off by one the first time, because counting variants by eye skipped one.
const fn code(e: BellError) -> u32 {
    anchor_lang::error::ERROR_CODE_OFFSET + e as u32
}
const MARKET_CLOSED: u32 = code(BellError::MarketClosed);
const STATE_STALE: u32 = code(BellError::StateStale);
const ISSUER_PAUSED: u32 = code(BellError::IssuerPaused);
const REBASE_PENDING: u32 = code(BellError::RebasePending);
const REBASE_UNCLASSIFIED: u32 = code(BellError::RebaseUnclassified);
const MULTIPLIER_MOVED: u32 = code(BellError::MultiplierMoved);
const HOOK_ARMED: u32 = code(BellError::HookArmed);
const NOT_TOKEN_2022: u32 = code(BellError::NotToken2022);
const NOT_ATTESTOR: u32 = code(BellError::NotAttestor);
const TIMESTAMP_IN_FUTURE: u32 = code(BellError::TimestampInFuture);
const RISK_STALE: u32 = code(BellError::RiskStale);

/// Assert a refusal by its code. A bare `is_err()` keeps passing after the
/// reason has changed underneath it — exactly what happened when the TokenRisk
/// age bound arrived and a mark-staleness test quietly started failing on
/// RiskStale.
fn assert_code(r: Result<(), String>, code: u32, why: &str) {
    match r {
        Ok(()) => panic!("expected Custom({code}) — {why} — but it passed"),
        Err(e) => assert!(e.contains(&format!("Custom({code})")), "expected Custom({code}) — {why} — got {e}"),
    }
}

fn strict() -> Mode {
    Mode::Strict
}

/// A caller that accepts off-hours risk. Used where a refusal must be shown
/// not to come from gate 7, the only gate the mode changes.
fn guarded() -> Mode {
    Mode::Guarded
}

fn ix_init_risk(ctx: &Ctx, mint: Pubkey) -> Instruction {
    ix_init_risk_for(ctx, mint, ctx.payer.pubkey())
}

fn ix_init_risk_for(ctx: &Ctx, mint: Pubkey, attestor: Pubkey) -> Instruction {
    Instruction::new_with_bytes(
        ctx.program_id,
        &bell_session::instruction::InitTokenRisk { attestor }.data(),
        bell_session::accounts::InitTokenRisk {
            payer: ctx.payer.pubkey(),
            mint,
            risk: ctx.risk_pda(&mint),
            system_program: system_program::ID,
        }
        .to_account_metas(None),
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

fn ix_push(
    ctx: &Ctx,
    symbol: [u8; SYMBOL_LEN],
    attestor: Pubkey,
    halt: HaltState,
    open_now: bool,
    observed_at: i64,
) -> Instruction {
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
        bell_session::accounts::PushSession {
            attestor,
            symbol_state: ctx.symbol_pda(&symbol),
        }
        .to_account_metas(None),
    )
}

fn ix_assert(
    ctx: &Ctx,
    symbol: [u8; SYMBOL_LEN],
    mint: Pubkey,
    mode: bell_session::instructions::assert_tradeable::Mode,
    expected_multiplier_bits: u64,
) -> Instruction {
    Instruction::new_with_bytes(
        ctx.program_id,
        &bell_session::instruction::AssertTradeable {
            symbol,
            mode,
            expected_multiplier_bits,
        }
        .data(),
        bell_session::accounts::AssertTradeable {
            symbol_state: ctx.symbol_pda(&symbol),
            risk: ctx.risk_pda(&mint),
        }
        .to_account_metas(None),
    )
}

// ---------------------------------------------------------------- mint parsing

#[test]
fn reads_the_real_apple_mint() {
    let mut ctx = Ctx::new();
    let mint = ctx.install_mint(AAPLX, include_bytes!("fixtures/aaplx.bin"));
    ctx.send(ix_init_risk(&ctx, mint), &[]).unwrap();

    let risk = ctx.read_risk(&ctx.risk_pda(&mint));
    assert_eq!(risk.mint, mint);
    assert!(!risk.paused, "AAPLx is not paused on mainnet");

    // Apple's multiplier reflects accumulated dividend reinvestment: slightly
    // above 1.0, and emphatically not 1.0, which is what a naive integration
    // that ignores scaledUiAmount would assume.
    let m = f64::from_bits(risk.multiplier_bits);
    assert!(m > 1.0 && m < 1.1, "unexpected AAPLx multiplier: {m}");

    // The issuer can seize any AAPLx from any wallet. Recorded, not ignored.
    assert!(risk.permanent_delegate.is_some(), "AAPLx has a permanent delegate");

    // The transfer-hook slot is armed but empty today.
    assert!(risk.hook.is_none());
    assert_eq!(risk.rebase_kind, RebaseKind::None);
}

#[test]
fn reads_a_split_adjusted_mint() {
    let mut ctx = Ctx::new();
    let mint = ctx.install_mint(NFLXX, include_bytes!("fixtures/nflxx.bin"));
    ctx.send(ix_init_risk(&ctx, mint), &[]).unwrap();

    // Netflix's 10:1 split already activated, so the multiplier is exactly 10.
    // A holder's raw balance is one tenth of their share count — the single
    // most consequential thing a tokenized-equity integration can get wrong.
    let m = f64::from_bits(ctx.read_risk(&ctx.risk_pda(&mint)).multiplier_bits);
    assert_eq!(m, 10.0, "NFLXx multiplier should be 10 after the split");
}

#[test]
fn is_issuer_agnostic() {
    // Same code path, a different issuer: a Backpack UCC Article 8 entitlement
    // rather than a Backed tracker certificate.
    let mut ctx = Ctx::new();
    let mint = ctx.install_mint(PFE_BACKPACK, include_bytes!("fixtures/pfe_backpack.bin"));
    ctx.send(ix_init_risk(&ctx, mint), &[]).unwrap();
    assert_eq!(ctx.read_risk(&ctx.risk_pda(&mint)).mint, mint);
}

#[test]
fn rejects_a_mint_that_is_not_token_2022() {
    // The bytes are the real AAPLx mint, which Token-2022's parser accepts, so
    // the only thing wrong is who owns the account. Zeroed bytes would not do:
    // they fail to unpack, which `read_mint` also reports as NotToken2022, and
    // the test would keep passing with the owner check deleted. Anyone can copy
    // a mint's bytes into an account their own program owns and set a pause
    // flag or a multiplier to whatever they like there.
    let aapl = include_bytes!("fixtures/aaplx.bin");
    let classic: Pubkey = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA".parse().unwrap();
    for (owner, who) in [
        (classic, "a genuine mint's bytes under the classic token program"),
        (Pubkey::new_unique(), "a genuine mint's bytes under a program the caller wrote"),
    ] {
        let mut ctx = Ctx::new();
        let key = Pubkey::new_unique();
        ctx.svm
            .set_account(
                key,
                Account {
                    lamports: 1_000_000_000,
                    data: aapl.to_vec(),
                    owner,
                    executable: false,
                    rent_epoch: 0,
                },
            )
            .unwrap();
        assert_code(ctx.send(ix_init_risk(&ctx, key), &[]), NOT_TOKEN_2022, who);
    }

    // The same bytes under Token-2022 are read, so the owner was the reason.
    let mut ctx = Ctx::new();
    let key = Pubkey::new_unique();
    ctx.svm
        .set_account(
            key,
            Account { lamports: 1_000_000_000, data: aapl.to_vec(), owner: token_2022(), executable: false, rent_epoch: 0 },
        )
        .unwrap();
    ctx.send(ix_init_risk(&ctx, key), &[]).unwrap();
}

// ---------------------------------------------------------------- the gate

/// Registered, risk-verified, and attested open. The baseline everything else
/// is measured against.
fn open_market(ctx: &mut Ctx) -> ([u8; SYMBOL_LEN], Pubkey, Keypair, u64) {
    let symbol = sym("AAPL");
    let mint = ctx.install_mint(AAPLX, include_bytes!("fixtures/aaplx.bin"));
    let attestor = Keypair::new();
    ctx.svm.airdrop(&attestor.pubkey(), 1_000_000_000).unwrap();

    ctx.send(ix_init_risk(ctx, mint), &[]).unwrap();
    ctx.send(ix_register(ctx, symbol, mint, attestor.pubkey()), &[]).unwrap();
    let now = ctx.now();
    ctx.send(
        ix_push(ctx, symbol, attestor.pubkey(), HaltState::None, true, now),
        &[&attestor],
    )
    .unwrap();

    let bits = ctx.read_risk(&ctx.risk_pda(&mint)).multiplier_bits;
    (symbol, mint, attestor, bits)
}

#[test]
fn an_open_market_passes() {
    let mut ctx = Ctx::new();
    let (symbol, mint, _a, bits) = open_market(&mut ctx);
    ctx.send(ix_assert(&ctx, symbol, mint, strict(), bits), &[]).unwrap();
}

#[test]
fn a_registered_symbol_is_untradeable_until_it_is_attested() {
    // The default must never be "open". A symbol that has been registered but
    // never attested is suspended, not tradeable.
    let mut ctx = Ctx::new();
    let symbol = sym("AAPL");
    let mint = ctx.install_mint(AAPLX, include_bytes!("fixtures/aaplx.bin"));
    let attestor = Keypair::new();

    ctx.send(ix_init_risk(&ctx, mint), &[]).unwrap();
    ctx.send(ix_register(&ctx, symbol, mint, attestor.pubkey()), &[]).unwrap();

    let s = ctx.read_symbol(&ctx.symbol_pda(&symbol));
    assert_eq!(s.halt, HaltState::Suspension);
    assert!(!s.open_now);

    // Refused at gate 1, before the halt is looked at: registration writes
    // `observed_at = 0`, so a record nobody has attested is older than any
    // freshness bound. The `Suspension` default is the second line of defence,
    // and cannot be the reason here, because the only way to make the record
    // fresh is a push that overwrites it.
    let bits = ctx.read_risk(&ctx.risk_pda(&mint)).multiplier_bits;
    assert_code(
        ctx.send(ix_assert(&ctx, symbol, mint, guarded(), bits), &[]),
        STATE_STALE,
        "registered, never attested",
    );
}

#[test]
fn a_halt_stops_the_trade() {
    let mut ctx = Ctx::new();
    let (symbol, mint, attestor, bits) = open_market(&mut ctx);
    let now = ctx.now();
    ctx.send(
        ix_push(&ctx, symbol, attestor.pubkey(), HaltState::Luld, true, now),
        &[&attestor],
    )
    .unwrap();

    // Gate 2. Guarded, so this is the halt refusing and not gate 7's session
    // check, which reports the same code.
    assert_code(
        ctx.send(ix_assert(&ctx, symbol, mint, guarded(), bits), &[]),
        MARKET_CLOSED,
        "LULD pause during an open session",
    );
}

#[test]
fn a_stale_attestation_fails_closed() {
    // The attestor going dark must close the venue, not leave it open.
    let mut ctx = Ctx::new();
    let (symbol, mint, attestor, bits) = open_market(&mut ctx);

    let stale = ctx.now() - (bell_session::constants::MAX_STATE_AGE_SECONDS + 1);
    ctx.send(
        ix_push(&ctx, symbol, attestor.pubkey(), HaltState::None, true, stale),
        &[&attestor],
    )
    .unwrap();

    assert_code(
        ctx.send(ix_assert(&ctx, symbol, mint, guarded(), bits), &[]),
        STATE_STALE,
        "attested MAX_STATE_AGE_SECONDS + 1 ago",
    );
}

#[test]
fn strict_mode_refuses_a_closed_market() {
    let mut ctx = Ctx::new();
    let (symbol, mint, attestor, bits) = open_market(&mut ctx);
    let now = ctx.now();
    ctx.send(
        ix_push(&ctx, symbol, attestor.pubkey(), HaltState::None, false, now),
        &[&attestor],
    )
    .unwrap();

    // Gate 7: no halt, just a session that is not live.
    assert_code(
        ctx.send(ix_assert(&ctx, symbol, mint, strict(), bits), &[]),
        MARKET_CLOSED,
        "strict caller, primary market closed",
    );

    // ...while a guarded caller, which widens its own price bands, may proceed.
    ctx.send(ix_assert(&ctx, symbol, mint, guarded(), bits), &[]).unwrap();
}

#[test]
fn an_order_built_on_a_different_multiplier_is_invalidated() {
    // A rebase between quote and execution silently re-denominates the trade.
    let mut ctx = Ctx::new();
    let (symbol, mint, _a, _bits) = open_market(&mut ctx);
    let wrong = 1.0f64.to_bits();
    assert_code(
        ctx.send(ix_assert(&ctx, symbol, mint, strict(), wrong), &[]),
        MULTIPLIER_MOVED,
        "built at 1.0 against AAPLx's accumulated multiplier",
    );
}

#[test]
fn only_the_registered_attestor_may_push() {
    let mut ctx = Ctx::new();
    let (symbol, _mint, _attestor, _bits) = open_market(&mut ctx);
    let impostor = Keypair::new();
    ctx.svm.airdrop(&impostor.pubkey(), 1_000_000_000).unwrap();
    let now = ctx.now();
    assert_code(
        ctx.send(ix_push(&ctx, symbol, impostor.pubkey(), HaltState::None, true, now), &[&impostor]),
        NOT_ATTESTOR,
        "signed by a key other than the symbol's attestor",
    );
}

#[test]
fn an_attestation_cannot_be_dated_in_the_future() {
    // Otherwise an attestor could buy itself an arbitrarily long freshness window.
    let mut ctx = Ctx::new();
    let (symbol, _mint, attestor, _bits) = open_market(&mut ctx);
    let future = ctx.now() + 10_000;
    assert_code(
        ctx.send(ix_push(&ctx, symbol, attestor.pubkey(), HaltState::None, true, future), &[&attestor]),
        TIMESTAMP_IN_FUTURE,
        "observed_at 10,000s ahead of the clock",
    );
}

// ------------------------------------------------- regressions from the audit
//
// Each of these failed before the fix in the same commit. They are here because
// the fixes changed instruction shapes without breaking a single existing test,
// which is precisely the condition under which a security fix quietly regresses.

fn ix_classify(ctx: &Ctx, mint: Pubkey, attestor: Pubkey, kind: RebaseKind) -> Instruction {
    Instruction::new_with_bytes(
        ctx.program_id,
        &bell_session::instruction::ClassifyRebase { kind }.data(),
        bell_session::accounts::ClassifyRebase {
            attestor,
            risk: ctx.risk_pda(&mint),
        }
        .to_account_metas(None),
    )
}

#[test]
fn a_stranger_cannot_classify_a_rebase() {
    // The original hole: `classify_rebase` read its authority from a
    // `SymbolState` that carried no seed constraint, while `register_symbol` is
    // permissionless and takes both the mint and the attestor as caller-supplied
    // arguments. So anyone could register an unused ticker naming a real mint,
    // name themselves attestor, and write `rebase_kind` on that mint's shared
    // `TokenRisk` — clearing it to disarm gate 4 during a corporate action, or
    // setting it to `Unknown` to freeze every symbol on the mint.
    let mut ctx = Ctx::new();
    let mint = ctx.install_mint(AAPLX, include_bytes!("fixtures/aaplx.bin"));
    ctx.send(ix_init_risk(&ctx, mint), &[]).unwrap();

    let impostor = Keypair::new();
    ctx.svm.airdrop(&impostor.pubkey(), 1_000_000_000).unwrap();

    // The exact escalation the audit described: squat a ticker on someone
    // else's mint, naming yourself as its attestor. Registering still succeeds —
    // it is a ticker nobody uses — but it must buy no authority over the mint.
    ctx.send(
        ix_register(&ctx, sym("AAPLX9"), mint, impostor.pubkey()),
        &[],
    )
    .unwrap();

    assert_code(
        ctx.send(ix_classify(&ctx, mint, impostor.pubkey(), RebaseKind::Split), &[&impostor]),
        NOT_ATTESTOR,
        "a self-registered symbol must not confer authority over a shared TokenRisk",
    );
}

#[test]
fn the_risk_records_its_own_classification_authority() {
    // And the key that created the record still can.
    let mut ctx = Ctx::new();
    let mint = ctx.install_mint(AAPLX, include_bytes!("fixtures/aaplx.bin"));
    ctx.send(ix_init_risk(&ctx, mint), &[]).unwrap();
    let risk = ctx.read_risk(&ctx.risk_pda(&mint));
    assert_eq!(risk.attestor, ctx.payer.pubkey());

    ctx.send(ix_classify(&ctx, mint, ctx.payer.pubkey(), RebaseKind::Dividend), &[])
        .unwrap();
    assert_eq!(ctx.read_risk(&ctx.risk_pda(&mint)).rebase_kind, RebaseKind::Dividend);
}

#[test]
fn the_activation_instant_survives_the_change_taking_effect() {
    // Netflix's mint carries a 10:1 split whose activation timestamp is in the
    // past relative to our pinned clock. `read_mint` used to zero
    // `activates_at` once it passed, which deleted the half of the rebase guard
    // window that sits *after* the activation — the window in which a dividend
    // has already stepped value-per-raw-unit up and the pool is stale-low by
    // exactly that amount. Anyone could trigger that deletion, because
    // refreshing is permissionless.
    let mut ctx = Ctx::new();
    let mint = ctx.install_mint(NFLXX, include_bytes!("fixtures/nflxx.bin"));
    ctx.send(ix_init_risk(&ctx, mint), &[]).unwrap();
    let risk = ctx.read_risk(&ctx.risk_pda(&mint));

    assert_ne!(
        risk.activates_at, 0,
        "an activation that has already happened must still be recorded"
    );
    // It is in force, so nothing is pending and no classification is demanded.
    assert_eq!(risk.pending_multiplier_bits, 0);
    assert_eq!(risk.rebase_kind, RebaseKind::None);
}


// ------------------------------------------------ the TokenRisk freshness bound
//
// Gates 3-6 are proven from the mint, but only as of the last read. For its
// first day on devnet nobody re-read it: the record was a snapshot from
// registration. `MAX_RISK_AGE_SECONDS` makes a stale read fail closed, the same
// way a stale attestation does.

fn ix_refresh(ctx: &Ctx, mint: Pubkey) -> Instruction {
    Instruction::new_with_bytes(
        ctx.program_id,
        &bell_session::instruction::RefreshTokenRisk {}.data(),
        bell_session::accounts::RefreshTokenRisk { mint, risk: ctx.risk_pda(&mint) }.to_account_metas(None),
    )
}

#[test]
fn a_stale_risk_record_fails_closed() {
    let mut ctx = Ctx::new();
    let (symbol, mint, attestor, bits) = open_market(&mut ctx);
    ctx.warp(NOW + 601);
    ctx.send(ix_push(&ctx, symbol, attestor.pubkey(), HaltState::None, true, NOW + 601), &[&attestor]).unwrap();
    assert_code(ctx.send(ix_assert(&ctx, symbol, mint, strict(), bits), &[]), RISK_STALE, "mint last read 601s ago");
}

#[test]
fn anyone_re_reading_the_mint_reopens_the_gate() {
    // Refresh is permissionless, so the bound cannot be used to hold the venue
    // shut: the cure is available to everyone, in their own transaction.
    let mut ctx = Ctx::new();
    let (symbol, mint, attestor, bits) = open_market(&mut ctx);
    ctx.warp(NOW + 601);
    ctx.send(ix_push(&ctx, symbol, attestor.pubkey(), HaltState::None, true, NOW + 601), &[&attestor]).unwrap();
    ctx.send(ix_refresh(&ctx, mint), &[]).unwrap();
    ctx.send(ix_assert(&ctx, symbol, mint, strict(), bits), &[]).unwrap();
}

#[test]
fn a_halt_still_reports_as_a_halt_over_a_stale_record() {
    // Gate 2b sits after the halt on purpose: when the market is halted, that
    // is the reason a user should see, not a bookkeeping one.
    let mut ctx = Ctx::new();
    let (symbol, mint, attestor, bits) = open_market(&mut ctx);
    ctx.warp(NOW + 601);
    ctx.send(ix_push(&ctx, symbol, attestor.pubkey(), HaltState::Luld, true, NOW + 601), &[&attestor]).unwrap();
    assert_code(ctx.send(ix_assert(&ctx, symbol, mint, strict(), bits), &[]), MARKET_CLOSED, "halted and stale");
}

#[test]
fn a_record_exactly_at_the_bound_still_passes() {
    let mut ctx = Ctx::new();
    let (symbol, mint, attestor, bits) = open_market(&mut ctx);
    ctx.warp(NOW + 600);
    ctx.send(ix_push(&ctx, symbol, attestor.pubkey(), HaltState::None, true, NOW + 600), &[&attestor]).unwrap();
    ctx.send(ix_assert(&ctx, symbol, mint, strict(), bits), &[]).unwrap();
}

#[test]
fn a_dividend_walked_end_to_end_on_the_real_apple_mint() {
    // The real AAPLx mint carries a genuine scheduled multiplier step, so the
    // whole of gate 4 can be walked on issuer bytes rather than on a mint we
    // built: unclassified, classified, the window before, the window after (the
    // half an audit found could be deleted), a record left unread past the
    // window, and an order built on the old multiplier.
    let mut ctx = Ctx::new();
    let mint = ctx.install_mint(AAPLX, include_bytes!("fixtures/aaplx.bin"));

    // Find the step on the mint itself, read at the fixture's own clock.
    ctx.send(ix_init_risk(&ctx, mint), &[]).unwrap();
    let t = {
        let r = ctx.read_risk(&ctx.risk_pda(&mint));
        // At NOW the step is already in force; its instant is retained.
        assert!(r.activates_at != 0, "fixture should carry a multiplier activation");
        r.activates_at
    };

    // Rewind to half an hour before it, on a fresh ledger, and walk forward.
    let mut ctx = Ctx::new();
    ctx.warp(t - 1_800);
    let mint = ctx.install_mint(AAPLX, include_bytes!("fixtures/aaplx.bin"));
    ctx.send(ix_init_risk(&ctx, mint), &[]).unwrap();
    let before = ctx.read_risk(&ctx.risk_pda(&mint));
    assert_eq!(before.activates_at, t);
    assert_ne!(before.pending_multiplier_bits, 0, "the step is pending half an hour out");
    assert_eq!(before.rebase_kind, RebaseKind::Unknown);
    let old_bits = before.multiplier_bits;
    let new_bits = before.pending_multiplier_bits;

    let symbol = sym("AAPL");
    let attestor = Keypair::new();
    ctx.svm.airdrop(&attestor.pubkey(), 1_000_000_000).unwrap();
    ctx.send(ix_register(&ctx, symbol, mint, attestor.pubkey()), &[]).unwrap();
    let push = |ctx: &mut Ctx, at: i64| {
        let a = attestor.insecure_clone();
        ctx.send(ix_push(ctx, symbol, a.pubkey(), HaltState::None, true, at), &[&a]).unwrap();
    };

    // T-1800: a change nobody has identified. Outside the window, still refused.
    push(&mut ctx, t - 1_800);
    assert_code(ctx.send(ix_assert(&ctx, symbol, mint, strict(), old_bits), &[]), REBASE_UNCLASSIFIED, "T-1800, unclassified");

    // Classified as a dividend: tradeable again until the window opens.
    ctx.send(ix_classify(&ctx, mint, ctx.payer.pubkey(), RebaseKind::Dividend), &[]).unwrap();
    ctx.send(ix_assert(&ctx, symbol, mint, strict(), old_bits), &[]).unwrap();

    // T-900: the window opens.
    ctx.warp(t - 900);
    push(&mut ctx, t - 900);
    ctx.send(ix_refresh(&ctx, mint), &[]).unwrap();
    assert_code(ctx.send(ix_assert(&ctx, symbol, mint, strict(), old_bits), &[]), REBASE_PENDING, "T-900");

    // T+1: in force. The instant is retained, so the window's second half holds.
    ctx.warp(t + 1);
    push(&mut ctx, t + 1);
    ctx.send(ix_refresh(&ctx, mint), &[]).unwrap();
    let after = ctx.read_risk(&ctx.risk_pda(&mint));
    assert_eq!(after.multiplier_bits, new_bits);
    assert_eq!(after.pending_multiplier_bits, 0);
    assert_eq!(after.activates_at, t);
    assert_code(ctx.send(ix_assert(&ctx, symbol, mint, strict(), new_bits), &[]), REBASE_PENDING, "T+1, post-activation half");

    // T+901, nobody re-read the mint since T+1: 900s old, past the bound.
    // Without the bound, this is where a stale record would have let a trade
    // through while nobody had looked at the mint for fifteen minutes.
    ctx.warp(t + 901);
    push(&mut ctx, t + 901);
    assert_code(ctx.send(ix_assert(&ctx, symbol, mint, strict(), new_bits), &[]), RISK_STALE, "T+901, unread since T+1");

    // Re-read: clear of the window. An order built on the old multiplier is
    // invalidated rather than filled at a size nobody asked for.
    ctx.send(ix_refresh(&ctx, mint), &[]).unwrap();
    assert_code(ctx.send(ix_assert(&ctx, symbol, mint, strict(), old_bits), &[]), MULTIPLIER_MOVED, "old multiplier after T");
    ctx.send(ix_assert(&ctx, symbol, mint, strict(), new_bits), &[]).unwrap();
}

// ------------------------------------- issuer powers, armed on real issuer bytes
//
// On mainnet today no fixture is paused and every transfer-hook slot is empty,
// so gates 3 and 6 never fire against the fixtures as pulled. Building a mint
// from scratch would only prove we can read a mint we wrote. Instead each of
// these takes a real mint and changes one field inside one extension, leaving
// every other byte as the issuer wrote it, so the program still parses the
// issuer's own layout.

/// The byte range of one extension's value inside a Token-2022 mint, found by
/// walking the TLV entries the way Token-2022 does.
///
/// Walked rather than indexed because the extension order is the issuer's
/// choice, and the fixtures show that it varies: Backpack's PFE carries
/// `Pausable` sixty bytes earlier than Backed's mints do. A hardcoded offset
/// taken from one issuer would, on the other, silently flip a byte inside
/// whichever extension happens to sit there.
fn extension_value(data: &[u8], want: ExtensionType) -> Range<usize> {
    // Extensions begin after the base state padded to a token account's
    // length, plus the one byte that says which kind of account this is.
    let base = <SplAccount as PackedSizeOf>::SIZE_OF;
    assert_eq!(data[base], AccountType::Mint as u8, "not a Token-2022 mint with extensions");
    let mut at = base + 1;
    while at + 4 <= data.len() {
        let ty = u16::from_le_bytes([data[at], data[at + 1]]);
        let len = u16::from_le_bytes([data[at + 2], data[at + 3]]) as usize;
        // Nothing is ever written after an uninitialized entry.
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

/// A copy of `fixture` with the issuer's `PausableConfig.paused` flag set.
fn paused(fixture: &[u8]) -> Vec<u8> {
    let mut data = fixture.to_vec();
    let v = extension_value(&data, ExtensionType::Pausable);
    assert_eq!(v.len(), size_of::<PausableConfig>(), "Pausable entry has an unexpected length");
    let flag = v.start + offset_of!(PausableConfig, paused);
    assert_eq!(data[flag], 0, "fixture should ship unpaused");
    data[flag] = 1; // PodBool true
    // Read back through Token-2022's own parser, the one the program uses, so
    // the test cannot have written somewhere the program does not look.
    let mint = StateWithExtensions::<SplMint>::unpack(&data).unwrap();
    assert!(bool::from(mint.get_extension::<PausableConfig>().unwrap().paused));
    data
}

/// A copy of `fixture` whose transfer-hook slot names `program`.
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

#[test]
fn an_issuer_pause_on_the_mint_stops_the_trade() {
    // Gate 3. The pause is Backed's own flag on the real AAPLx mint, set as
    // the issuer's pause authority would set it, and seen by nothing but a
    // permissionless re-read of the mint.
    let mut ctx = Ctx::new();
    let (symbol, mint, _a, bits) = open_market(&mut ctx);
    let real = include_bytes!("fixtures/aaplx.bin");

    ctx.install_mint(AAPLX, &paused(real));
    ctx.send(ix_refresh(&ctx, mint), &[]).unwrap();
    assert!(ctx.read_risk(&ctx.risk_pda(&mint)).paused, "the refresh read the flag from the mint");
    // Guarded: the pause binds a caller that accepts off-hours risk too.
    assert_code(
        ctx.send(ix_assert(&ctx, symbol, mint, guarded(), bits), &[]),
        ISSUER_PAUSED,
        "AAPLx paused by its issuer",
    );

    // Unpaused and re-read, the same record trades again: the flag, and
    // nothing else the synthesis touched, was the reason.
    ctx.install_mint(AAPLX, real);
    ctx.send(ix_refresh(&ctx, mint), &[]).unwrap();
    ctx.send(ix_assert(&ctx, symbol, mint, guarded(), bits), &[]).unwrap();
}

#[test]
fn a_pause_is_read_on_either_issuers_extension_layout() {
    // Backed and Backpack order their extensions differently, so the same flag
    // sits at different offsets. The program reads it by type on both, and so
    // does the synthesis — which the first assertion keeps honest, by failing
    // if the fixtures ever stop disagreeing about where it is.
    let aapl = &include_bytes!("fixtures/aaplx.bin")[..];
    let pfe = &include_bytes!("fixtures/pfe_backpack.bin")[..];
    assert_ne!(
        extension_value(aapl, ExtensionType::Pausable).start,
        extension_value(pfe, ExtensionType::Pausable).start,
        "the two issuers' layouts should place Pausable differently"
    );

    let mut ctx = Ctx::new();
    for (address, fixture) in [(AAPLX, aapl), (PFE_BACKPACK, pfe)] {
        let mint = ctx.install_mint(address, &paused(fixture));
        ctx.send(ix_init_risk(&ctx, mint), &[]).unwrap();
        assert!(ctx.read_risk(&ctx.risk_pda(&mint)).paused, "{address} should read as paused");
    }
}

#[test]
fn an_armed_transfer_hook_stops_the_trade() {
    // Gate 6. Every fixture ships with the hook slot present and empty, which
    // is how the issuer keeps the power to arm one later. Arming it routes
    // every transfer through a program nobody here has read, so the mint
    // stops being tradeable at the instant a re-read sees it.
    let mut ctx = Ctx::new();
    let (symbol, mint, _a, bits) = open_market(&mut ctx);
    let real = include_bytes!("fixtures/aaplx.bin");
    let hook_program = Pubkey::new_unique();

    ctx.install_mint(AAPLX, &with_hook(real, &hook_program));
    ctx.send(ix_refresh(&ctx, mint), &[]).unwrap();
    assert_eq!(ctx.read_risk(&ctx.risk_pda(&mint)).hook, Some(hook_program));
    assert_code(
        ctx.send(ix_assert(&ctx, symbol, mint, guarded(), bits), &[]),
        HOOK_ARMED,
        "AAPLx with a transfer-hook program set",
    );

    // Disarmed and re-read, it trades again.
    ctx.install_mint(AAPLX, real);
    ctx.send(ix_refresh(&ctx, mint), &[]).unwrap();
    assert_eq!(ctx.read_risk(&ctx.risk_pda(&mint)).hook, None);
    ctx.send(ix_assert(&ctx, symbol, mint, guarded(), bits), &[]).unwrap();
}
