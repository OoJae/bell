# Integrating BELL's gate

This guide is for developers of wallets, routers, lending markets and vaults. If
you move tokenized US stocks on Solana, you can make that movement fail when the
stock is not safely tradeable. You do it by adding one instruction, not by
routing through BELL.

`assert_tradeable` is a single instruction in the `bell-session` program. It
succeeds silently, or fails with a reason your code can read. Because a
Solana transaction is atomic, a failure aborts everything else in the same
transaction.

> **Status: devnet only.** The program is deployed on devnet at
> [`56AUPR1c1Tq5AgMvAa3PASax61YYo1KTdocwW6pR7Pdx`](https://explorer.solana.com/address/56AUPR1c1Tq5AgMvAa3PASax61YYo1KTdocwW6pR7Pdx?cluster=devnet).
> It covers nine symbols, and on devnet each one is a *mirror* of the real
> mainnet mint, not the mint itself (see the README, "What that costs in
> honesty"). BELL has no mainnet deployment, so nothing here can guard a
> mainnet trade today. Everything below works against devnet now and would
> work the same way against a mainnet deployment.

---

## Why a gate and not a warning

Tokenized stocks trade on Solana at any hour, but their primary markets do
not. MetaMask's help centre on tokenized stocks says it directly: "Tokenized
stocks and ETFs can technically be traded onchain at any time. However, trading
outside of Ondo Global Markets-defined hours may involve lower liquidity, higher
price volatility, and limited or unavailable price quotes"
([support.metamask.io/trade/real-world-assets](https://support.metamask.io/trade/real-world-assets),
read 24 September 2026). That warning is advice to a user, and the user can
ignore it. `assert_tradeable` is an instruction, so a trade it refuses does not
execute.

---

## What the gate checks

The checks run in this order, cheapest and most categorical first, so a refusal
names the most fundamental reason
(`programs/bell-session/src/instructions/assert_tradeable.rs`,
`check_tradeable`):

| # | Check | Refuses with | Where the fact comes from |
|---|---|---|---|
| 1 | The session attestation is at most 120 s old (`MAX_STATE_AGE_SECONDS`) | `StateStale` | attested by BELL's keeper |
| 2 | Trading in the security is not stopped (`halt == None`) | `MarketClosed` | attested |
| 2b | The mint was read at most 600 s ago (`MAX_RISK_AGE_SECONDS`) | `RiskStale` | the mint's own data |
| 3 | The issuer has not paused the mint (`PausableConfig`) | `IssuerPaused` | the mint |
| 4 | No multiplier activation within 900 s either side of now (`REBASE_GUARD_SECONDS`), and any pending change is classified as a split or a dividend | `RebasePending`, `RebaseUnclassified` | the mint, plus an attested split/dividend label |
| 5 | The multiplier is the one you built against | `MultiplierMoved` | the mint |
| 6 | No transfer hook is armed | `HookArmed` | the mint |
| 7 | **Strict mode only:** the primary market is open | `MarketClosed` | attested |

Checks 2b to 6 read `TokenRisk`, a record the program fills by deserializing
the Token-2022 mint's extensions itself (`verify_token_risk.rs`), so nobody can
misreport them. Only the session (1, 2 and 7) and the split/dividend label in 4
are attested. The constants are in `programs/bell-session/src/constants.rs` and
in the IDL (`src/chain/idl.json`, `constants`).

**Modes.** The `mode` argument is `Strict` (0) or `Guarded` (1). `Guarded` skips
check 7 and nothing else. Halts, stale state, pauses, rebases, a moved
multiplier and hooks still refuse. The program documents `Guarded` as "Will
trade off-hours; the caller is expected to widen its own price bands to
compensate for the absence of arbitrage", which puts pricing off-hours on you.
Measured on devnet on the evening of 23 September (ET), SPYx refused in
`Strict` (`MarketClosed`, market shut) and passed in `Guarded`. IWMx refused in
both, because its issuer has withdrawn it, so its attested halt state is not
`None`.

`MarketClosed` covers both a shut session and a stopped security. To tell them
apart, read `SymbolState.halt` (layout below): `0` means the market is simply
shut, and anything else means trading is stopped.

---

## Three ways to use it

### 1. Prepend it: wallets and routers

Put `assert_tradeable` first, then your instructions, unchanged, in the same
transaction. If the gate refuses, nothing after it runs. There is no partial
execution and no wrapper program, and BELL never sees your swap.

**With this repo's client**, `guardInstructions` in `src/chain/guard.ts` does
the composition. It reads the two accounts it needs and the multiplier to build
against, builds an unsigned v0 transaction with your lookup tables, and runs a
read-only simulation of the gate so you can show its answer before asking for a
signature:

```ts
import { Connection, PublicKey, type AddressLookupTableAccount, type TransactionInstruction } from '@solana/web3.js'
import { guardInstructions } from './src/chain/guard.ts'
import { Mode } from './src/chain/codec.ts'

// Pin symbol, mint and attestor together. Never look a symbol up by ticker.
const SPYX = {
  symbol: 'SPYx',
  mint: new PublicKey('AFrGCsmPc3WeUAEM3jw8Ec3M6BrKrJGDQeX2g1Ctrrwx'), // devnet mirror
  attestor: new PublicKey('EsZp7XusAj9fJ1ntQYCTMEw7h6L9mfZUtAvaXDxi4TcG'),
}

export async function guardSwap(
  conn: Connection,
  user: PublicKey,
  swapInstructions: TransactionInstruction[], // from your router, passed through unchanged
  lookupTables: AddressLookupTableAccount[],
) {
  const g = await guardInstructions(conn, {
    ...SPYX,
    instructions: swapInstructions,
    payer: user,
    mode: Mode.Strict,
    lookupTables,
  })
  if (!g.verdict.tradeable) {
    // The program's own words, from the IDL, and whether waiting for the open would help.
    return { refused: g.verdict.reason, why: g.verdict.message, offerBellOrder: g.verdict.waitsForOpen }
  }
  return { transaction: g.transaction } // have the wallet sign it, then send as usual
}
```

What it returns:

- `transaction` is an unsigned `VersionedTransaction`: BELL's instructions,
  then yours.
- `instructions` is the same list, in case you compile your own message.
- `gateIndex` is `0`, or `1` with `refreshRisk`.
- `blockhash` and `lastValidBlockHeight` come with the transaction.
- `verdict` is described in [way 3](#3-ask-without-trading-a-warning-or-a-bell-order).

It throws when it cannot build the transaction honestly. That happens when the
symbol is not registered, the mint has no risk record, the symbol is bound to
a different mint, either record (`SymbolState` or `TokenRisk`) names a
different attestor than the one you pinned, or the chain cannot be read. If
you meant to guard a trade, treat a throw as a refusal. Do not fall back to
sending the trade unguarded. The unit
tests in `test/guard.test.ts` check the order: the gate comes first, and your
instructions follow as the same objects, in the same order, unmodified.

`guarded()` in the same file is the older form. It returns a legacy
`Transaction` and no verdict, and `scripts/guarded-swap.ts` still uses it.

**Without BELL's code**, the instruction is small enough to build with
`@solana/web3.js` alone. This is the whole of it (checked against devnet on 24
September 2026):

```ts
import { Connection, PublicKey, TransactionInstruction } from '@solana/web3.js'

const BELL = new PublicKey('56AUPR1c1Tq5AgMvAa3PASax61YYo1KTdocwW6pR7Pdx')
const ASSERT_TRADEABLE = Uint8Array.from([151, 32, 226, 185, 18, 114, 155, 21])
export const STRICT = 0
export const GUARDED = 1

/** The ticker, space-padded to 12 bytes: both a PDA seed and the first argument. */
function symbolBytes(symbol: string): Uint8Array {
  const out = new Uint8Array(12).fill(0x20)
  out.set(new TextEncoder().encode(symbol))
  return out
}

export async function gateFor(conn: Connection, symbol: string, mint: PublicKey, mode = STRICT) {
  const [symbolState] = PublicKey.findProgramAddressSync([Buffer.from('sym'), symbolBytes(symbol)], BELL)
  const [risk] = PublicKey.findProgramAddressSync([Buffer.from('risk'), mint.toBytes()], BELL)

  // TokenRisk.multiplier_bits: a u64 at byte 41 (discriminator 8, mint 32, paused 1).
  const info = await conn.getAccountInfo(risk)
  if (!info) throw new Error(`BELL has no risk record for ${mint.toBase58()}`)
  const bits = new DataView(info.data.buffer, info.data.byteOffset).getBigUint64(41, true)

  // discriminator (8) | symbol [u8; 12] | mode u8 | expected_multiplier_bits u64 = 29 bytes
  const data = new Uint8Array(29)
  data.set(ASSERT_TRADEABLE, 0)
  data.set(symbolBytes(symbol), 8)
  data[20] = mode
  new DataView(data.buffer).setBigUint64(21, bits, true)

  return new TransactionInstruction({
    programId: BELL,
    keys: [
      { pubkey: symbolState, isSigner: false, isWritable: false },
      { pubkey: risk, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(data),
  })
}

// const tx = new VersionedTransaction(new TransactionMessage({
//   payerKey: user, recentBlockhash, instructions: [await gateFor(conn, 'SPYx', mint), ...swapInstructions],
// }).compileToV0Message(lookupTables))
```

The standalone version skips the checks `guardInstructions` makes: that the
symbol's `mint` is the mint you trade, and that both records name the
attestor you trust. Read `SymbolState` and `TokenRisk` yourself (layouts
below) and make those checks. `TokenRisk.attestor` matters because it is the
key that labels a pending multiplier change a split or a dividend, which check
4 trusts, and whoever first calls `init_token_risk` for a mint names it.

**Practical notes.**

- **Size.** The gate adds 130 bytes when none of its keys is already in your
  transaction:
  - the 32-byte program id, which a v0 message cannot load from a lookup table
    (`solana-message`, `MessageV0::sanitize`: "reject program ids loaded from
    lookup tables");
  - the two 32-byte PDAs, which a lookup table can hold;
  - a 34-byte compiled instruction.

  A transaction's limit is 1,232 bytes. `scripts/examples/guard.ts` prints the
  figure for the transaction it builds.
- **Compute.** Measured on devnet on 24 September 2026, the gate used 5,068
  compute units when it passed and about 7,000 when it refused (6,971 for SPYx
  closed, 6,933 for IWMx stopped). A mint re-read used 5,333 more. If you set a
  compute-unit limit, leave room for these. The runtime scans the whole
  message for compute-budget instructions (`solana-compute-budget-instruction`,
  `ComputeBudgetInstructionDetails::try_from`), so where they sit relative to
  the gate does not matter.
- **`RiskStale` without depending on our re-reads.** BELL's keeper re-reads
  every mint every tick. If its attestations keep landing but its re-reads do
  not, the risk record ages past 600 s and the gate refuses with `RiskStale`.
  (If the whole keeper stops, the session goes stale first, at 120 s, and the
  gate refuses with `StateStale`, which no re-read of yours can clear;
  `constants.rs` explains the ordering.) `refresh_token_risk` is
  permissionless, so you can carry your own re-read. Pass `refreshRisk: true`, or put `refresh_token_risk`
  (accounts: the mint, then the risk PDA as writable; no arguments) in front of
  the gate. The cost is a write lock on that mint's risk account, which
  serializes every transaction that re-reads the same mint. That is why the
  option is off by default.
- **`expected_multiplier_bits`.** Read it from `TokenRisk` when you *quote*,
  not when you send. If a rebase lands between your quote and execution, the
  gate refuses with `MultiplierMoved` rather than settling a trade sized in a
  denomination nobody quoted.
- **A refusal usually costs nothing.** Wallets simulate before sending, see the
  gate refuse, and stop. If a refused transaction is sent past preflight anyway,
  it lands as a failed transaction and pays its fee. The README links to one
  that did (5,000 lamports, transfer absent).

### 2. CPI from a program: lending markets and vaults

A program can call the same instruction and get the same answer. If BELL
refuses, the CPI fails and your whole transaction aborts. A Solana program
cannot catch a failed CPI and carry on.

The sketch below uses Anchor's `declare_program!`, which needs only BELL's IDL,
not its crate. Save `src/chain/idl.json` as `idls/bell_session.json` in your
workspace. The README gives the address of the copy on chain. With a
`declare_id!` added, the sketch compiles (`cargo check`) against anchor-lang
1.2.0, BELL's own version. It was checked on 24 September 2026:

```rust
use anchor_lang::prelude::*;

// Your own declare_id!(...) goes here, as in any Anchor program.

declare_program!(bell_session);

use bell_session::{
    accounts::{SymbolState, TokenRisk},
    cpi::{self as bell, accounts::AssertTradeable},
    program::BellSession,
    types::Mode,
};

/// BELL's attestor on devnet. Both records are first-come, so pin the key you trust.
const BELL_ATTESTOR: Pubkey = pubkey!("EsZp7XusAj9fJ1ntQYCTMEw7h6L9mfZUtAvaXDxi4TcG");

#[program]
pub mod guarded_lender {
    use super::*;

    /// `expected_multiplier_bits` comes from your client, read from TokenRisk when it quoted.
    pub fn borrow_against(ctx: Context<BorrowAgainst>, expected_multiplier_bits: u64) -> Result<()> {
        bell::assert_tradeable(
            CpiContext::new(
                bell_session::ID,
                AssertTradeable {
                    symbol_state: ctx.accounts.bell_symbol.to_account_info(),
                    risk: ctx.accounts.bell_risk.to_account_info(),
                },
            ),
            ctx.accounts.bell_symbol.symbol,
            Mode::Strict,
            expected_multiplier_bits,
        )?;
        // Everything from here on runs only if the gate passed.
        Ok(())
    }
}

#[derive(Accounts)]
pub struct BorrowAgainst<'info> {
    /// CHECK: only its address is used, to tie BELL's record to the token you move.
    pub stock_mint: UncheckedAccount<'info>,
    #[account(
        constraint = bell_symbol.mint == stock_mint.key(),
        constraint = bell_symbol.attestor == BELL_ATTESTOR,
    )]
    pub bell_symbol: Account<'info, SymbolState>,
    /// BELL checks this is the risk PDA for `bell_symbol.mint`.
    #[account(constraint = bell_risk.attestor == BELL_ATTESTOR)]
    pub bell_risk: Account<'info, TokenRisk>,
    pub bell_program: Program<'info, BellSession>,
    // ... your own accounts
}
```

Notes:

- **The instruction.** The name, accounts and arguments match
  `programs/bell-session/src/lib.rs` and `instructions/assert_tradeable.rs`.
  There are two read-only accounts, `symbol_state` and `risk`, and no signer.
  The arguments are `symbol: [u8; 12]`, `mode: Mode` and
  `expected_multiplier_bits: u64`.
- **`bell_program` is required** even though `CpiContext::new` takes the
  program's id rather than its account (in anchor-lang 1.2). The runtime
  resolves a CPI's callee from the calling instruction's own accounts, and
  fails with "Unknown program" if it is not there (`solana-program-runtime`,
  `invoke_context.rs`).
- **Checking your own accounts.** `Account<'info, SymbolState>` checks the
  owner and the discriminator. BELL then checks both PDAs' seeds itself. The
  three `constraint`s are yours to keep. Without the first, a caller could pass
  the record for a different stock. Without the attestor checks, you trust
  whichever key registered that ticker first, and whichever key first created
  that mint's risk record, because both are first-come.
- **`expected_multiplier_bits`.** Passing
  `ctx.accounts.bell_risk.multiplier_bits` would make check 5 compare the
  record with itself. Take the value as an argument from the client that
  quoted.
- **Reading a refusal off chain.** It surfaces as `InstructionError` at *your*
  instruction's index with BELL's code, for example `Custom(6000)`. Anchor
  numbers your program's errors from 6000 too, so the code alone is ambiguous.
  The logs say whose it is: `Program 56AUPR…Pdx failed: custom program error:
  0x1770`, together with Anchor's `Error Code: MarketClosed` line.
- **Choosing what to guard is a policy decision.** A borrow against
  tokenized-stock collateral, a vault deposit priced from a pool, and a swap
  are natural fits. Think twice before guarding a liquidation. Refusing one
  during a halt protects nobody if the position is already underwater.

### 3. Ask without trading: a warning, or a bell order

The gate either succeeds or fails, so simulating it answers exactly what
execution would answer at that moment, for free, with nothing signed or sent.
`guardInstructions` returns this answer as `verdict`:

| field | meaning |
|---|---|
| `tradeable` | the gate passed. This is the only field to branch on. |
| `reason` | `BellError` name (e.g. `MarketClosed`); `AccountNotInitialized` / `ConstraintSeeds` when accounts were wrong; `Unavailable` when the simulation could not run |
| `message` | the program's own sentence for `reason`, from the IDL |
| `waitsForOpen` | refused only because the attested session is shut, with no halt attested: the case a bell order is for |
| `session` | the attested `openNow`, `halt`, `nextChangeAt` (while the market is shut, the open) and `observedAt`; times in Unix seconds |
| `unitsConsumed`, `logs` | from the simulation |

To reproduce it with your own code:

- **Simulate the gate alone.** It reads only its two accounts and the clock, so
  nothing after it in a transaction can change its answer.
- **Use a funded fee payer.** A user's fresh wallet with 0 SOL fails simulation
  with `AccountNotFound` before the gate runs. BELL's page once used the
  connected wallet and showed exactly that for a fresh one. It now uses the
  symbol's attestor as the simulation's fee payer, because that account is
  discoverable from chain, funded, and never charged for a simulation.
- **Pass `replaceRecentBlockhash: true` and `sigVerify: false`.** A
  load-balanced RPC can then never fail the simulation over a blockhash it has
  not seen (`simulate` in `src/chain/client.ts`).
- `checkGate` in `src/chain/client.ts` is the gate-only check, without the
  composition.

To read a simulation of the *whole* guarded transaction, as your wallet's own
preflight runs it, call `readVerdict(err, gateIndex)`. A failure at or before
the gate is a refusal. A failure after the gate means the gate passed and one
of your instructions failed, which BELL does not report as its refusal.

What to do with a refusal:

- **`waitsForOpen` is true** (a `MarketClosed` with `halt == 0`): as far as the
  chain says, nothing is wrong except the hour. This is where BELL's queue fits. A *bell order* parks
  the intent and fills after the open, funded by an SPL delegation, so the
  user's money stays in their wallet until the fill and `revoke` cancels it.
  The instruction is `place_order`, and the reference clients are
  `scripts/queue.ts` and `web/lib/queue.ts`. The README's "A refusal is not a
  dead end" explains the design. On devnet only BELL can mint the mirror stock,
  so in practice the filler there is BELL's own.
- **Anything else** (a halt, a withdrawal, stale state, a pause, a rebase, a
  hook): waiting for the open would not clear it. Show the reason. The
  program's sentence is in `message`.
- **`Unavailable`**, or a throw: you do not know the gate's answer. Treat it as
  a refusal. Even so, a transaction `guardInstructions` returned still carries
  the gate, so the chain decides again at execution.

A runnable version:

```bash
BELL_CLUSTER=devnet BELL_RPC_URL=https://api.devnet.solana.com \
  node scripts/examples/guard.ts SPYx            # add --guarded, --refresh
```

It wraps a stand-in swap (an SPL Memo instruction) and prints the verdict, the
reason and the session. It then simulates the whole guarded transaction and
reports whether the stand-in ran, plus the gate's compute and byte cost. It
holds no key and sends nothing. At about 23:20 ET on 23 September it printed
`REFUSED MarketClosed … offer a bell order … the swap never ran` for SPYx, and
`TRADEABLE … the swap ran` for SPYx with `--guarded`.

---

## Fail-closed, precisely

- **A silent attestor closes everything.** Session state older than 120 s
  refuses with `StateStale`. BELL's keeper attests every 45 s, so a dead keeper
  closes every symbol within about two minutes of its last attestation.
- **An unread mint closes its symbol.** A risk record older than 600 s refuses
  with `RiskStale`. Anyone can re-read it, including you, in the same
  transaction.
- **A missing or wrong account aborts.** An unregistered symbol fails with
  `AccountNotInitialized` (3012). A risk account that is not the one for the
  symbol's mint fails with `ConstraintSeeds` (2006). Both were measured on
  devnet. If you prepend the gate for a mint BELL does not cover, every
  transaction fails, so decide your policy for uncovered mints before you
  prepend.
- **A refusal aborts the whole transaction,** prepended or by CPI. Nothing
  after the gate runs, and a program cannot catch it.
- **The verdict is advisory; execution is binding.** The gate runs again at
  execution, against the attestation on chain and the clock of the slot that
  executes it. A transaction built while the session was open is refused if
  it lands after BELL has attested the close. In `Strict` mode the edge of the
  session is therefore no sharper than the keeper's 45 s tick.
- **Not fail-closed against a leaked attestor key.** Whoever holds it can
  attest a symbol open when it should be shut, and a swap you guarded with
  `assert_tradeable` then passes. Your swap gets neither of the bounds BELL's
  own orders have (the loss floor and the $1,000 cap). It is limited only by
  your own slippage. The README's "What you must trust" covers this in full.

---

## Error codes

All codes come from `src/chain/idl.json` (`errors`). `BellError` codes are
append-only, and the client decodes by offset from 6000. The hex form is what
the runtime logs, for example `custom program error: 0x1770`.

**What the gate raises** (`assert_tradeable`, and `fill_order`, which runs the
same `check_tradeable`; `place_order` also raises 6002 for a frozen quote
token account, and 6008 for accounts that name the wrong mint):

| code | hex | name | program's message | meaning for you |
|---|---|---|---|---|
| 6000 | 0x1770 | `MarketClosed` | Market is closed or trading in this security is stopped | Shut session (Strict), or any halt or withdrawal (both modes). `SymbolState.halt` says which. |
| 6001 | 0x1771 | `StateStale` | Session state is stale; treated as closed | BELL's attestations stopped arriving. Nothing you can fix. |
| 6002 | 0x1772 | `IssuerPaused` | Issuer has paused this mint | The issuer froze transfers. |
| 6003 | 0x1773 | `RebasePending` | A scheduled rebase activates inside the guard window | Within 900 s either side of a multiplier change. |
| 6004 | 0x1774 | `RebaseUnclassified` | Pending corporate action is neither a split nor a dividend | A change is scheduled and not yet labelled. |
| 6005 | 0x1775 | `MultiplierMoved` | The multiplier changed after this order was built | Re-quote: the denomination moved since you read it. |
| 6006 | 0x1776 | `HookArmed` | A transfer hook is armed on this mint | Settlement semantics changed. |
| 6026 | 0x178a | `RiskStale` | The issuer's mint state has not been read recently enough to trust | Put `refresh_token_risk` in front, or wait for the keeper. |
| 6008 | 0x1778 | `MintMismatch` | Symbol does not match the mint recorded for it | Declared on the gate's `risk` account. A wrong account fails the seeds check (2006) first, as measured. Also raised by `push_mark`, `place_order` and `fill_order`. |
| 2006 | 0x7d6 | `ConstraintSeeds` (Anchor) | A seeds constraint was violated | `risk` is not the PDA for the symbol's mint. |
| 3012 | 0xbc4 | `AccountNotInitialized` (Anchor) | The program expected this account to be already initialized | The symbol is not registered. |

**Raised by other instructions** (you meet these only if you call them):

| code | hex | name | program's message | raised by |
|---|---|---|---|---|
| 6007 | 0x1777 | `NotToken2022` | Mint is not owned by the Token-2022 program | `refresh_token_risk` / `init_token_risk`, `fill_order` |
| 6009 | 0x1779 | `NotAttestor` | Only the registered attestor may push session state | `push_session`, `push_mark`, `classify_rebase` |
| 6010 | 0x177a | `TimestampInFuture` | Attested timestamp is in the future | `push_session`, `push_mark` |
| 6011 | 0x177b | `MarkStale` | The price mark is stale | `fill_order` |
| 6012 | 0x177c | `MarkTooWide` | The mark's uncertainty exceeds what this order accepts | `fill_order`, `push_mark` |
| 6013 | 0x177d | `PriceOutOfBand` | Delivered less than the order's minimum acceptable output | `fill_order` |
| 6014 | 0x177e | `NotYetDue` | The order is not yet due to fill | `fill_order` |
| 6015 | 0x177f | `OrderExpired` | The order has expired | `fill_order` |
| 6016 | 0x1780 | `OverFill` | Fill exceeds the amount remaining on this order | `fill_order` |
| 6017 | 0x1781 | `FillTooSmall` | Fill is smaller than the order's minimum | `fill_order` |
| 6018 | 0x1782 | `DelegationMissing` | The quote account is not delegated to this order's authority | `place_order` |
| 6019 | 0x1783 | `QuoteMintMismatch` | Token account mint does not match | `place_order`, `fill_order`; also any token account that does not unpack (`place_order`, `cancel_order`, `fill_order`) |
| 6020 | 0x1784 | `NotOrderOwner` | Only the order owner may do this while the order is live | `cancel_order` |
| 6021 | 0x1785 | `AmountTooLarge` | Order amount is outside the permitted range | `place_order` |
| 6022 | 0x1786 | `MathOverflow` | Arithmetic overflow | `fill_order` |
| 6023 | 0x1787 | `BadParameters` | Parameter outside the permitted range | `place_order`, `push_mark` |
| 6024 | 0x1788 | `TokenOwnerMismatch` | Token account owner does not match | `place_order` |
| 6025 | 0x1789 | `TokenProgramMismatch` | Account is not owned by the token program it is claimed to belong to | the queue's token-account reads (`place_order`, `cancel_order`, `fill_order`) |

`errorName(code)` in `src/chain/codec.ts` maps codes to names from the IDL.
`readVerdict` in `src/chain/guard.ts` adds the program's message and the two
Anchor codes above.

---

## Accounts, PDAs and layouts

| account | seeds (program `56AUPR1c1Tq5AgMvAa3PASax61YYo1KTdocwW6pR7Pdx`) | in the gate |
|---|---|---|
| `symbol_state` (`SymbolState`) | `"sym"`, then the ticker as 12 bytes, space-padded (`"SPYx"` + 8 × `0x20`) | read-only, first |
| `risk` (`TokenRisk`) | `"risk"`, then the 32-byte mint | read-only, second |

Instruction data is 29 bytes, little-endian:

| discriminator | `symbol` | `mode` | `expected_multiplier_bits` |
|---|---|---|---|
| `[151, 32, 226, 185, 18, 114, 155, 21]` | `[u8; 12]` | `u8` (0 Strict, 1 Guarded) | `u64` |

The discriminator is the first 8 bytes of `sha256("global:assert_tradeable")`.
`refresh_token_risk` is `[237, 154, 130, 127, 250, 102, 35, 148]` with no
arguments.

**`SymbolState`**, 108 bytes, discriminator `[37, 39, 220, 29, 61, 155, 229, 71]`.
Offsets: `symbol` 8..20 · `mint` 20..52 · `exchange_mic` 52..56 · `hours_mode`
56 · `halt` 57 · `open_now` 58 · `next_change_at` i64 59..67 · `observed_at` i64
67..75 · `attestor` 75..107 · `bump` 107. `halt` values (`state.rs`, `HaltState`):
0 None, 1 LULD pause, 2 news pending, 3 market-wide circuit breaker, 4
suspension, 5 unspecified. The issuer withdrawing its own token reads as 5; it
is not an exchange halt.

**`TokenRisk`**, discriminator `[173, 99, 234, 203, 30, 82, 77, 213]`. The fixed
prefix: `mint` 8..40 · `paused` 40 · `multiplier_bits` u64 41..49 (an `f64`'s raw
bits, compared exactly) · `pending_multiplier_bits` 49..57 · `activates_at` i64
57..65 · `rebase_kind` 65. After that come two Borsh `Option<Pubkey>` fields
(`hook`, `permanent_delegate`), so later offsets vary: `verified_at`,
`attestor` and `bump` follow them. `decodeTokenRisk` in `src/chain/codec.ts`
reads the whole record.

**The live devnet deployment**, read from chain on 24 September 2026:

| symbol | devnet mint (BELL's mirror) | the real mainnet mint (no BELL deployment there) |
|---|---|---|
| SPYx | `AFrGCsmPc3WeUAEM3jw8Ec3M6BrKrJGDQeX2g1Ctrrwx` | `XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W` |
| NVDAx | `G5J2MqRTn1LQMdXazK6Cm7TJo2VcCizij1e63tDnmhBM` | `Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh` |
| QQQx | `9PzL1Z5HUFbM5PKHw7TUKyUuejnNhXxjQm6KkHhjVnFj` | `Xs8S1uUs1zvS2p7iwtsG3b6fkhpvmwz4GYU3gWAmWHZ` |
| TSLAx | `7CSbB2uXQwh6NfkdAonyAfDg679ZXQEP6paAWZ455Ewg` | `XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB` |
| AAPLx | `Fpd6EgE5KJgN5UZgKtABNtgP3Be2RNktdFheJSwLTCHC` | `XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp` |
| IWMx | `9tnBMc7cwaGNAKDHJKhHbL4buWJET5TqVcPZAC4yQ2aY` | `XsbELVbLGBkn7xfMfyYuUipKGt1iRUc2B7pYRvFTFu3` |
| JPSTx | `GBkd15Z3AAqUEHDDYoW2373PASazzsvBvPq2dqkJT43L` | `XsCAXu7xTaZMG9b9KJhNWYapuvNjxPuE4SysZq8uvMq` |
| PFE | `7qtvrsM1XCTwzJVM7d5zNWNmW4vtsrktjoEJg27xB5Rq` | `PFER6ENqP8r8NF3CqVt4mFowxsin3V5MLidBNQFCC3x` |
| LMT | `Ce9q1o7GYAH7YxPoQvMDb5UDyuw1G4QLtqCWYyby19nf` | `LMT3i1BHgixFqPUgcyteJhnEz2dpy9i3cYy4pi9BoeV` |

Every one of the nine `SymbolState` and `TokenRisk` records names the attestor
`EsZp7XusAj9fJ1ntQYCTMEw7h6L9mfZUtAvaXDxi4TcG`. The devnet mints are in
`src/mirrors.json` and the mainnet ones in `src/listings.ts`. SPYx's PDAs are
`BSiAQguanExJXTuf5PbPwYVFMbbmDp2ei4KPPZVDBQJN` (symbol) and
`8Dwi6a2DLHB7UZomuCE9PFuSWjrhQdNkLJWSo97U2rNi` (risk).

---

## What it cannot do

- **It does not price your swap.** The gate never sees your amounts, your
  route or your minimum output. It answers whether the security is in a state
  where trading is sane, not whether *this* trade is a good price. Your
  slippage bound is still your only price protection. That matters most in
  `Guarded` mode off-hours, when nothing is arbitraging the pool against a
  live market. BELL's price mark is not read by the gate; it prices BELL's own
  queue.
- **It does not know which token your instructions move.** It is keyed by
  symbol, and your swap moves a mint. Tie them together yourself:
  `guardInstructions` does it, and the CPI sketch does it with a `constraint`.
- **It covers only what is registered.** That means nine symbols, on devnet,
  over mirror mints. Registration (`register_symbol`) is permissionless and
  first-come, so a record exists under a ticker only if someone created it,
  and it is worth only the attestor it names.
- **It cannot stop a permanent delegate.** All nine real mints have one. It
  can move tokens out of any holder's account without their signature. BELL
  records it in `TokenRisk.permanent_delegate`; that is a disclosure, not a
  defence.
- **It cannot see an unannounced multiplier change.** Token-2022 lets the
  issuer's multiplier authority set an effective time of zero or in the past,
  which applies the change immediately with no pending state. Check 4 measures
  its window from that time, so zero, or a time more than fifteen minutes gone,
  leaves it nothing to refuse. Check 5 catches a trade built on the old
  multiplier, but a trade built after the change is not protected.
- **It is not a compliance product.** BELL is not a registered Tokenized
  Securities Venue. See the README, "On the regulatory framing".

## What you are trusting

The README's "What you must trust" is the full account. In brief:

- **One hot attestor key** attests sessions, halts, marks and split/dividend
  labels. Silence fails closed. A leak does not (see above).
- **The upgrade authority is live**
  (`Dqp6DbUh6j5Jddff9VHPAK1UpByo85NhLVw83S58Ziqs`) until it is burned. A
  malicious upgrade could change what `assert_tradeable` answers.
- **Attestations are not monotonic.** `push_session` accepts a timestamp older
  than the one it replaces.

## Checking this document

- `node --test test/guard.test.ts`: the composition order, the verdict
  mapping, the refusals to build a transaction that guards the wrong thing, and
  that `guarded()` still returns a legacy transaction with the gate at 0.
- `BELL_CLUSTER=devnet BELL_RPC_URL=https://api.devnet.solana.com node
  scripts/examples/guard.ts <SYMBOL>`: the live verdict, the compute cost, the
  size, and whether the stand-in swap ran.
- The error table is `src/chain/idl.json`'s `errors`, and the "raised by"
  column comes from searching `programs/bell-session/src` for each
  `BellError::` variant.
