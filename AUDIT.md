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

## Not fixed, by decision

- **The mark fails open.** The gate can only refuse; a mark lets the attestor
  set a price. `fill_order` and `fill_sell_order` are permissionless, so a
  leaked attestor key can open a symbol, push a bad price and fill parked
  orders itself. Each order's loss floor (#14), where it has one, and the
  $1,000 per-order cap bound it. A sale the page or `scripts/queue.ts` places
  always has a floor (the program, as for a buy, accepts a zero one), and a
  sale's cap is its value at the mark when placed.
  `Mode::Strict` is not an independent bound, since the same key attests the
  session, and the 60-second freshness limit stops a silent attestor, not a
  leaked one. Disclosed in the README.
- **`permanentDelegate`** on all nine mints lets one key move or burn the token
  in any wallet without the owner's signature. On mainnet that is Backed
  (`5aMN…`) for the seven xStocks and Backpack (`2cVY…`) for PFE and LMT; on the
  devnet mirrors it is BELL's own deploy key, `Dqp6…`. The page names it in a
  disclosure row; nothing in this design can prevent it.
- **The upgrade authority is live** (`Dqp6…`) until it is burned. A malicious
  upgrade could take whatever a user currently has approved — their open orders
  plus any approval not revoked — with each order capped at $1,000 by
  `MAX_ORDER_IN`, a sale at its value when placed.
- **`register_symbol` stays permissionless, and first-come.** The listed tickers
  are registered at deploy. Squatting an unused ticker confers no authority over
  anything shared, and the allowlist is pinned by mint address rather than by
  ticker, so a squatted symbol is not reachable by users. The page and the
  filler do not verify a symbol's attestor (`guardInstructions` checks both
  records against one an integrator pins); all nine live records name the
  right one.
- **Pushes are not monotonic.** `push_session` and `push_mark` accept a
  timestamp older than the one they replace.

## Reproducing

The review's own workflow is not in this repo. The program fixes are covered by
the 64 program tests in `programs/bell-session/tests/` (`test_gates.rs` 23,
`test_queue.rs` 22, `test_sell.rs` 19), which run under litesvm against the
deployed binary; #5 and the enum check in #8 by `test/portability.test.ts`;
#10, #11, #13 and #14 by `test/halts.test.ts`, `test/reconcile.test.ts`,
`test/client.test.ts` and `test/order.test.ts`, with the calendar that now
stands in for #11 in `test/calendar.test.ts`. The clients' sell arithmetic, which must match
`sell.rs` to the unit, is checked in `test/sell.test.ts`, and the page's sell
and cancel transactions in `test/web-sell.test.ts`.
