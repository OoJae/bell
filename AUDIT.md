# Audit

An adversarial review of the delegation and queue surface, run before the
mainnet deploy — the point at which real user funds sit behind a delegation.

**Method.** Six independent reviewers, one per risk dimension: delegation and
authority, fill arithmetic, account validation, order lifecycle and rent,
fail-closed behaviour of the gate, and client/program codec parity. Each
reviewer read the code with no knowledge of the others' findings.

Every finding then faced three further reviewers whose instruction was to
**refute** it, each through a different lens — is it reachable, is it already
prevented somewhere the finder did not read, and is the finder simply wrong
about what the code does — with instructions to default to *refuted* under
uncertainty. A finding survived only if at least two of three failed to kill it.

**Result: 26 raised, 6 survived.** 84 agents, no errors.

The 20 that died matter as much as the 6 that lived. Several were plausible and
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

### 4. Both token programs in `fill_order` were unconstrained — MEDIUM

Not a confirmed finding — the reviewers killed the exploits built on it, because
`require!(taken <= amount_in_leg)` measures the user's account after the transfer
and bounds what any callee could take. Fixed anyway: `fill_order` hands its
callee a CPI signed by the per-owner delegate authority, and an arbitrary
program in that position is a primitive worth refusing to create even when the
measurement contains it. Both legs are now pinned to SPL Token or Token-2022.

### 5. The browser could not place or cancel an order at all — HIGH, 3/3

`orderPda` derives its seed with `Buffer.writeBigUInt64LE`, which the browser's
Buffer polyfill does not implement. Both the place and the cancel path go
through it.

This one is embarrassing in a useful way: the same trap had been found and
written up in `FRICTION.md` two hours earlier, fixed in `codec.ts`, and missed
here because the seed is *derived* rather than encoded — and because the browser
module was verified by running it under Node, where the method exists.

**Fix.** `DataView`, and a test that deletes the six Node-only `Buffer` methods
before importing anything, so a shared module that reaches for one fails in CI
rather than on the page. Verified to have teeth by reintroducing the bug: three
tests fail.

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

**Fix.** The client re-approves the whole book — the sum of what is still owed
across live orders, plus the new one — and the page states the delegated total
and that a revoke cancels all of them, because one token account has one
delegate.

---

## Not fixed, by decision

- **The mark fails open.** The gate can only refuse; a mark lets the attestor
  set a price. Bounded by the user's own floor, `Mode::Strict`, and a 60-second
  freshness limit. Disclosed in the README in those words.
- **`permanentDelegate`** on SPYx and PFE lets the issuer claw tokens back after
  a fill. Recorded and surfaced; not preventable by anything in this design.
- **The upgrade authority is live** until it is burned, and `MAX_ORDER_IN` caps
  the blast radius meanwhile.
- **`register_symbol` stays permissionless.** Squatting an unused ticker now
  confers no authority over anything shared, and the allowlist is pinned by mint
  address rather than by ticker, so a squatted symbol is not reachable by users.

## Reproducing

The audit is a script, not a transcript — see the workflow in the session
record. The fixes are covered by `programs/bell-session/tests/` (27 tests) and
`test/portability.test.ts`.
