# Stocklana — plan to win the $100k main track

> **Revision 2.** An adversarial review landed after approval and corrected my evidence base.
> I re-measured everything against the issuer's own API. The champion survives and is stronger;
> the numbers below replace the earlier ones. Changes are marked **[R2]**.

## Context

Solana Foundation's **Stocklana** hackathon (tokenized stocks on Solana, $126k pool, $100k main track,
~138 submissions, close **Fri 2026-09-25 16:00 ET**). Judging is one sentence: *"could this be a real
app that people will actually use?"* — real user and problem, working end-to-end demo, a reason it
belongs on Solana, quality of execution.

### 1. The market is ~20 names deep — and the tail is far larger than I first measured **[R2]**

My first pass queried Jupiter with `limit=100` and I mistook the page cap for the universe. The real
figure is **928 Solana xStocks**. I pulled every mint from `api.xstocks.fi/api/v2/public/assets`
and re-queried all 928 through Jupiter:

| | |
|---|---|
| Solana xStocks in existence | **928** |
| Total DEX liquidity, all 928 | **$27.3M** |
| Top 20 names' share of it | **98.3%** |
| Names with < $1,000 liquidity | **883 / 928** |
| Names with zero organic buyers in 24h | **904 / 928** |
| Organic buyers across the entire asset class, 24h | **898** |
| Reported 24h buy volume that is *organic* | **10%** — the other 90% is bots |
| $1,000 buy of JPMx / Vx / UBERx | **95.4% / 80.5% / 80.2%** price impact |
| PFEx | **no route at all** |

The correction makes the case stronger, not weaker: **883 of 928 tokenized stocks have less than
$1,000 of liquidity behind them.**

### 2. The SEC excluded this asset class from its new framework three days ago

Order 34-106402 (2026-09-17) creates *Tokenized Securities Venues*. I pulled the PDF and read it. §I, verbatim:

> "'Tokenized NMS Stock' does not include securities where a third party issues a crypto asset
> representing its own security that provides synthetic exposure to an underlying security,
> **such as a tokenized linked security** or a tokenized security-based swap."

Backed's xStocks are Swiss tracker certificates — Backed issues its own security tracking the
underlying. On a plain reading that is the excluded structure. Also confirmed verbatim:
**§II.H** *"A TSV must stop trading in a Tokenized NMS Stock concurrently with any stoppage of trading
in the underlying NMS stock on the primary listing exchange"*; **§II.B** *"a TSV must be a U.S. person"*;
LP relief requires trading *"solely for its own account, and must not hold or custody customer assets"*;
**§II.J No Leverage**; Tier 1 ≤ 75 symbols and 0.25% of prior-month ADV; contracts must be
*"auditable, public, and deployed on a public, permissionless distributed ledger."*

### 3. The compliant replacement is seven days old with no application layer

Backpack's undocumented `/api/v1/assets`: **6,375 Solana security mints provisioned, exactly 56 with
`withdrawEnabled: true`** — self-custodiable Token-2022 UCC Article 8 entitlements to real shares, with
dividends and ACATS redemption. Same chain, same minute:

```
USDC → PFEx    (Backed,   $221 depth)    → "No routes found"
USDC → PFE.US  (Backpack, $21,214 depth) → fills, 0.58% impact on $1,000
```

Those 56 carry ~$12.3M of depth in three weeks. AAPLx, after fifteen months, has 24 organic buyers a day.

**So ~138 teams are building for a synthetic wrapper the SEC just wrote out of the perimeter, on a
market with 898 daily buyers.** Of ~35 publicly identifiable entries, **~14 are read-only dashboards**.

---

## The candidates, and why four died

All four were killed by measurement, not opinion.

**1 — Pooled redemption desk.** Aggregate small redemptions past the issuer minimum. **Dead.** Needs a
KYC'd, whitelisted counterparty of record; a contract cannot be whitelisted, and holding customer
securities to submit their orders is unregistered broker-dealer activity — explicitly outside the SEC's
own LP condition. **[R2]** The premise was also wrong: the live API returns `minOrderFiatValue: 1000`
on 923 of 928 assets, not the $5,000 in the prose docs.

**2 — NAV crossing network.** **Dead, four ways.** Jupiter's Trigger API already builds working limit
orders on these exact Token-2022 mints (I verified, both directions). **904 of 928 names had zero
organic buyers in 24h**, so no counterparty exists and the demo would have to fake both sides. Pyth's
24/7 `Crypto.<T>X/USD` feeds exist for only ~19 names — none of the target tail — so the oracle exists
only where the problem doesn't. And clearing at a stale oracle off-hours is a free option handed to an
informed attacker.

**3 — AP / best-execution router.** **Dead.** The primary path is reachable for 56 of 6,375 mints, and
for exactly those 56 the DEX already fills fine. It routes around a problem that doesn't exist.

**4 — Pre-IPO SPV sanity layer.** Real harm (Anthropic/OpenAI voided SPV transfers; tokens −34%/−39%),
but as specified it is a dashboard, `prestocks-pulse` already occupies the data layer, and the core
metric depends on attestations the issuer hasn't published.

**5 — A venue that refuses to fill you at a harmful price. ← CHAMPION.**

---

## Champion: BELL

> **The venue for real US securities on Solana that knows what time it is.**

Every venue on Solana will sell you Lockheed at 3am on a Sunday against a pool nobody has arbitraged
since Friday's close. BELL is the one that won't — it takes the order and fills it at the opening bell.

**Independent corroboration [R2]:** the adversarial reviewer, tasked with killing every idea, ranked
"be the first to demonstrate SEC-mandated halt synchronisation on-chain" as the strongest defensible
first available. That is BELL's core mechanism.

**The user.** Tolu in Lagos, USDC in Phantom, locked out of US brokerages. He wants Pfizer, Lockheed,
a slice of SpaceX, and the dividends. Today the xStock he *could* buy is the wrapper the SEC excluded,
the real one has no route, and nothing on Solana knows the market is shut.

### The gates

Every trade passes one program. Seven gates:

1. **Session** — per-asset, not global. **[R2]** The issuer exposes three distinct modes across the
   universe: `TwentyFourFive` (734 assets), `MarketHours` (104), `Regular` (87). No app can get
   "is this tradeable now" right without reading it per symbol.
2. **Halt** — **[R2] six xStocks are halted right now**: CRDAx, CKAHx, CKHUTx, CITICx, JPSTx, IWMx.
   The issuer publishes `isTradingHalted`, `currentPeriod`, `openNow`, `nextChangeAt` and the listing
   `exchange.mic` on a public endpoint. **Nothing on Solana consumes it.** This is a better source than
   scraping Nasdaq RSS, and it means the demo shows a *live* halt, not an archived replay.
3. **Issuer pause** — `pausableConfig`, read from the mint.
4. **Rebase** — the scheduled `newMultiplierEffectiveTimestamp`. **[R2]** And the sharp version:
   **a split and a dividend are both just a multiplier change, and they have opposite consequences for
   an AMM.** A split (NFLXx `currentMultiplier: 10`) leaves value per raw unit invariant — pools are
   fine. A dividend (SPYx `1.005715`, AAPLx `1.003269`) steps value per raw unit up at a known instant,
   leaving the pool stale-low by exactly the dividend and drained in the first block after activation.
   BELL classifies the event by cross-referencing the `Crypto.<SYM>X/<SYM>.RR` redemption-rate feed
   against `Equity.US.<SYM>/USD`, and refuses to trade through an unclassified activation.
5. **Transfer hook** — armed-but-empty slot; aborts if the issuer arms it mid-flight.
6. **Oracle** — Pyth freshness plus confidence, band widened off-hours.
7. **Execution quality** — NAV basis bound and depth bound. This is the gate that stops the 95% fill.

Pass → CPI the swap. Fail → **the transaction reverts on-chain**, and the order converts to an escrowed
bell order the user can cancel at any instant.

**The spine: prove what you can, attest only what you must.** These mints carry `pausableConfig`,
`permanentDelegate` (the issuer can seize any token from any wallet), `scaledUiAmountConfig` and a
transfer-hook slot. **None of it is readable by any Solana app today.** BELL deserializes the Token-2022
extensions on-chain rather than trusting an oracle; only session/halt/ADV need an attestation, and that
path **fails closed** — stale attestation is treated as halted.

**Why Solana.** The guard is a program other programs CPI into, so the protection composes into any
lending market, vault or wallet. `scaledUiAmount` is a Token-2022 feature — this bug class does not
exist on Ethereum. And the SEC now requires these contracts to be public and on a permissionless ledger.

### The demo (3 minutes)

- **0:00–0:20** — Phantom holding real Pfizer. Jupiter: `USDC → PFEx` → **No routes found**; same second
  `USDC → PFE.US` → fills. *"One of these is the wrapper the SEC excluded on Wednesday."*
- **0:20–0:50** — 928 tokenized stocks, $27.3M of liquidity, **883 of them under $1,000**, **898 organic
  buyers in 24 hours**, 90% of volume bots. *"138 teams are building for this."*
- **0:50–2:10 — the money shot.** Split screen, mainnet, one wallet, $200 into LMT.US. **Left:** raw
  Jupiter — succeeds. *"Filled. Market closed. Nobody asked."* **Right:** through BELL — the guard panel
  lights field by field and **the transaction reverts on-chain with `BellError::MarketClosed`**, visible
  in the explorer. One click queues it; cut to Friday 09:30:00 ET, the crank fires, it fills.
- **2:10–2:40 — the live halt. [R2]** Not a replay: CRDAx is halted *right now*. Show the issuer feed,
  show `Halt` propagate on-chain, show every BELL order for it stop and re-arm on resume. On screen,
  the §II.H sentence and its date. *"Three days old. This is the only implementation on any chain."*
- **2:40–3:00** — The tape, emitted as a program event.

**The moment that wins it is the revert.** Judges have seen a hundred dashboards that *say* a trade is
risky. They have not seen a program that refuses.

---

## Architecture

**On-chain (Anchor, mainnet).**
- `bell_session` — `Symbol` PDA (mint, tier, pyth feed, session mode, halt, ADV, caps, `updated_at`) and
  `TokenRisk` PDA (paused, multiplier, new_multiplier, effective_ts, event class, hook, permanent_delegate).
  `verify_token_risk` unpacks Token-2022 extensions on-chain. `push_session` fails closed on staleness.
- `bell_guard` — one instruction, the seven gates, then a Jupiter CPI. Emits an `Execution` event per
  fill — that event *is* the §II.G tape.
- `bell_queue` — escrowed bell orders. Key decision: **`limit_px` is bps of deviation from the Pyth
  reference at fill time, not an absolute price**, so an order placed 14 hours early is still sane at the
  open. `fill` is **permissionless** — any cranker re-runs the identical on-chain gate for a fixed tip,
  so the venue does not depend on your server.

**Off-chain keeper** (your Ripcord stack: pnpm, zod, pino, better-sqlite3, ulid). Sense (xStocks
`/assets` + `/multiplier`, Backpack `/securities` `/assets` `/market-sessions` `/market-holidays`, Nasdaq
halt RSS as a cross-check, Pyth Hermes, Jupiter, `getAccountInfo` per mint) → Policy → Planner/Critic
(**LLM boxed to human-facing explanations only — never a price, address or size**) → Guard → Execute →
Notify → Record. Your invariants carry: DRY_RUN default plus an arm flag, notional caps, **mint allowlist
pinned by address, never by symbol** (there is a pump.fun `JPMx` with more liquidity than the real one),
no LLM-supplied addresses, fail closed on staleness.

**Evidence table.** `refusals(symbol, ts, reason, would_have_px, later_px)` — every refusal logs its
counterfactual, so EVIDENCE.md can state a measured median saving in bps.

## Build sequence

0. **Day 0, parallel:** `rustup update` (you're on 1.81; Anchor/Agave wants ~1.85+), install Agave +
   Anchor, fund a mainnet keypair. **Request a Pyth API key — Hermes price reads return 401 since
   2026-08-26; this is the critical path.** Open the Backpack account so the demo wallet holds a real security.
1. **Freeze the allowlist by address**, snapshot every mint's extension state, ship the measurement page.
2. **`bell_session` + `verify_token_risk`** on mainnet; read-only guard API.
3. **`bell_guard` + Jupiter CPI** — first real guarded buy, first real revert.
4. **`bell_queue` + permissionless crank**; run live across a real weekend and accumulate refusals.
5. **Halt path, rebase classifier, tape, front end, demo film, live site, EVIDENCE.md / FRICTION.md,
   `NOTICE.md`** (a filled-in draft of the order's public Notice — costs a day, nobody else will have it).

**Bounties, main-track first.** Pyth is load-bearing (schedule parsing, `.RR` feeds for the rebase
classifier, confidence-widened collars, self-posted updates since sponsored equity accounts are ~37 days
stale). Meteora is crowded; a guarded DAMM v2 pool is the stretch if stage 5 lands early.

## Verification

- `anchor test` green on all seven gates: forced halt, stale oracle, scheduled rebase, unclassified event.
- Point `bell_session` at CRDAx / JPSTx (**halted today**) and assert every order stops and re-arms.
- Reproduce live: `PFEx → no route` while `PFE.US` fills at 0.58%.
- **One real mainnet revert and one real mainnet fill**, both signatures in EVIDENCE.md.
- Keeper soak across a full weekend→open transition.

## Risks

1. **"Refusing" reads as blocking users.** The real product risk. A refusal is *never* a bare error — it
   always converts to a cancellable escrowed order, so the outcome is better, never blocked. Then
   quantify it; if the median saving is small, **say so in EVIDENCE.md**. The halt case carries it alone.
2. **Regulatory over-claiming.** A TSV must be a U.S. person, file a public Notice, and give issuers veto
   notice. BELL is none of those and must never imply SEC registration or endorsement. Frame it exactly as
   *"a reference implementation of the TSV operating conditions, and a non-custodial guard any venue can
   adopt."* The reading that xStocks fall in the synthetic exclusion is **analysis, not a legal opinion** —
   attribute the words to the order and let the quote do the work.
3. **Backpack or Backed pulls an endpoint.** BELL calls **zero authenticated endpoints** and caches every
   response as a signed snapshot, so the demo is reproducible offline. The mints are ordinary Token-2022
   accounts independent of either company's servers, and the guard is issuer-agnostic.

## Open items

- Confirm what the KYC'd Backpack account unlocks; BELL needs none of it, but the demo wallet should hold
  a real security.
- Pick the final name before the repo goes public.
