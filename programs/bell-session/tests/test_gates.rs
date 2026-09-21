//! Gate tests for `bell-session`.
//!
//! The mint fixtures in `tests/fixtures/` are **real mainnet accounts**, byte
//! for byte, pulled with `getAccountInfo`. Testing extension parsing against a
//! synthetic mint would only prove we can read a mint we built ourselves; these
//! prove we read Apple, Netflix, SPY and a Backpack entitlement as they
//! actually exist on chain today.

use {
    anchor_lang::{
        prelude::Pubkey,
        solana_program::{instruction::Instruction, system_program},
        AccountDeserialize, InstructionData, ToAccountMetas,
    },
    bell_session::{
        constants::{RISK_SEED, SYMBOL_SEED, SYMBOL_LEN},
        state::{HaltState, HoursMode, RebaseKind, SymbolState, TokenRisk},
    },
    anchor_lang::solana_program::clock::Clock,
    litesvm::LiteSVM,
    solana_account::Account,
    solana_keypair::Keypair,
    solana_message::{Message, VersionedMessage},
    solana_signer::Signer,
    solana_transaction::versioned::VersionedTransaction,
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

    /// Drop a real mainnet mint account into the test ledger unchanged.
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

fn ix_init_risk(ctx: &Ctx, mint: Pubkey) -> Instruction {
    Instruction::new_with_bytes(
        ctx.program_id,
        &bell_session::instruction::InitTokenRisk {}.data(),
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
    let mut ctx = Ctx::new();
    let key = Pubkey::new_unique();
    ctx.svm
        .set_account(
            key,
            Account {
                lamports: 1_000_000_000,
                data: vec![0u8; 82],
                owner: system_program::ID,
                executable: false,
                rent_epoch: 0,
            },
        )
        .unwrap();
    let err = ctx.send(ix_init_risk(&ctx, key), &[]).unwrap_err();
    assert!(err.contains("NotToken2022") || err.contains("Custom"), "got {err}");
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
    ctx.send(
        ix_assert(&ctx, symbol, mint, bell_session::instructions::assert_tradeable::Mode::Strict, bits),
        &[],
    )
    .unwrap();
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

    let bits = ctx.read_risk(&ctx.risk_pda(&mint)).multiplier_bits;
    assert!(ctx
        .send(
            ix_assert(&ctx, symbol, mint, bell_session::instructions::assert_tradeable::Mode::Guarded, bits),
            &[]
        )
        .is_err());
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

    let err = ctx
        .send(
            ix_assert(&ctx, symbol, mint, bell_session::instructions::assert_tradeable::Mode::Guarded, bits),
            &[],
        )
        .unwrap_err();
    assert!(err.contains("MarketClosed") || err.contains("Custom"), "got {err}");
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

    assert!(ctx
        .send(
            ix_assert(&ctx, symbol, mint, bell_session::instructions::assert_tradeable::Mode::Guarded, bits),
            &[]
        )
        .is_err());
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

    let strict = bell_session::instructions::assert_tradeable::Mode::Strict;
    assert!(ctx.send(ix_assert(&ctx, symbol, mint, strict, bits), &[]).is_err());

    // ...while a guarded caller, which widens its own price bands, may proceed.
    let guarded = bell_session::instructions::assert_tradeable::Mode::Guarded;
    ctx.send(ix_assert(&ctx, symbol, mint, guarded, bits), &[]).unwrap();
}

#[test]
fn an_order_built_on_a_different_multiplier_is_invalidated() {
    // A rebase between quote and execution silently re-denominates the trade.
    let mut ctx = Ctx::new();
    let (symbol, mint, _a, _bits) = open_market(&mut ctx);
    let wrong = 1.0f64.to_bits();
    assert!(ctx
        .send(
            ix_assert(&ctx, symbol, mint, bell_session::instructions::assert_tradeable::Mode::Strict, wrong),
            &[]
        )
        .is_err());
}

#[test]
fn only_the_registered_attestor_may_push() {
    let mut ctx = Ctx::new();
    let (symbol, _mint, _attestor, _bits) = open_market(&mut ctx);
    let impostor = Keypair::new();
    ctx.svm.airdrop(&impostor.pubkey(), 1_000_000_000).unwrap();
    let now = ctx.now();
    assert!(ctx
        .send(
            ix_push(&ctx, symbol, impostor.pubkey(), HaltState::None, true, now),
            &[&impostor]
        )
        .is_err());
}

#[test]
fn an_attestation_cannot_be_dated_in_the_future() {
    // Otherwise an attestor could buy itself an arbitrarily long freshness window.
    let mut ctx = Ctx::new();
    let (symbol, _mint, attestor, _bits) = open_market(&mut ctx);
    let future = ctx.now() + 10_000;
    assert!(ctx
        .send(
            ix_push(&ctx, symbol, attestor.pubkey(), HaltState::None, true, future),
            &[&attestor]
        )
        .is_err());
}
