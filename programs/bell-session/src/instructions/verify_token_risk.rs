use anchor_lang::prelude::*;
use spl_token_2022::{
    extension::{
        pausable::PausableConfig, permanent_delegate::PermanentDelegate,
        scaled_ui_amount::ScaledUiAmountConfig, transfer_hook::TransferHook,
        BaseStateWithExtensions, StateWithExtensions,
    },
    state::Mint as SplMint,
};

use crate::{
    constants::RISK_SEED,
    error::BellError,
    state::{RebaseKind, TokenRisk},
};

/// Token-2022 encodes "unset" optional pubkeys as all zeroes rather than as a
/// tagged option, so the zero key is the sentinel for absent.
fn optional_key(bytes: [u8; 32]) -> Option<Pubkey> {
    if bytes == [0u8; 32] {
        None
    } else {
        Some(Pubkey::new_from_array(bytes))
    }
}

/// What the mint itself says about issuer powers and pending re-denominations.
struct MintFacts {
    paused: bool,
    multiplier_bits: u64,
    pending_multiplier_bits: u64,
    activates_at: i64,
    hook: Option<Pubkey>,
    permanent_delegate: Option<Pubkey>,
}

/// Deserialize the Token-2022 extension data from a real mint account.
///
/// Everything here is **proven, not attested**: it is read from the mint, so no
/// attestor can misreport it and no oracle needs to be believed.
fn read_mint(mint_info: &AccountInfo, now: i64) -> Result<MintFacts> {
    // anchor-lang and spl-token-2022 pull in different `Pubkey` types, so
    // compare by bytes rather than fighting the trait impls.
    require!(
        mint_info.owner.to_bytes() == spl_token_2022::ID.to_bytes(),
        BellError::NotToken2022
    );

    let data = mint_info.try_borrow_data()?;
    let mint = StateWithExtensions::<SplMint>::unpack(&data)
        .map_err(|_| error!(BellError::NotToken2022))?;

    let paused = mint
        .get_extension::<PausableConfig>()
        .map(|c| bool::from(c.paused))
        .unwrap_or(false);

    // ScaledUiAmountConfig carries BOTH the outgoing and the incoming
    // multiplier, and `multiplier` is NOT authoritative once the activation
    // timestamp has passed — after that instant the effective value is
    // `new_multiplier`. Reading the wrong field is how an integration ends up
    // off by an entire stock split: Netflix's mint still reports `multiplier`
    // 1.0 alongside `new_multiplier` 10.0 with a timestamp in the past.
    let (multiplier_bits, pending_multiplier_bits, activates_at) =
        match mint.get_extension::<ScaledUiAmountConfig>() {
            Ok(c) => {
                let outgoing = f64::from(c.multiplier).to_bits();
                let incoming = f64::from(c.new_multiplier).to_bits();
                let at = i64::from(c.new_multiplier_effective_timestamp);

                if at != 0 && now >= at {
                    // Already in force, so nothing is *pending* — but the
                    // instant is kept rather than zeroed. Gate 4 measures
                    // |activates_at - now|, so dropping it here would delete
                    // the half of the guard window that sits *after* the
                    // activation, and anyone could do it by calling the
                    // permissionless refresh one second past T. That window is
                    // the dangerous one: a dividend steps value-per-raw-unit up
                    // at a known instant, leaving the pool stale-low by exactly
                    // the dividend until arbitrage catches up.
                    (incoming, 0, at)
                } else if at != 0 && incoming != outgoing {
                    // Scheduled and published ahead of time — which is exactly
                    // what makes the dividend drain predictable, and refusable.
                    (outgoing, incoming, at)
                } else {
                    (outgoing, 0, 0)
                }
            }
            // No scaled-amount extension: raw balances are already share units.
            Err(_) => (1.0f64.to_bits(), 0, 0),
        };

    Ok(MintFacts {
        paused,
        multiplier_bits,
        pending_multiplier_bits,
        activates_at,
        hook: mint
            .get_extension::<TransferHook>()
            .ok()
            .and_then(|c| optional_key(c.program_id.0.to_bytes())),
        permanent_delegate: mint
            .get_extension::<PermanentDelegate>()
            .ok()
            .and_then(|c| optional_key(c.delegate.0.to_bytes())),
    })
}

fn apply(risk: &mut TokenRisk, mint: Pubkey, facts: MintFacts, now: i64) {
    risk.mint = mint;
    risk.paused = facts.paused;
    risk.multiplier_bits = facts.multiplier_bits;
    risk.pending_multiplier_bits = facts.pending_multiplier_bits;
    risk.activates_at = facts.activates_at;
    // A newly observed pending change is unclassified until something proves
    // which kind it is, and `Unknown` is never tradeable. An existing
    // classification survives a refresh so a re-read cannot quietly clear it.
    risk.rebase_kind = if facts.pending_multiplier_bits == 0 {
        RebaseKind::None
    } else if risk.rebase_kind == RebaseKind::None {
        RebaseKind::Unknown
    } else {
        risk.rebase_kind
    };
    risk.hook = facts.hook;
    risk.permanent_delegate = facts.permanent_delegate;
    risk.verified_at = now;
}

/// Create the risk record for a mint. Permissionless — anyone may do this once.
///
/// The caller names the `rebase_kind` attestor, exactly as `register_symbol`
/// does, so rent can be paid by a cold deploy key while the hot keeper key
/// holds the attestation authority. Every other field is proven from the mint
/// and stays permissionlessly refreshable; only the attested one needs an
/// owner. First-come-first-served per mint, which is why the nine listed mints
/// are initialised at deploy.
///
/// Deliberately separate from `refresh_token_risk` rather than using
/// `init_if_needed`: keeping creation and update distinct means there is no
/// path on which an existing record is silently re-initialised.
#[derive(Accounts)]
pub struct InitTokenRisk<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: validated in `read_mint` — must be owned by Token-2022 and must
    /// deserialize as a mint. Unchecked here so this works for any mint
    /// without prior registration.
    pub mint: UncheckedAccount<'info>,
    #[account(
        init,
        payer = payer,
        space = 8 + TokenRisk::INIT_SPACE,
        seeds = [RISK_SEED, mint.key().as_ref()],
        bump,
    )]
    pub risk: Account<'info, TokenRisk>,
    pub system_program: Program<'info, System>,
}

pub fn handle_init_token_risk(ctx: Context<InitTokenRisk>, attestor: Pubkey) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let facts = read_mint(&ctx.accounts.mint.to_account_info(), now)?;
    ctx.accounts.risk.rebase_kind = RebaseKind::None;
    ctx.accounts.risk.attestor = attestor;
    ctx.accounts.risk.bump = ctx.bumps.risk;
    apply(&mut ctx.accounts.risk, ctx.accounts.mint.key(), facts, now);
    Ok(())
}

/// Re-read the mint. Permissionless: anyone may keep the record fresh, and
/// nobody can make it say anything the mint does not.
#[derive(Accounts)]
pub struct RefreshTokenRisk<'info> {
    /// CHECK: validated in `read_mint`; bound to the PDA by the seeds below.
    pub mint: UncheckedAccount<'info>,
    #[account(
        mut,
        seeds = [RISK_SEED, mint.key().as_ref()],
        bump = risk.bump,
    )]
    pub risk: Account<'info, TokenRisk>,
}

pub fn handle_refresh_token_risk(ctx: Context<RefreshTokenRisk>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let facts = read_mint(&ctx.accounts.mint.to_account_info(), now)?;
    apply(&mut ctx.accounts.risk, ctx.accounts.mint.key(), facts, now);
    Ok(())
}
