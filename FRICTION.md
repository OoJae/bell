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
and would read every NFLXx balance at one tenth of its share count.

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
the deployed program then run the *same* binary, and v1 is the more conservative
deployment format anyway. `--tools-version` is required: without it
cargo-build-sbf tries to download v1.54 and times out.

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

**Fix:** sessions and marks go in separate transactions. An extra signature is
a rounding error against getting this wrong at the open.

## 2026-09-21 — the Pyth key is entitled to crypto only

A free Pyth Terminal key authenticates but returns **403** for every feed in
this asset class — `Equity.US.AAPL/USD`, `Crypto.AAPLX/USD`, and the `.RR`
redemption-rate feed — while `Crypto.SOL/USD` returns 200. The docs describe the
key as simply something you view, which is true, and say nothing about
entitlement, which is what actually gates it.

**Fix:** sessions from Pyth's free `/v2/price_feeds` metadata (`market_hours`
plus the machine-readable `schedule`, across 1,245 equity feeds). Prices from an
executable Jupiter quote: $200 of USDC into the real mainnet mint, which is what
a filler can actually get. Backpack's free tickers were the first plan, but most
of them are perpetuals trading 38–275bps below spot, and a low mark is the
unsafe direction. The mark's `conf_bps` is that one quote's price impact,
capped at 200, not a disagreement between sources. See `docs/PYTH.md`.

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

Worth noting how it presented: the page showed *"Cannot reach the chain.
Nothing is tradeable while this is true"*. That was the fail-closed path doing
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
cannot collide — that names, among others, the two that are not failures at
all: `OwnerRevoked` (the user cancelled) and `OwnerSpentTheFunds` (they spent
the money elsewhere, which silently invalidates the order by design). It now
reads `OwnerRevoked`.

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

**Fix:** `test/portability.test.ts` replaces six `Buffer` methods (the four
BigInt ones the polyfill lacks, and the two f64 ones) with ones that throw,
before importing anything, and then exercises every shared path — PDAs,
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

**Fix, for now:** `touch programs/bell-session/src/lib.rs && cargo build-sbf
--arch v1 --tools-version v1.57` before `cargo test`, every time, and treat a
green suite that followed a source change without a rebuild as no evidence at
all.

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

## 2026-09-22 — fail-closed tripping over its own feet

The devnet site came up reading *"Cannot reach the chain. Nothing is tradeable
while this is true"* across all nine symbols. The chain was fine. The keeper was
attesting on schedule and `scripts/gate.ts` agreed from the same machine.

The board was making ~36 RPC requests per refresh — three `getAccountInfo` per
symbol for state, risk and mark, plus a `simulateTransaction` each for the
verdict — every ten seconds. Public devnet answers that with HTTP 429, the
browser client throws, and the catch block correctly concludes that an
unreachable chain is not permission to trade.

So the error path was right and the message was true, and the result was still
wrong: **a venue that closes itself because it asked too many questions is not
demonstrating fail-closed, it is tripping over its own feet.** A judge sees a
broken site, and the property we most wanted to show is what hides the cause.

**Fix:** `readAllSymbols` fetches all 27 accounts in a single
`getMultipleAccounts` (the limit is 100). The board's verdict is derived from
those same accounts by taking the first failing gate in `check_tradeable`'s own
order, which reproduces the answer *and* the reason. The authoritative
simulation still runs — for the one symbol being looked at — so a disagreement
between the derived view and the program would surface exactly where someone is
looking. 36 calls became 2.

The general lesson is about error paths that are individually correct. Rate
limiting and a dead RPC are indistinguishable to a client, and we chose to treat
the ambiguous case as closed. That is still the right choice. It just means the
cost of being noisy is paid in false closures, so the client has to be quiet.

## 2026-09-22 — the refresh nobody called

Hours after the devnet deploy, a check of the live system against its own
claims found that `refresh_token_risk` had never been called. The builder was in
`client.ts`; no script used it and neither did the keeper. So `TokenRisk` was a
snapshot from registration, and four gates — pause, rebase, multiplier, hook —
were checking that snapshot. A dividend scheduled that afternoon would not have
been seen.

The instructive part is why nothing flagged it. Every test called `init` and
then asserted immediately, so a record was always fresh in a test. The audit
raised the unbounded age and killed it because refresh is permissionless — a
correct argument about *blocking* a refresh that says nothing about everyone
*skipping* one. And the program stored `verified_at` on every record and never
read it: the field that would have made the staleness visible was being
written and ignored.

**Fix:** the keeper re-reads every mint each tick in an isolated transaction,
and the program refuses a read older than ten minutes (gate 2b, `RiskStale`).
The lesson for anything "anyone can call": check that *someone does*.

## 2026-09-22 — eight seconds from closing the venue

Decoding the hosted keeper's session pushes showed attestations landing 110–112
seconds old against a 120-second limit. The keeper's loop slept 45s after each
tick, so a tick really took ~57s end to end, and with `refreshBefore=60` a
symbol whose state had not changed was re-pushed only every *other* tick. It had
never failed — which is exactly why nobody had looked. One dropped push would
have closed all nine symbols for most of a minute.

**Fix:** `refreshBefore` 30, so every tick pushes; worst-case age is one tick.
Later the loop was fixed too: it sleeps what is left of 45 seconds rather than a
full 45 after the work, so ticks start 45 seconds apart, not ~57, unless one
runs longer than that.

## 2026-09-22 — error codes counted by eye

Hand-typed error codes in a new test were each off by one. Counting the enum by
eye — and then with a regex that matched `[A-Za-z]+` — skipped `NotToken2022`,
whose name contains a digit. The tests failed, loudly, which is the good
outcome; the reviewer who had quoted the right codes had been "corrected" by me.

**Fix:** tests derive codes from the enum (`ERROR_CODE_OFFSET + variant as
u32`), and assert by code rather than `is_err()`. One existing test had kept
passing after its failure reason silently changed from `MarkStale` to the new
`RiskStale` — an `is_err()` assertion cannot tell the difference.

## 2026-09-22 — rent is not the textbook number

Our cost estimates used the textbook 6,960 lamports per byte. The cluster charges
5,080: the ProgramData account (room for a 420,000-byte program, plus a 45-byte
header) holds exactly 2.13447884 SOL, and `solana rent 420045` gives that same
figure on devnet and on mainnet (checked 23 September), so this is not a devnet
discount. It mattered here only as good news: an upgrade buffer for the
312,640-byte binary is about 1.589 SOL, refunded when the upgrade lands.

Any budget built on the textbook rate is a guess;
`getMinimumBalanceForRentExemption` is the number. The faucet's SOL grant is
sized from rent *measured* on devnet (a stock account 1.56M lamports, an order
2.00M), but it is a constant, so a rent change would need it re-measured.

## 2026-09-22 — the halt feed is newest first

Nasdaq's trade-halt feed lists every halt of the day, one row each, newest
first. `fetchHalts` put the rows into a map by ticker, so the last row written
won — and in a newest-first feed that is the *oldest* halt. In that evening's
feed JAGX had been paused eight times; the map kept the first pause, which
resumed at 12:41 ET, and read the one that began at 14:54 as already over.

This feed is BELL's only source of exchange halts, and for PFE and LMT, whose
issuer publishes no halt state of its own, the only halt input of any kind. As
JAGX shows, volatility pauses come in clusters, so a listed stock paused twice
in a day would have read as trading while halted. Nothing tested the parser;
the post-deploy adversarial review found it.

**Fix:** `parseHalts` keeps, per ticker, the row with the latest halt time.
That evening's feed is committed as `test/fixtures/tradehalts-2026-09-22.xml`,
and the test checks JAGX halted at 14:56 and resumed by 15:00. Any feed folded
into a map needs its order known, and which row wins decided on purpose.

## 2026-09-22 — a 100-key limit anyone could fill

`getMultipleAccounts` refuses more than 100 keys in one request. The crank read
everything in one: three accounts for each symbol in the book, the clock, and
two per order (the owner's quote account and the filler's inventory). Nine
symbols and 37 orders is 102 keys, and from there every crank pass threw. An
order costs its owner a fee and refundable rent — the program accepts any
amount above zero — and lives up to seven days, so anyone with a little devnet
SOL could have stopped every fill for up to a week, the orders parked for the
bell included.

The limit is documented. What we missed is that the length of the list was in
other people's hands. The post-deploy review found it.

**Fix:** `readAccounts` splits any key list into requests of at most 100
(`MAX_KEYS_PER_READ`), one after another rather than in parallel, since a burst
is what public RPC answers with 429. `test/client.test.ts` checks lists of 0,
1, 99, 100, 101 and 250 keys, and a board with 60 orders on it.

## 2026-09-22 — web3.js retries a 429 for you

The board's 429s were fixed by asking less (*fail-closed tripping over its own
feet*, above). The ones left, web3.js handled without telling us: a
`Connection` answers a 429 by retrying on its own — up to four more tries,
sleeping 0.5, 1, 2 and 4 seconds — and the caller sees nothing but console
lines until it gives up. The page polled on a fixed ten-second `setInterval`,
and a poll makes several requests, so a throttled poll could still be sleeping
when the next one began. Each overlap was another request at an endpoint
already saying no.

**Fix:** `disableRetryOnRateLimit: true` on the page's connection, so a 429
fails the poll and the page says so. Each poll is scheduled when the last one
ends, never on a fixed beat, and a guard stops two running at once. The next
poll is the retry.

## 2026-09-22 — public RPC is several nodes, and they disagree

Public devnet spreads requests across nodes that can be a few seconds apart. It
showed up twice.

Gate simulations failed intermittently with `BlockhashNotFound`, consistently
on the last symbols checked: the blockhash came from one node, and the
simulation ran on another that had not seen it. On the board that read as a
refusal for a tradeable symbol. **Fix:** `simulate()` sets
`replaceRecentBlockhash`, so the node uses its own — one request instead of
two, and it cannot fail that way.

Then a `getProgramAccounts` read right after a cancel still listed the closed
order, and one right after a place can miss the new one. The page approves the
whole book at once, and SPL `Approve` replaces rather than adds, so a read that
missed a live order would fund less than the book needs and silently defund
that order. On screen, a poll that began before a close would put the closed
order back, and the next cancel press would land on it. **Fix:** the page
remembers the orders it closed and drops them from every read, and before it
approves, merges a fresh read with the orders it last saw. When a read is
wrong, that errs toward funding too much, never toward defunding a live order.

## 2026-09-23 — `anchor idl init` wrote half an IDL

Anchor 1.2 puts the IDL in a Program Metadata account (program
`ProgM6JCCvbYkfKqJYHePx4xxSUSqJp7rh8Lyv7nk7S`, seed `idl`), which is what
explorers read to decode instructions. `anchor idl init` created the account,
wrote the data, and failed its last step, which left a header that made every
fetch return raw zlib as hex. A retry refused because the account now existed,
and left a 7.5 KiB buffer behind; the Program Metadata CLI's own `write` then
failed in simulation and left a second. Each held rent in an account nothing
pointed to.

**Fix:** close the metadata account and both buffers (`close idl`,
`close-buffer`; the rent comes back), then write it once with the Program
Metadata CLI:

```sh
npx @solana-program/program-metadata write idl \
  56AUPR1c1Tq5AgMvAa3PASax61YYo1KTdocwW6pR7Pdx src/chain/idl.json \
  --format json --keypair <upgrade authority> --rpc https://api.devnet.solana.com
```

It now fetches as JSON identical to `src/chain/idl.json`. The metadata account,
`C1dLwNvn2sMeNK8e8VhtfpoE7dRykTGYnM3YLzUq3Up8`, holds about 0.04 SOL,
recoverable by closing it. After a failed multi-transaction write, run
`list-buffers` for the authority before retrying.

## 2026-09-23 — zsh does not split `$E`

Landing the refused SPYx transaction, I kept the environment in a variable:

```sh
E="BELL_CLUSTER=devnet BELL_RPC_URL=https://api.devnet.solana.com BELL_PAYER_KEYPAIR=…"
env $E BELL_ARM=1 node scripts/guarded-swap.ts --land SPYx
```

bash splits `$E` into three assignments. zsh does not word-split an unquoted
parameter, so `env` got one argument: `BELL_CLUSTER` became the whole string
and `BELL_RPC_URL` was never set. The client's default RPC is
`http://127.0.0.1:8899`, nothing was listening, and the error was
`fetch failed`, which reads as a network fault.

The localhost default is what made it loud: with a local validator running, the
same line would have run against localnet instead.

**Fix:** spell the assignments out on the command line, or split on purpose with
zsh's `${=E}`.

## 2026-09-24 — the textbook ceiling, and which way a sale rounds

A sale's minimums are quote the seller is owed, so each one rounds up. The
textbook ceiling is `(num + rate − 1) / rate`. It is safe for every amount only
while the rate is at most 2^64. Here `num` is `a << 64`; for an amount near
the top of a `u64` that already fills a `u128` to within 2^64, and adding
`rate − 1` then carries past the top. Rates above 2^64 are ordinary: the mark's
rate is stock raw per quote raw, so any 8-decimal stock under $100 has one (at
$25 it is four raw per raw). The release profile sets `overflow-checks = true`,
so the overflow would be a refused fill, not a wrong number.

**Fix:** `stock_to_quote_ceil` in `sell.rs` computes
`num / rate + (num % rate != 0)`, which cannot overflow for any `u64` amount and
any non-zero rate, so it does not lean on the $1,000 cap to keep amounts small.
`a_stock_under_a_hundred_dollars_prices_through_a_rate_above_one` fills a sale
at a rate of 4 × 2^64. The TypeScript mirror, `stockToQuoteCeil` in
`codec.ts`, is written the same way although BigInt cannot overflow: a mirror
written differently is one that can quietly start to disagree.

The direction is deliberate too. `fill_order` rounds each figure down: the
stock a buyer is owed at the mark, the band edge below it, and the floor, so
less than a raw unit of stock at each step stays with the filler; at eight decimals a raw
unit is a hundred-millionth of a share. That is the deployed buy path, and the
sell change leaves `fill_order` as it was. The sell side is new, so every
minimum in it rounds up — the value at the mark, the band edge below it, and
the floor — and a filler can never meet one by a unit the arithmetic dropped.
`a_six_decimal_stock_sells_at_the_same_rounding` pins a case where rounding
down would have let a payment one unit short through. It binds the clients as
well: a filler that priced a sale with the buy side's rounding could pay a
unit short and be refused with `PriceOutOfBand`, which is why `crank.ts`
prices sales with `codec.ts`'s mirrors, step for step. The one figure in
`sell.rs` that rounds down is the $1,000 value cap, so a sale worth exactly
$1,000 at the mark is never refused over a fraction of a unit.
