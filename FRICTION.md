# Friction

Things that cost time or were wrong, and what they cost.

## 2026-09-21 — `scaledUiAmount` has two multipliers, and the obvious one is wrong

`ScaledUiAmountConfig` carries **both** `multiplier` and `new_multiplier`, plus
`new_multiplier_effective_timestamp`. Once that timestamp passes, the effective
value is `new_multiplier` — the field named `multiplier` is stale and stays
stale. Reading it is not a rounding error: Netflix's mint reports

```
multiplier      = 1.0
new_multiplier  = 10.0     (timestamp in the past — already in force)
```

so an integration that reads `multiplier` is wrong by the entire 10:1 split,
and would size every NFLXx order at one tenth of its intended share count.

Caught only because the tests run against **real mainnet mint bytes** rather
than a synthetic mint we built ourselves. A synthetic fixture would have
encoded our own misunderstanding and passed.

Note the asymmetry worth knowing: `api.xstocks.fi/.../multiplier` *pre-resolves*
this and returns `currentMultiplier: 10` for NFLXx, so the off-chain path looks
correct while the on-chain path is wrong. The two disagree precisely when it
matters most — inside the activation window.

**Fix:** `read_mint` takes `now` and resolves the effective multiplier itself.
Pending is now genuinely pending — scheduled but not yet in force.

## 2026-09-21 — litesvm cannot load an sbpf v3 program

`anchor build` emits sbpf **v3**. litesvm 0.10–0.13 reject it with a bare
`InvalidAccountData` from `add_program`, which reads like a corrupt file rather
than a version mismatch and sent me looking at the wrong thing. 0.16 supports
it but needs a newer Rust than the 1.89 that Anchor pins, so that door is shut
too.

**Fix:** build with `cargo build-sbf --arch v1 --tools-version v1.57`. Tests and
mainnet then run the *same* binary, and v1 is the more conservative deployment
format anyway. `--tools-version` is required: without it cargo-build-sbf tries
to download v1.54 and times out.

## 2026-09-22 — `anchor build` silently un-does the v1 build

`anchor build` regenerates the IDL, which you need whenever an instruction is
added — but it also emits an sbpf **v3** `.so` over the top of the v1 one, and
litesvm cannot load v3. The symptom is all 24 program tests failing at once with
`InvalidAccountData`, which reads like a corrupt binary rather than "your last
build overwrote the artefact".

Worse, `cargo build-sbf` then considers the crate unchanged and no-ops, so
re-running it does not fix anything. It has to be forced.

**Fix:** the two commands are a pair and the order matters.

```sh
anchor build                                      # IDL
touch programs/bell-session/src/lib.rs            # defeat the cache
cargo build-sbf --arch v1 --tools-version v1.57   # the .so we test and ship
```

`file target/deploy/bell_session.so` tells them apart: v1 reports
`shared object, *unknown arch 0x107*`, v3 reports `pie executable, eBPF`.

## 2026-09-22 — sessions and marks do not fit in one transaction

Nine `push_session` instructions is 841 bytes against the 1,232 limit, which I
had measured and relied on. Adding seven `push_mark` instructions took the
combined message to **1,520** and the tick died. A mark carries a `u128` rate
plus price fields, so it is a much fatter instruction than a session push.

**Fix:** two transactions per tick, one for sessions and one for marks. Two
signatures is a rounding error against getting this wrong at the open.

## 2026-09-21 — the Pyth key is entitled to crypto only

A free Pyth Terminal key authenticates but returns **403** for every feed in
this asset class — `Equity.US.AAPL/USD`, `Crypto.AAPLX/USD`, and the `.RR`
redemption-rate feed — while `Crypto.SOL/USD` returns 200. The docs describe the
key as simply something you view, which is true, and say nothing about
entitlement, which is what actually gates it.

**Fix:** sessions from Pyth's free `/v2/price_feeds` metadata (`market_hours`
plus the machine-readable `schedule`, across 1,245 equity feeds), prices from
Backpack's free `/api/v1/tickers`. See `docs/PYTH.md`.

## 2026-09-22 — the shared codec was only shared in one direction

Making the front end run the keeper's own encoder was supposed to be the safe
choice: one codec, so the panel cannot drift from what the chain enforces. It
worked in Node and failed in the browser with

    b.writeBigUInt64LE is not a function

`Buffer.writeBigUInt64LE` and its three siblings are Node built-ins. Bundlers
substitute the `buffer` npm polyfill, which implements the byte and 32-bit
methods but **not** the BigInt ones — so every `u64`, `i64` and `u128` in the
codec worked in tests and broke on the page. Nothing caught it, because the 38
tests all run under Node, where the methods exist.

Worth noting how it presented: the page showed *"Cannot reach the chain —
nothing is tradeable while this is true"*. That was the fail-closed path doing
its job, and it made a client-side bug look like an RPC outage. Failing closed
is right, but it does mean an encoder bug and a dead network are indistinguishable
from the outside.

**Fix:** `DataView` (`setBigUint64`/`getBigUint64`/`setBigInt64`/`getBigInt64`)
throughout `codec.ts`, which is standard in both runtimes; `Reader` now takes a
`Uint8Array` and decodes text with `TextDecoder`. The rule that follows: code
shared across runtimes must be written against the *intersection* of their APIs,
and "it passes in Node" does not establish that.

## 2026-09-22 — a revoked order refused with `custom 4`

The cancel path is the design's best property: `revoke` is one SPL instruction
against the user's own account, and it makes an order unfillable even with the
gate wide open and the order still on chain. Verified exactly that — forced the
session open with a fresh mark so all seven gates passed, and the fill still
refused.

But it refused with **`custom 4`**. `errorName()` reads the IDL, which only
carries BELL's own errors; anchor numbers those from 6000, and this was the SPL
token program's `OwnerMismatch`. So the system's strongest guarantee reported
itself as an unexplained error code.

**Fix:** a small `SPL_TOKEN_ERRORS` table beside the IDL lookup — the ranges
cannot collide — naming the two that are not failures at all: `OwnerRevoked`
(the user cancelled) and `OwnerSpentTheFunds` (they spent the money elsewhere,
which silently invalidates the order by design). It now reads `OwnerRevoked`.

## 2026-09-22 — verifying the browser path by running it in Node

The `writeBigUInt64LE` fix above was incomplete, and the way it was incomplete
is the interesting part. I swept `codec.ts`, fixed it, and then "verified the
browser module" by importing `web/lib/queue.ts` **in Node** and submitting a
real transaction. It worked, so I moved on.

`orderPda` in `client.ts` still called `Buffer.writeBigUInt64LE`. It is a *seed*
derivation rather than an encoder, so a sweep of the codec did not reach it, and
a Node harness cannot fail on it by construction. Both the place and the cancel
path go through it, so the front end's two write operations were broken while
the test that was supposed to prove them passed.

An adversarial review found it. I would not have.

**Fix:** `test/portability.test.ts` deletes the six Node-only `Buffer` methods
before importing anything and then exercises every shared path — PDAs,
encoders, decoders, the f64 multiplier. Node's test runner gives each file its
own process, so the amputation is contained. Confirmed to have teeth by putting
the bug back: three tests fail.

The rule: a compatibility fix needs a test that *cannot pass* in the environment
that has the feature. Anything else is checking the wrong runtime.

## 2026-09-22 — `cargo test` was green against a binary it did not build

Right after changing four instruction handlers, `cargo test` reported 24/24
green. It was testing the *previous* program: the litesvm harness loads
`target/deploy/bell_session.so`, which is produced by `cargo build-sbf`, and
`cargo test` never builds it.

So the most dangerous possible moment — immediately after security fixes — is
exactly when the suite is most likely to be reassuring about the wrong artefact.
Two of the three new regression tests failed the moment the real binary was
built, which is how it surfaced.

This is the same family as the earlier `anchor build` overwrite, and the whole
family has one shape: **the tests and the thing under test are connected by a
file path, not by a dependency.** Nothing rebuilds, nothing notices.

**Fix, for now:** `touch src/lib.rs && cargo build-sbf --arch v1 --tools-version
v1.57` before `cargo test`, every time, and treat a green suite that followed a
source change without a rebuild as no evidence at all.

## 2026-09-22 — a mark binds its quote mint permanently

`open_mark` uses `init` and records `quote_mint` with no instruction to change
it afterwards. After rebuilding localnet I ran `register.ts` before
`demo-setup.sh`, so every mark bound the quote mint from the *previous* ledger —
an address that no longer existed. Nothing complained. The failure surfaced much
later as `QuoteMintMismatch` on the first `place_order`, which points at the
order, not at the mark that was mis-bound twenty minutes earlier.

An adversarial reviewer had raised the general shape of this ("`open_mark` takes
`quote_mint` as an unvalidated raw `Pubkey`") and it was refuted as
unexploitable, which was correct — it is an operational footgun, not a
vulnerability. It still cost a full rebuild cycle.

**Fix:** `register.ts` now refuses to open marks unless the quote mint account
actually exists on the cluster it is pointed at. The permanence stays — on
mainnet the quote asset is USDC and never changes, and binding it is part of the
mark's identity — but binding it to *nothing* is now impossible.
