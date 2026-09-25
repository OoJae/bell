# Adversarial review

An automated adversarial review (84 AI agents) of the delegation and queue
surface, run before the devnet deploy. It is not a third-party audit.

**Method.** Six independent reviewers, one per risk dimension: delegation and
authority, fill arithmetic, account validation, order lifecycle and rent,
fail-closed behaviour of the gate, and client/program codec parity. Each
reviewer read the code with no knowledge of the others' findings.

Every finding then faced three further reviewers whose instruction was to
**refute** it, each through a different lens — is it reachable, is it already
prevented somewhere the finder did not read, and is the finder simply wrong
about what the code does — with instructions to default to *refuted* under
uncertainty. A finding survived only if at least two of three failed to kill it.

**Result: 26 raised, 5 confirmed + 1 hardened.** The hardened one, #4, was
refuted and fixed anyway. 84 agents: the six finders, and three refuters for
each of the 26 findings.

The 21 refuted matter as much as the 5 confirmed. Several were plausible and
specific — "a filler can substitute their own account for the user's",
"`min_out` truncates to zero on small legs", "partial fills let a filler pick a
new mark each time" — and each was killed by a reviewer who found the constraint
that already prevented it. A review that confirms everything it raises is not a
review.

The sections after the first record what came later, in order: two findings
from checking the live deployment, a post-deploy study, sell orders, and
upgrade #2 (the circuit breaker, the checker, night fills and the cross) with
its own reviews. Fixed findings are numbered straight through.

---

## Fixed

### 1. Anyone could write `rebase_kind` on any mint — HIGH, 3/3 lenses held

Found independently by two dimensions, which is usually a sign something is
really there.

`classify_rebase` was the only account context in the program whose
`symbol_state` carried no seed constraint, so any account of type `SymbolState`
was accepted. Its two constraints — that the symbol's mint matches the risk
record's, and that the signer is the symbol's attestor — were therefore the
whole gate. And `register_symbol` is permissionless, taking both the mint and
the attestor as caller-supplied arguments.

So: register an unused ticker naming a real mint, name yourself its attestor,
and you hold write access to that mint's `TokenRisk` — which is shared by every
symbol referencing that mint.

Both directions were live. Setting `Unknown` froze every symbol on the mint
indefinitely, for one transaction a time. Clearing it to `Split` disarmed gate 4
during an unclassified corporate action, which is exactly the dividend-drain the
gate exists to refuse.

**Fix.** `rebase_kind` is a fact about the *mint*, so the symbol was never the
right place to look for authority over it. `TokenRisk` now records its own
attestor, named at creation, and `ClassifyRebase` drops the `SymbolState`
account entirely — removing the crossover rather than constraining it.
`init_token_risk` takes the attestor as an argument, as `register_symbol`
already did, so rent can be paid by a cold key while a hot key holds the
attestation authority.

Regression test: `a_stranger_cannot_classify_a_rebase` performs the exact
escalation — squats a ticker on a real mint, then tries to classify.

### 2. The rebase guard's second half was removable by anyone — HIGH, 3/3

Gate 4 refuses within `REBASE_GUARD_SECONDS` either side of a multiplier
activation, measured as `|activates_at - now|`. But once the activation passed,
`read_mint` returned `activates_at = 0`, and gate 4 was wholly conditional on
that field being non-zero. Since refreshing is permissionless, anyone could
delete the post-activation half of the guard by calling refresh one second after
the activation.

That is the dangerous half. A dividend steps value-per-raw-unit up at a known
instant and leaves the pool stale-low by exactly the dividend until arbitrage
catches up — the drain happens *after* the timestamp, not before.

**Fix.** The activation instant is retained once it passes, so `|at - now|`
covers both halves. The classification requirement was split into its own check
keyed on `pending_multiplier_bits`, because holding it open forever would have
permanently frozen any mint that ever rebased unclassified — a self-inflicted
denial of service in the course of fixing a real one.

Regression test: `the_activation_instant_survives_the_change_taking_effect`,
against Netflix's real mint and its past-dated 10:1 split.

### 3. `read_token_account` never checked who owned the account — MEDIUM, 3/3

The function's own comment claimed the owning program was "checked by the caller
against the program account it will actually transfer through." No caller did.

Every fact it returns — owner, mint, delegate, delegated amount, frozen — was
therefore attacker-supplied for anyone willing to pass an account owned by a
program they wrote. A reader the rest of the program trusts for authorisation
decisions has to establish that itself.

**Fix.** The check moved into the function. `fill_order` passes the program each
leg will actually move under, so an account cannot be read under one token
program and transferred under another; `place_order` and `cancel_order` use a
variant that requires the owner to be one of the two real token programs.

Regression tests: `an_order_cannot_be_placed_against_an_account_no_token_program_owns`
and `a_leg_is_read_under_the_token_program_it_moves_under`.

### 4. Both token programs in `fill_order` were unconstrained — MEDIUM

Refuted, not confirmed — the reviewers killed the exploits built on it, because
`require!(taken <= amount_in_leg)` measures the user's account after the transfer
and bounds what any callee could take. Fixed anyway: `fill_order` hands its
callee a CPI signed by the per-owner delegate authority, and an arbitrary
program in that position is a primitive worth refusing to create even when the
measurement contains it. Both legs are now pinned to SPL Token or Token-2022.

Regression test: `fill_order_refuses_a_leg_program_that_is_not_a_token_program`,
which pins the refusal to `fill.rs` by the log line, before any cross-program call.

### 5. The browser could not place or cancel an order at all — HIGH, 3/3

`orderPda` derives its seed with `Buffer.writeBigUInt64LE`, which the browser's
Buffer polyfill does not implement. Both the place and the cancel path go
through it.

This one is embarrassing in a useful way: the same trap had been found and
written up in `FRICTION.md` two hours earlier, fixed in `codec.ts`, and missed
here because the seed is *derived* rather than encoded — and because the browser
module was verified by running it under Node, where the method exists.

**Fix.** `DataView`, and a test that removes six `Buffer` methods, among them
the four BigInt ones the polyfill lacks, before importing anything, so a shared
module that reaches for one fails in CI rather than on the page. Verified to
have teeth by reintroducing the bug: three tests fail.

### 6. A second order silently defunded the first — HIGH, 2/3

A token account has one delegate slot holding one amount, and SPL `Approve`
**assigns** rather than adds. The client approved only the new order's size, so
placing a second order left the first unfundable — and a defunded order is
garbage-collectable by anyone, so a stranger could then close it.

The dissenting reviewer was right that the program side is working as designed
and tested: in a non-escrow venue, a delegation below an order's remaining *is*
the cancel, and rent always returns to the owner, so nothing is stolen. The
defect is in the client, and in a UI that showed a dead order as "waiting for
the bell".

**Fix.** Each client re-approves the whole book — the sum of what is still owed
across live orders, plus the new one — and the page states the delegated total
and that a revoke cancels all of them, because one token account has one
delegate. The CLI kept approving one order's size until
[c91ae43](https://github.com/OoJae/bell/commit/c91ae432547d5439e7b89cef8256a8ccf105dcad).

---

## Reopened after deploy

Two findings came from checking the *live* devnet deployment against the
product's own claims, hours after it went up. Both are recorded here because
"reviewed before deploy" should describe what is deployed, not what was.

### 7. Four of seven gates read a registration-day snapshot — HIGH

One of the 21 findings the refuters killed was *"check_tradeable never
bounds the age of the TokenRisk account it trusts."* The reasoning for killing
it was sound: `refresh_token_risk` is permissionless, so nobody can stop the
record being brought up to date.

That defends against someone **blocking** a refresh. It does nothing about
everyone **skipping** one — and on the live deployment, everyone did. The
builder existed in the client; no script and no keeper ever called it. From
registration onward `TokenRisk` held what the mints said at registration, and gates 3
(pause), 4 (rebase), 5 (multiplier moved) and 6 (hook) read it. A dividend
scheduled on the mint would never have been seen. The party that profits from a
stale record — someone trading through a dividend — is precisely the party that
never refreshes it.

**Fix, in two parts.** The keeper re-reads all nine mints every tick, in its own
transaction, isolated so a failed re-read never costs the session push. And the
program now refuses to trust a stale read at all: gate 2b rejects a record older
than `MAX_RISK_AGE_SECONDS` (600) with `RiskStale`. The value is checked at
compile time against both neighbours — no more than `REBASE_GUARD_SECONDS`, so a
record read before an activation can never still pass after the window closes;
no less than `MAX_STATE_AGE_SECONDS`, so a dead keeper still reads `StateStale`
first. It cannot hold the venue shut, because anyone may put a refresh in front
of their own transaction. The order path and the filler now do exactly that.

Regression test: `a_dividend_walked_end_to_end_on_the_real_apple_mint` walks the
real AAPLx mint's own scheduled step through every state, including a record
left unread past the window.

### 8. The UI copied an enum in the wrong order — MEDIUM

`RebaseKind` is `None, Split, Dividend, Unknown` on chain. The page held its own
copy with `Unknown` second. During a rebase it would have rendered an
unclassified change as "pending Dividend" and tradeable, while the program
refused it — the board contradicting the chain in front of a viewer, which for
this product is the worst failure available. Every TypeScript mirror of an
on-chain enum is now checked against the IDL's variant order, and the test fails
with the old order.

The same pass found the board letting an informational row ("price fresh", which
gates a fill, not `assert_tradeable`) decide its verdict. Rows now declare which
refusal they stand for; the ones that stand for none do not vote.

---

## After the post-deploy study

A second automated adversarial review, run after the devnet deploy:
196 AI agents, 62 findings raised, 53 survived refutation, merged into 22 items.
Its report is not in this repo. Six of its items belong in this record. Unless
noted, the fix is in
[c91ae43](https://github.com/OoJae/bell/commit/c91ae432547d5439e7b89cef8256a8ccf105dcad).

9. **`MarketClosed` called every refusal an exchange halt.** Error 6000 read
   "Primary listing exchange has halted or suspended this security", printed for
   SPYx on any weeknight and for an issuer's withdrawal. A message-only upgrade
   on Wed 23 Sep, 15:32 ET, in [slot 503099324](https://explorer.solana.com/tx/2n76MxQTgdKhMqy4vv9E8rX47PQGXqad6ucVKLC2X6uXd8ForsanJEP6AHkzuSiQ3sy4V6vj4ScAK9sd1pXzp46G?cluster=devnet),
   changed it to "Market is closed or trading in this security is stopped" and
   `StateStale` to "…treated as closed"; every error code kept its number, and the
   deployed bytes are the tested build (sha256 `cc5f462f220cb0c0…`, 312,640 bytes).
10. **The halt feed was judged by each ticker's oldest halt.** Nasdaq's feed lists
    halts newest first and the parser kept the last row per ticker, so a stock
    halted, resumed and halted again read as resumed. It now keeps the latest
    halt, tested against the feed as captured on 22 Sep.
11. **A missing Pyth feed failed open.** For a US listing with no Pyth feed,
    reconciliation trusted Backed's 24/5 flag, which reads open all night, so a
    feed that dropped a ticker would have opened it overnight and let parked
    orders fill. It then read closed until the feed returned; since 24 Sep a
    local NYSE calendar stands in for a missing feed, so such a listing is open
    only during the regular session and while the issuer trades it, and closed
    overnight exactly as before.
12. **Cancel's revoke was not independent of BELL.** The page sent the SPL
    `revoke` in the same transaction as `cancel_order`, so any failure in BELL's
    instruction rolled the revoke back. Cancel now sends the revoke alone, then
    the close, then re-approves any other orders — never before the close, which
    would leave the cancelled order fundable — and a "Revoke all funding" button
    shows while any approval is outstanding.
13. **One unchunked read let anyone stop every fill.** The crank read every
    order's funding account in one `getMultipleAccounts` call, which the node
    refuses above 100 keys, so enough dust orders, each costing only refundable
    rent, would have made every crank pass throw. Batched reads now split under
    the limit.
14. **Orders had no loss floor.** The page and the CLI placed every order with
    `floor_rate_q64 = 0`, so a leaked attestor key could open a symbol, push a
    near-zero mark and fill parked orders for dust. Both now set a floor at three
    quarters of the placement-time mark; the program accepts any floor, and an
    order placed before a symbol's first mark has none.

Found since, while reviewing the new program tests on Wed 23 Sep, and fixed
with sell orders in `64549f0`:

15. **A stranger could not close an order whose quote account was gone.** On
    the stranger path `handle_cancel_order` read `payer_in` with `?` before
    checking expiry, so once an owner closed their quote account, the unreadable
    account was an error rather than proof of defunding. Nobody but the owner
    could close that order, live or expired, and reclaim its rent. First
    disclosed here for expired orders only; the live case was the same. No
    funds were at risk. The fix: an expired order is closed without reading the
    account at all, and a live one whose funding account no longer reads as a
    token account counts as defunded, as a revoked one does. `cancel_sell_order`
    applies the same rule to a sale's stock account. Regression tests:
    `a_stranger_may_close_a_live_order_whose_quote_account_was_closed` and
    `a_stranger_may_close_an_expired_order_whose_quote_account_was_closed` in
    `test_queue.rs`, and `a_stranger_may_close_an_expired_or_defunded_sell` in
    `test_sell.rs`. On devnet it shipped in the same program upgrade as sell
    orders (below).

---

## Sell orders

Added in `64549f0`, after both reviews above; neither covered them. The program
gains `place_sell_order`, `fill_sell_order` and `cancel_sell_order`, and a
`SellOrder` account under its own seed (`"sell"`). No existing account, event
or error changed; the one change to an existing instruction is #15. The 19
tests in `test_sell.rs` run against the real mainnet AAPLx mint's bytes, and
the six-decimal case against Backpack's PFE.

Deployed to devnet on Thu 24 Sep at 09:49 ET, in
[slot 503496372](https://explorer.solana.com/tx/2Mmp8hXoDEuFP5yYe8EtXxwanfamWW8nfVm9SNterqNMMfMr6daDYFUsiYukWanHboBpyje53mEMyoaj55vfeUzJ?cluster=devnet):
the first 376,192 bytes of the program account hash to the tested build
(sha256 `27645cd263805479…`) and the rest is zero padding. The first sale on
devnet filled at 10:04:28 ET ([transaction](https://explorer.solana.com/tx/4trvXZHKDPrjqSjkwshjiiztct3uwPQUXdaTK8Td5i5v5yGGH6fZPmWsQd1gRf3L4eWCLGYNRon1qUYuWoEW9VDm?cluster=devnet)).

**What holds, and where it is tested.**

- **Funding.** A sale's delegation is on the seller's stock account, under
  Token-2022, to the same per-owner authority a buy uses, for what that
  account's live sales still need. The demo-USDC approval that funds buys is
  never touched by a sale (`test/web-sell.test.ts`). `place_sell_order`
  refuses a sale the stock delegation does not already cover
  (`a_sell_cannot_be_placed_without_a_stock_delegation`). A buy and a sale are
  different account types, and each fill and each cancel refuses the other's
  on its discriminator (`a_buy_and_a_sell_with_the_same_nonce_are_different_orders`,
  `neither_cancel_closes_the_other_kind_of_order`).
- **Settlement.** The filler's quote is delivered first and measured in the
  seller's account; only then is the stock taken, under the authority's
  signature (`a_due_sell_fills_while_the_market_is_open` checks the order of
  the two transfers). A short payment is refused with `PriceOutOfBand` and
  nothing moves (`a_sell_below_the_band_is_refused_and_moves_nothing`). Both
  token programs are checked before either is called
  (`fill_sell_order_refuses_a_leg_program_that_is_not_a_token_program`). The
  fill runs the same Strict gate and the same 60-second mark limit as a buy
  (`the_sell_fill_runs_the_same_gate_and_freshness_checks`).
- **Rounding.** Every minimum on a sale rounds up, in the seller's favour: the
  stock's value at the mark, the band edge below it, and the floor
  (`stock_to_quote_ceil`, `mul_shr64_ceil` in `sell.rs`). The $1,000 value cap
  rounds down, so a sale worth exactly $1,000 at the mark passes and one raw
  unit of stock more does not
  (`the_value_cap_is_a_quote_amount_and_binds_at_exactly_1000_dollars`). A
  buy's band still truncates; `FRICTION.md` says why the two differ.

**Documented, not prevented.**

- **A filler can aim the stock at the seller's own account.** `filler_in` is
  the filler's own business, so nothing stops a filler naming the seller's
  stock account there. The take is then a transfer from that account to
  itself: the seller is paid in full, keeps every share, and the order is
  recorded as filled and closes. Only the filler loses. A self-transfer does
  not draw the delegation down, so the seller's approval on that account stays
  standing. Nothing can use the excess: the only instructions that sign as
  the authority take from an account a live order pins, and never more than
  that order has left. It stays until the seller revokes it, or places or
  cancels another sale from that account, which resets it to what their live
  sales need. The page lists
  it under "BELL may … sell up to", and **Revoke all funding** revokes it
  (`a_filler_aiming_the_stock_at_the_users_own_account_pays_for_nothing`).
- **The value cap is sized against the mark at placement, which need only
  carry a price.** `place_sell_order` refuses a mark with a zero rate
  (`a_mark_that_was_never_pushed_refuses_the_sell`) and does not check its
  age, so a sale placed while the mark is old is capped at the old price. The
  fill still refuses a mark more than 60 seconds old.
- **Partial fills each round up.** A sale filled in pieces can be paid a few
  raw quote units (millionths of a demo-USDC) more in total than one fill of
  the whole would pay, and never less: one unit more in
  `a_partial_sell_leaves_the_delegation_equal_to_the_remainder`. The page and
  `scripts/queue.ts` place every sale all-or-none, so only an order placed by
  another client can fill in pieces.

---

## Upgrade #2

The circuit breaker, the checker, night fills and the opening cross. The
program is commit `2787198`; the clients are `1a8d6eb` and `65feb8d`. None of
the reviews above covered them. They had their own, below, before they
deployed to devnet on Thu 24 Sep.

### What was built

- **A circuit breaker on the mark** (`mark.rs`). A push may move the mark by at
  most `MAX_MARK_STEP_BPS` (500) scaled by the observation time since the mark
  on record, up to 60 seconds, so at most one 5% step a minute however the
  pushes are split. A bigger jump is held: the old rate stays, `conf_bps` is
  set to 65535, `MarkTripped` is emitted, and every fill refuses until a push
  lands inside the step or 300 seconds pass (`MAX_MARK_STEP_AGE_SECONDS`):
  `MarkPaused` (6027), or `MarkStale` (6011) once the held observation is a
  minute old, since `admit` checks the mark's age first. The hold returns `Ok`: an error would fail
  the keeper's whole batch of marks, and would roll the hold marker back along
  with the push. An observation older than the one on record is now ignored
  rather than written.
- **A second signer** (`check.rs`). `open_check` creates a symbol's
  `SymbolCheck` and names its checker, once. Only the program's upgrade
  authority can call it, read from the program's own ProgramData account
  (`NotAuthority`, 6028), and the checker may be neither the attestor nor the
  default key. `push_check` is the named checker's alone (`NotChecker`, 6029).
- **One admission test** (`admit.rs`), which every fill and every cross calls:
  due, the gate, the mark, then the check. The check must be under 120 seconds
  old and agree about the session (`CheckStale` 6030, `CheckerDisagrees` 6031).
  Its reference must be under 300 seconds old in session and 12 hours at
  night, and the mark within 300 bps of it in session and 150 bps at night
  (`MarkOffReference` 6032). The bounds are `#[constant]`s in `constants.rs`,
  and the compiler checks how they order against each other.
- **Night fills** (`night.rs`). `opt_in_night` creates a `NightOptIn` at
  `["night", owner]`; `opt_out_night` closes it. While the attested session is
  shut, an opted-in owner's order is admitted as `Guarded`, which lifts gate 7
  alone, the checker must say closed, and the fill must also deliver the
  reference less 150 bps (`fill.rs`, `sell.rs`).
- **The opening cross** (`cross.rs`). `cross_orders` settles a due buy against
  a due sale of the same symbol from different owners at the mark, each leg by
  its own owner's delegation, between accounts the orders pin. The buyer
  receives exactly `fill_order`'s fair amount; the seller at least what
  `fill_sell_order` would owe, by the same functions (`buy_min_out`,
  `sell_min_out`). Both are admitted `Strict`, so it runs in session only. One
  owner's pair is refused (`SelfCross`, 6033).
- **Fills take 17 accounts.** `check` and `night` are appended after the 15
  there were, so a filler built for the old form fails with Anchor's 3005
  (`AccountNotEnoughKeys`) before any handler code runs, rather than skipping
  the check (`the_old_fifteen_account_fill_is_refused_not_a_bypass`).
- **Every existing error code kept its number.** Seven were appended: 27
  became 34. The IDL went from 14 instructions to 19.

64 new program tests: `test_check.rs` 15, `test_cross.rs` 17, `test_mark.rs`
15, `test_night.rs` 17. With `test_ondo.rs`'s 8 on Ondo's real mints (from
`87f55cd`), the suite is 136.

### How it was reviewed

Automated adversarial review by AI agents, not a third-party audit. Two
reviewers read the program independently, re-ran every test and wrote their
own probes against the binary; a third applied the findings. Then one reviewer
read the services (the keeper, the checker, the crank, `open-checks.ts` and
the client) and one the page. Their reports are not in this repo. What they
found:

### Found and fixed

**16. The breaker could be walked inside one transaction — MEDIUM, both
program reviewers.** As first written, each push could move the mark 500 bps
from the rate it replaced, and a push at the same `observed_at` was accepted.
So pushes each one step from the last compounded: ten in one transaction moved
the mark +63%, and after a hold, the same walk from the held rate cleared it at
the rate that had tripped it. **Fix:** the allowance scales with the
observation time since the mark on record, capped at 60 seconds, so a push at
the time on record cannot move the rate at all, and the drift is at most one
step a minute however the pushes are split. 60 rather than 300: at the
keeper's roughly one push a minute its own pushes keep about 475 of the 500
bps, where a 300-second window would leave about 95 and hold marks in an
ordinary fast market. The doc comments now say what the breaker is: it catches
a faulty push and slows a compromised attestor, and the checker's band is what
stops one. Regression tests, in `test_mark.rs`:
`pushes_at_the_time_on_record_cannot_move_the_mark`,
`a_walk_split_across_seconds_moves_no_faster_than_one_step_a_minute`,
`a_held_mark_cannot_be_walked_on_to_the_rate_that_tripped_it`,
`the_step_allowed_grows_with_the_time_since_the_mark` and
`the_breaker_cannot_be_reset_by_backdating_in_the_same_transaction`.

**17. The session reference's age was unbounded — LOW, program reviewer 1.**
In session only the check's `observed_at` had to be recent; `ref_at` was
bounded only at night. A checker whose price feed had stuck, but whose loop
kept pushing, would go on agreeing with the attestor about a price from before
the feed stopped. **Fix:** `MAX_SESSION_REF_AGE_SECONDS` (300), checked at
compile time to be at least the check's own 120 and at most the night's 12
hours, refusing as `CheckStale`. The checker also pushes nothing for a symbol
whose last sale is over 300 seconds old in session. Regression test:
`a_session_fill_against_a_stuck_reference_is_refused`.

**18. Every fill paid for a bump search priced by the owner's key — LOW,
program reviewer 2.** The `night` account was constrained by its seeds with
Anchor's bare `bump`, which searches down from 255 at about 1,500 compute units
a step. Measured in the review, a buy fill cost 29,732 units for an owner whose
opt-in address had bump 255, and 53,732 at bump 239. **Fix:** the fill no
longer checks the address. `night::opted_in` accepts the account only if this
program owns it, it carries the `NightOptIn` discriminator, and it records the
order's owner. That is equivalent, since only `opt_in_night` creates such an
account and it records its signer. A buy fill then cost 28,198 units at every
bump. Two effects outside the program: the IDL no longer carries a PDA for
`night`, so clients derive `["night", owner]` themselves, and a stranger's
opt-in now refuses as `MarketClosed` (6000) at night, not `ConstraintSeeds`.
Regression tests, in `test_night.rs`: `a_fill_costs_the_same_whoever_the_owner_is`,
`a_filler_cannot_pass_another_owners_opt_in`, `a_forged_opt_in_is_not_consent`.

**19. A few lamports at a check address would have stopped every service —
HIGH, services reviewer.** Anyone can send lamports to any address. A transfer
to a check address before `open_check` leaves an empty account there, owned by
the system program. The client decoded whatever sat at each check address, and
decoding that threw. The board reads every symbol's check in one request, so
one transfer, 650,240 lamports on devnet today, would have stopped the keeper,
the crank, the checker, the queue CLI and the page together. It was reachable:
the addresses are derived from public seeds, and no check was open on devnet
yet. **Fix:** `checkAt` in `src/chain/client.ts` reads an account as a check
only when this program owns it and it carries the `SymbolCheck`
discriminator; anything else reads as no check. `open_check` still succeeds
over a funded address, since Anchor's `init` takes one. A fill against such an
address fails with Anchor's 3007 (`AccountOwnedByWrongProgram`) rather than
3012, and the clients now name it. Regression test, in
`test/chain-v2.test.ts`: "lamports sent to a check address before open_check
read as no check, not a board that throws". `FRICTION.md` has the longer story.

**20. The night reference was the last sale, which after hours can be far
off — MEDIUM, services reviewer.** As first built, the checker pushed Nasdaq's
last sale at night. That included extended-hours prints: SPY's read $714.68 at
16:56 ET on 24 September, 6.8% under the day's close, and a night fill was
refused as `MarkOffReference` until the next pass. An outlier could only block
a fill, not make a bad one, but the program's own comment called the night
reference the close. **Fix, in `65feb8d`:** outside the session the reference
is the regular session's official close, which Nasdaq stamps "Closed at … 4:00
PM ET", parsed strictly and believed only at an instant the calendar says a
session ended; never an extended-hours print. Yahoo stands in only where
Nasdaq gives nothing. Tests in `test/nasdaq.test.ts` ("the reference is the
last sale in session and the official close outside it, never the other way")
and `test/checker-armed.test.ts` ("out of session the checker says closed,
with the close as its reference, however old"). On chain at 20:15 ET the same
evening, all fourteen checks carried a `ref_at` of 16:00:00 ET.

**21. The tape showed a cross's counterparty — MEDIUM, page reviewer.** A
wallet's own request to `/api/tape` returned the other party's wallet on a
cross row. **Fix, in `65feb8d`:** `rowsFor` in `web/lib/tape.ts` gives each
party only its own side, and a per-wallet Telegram message about a cross never
names the other party. Tests: "each party to a cross finds it, and sees its own
side and never the counterparty" in `test/tape-route.test.ts`, and "a cross is
told to each party’s followers from its own side, and neither is told the
other" in `test/alerts.test.ts`.

**22. Four smaller page fixes — MEDIUM and LOW, page reviewer.** The page's
explanation of `CheckStale` said only that the checker had not reported, but
it is also what a night fill meets all weekend while the checker reports every
minute: the reference is too old. The night switch's sentence left out the
12-hour limit, and that a recurring buy's later orders keep their own opens.
Cross receipts could share a React key when one buy crossed several sales. And
a held mark's tile said "price paused" twice. All four were fixed before the
deploy.

### Documented, not fixed

- **All-or-nothing orders almost never cross — MEDIUM, program reviewer 2.**
  The page and `scripts/queue.ts` placed every order with its minimum fill
  equal to its size. `cross.rs` holds each side to its own minimum fill, so two
  such orders cross only when the buy's whole amount buys exactly the sale's
  whole amount at the mark, to the raw unit. At the tests' AAPLx rate, of the
  2,001 buy sizes within 1,000 raw units of one share's price, one crosses the
  share; $334 and $335 are both refused. That is a product decision, not a
  program one. It is on record in
  `all_or_nothing_orders_cross_only_at_an_exact_size`, `scripts/queue.ts`
  gained `--partial` (parts of about a dollar), and the page still places
  all-or-nothing orders.
- **A sale's night reference minimum can ask one raw unit above fair — LOW,
  program reviewer 2.** Both of its steps round up, as every minimum on a sale
  does. So with the mark at the edge of the night gap it can sit one quote raw
  above the sale's value at the mark, and a filler pays that unit. It never
  makes a night fill impossible. A buy's truncates, so it never passes fair.
  No code change; the comment in `sell.rs` says so, and
  `the_night_reference_floor_binds_over_a_generous_band` pins both roundings.
- **A cross's rounding goes to the seller, and can leave dust — LOW, program
  reviewer 2.** The buyer receives exactly its quote's worth at the mark. When
  the buyer's whole remainder crosses, the seller can receive a few raw units
  of quote over its stock's value rounded up: two for AAPLx. With a rate above
  one, an eight-decimal stock under about $100, a cross can leave a few raw
  units on the sale that no later cross can clear; a fill or its expiry does.
  This is what was specified. `the_rounding_leaves_both_sides_at_or_above_their_own_fair_value`
  holds both sides to their own fair value.
- **The rollout fails closed, and a burn would freeze the checkers — MEDIUM,
  program reviewer 1.** Every fill and cross refuses until the symbol's check
  is opened (3012), its checker has pushed (`CheckStale`), and the client sends
  17 accounts (3005). Only the upgrade authority opens checks, and there is no
  instruction to rotate a checker; one gated on the authority would stop
  working at the moment of a burn, and before a burn an upgrade does the same.
  So a burn before every check is open, or with a checker key the operators
  would not live with forever, leaves symbols shut for good. The order is in
  `check.rs`'s module doc: upgrade, `open_check`, start the checker, ship the
  clients, and only then move or burn the authority. `docs/SETUP.md` repeats
  it.
- **A retried cross can land twice — LOW, services reviewer.** `send()` in
  `src/chain/client.ts` retries on a timeout or an expired block height, and a
  transaction can land in both cases. `cross_orders` takes no amounts, so if a
  timed-out first cross had landed and both orders still had a remainder, the
  retry would cross those too. Each owner is still held to their own limits
  and minimum fills; the Telegram notice would report only the first.
- **Dry-run amounts for a second cross of the same order can be off — LOW,
  services reviewer.** A dry run plans the second pair against the chain's
  unreduced remainder. An armed pass re-reads the chain, and the program
  computes the amounts itself.
- **"price fresh" does not vote on the board — LOW, page reviewer.** It never
  did. In session a symbol whose price is hours old can read tradeable while
  the program would refuse `MarkStale`. The three new rows ("circuit breaker
  clear", "second source agrees", "within the band of Nasdaq") do vote.
- **The health check does not read the checks** or the checker's balance. A
  stopped checker shows as fills refusing, not as a failed check.

### Deploy record

The binary was 462,456 bytes, and the program data account had room for
420,000. Boxing accounts and sharing code saved a few kilobytes; the one
setting that would have saved more cost a fifth more compute on every fill
(`FRICTION.md`). So the account was extended by 50,648 bytes, which leaves
8,192 bytes of room over this binary.

| step | when (ET, Thu 24 Sep) | slot | transaction |
|---|---|---|---|
| Extend the program data account by 50,648 bytes, to 470,648; 257,291,840 lamports more rent, recoverable only by closing the program | 18:02:52 | 503674878 | [`2xCAD12U…`](https://explorer.solana.com/tx/2xCAD12UPf8miDXj9xuueGeXtdojzTUaaTuifc7pcBxtdG7mrYHV7gqyKhB9aXfZVbFGGsRjCWDD9D7gEAHQxtK8?cluster=devnet) |
| Upgrade | 18:04 | 503675389 | [`5aM3UhZf…`](https://explorer.solana.com/tx/5aM3UhZfADExNbRJMbRwmRt1TsAtMYJZWnDaXJ3ZeRwjb2wCo6k4Yz5x2pFfFoPzEwBP6bPRHKWkQHNFk8TGNcLH?cluster=devnet) |
| `open_check` for eight symbols | 18:05:49 | 503675935 | [`5ibXsi1E…`](https://explorer.solana.com/tx/5ibXsi1E8m2EVjy6vumWYnD1Ah2Pv97jiFEEDpEPGbN6vSc7K8qPE1sG1HkLFLRxF9QLvjuh6SpDDKyDGXetrvCe?cluster=devnet) |
| `open_check` for the other six | 18:05:52 | 503675953 | [`3tmQBQx2…`](https://explorer.solana.com/tx/3tmQBQx2iFWNu5QY1wV3XZnJtS6LXALN9SAhqxs4LuvXRPumnN4Kge8DbQtNJ9dRNKB5zC31pbARbpH7xTX4n1EW?cluster=devnet) |
| The first night fill: $5 of demo-USDC for 647,002 raw SPYx | 18:20:28 | 503681235 | [`dYzTs3Sa…`](https://explorer.solana.com/tx/dYzTs3SaS8Tmmmo3iDi3trWBiLAhzVZVqjDpZYV9svt5guocoBbL5nYrexZ4W2QSwANPj967dVrfXLi3BAYYqLS?cluster=devnet) |
| The first cross | [cross-fill-time], Fri 25 Sep | | [cross-fill] |

The first 462,456 bytes of the program account hash to the tested build,
sha256 `51d509e3f7521484831260882113d9251bedcb3b98bc726298168360d931b4cc`, and
the rest is zero padding. The upgrade authority is still the deploy key,
`Dqp6…Ziqs`. The IDL was rewritten through the Program Metadata program after
the upgrade; fetched back, it is identical to `src/chain/idl.json`: 19
instructions and 34 errors. All fourteen checks name the checker
`FWQdNaez3rAUn9t4VCf1EPs2pB821yPk7vgTFk68uJVR`, a key that is neither the
attestor nor the upgrade authority, run by the Railway service "checker". It is
BELL's own service, on the same Railway account as the keeper: a separate key,
process and data source, not a separate operator or host. The morning's
upgrade, sell orders, was at 09:49 ET in slot 503496372 (above).

Planned for Friday 25 Sep and not done: moving the upgrade authority to a
Squads v4 multisig on devnet. Until then it is one key.

---

## Not fixed, by decision

- **The mark can still be moved inside the checker's band.** The gate can only
  refuse; a mark lets the attestor set a price. Fills and crosses are
  permissionless. Before upgrade #2 a leaked attestor key could open a symbol,
  push a bad price and fill parked orders itself. Now every fill and cross
  also needs the checker to agree about the session and the mark to sit within
  300 bps of its reference in session, 150 at night, and the breaker slows the
  mark to one 5% step a minute. Inside that band, each order's loss floor
  (#14), where it has one, and the $1,000 per-order cap are what bound a
  leaked key. A sale the page or `scripts/queue.ts` places always has a floor
  (the program, as for a buy, accepts a zero one), and a sale's cap is its
  value at the mark when placed. BELL runs both signers on one Railway
  account, so the checker guards against a leaked key or a faulty feed, not
  against the operator; with both keys, only the floor and the cap remain.
  `assert_tradeable` does not read the check, so a swap guarded by it
  elsewhere still trusts the attestor alone for the session. Disclosed in the
  README.
- **The checker does not read halts or withdrawals.** Those can only close a
  symbol, and gate 2 takes them on the attestor's word alone, so the check does
  not look for a halt that a leaked attestor key has cleared.
- **`permanentDelegate`** on the nine Backed and Backpack mints lets one key
  move or burn the token in any wallet without the owner's signature. On
  mainnet that is Backed (`5aMN…`) for the seven xStocks and Backpack (`2cVY…`)
  for PFE and LMT; on their devnet mirrors it is BELL's own deploy key,
  `Dqp6…`. Ondo's five mints have none. The page names it in a disclosure row;
  nothing in this design can prevent it.
- **The upgrade authority is live** (`Dqp6…`) until it is burned, and it is one
  key: the move to a Squads multisig is planned, not done. A malicious upgrade
  could take whatever a user currently has approved — their open orders plus
  any approval not revoked — with each order capped at $1,000 by
  `MAX_ORDER_IN`, a sale at its value when placed. It alone opens checks, and
  there is no instruction to rotate a checker.
- **`register_symbol` stays permissionless, and first-come.** The listed tickers
  are registered at deploy. Squatting an unused ticker confers no authority over
  anything shared, and the allowlist is pinned by mint address rather than by
  ticker, so a squatted symbol is not reachable by users. The page and the
  filler do not verify a symbol's attestor (`guardInstructions` checks both
  records against one an integrator pins); all fourteen live records name the
  right one.
- **Session pushes are not monotonic.** `push_session` accepts a timestamp
  older than the one it replaces. `push_mark` and `push_check` now ignore an
  older observation: it is neither written nor refused.

## Reproducing

The reviews' own workflows are not in this repo. The program fixes are covered
by the 136 program tests in `programs/bell-session/tests/` (`test_check.rs` 15,
`test_cross.rs` 17, `test_gates.rs` 23, `test_mark.rs` 15, `test_night.rs` 17,
`test_ondo.rs` 8, `test_queue.rs` 22, `test_sell.rs` 19), which run under
litesvm against the deployed binary; #5 and the enum check in #8 by
`test/portability.test.ts`; #10, #11, #13 and #14 by `test/halts.test.ts`,
`test/reconcile.test.ts`, `test/client.test.ts` and `test/order.test.ts`, with
the calendar that now stands in for #11 in `test/calendar.test.ts`. The
clients' sell arithmetic, which must match `sell.rs` to the unit, is checked in
`test/sell.test.ts`, and the page's sell and cancel transactions in
`test/web-sell.test.ts`. For upgrade #2, the clients' 17-account fills, the
cross builder and #19 are in `test/chain-v2.test.ts`; the crank's pairing and
its mirror of `cross.rs` in `test/crank-v2.test.ts`; the armed checker in
`test/checker-armed.test.ts`; #20 in `test/nasdaq.test.ts`; #21 in
`test/tape-route.test.ts` and `test/alerts.test.ts`; and the page's new rows
and night switch in `test/web-v2.test.ts`. The whole TypeScript suite is 369
tests.
