# BELL

**The venue for real US securities on Solana that knows what time it is.**

Every venue on Solana will sell you Lockheed at 3am on a Sunday, against a pool
nobody has arbitraged since Friday's close. BELL is the one that won't — it
takes the order and fills it at the opening bell.

The product is the refusal. Judges have seen plenty of dashboards that *say* a
trade is risky. This is a program that declines to sign one.

**Live:** https://web-production-f46ca9.up.railway.app
**Program:** [`56AUPR1c1Tq5AgMvAa3PASax61YYo1KTdocwW6pR7Pdx`](https://explorer.solana.com/address/56AUPR1c1Tq5AgMvAa3PASax61YYo1KTdocwW6pR7Pdx?cluster=devnet) (devnet)

The site talks to Solana RPC directly from your browser — there is no backend
between you and the chain. The keeper runs separately and only writes
attestations, so **stop it and the site keeps working, correctly showing
everything closed.** That is the fail-closed property as something you can
watch rather than something we claim.

Devnet rather than mainnet, deliberately. The rent is identical either way
(2.17 SOL at exact length) and the program is byte-for-byte the same; devnet SOL
is free, and a judge can verify a devnet address exactly as well as a mainnet
one. What mainnet would have bought is a clickable address — at the cost of
parking ~$255 recoverable only by keeping a live upgrade authority.

**What that costs in honesty, said plainly.** None of these securities exist on
devnet, so the live deployment trades against *mirror* mints.
`scripts/mirror-mints.ts` derives each one by reading the real mainnet mint's
extension state through this program's own parser and reproducing it — same
decimals, same scaled-UI multiplier, same pausable config, same permanent
delegate, same armed hook slot. SPYx's mirror carries multiplier
`1.005714560286254` because the real one does.

So: **the 27 program tests parse real mainnet mint bytes, and
`scripts/localnet.sh` clones the real mainnet accounts. The devnet deployment
does not.** Those are different claims and this README keeps them apart.

It buys one thing mainnet cannot: we hold the mirror mint authorities, so a
multiplier activation can be *scheduled on demand* and gate 4 filmed refusing
across it. Backed will not schedule a dividend for a demo.

---

## Why this matters

Tokenized equities on Solana have a liquidity problem and a timing problem, and
almost every app addresses neither.

| | |
|---|---|
| Solana xStocks in existence | **928** |
| Total DEX liquidity across all 928 | **$27.3M** |
| Share held by the top 20 names | **98.3%** |
| Names with under $1,000 of liquidity | **883 / 928** |
| Names with zero organic buyers in 24h | **904 / 928** |
| Organic buyers across the entire asset class, 24h | **898** |
| Reported 24h buy volume that is organic | **~10%** |

A $1,000 buy of JPMx moves the price **95.4%**. PFEx has no route at all.

Reproduce every one of these: `node scripts/measure.ts` writes a timestamped
snapshot from public, unauthenticated endpoints.

### The timing problem is worse, because it is silent

A thin pool is visible. A stale one is not. Off-hours, the primary market is
shut, nobody is arbitraging, and the pool still quotes a price — so a trade
executes against a number that stopped meaning anything hours ago. Nothing
on-chain knows the difference.

The SEC's order on Tokenized Securities Venues (**34-106402**, 2026-09-17) makes
this a stated condition rather than a matter of taste. §II.H:

> "A TSV must stop trading in a Tokenized NMS Stock concurrently with any
> stoppage of trading in the underlying NMS stock on the primary listing
> exchange."

BELL is a non-custodial implementation of that sentence.

---

## The seven gates

Every trade passes one program. It refuses, in this order — cheapest and most
categorical first, so a refusal names the most fundamental reason rather than
whichever check happened to run first:

1. **State freshness** — an attestation older than 120s is not a green light. An
   attestor that goes dark closes the venue.
2. **Halt** — the underlying is halted on its primary listing exchange.
3. **Issuer pause** — `PausableConfig`, read from the mint itself.
4. **Rebase** — a `ScaledUiAmountConfig` activation. Refused within a guard
   window on **both sides** of the activation instant, and refused outright
   while a pending change is unclassified. Both halves matter: before, the order
   would settle in a different denomination than it was built for; after, a
   dividend has already stepped value-per-raw-unit up and the pool is stale-low
   by exactly that amount until arbitrage catches up.
5. **Multiplier moved** — the order was built against a multiplier that is no
   longer in force.
6. **Transfer hook** — an armed hook changes settlement semantics mid-flight.
7. **Market open** — for callers in `Strict` mode.

Four of those are proven on-chain by deserializing Token-2022 extensions
directly from the mint (`verify_token_risk`), not taken from an oracle. Only
session and halt need an attestation, and that path **fails closed**: stale means
halted.

`check_tradeable` is one function. `assert_tradeable` and `fill_order` both call
*it*, not a reimplementation of it — two copies of a safety check are two things
to keep in sync, and the second one is where the bug lives.

### It composes without a wrapper

`assert_tradeable` is a plain instruction. Put it first in a transaction and
Solana's atomicity does the rest, so a wallet or router adopts this by
prepending one instruction to whatever it already builds. No integration, no
CPI, no permission.

---

## A refusal is not a dead end

This is the part that keeps "we refuse trades" from being a worse product.

A refused order becomes a **bell order**: it parks and fills when the market
opens. Funding is by SPL delegation — the user `approve`s a capped amount and
**keeps their tokens**. Nothing is escrowed.

That choice has consequences worth stating:

- **Cancel is `spl_token::revoke`** — one standard instruction from the user's
  own wallet. It works if this program is frozen, our keeper is dead and our RPC
  is down. BELL is not in the cancel path at all.
- **If no filler ever comes, nothing happened.** The funds were never
  immobilised.
- **Spending the money elsewhere silently invalidates the order.** That is the
  design, not a failure.
- Escrow would strand funds in exactly the cases the gate exists to catch — a
  halt, a rebase, an expiry.

Fills are permissionless. Any filler re-runs the identical on-chain gate and is
paid by the spread, so the venue does not depend on our server.

---

## What is proven, not claimed

Run against a validator cloning the **real mainnet mints** — the same bytes
mainnet has, not fixtures we wrote.

**Fail-closed, on a live cluster.** Stop the keeper; 176 seconds later every
symbol refuses with `StateStale`, including the deeply liquid ones. Nobody did
anything. Silence closes the venue.

**A guarded trade, settled and aborted.** The same payload twice: SPYx settled,
IWMx aborted with `MarketClosed`, recipient balance unchanged.

**The close, and the thing we did not expect.** At the 16:00 ET bell the two
sources never agree:

| time (UTC) | Pyth | issuer | BELL |
|---|---|---|---|
| 19:54:51 | open | open | tradeable |
| 19:55:38 → 19:59:31 | **open** | **closed** | refused |
| 20:00:17 → | **closed** | **open** | refused |

The issuer stops 4m39s before the bell; Pyth marks the session shut at 20:00:17,
by which time the issuer's 24/5 wrapper reads open again. **There is no instant
at which both agree the market closed.** A venue trusting Pyth alone keeps
trading after the issuer has stopped; one trusting the issuer alone keeps trading
after the market has shut. BELL refuses across the whole window, because in both
directions the safe reading is the same.

That is a better argument for reconciliation than "the sources agree 635 times
out of 637" — at the boundary, where it matters, they never agree at all.

**The queue, end to end.**

```
market shut          → gate refuses
order queued         → by delegation; the quote never leaves the user's wallet
crank                → REFUSED  MarketClosed
attestor pushes open → crank → REFUSED  MarkStale
fresh mark lands     → crank → FILLED 200 quote → 25,608,169 raw
```

The `MarkStale` step was not scripted. We rang the bell, expected a fill, and got
refused because the mark had aged past sixty seconds. An open market is not
enough; the price has to be fresh too.

**The revoke, proven the hard way.** Session forced open with a fresh mark so all
seven gates pass, order still standing on chain — and the fill still refuses with
`OwnerRevoked`, because the user revoked the delegation. The cancel genuinely
needs nothing from this program.

`EVIDENCE.md` is generated from the tick log by `scripts/evidence.ts`. Every
number in it is counted, not written by hand.

**Tests:** 27 litesvm tests against real mainnet mint bytes, 45 TypeScript tests.

**Audited before deploy.** Six independent reviewers across the delegation and
queue surface, each finding then attacked by three more instructed to refute it.
26 findings raised, 6 survived, all 6 fixed — including one that let anyone
disarm the rebase gate on any mint, and one that meant the browser could not
place or cancel an order at all. `AUDIT.md` has each finding, its fix, and why
the other 20 died.

---

## What you must trust

Stated plainly, because a guard product that hides its own trust assumptions is
worth less than no guard at all.

**The mark fails open.** The gate can only refuse, so it fails closed. A *mark*
lets the attestor set a price, and a wrong mark could permit a bad fill. This is
the one place the queue adds trust the gate did not have. Three bounds contain
it: the user's own optional floor; `Mode::Strict`, so a fill only happens while
the real market is live and a wrong mark is arbitrageable against something we
do not control; and a 60-second freshness limit.

**The upgrade authority is live.** Until it is burned, a malicious upgrade could
move up to a user's delegated amount — capped by `MAX_ORDER_IN`. Burning it is
the production step and is named as such rather than quietly skipped.

**One delegate slot per token account.** SPL delegation is per-owner, not
per-order, so a `revoke` cancels every one of your orders at once, and placing
one re-approves the whole book. The page says so rather than implying orders are
independent.

**Every one of these mints has a `permanentDelegate`, and two keys cover all
nine.** Not some of them — all nine, verified against the real mainnet accounts:

| | |
|---|---|
| `5aMNNLQJwAEeoemTEMkv5NVjqKwvvefRYCQ5Z67HFvEq` | all seven Backed xStocks |
| `2cVYpagTt7ZGc3mmTXBa7fAznUtx5DUu6aCq8uVDaf4a` | both Backpack entitlements |

A permanent delegate can move tokens out of any holder's account without that
holder's signature, at any time, for any reason. So two keys can seize any
position in this asset class, after any fill, on any venue — and nothing about
BELL changes that.

Reproduce it: `spl-token display <mint>` against any of the nine.

`TokenRisk` records it and the page surfaces it, which is the whole of what a
guard can honestly do here. This is a disclosure, not a mitigation, and it is
the strongest reason to read these mints rather than trust a price feed about
them: **the risk that matters most is written on the mint and nothing else on
Solana reads it.**

**Prices are not Pyth.** A free Pyth key authenticates but is entitled to crypto
only; every equity feed returns 403. Sessions come from Pyth's free
`/v2/price_feeds` metadata (1,245 equity feeds), and marks from an executable
Jupiter quote. See `docs/PYTH.md`.

---

## On the regulatory framing

BELL is **not** a registered TSV and must not be read as one. A TSV must be a
U.S. person, file a public Notice, and give issuers veto notice. BELL is none of
those. It is a reference implementation of the operating conditions, and a
non-custodial guard any venue can adopt.

The order's §I excludes "securities where a third party issues a crypto asset
representing its own security that provides synthetic exposure to an underlying
security, such as a tokenized linked security." Backed's xStocks are Swiss
tracker certificates, which on a plain reading is that structure. **That reading
is analysis, not a legal opinion**, and the quote is there so you can judge it
yourself.

One correction we made rather than buried: we first read Backed's
`isTradingHalted` as an exchange halt. It is not. Cross-checked against Nasdaq's
UTP feed — which does carry NYSE Arca halts — IWM and JPST are absent. The
Russell 2000 ETF was never halted; Backed had withdrawn its own wrapper. Both
stop a trade, but §II.H is about the exchange halt, and claiming one that never
happened would be a false statement about one of the world's most liquid ETFs.
They are distinct inputs now, with a test asserting the issuer case never
produces exchange wording.

---

## Run it

Requires Rust 1.89+, Agave 4.1.2, Anchor 1.2.0 and Node 26 (which runs
TypeScript natively — there is no build step). Full setup in `docs/SETUP.md`.

```bash
pnpm install
./scripts/localnet.sh &        # validator cloning the real mainnet mints
./scripts/demo-setup.sh        # local quote asset + demo holdings
node scripts/register.ts       # set up the nine symbols
BELL_ARM=1 node scripts/keeper.ts   # sense → reconcile → attest, every 45s

node scripts/gate.ts           # what the chain says about each symbol, right now
node scripts/queue.ts place SPYx 200
node scripts/crank.ts          # try to fill; watch it refuse and say why

cd web && pnpm dev             # the refusal screen, at :3100
```

Order matters: a mark binds its quote mint permanently, so the quote asset has
to exist before the symbols are registered. `register.ts` refuses rather than
binding a mark to a mint that is not there.

To see fail-closed: stop the keeper, wait two minutes, run `scripts/gate.ts`
again. Everything refuses.

---

## Architecture

```
sensors → policy/reconcile → keeper → [ bell-session program ] ← browser
                                            ↑
                                    fillers (permissionless)
```

- **`programs/bell-session`** — the gate, the Token-2022 reader, and the queue,
  in one program. One deploy, one rent payment.
- **`src/sensor/`** — xStocks, Backpack, Pyth, Nasdaq UTP halts, Jupiter. All
  public and unauthenticated, so the demo does not depend on anyone's API key.
- **`src/policy/reconcile.ts`** — merges the sources and fails closed on anything
  unconfirmed. Pyth knows the session; the issuer knows the halt; **the
  disagreement between them is the halt.**
- **`web/`** — Next.js. No backend: the browser talks to RPC directly, so the
  site keeps working whether or not our keeper is up — and when the keeper is
  down it correctly shows everything closed, which makes fail-closed something
  you can watch rather than something we claim.

The front end and the keeper run **the same codec and the same policy code**. A
UI that reimplements the rules is a UI that will eventually lie about them.

**Why Solana.** The guard is a program other programs CPI into, so the protection
composes into any lending market, vault or wallet. `scaledUiAmount` is a
Token-2022 feature — this bug class does not exist on Ethereum. And the SEC now
requires these contracts to be public and on a permissionless ledger.

---

## The trap that justifies reading mints on-chain

`ScaledUiAmountConfig` carries **two** multipliers. The field named `multiplier`
is stale once `newMultiplierEffectiveTimestamp` has passed. NFLXx reports
`multiplier 1.0` beside `new_multiplier 10.0` — so the obvious read is wrong by
an entire 10:1 split.

We only caught it because the tests use real mainnet mint bytes. A split and a
dividend are both just a multiplier change and they have opposite consequences
for an AMM: a split leaves value per raw unit invariant, while a dividend steps
it up at a known instant, leaving the pool stale-low by exactly the dividend and
drained in the first block after activation.

More of these in `FRICTION.md`, including the two found while building the front
end.
