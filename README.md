# BELL

**The venue for real US securities on Solana that knows what time it is.**

**The safe way to trade US stocks from your own wallet, at any hour.** Wall Street
closes; Solana doesn't — and while New York is shut, a Solana pool has nothing
to check its price against. US exchanges trade about 32.5 of the week's 168
hours ([RedStone's COO](https://crypto.news/tokenized-stocks-face-24-7-pricing-gap-redstone-coo/)).
Over Labor Day weekend a tokenized AMC traded at $18.04; the stock had
closed at $2.54 on 3 September ([crypto.news](https://crypto.news/robinhood-amc-tokens-expose-limits-of-short-squeezes/);
on Robinhood Chain, not Solana — the mechanism is the same).

In the regular session, BELL trades. When the stock is halted, or a dividend is
about to change the token under you, it refuses — on-chain, in the transaction,
not as a warning. And while New York is shut, it holds your order for a real
price and fills it after the bell, with your money, or your shares, in your
wallet until then. A wallet that opts in can be filled at night too, but only
while the pool's price sits within 1.5% of the stock's official close. Outside
that band, it waits for the bell.

A dashboard can say a trade is risky; BELL is a program that makes it fail —
and turns the refusal into an order.

**Live:** https://web-production-f46ca9.up.railway.app (and `/overpay`, below)
**Program:** [`56AUPR1c1Tq5AgMvAa3PASax61YYo1KTdocwW6pR7Pdx`](https://explorer.solana.com/address/56AUPR1c1Tq5AgMvAa3PASax61YYo1KTdocwW6pR7Pdx?cluster=devnet) (devnet)
**IDL:** on chain through the Program Metadata program, account [`C1dLwNvn2sMeNK8e8VhtfpoE7dRykTGYnM3YLzUq3Up8`](https://explorer.solana.com/address/C1dLwNvn2sMeNK8e8VhtfpoE7dRykTGYnM3YLzUq3Up8?cluster=devnet), so explorers decode BELL's instructions. It matches `src/chain/idl.json`: 19 instructions, 34 errors.

![The live BELL page after the close: 0 of 9 symbols tradeable, SPYx selected with every gate passing except "market open", and the order offered a place in the queue for the opening bell.](docs/bell.png)

### Try it (about two minutes)

1. Switch your wallet to devnet — Phantom: Settings → Developer Settings →
   Testnet Mode → Solana Devnet.
2. Open the site and connect. Press **Get demo funds**: 1,000 demo-USDC (a
   devnet token BELL issued — not USDC) and a little devnet SOL for rent.
3. Pick a symbol and read the gate panel. While the regular session is closed —
   outside 09:30–16:00 ET on a trading day, to within one keeper tick — it
   refuses and offers to **queue the order for the opening bell**, optionally
   with your own limit price or at each of the next few opens; while the session
   is open, it takes it unless another gate refuses — a halt, a withdrawn token,
   a rebase. The panel also shows the Solana pool's price beside the US
   market's last trade.
4. Sign once. Your demo-USDC stays in your wallet — the order is funded by a
   delegation — and a filler that runs every five minutes settles it after the
   open. On 23 September it filled an overnight order at 09:35 ET. (A
   recurring buy is one approval and an order per open; when they do not fit
   in one transaction the page sends several, which most wallets sign in one
   prompt.) The switch **Fill my orders at night, inside the band**, off by
   default, lets your orders fill before the bell too, inside the night band
   ("Night mode", below). It covers orders you have already placed.
5. To sell shares you hold, switch the order box to **Sell**: a number of
   shares, and optionally a minimum price a share. The approval is on your
   stock account, not your demo-USDC, and the shares stay in your wallet until
   a filler has paid for them. The first sale on devnet sold 0.02 SPYx for
   15.267831 demo-USDC at 10:04:28 ET on Thu 24 Sep
   ([transaction](https://explorer.solana.com/tx/4trvXZHKDPrjqSjkwshjiiztct3uwPQUXdaTK8Td5i5v5yGGH6fZPmWsQd1gRf3L4eWCLGYNRon1qUYuWoEW9VDm?cluster=devnet)).
6. Cancel any time: the first thing a cancel sends is an SPL `revoke` from your
   own wallet, on its own — on the demo-USDC account for a buy, on the stock
   account for a sale.
7. After a fill, **Your fills** shows the receipt: when it filled (and how long
   after the bell), what you paid or were paid a share, and how far over or
   under the price it was checked against. The site's tape route reads it back
   from the chain, and each line links to its transaction, so you can check it
   without us. A cross (below) reads "crossed with another user at the pool's
   price, no filler spread".
8. To be told when a wallet's order fills, open
   [@Bell_solbot](https://t.me/Bell_solbot) on Telegram and send
   `/start <wallet>`; the page's footer links there with your wallet filled
   in. The keeper then sends that chat a message for each of that wallet's
   fills and crosses. Following a wallet claims nothing about owning it, since
   every fill is public anyway. The public channel
   [@bellfills](https://t.me/bellfills) posts every fill and cross our
   filler makes, and each halt, open and close the keeper attests. The first
   per-wallet message was for the 15:00 ET fill on Thu 24 Sep
   ([transaction](https://explorer.solana.com/tx/bEJXacdtQZtqcmag7Ak7JDDTQkRMoNBd82ht1xx9zeA92r3gTQwMkmd8TRJePVPrNqcYBQ22APZWCALwYaq17uA?cluster=devnet)).

**Did you overpay?** `/overpay` on the same site takes any Solana wallet and
reads its recent mainnet buys of the fourteen listed tokens. It is read-only:
it holds no key and needs no wallet. For each USDC buy made while New York was
shut, it sets the price paid a share beside the underlying's next
regular-session open. "Why this matters", below, gives what a sample of the
whole market paid.

For builders: [`docs/INTEGRATE.md`](docs/INTEGRATE.md) shows how a wallet,
router, lending market or vault puts the same gate in front of its own trades.
For regulators and partners: [`NOTICE.md`](NOTICE.md) answers the SEC order's
disclosure items as BELL would (an unofficial draft, not a filing), and
`/api/tape` publishes every fill in the shape the order asks a venue to use.

**Your orders never touch a server of ours.** The browser reads Solana RPC
directly, your wallet signs, and your browser submits. The server has four
routes, and none is in the order, fill or cancel path: a devnet faucet
(`/api/faucet`) that funds a fresh wallet — its own key owns a pool of
demo-USDC and a little SOL, and it cannot mint or touch the program; the last
US price of each underlying (`/api/reference`, from Nasdaq, shown beside the
pool's price and read by nothing else); the public tape (`/api/tape`, every
fill and cross read back from the chain); and the overpay lookup
(`/api/overpay`, read-only, mainnet). The keeper writes attestations and marks
and re-reads the mints; the checker, a separate process with its own key and
its own data, pushes a second opinion that every fill needs; a filler we run
every five minutes (`scripts/crank.ts`, which anyone holding the stock, or the
quote to pay for a sale, can run too) settles due orders and crosses. **Stop
the keeper and everything reads closed once its last attestation is two
minutes old; stop the checker and nothing fills once its last check is two
minutes old; stop the filler and orders simply wait** — and `revoke` still
cancels them from your wallet. That is fail-closed as something you can watch
rather than something we claim.

Devnet rather than mainnet, deliberately. The rent is the same on both: the
program data account, extended on 24 September to hold a 470,648-byte program,
holds 2.39177068 SOL, and `solana rent 470693` returns 2.39177068 SOL on devnet
and mainnet alike. The binary would be byte-for-byte the same, since nothing in
it names a cluster. Devnet SOL is free, and a judge can verify a devnet address
exactly as well as a mainnet one. Mainnet would have meant parking that SOL,
recoverable only while an upgrade authority stays live.

**What that costs in honesty, said plainly.** None of these securities exist on
devnet, so the live deployment trades against *mirror* mints.
`scripts/mirror-mints.ts` derives each of the nine Backed and Backpack mirrors
by reading the real mainnet mint's extension state through this program's own
parser and reproducing it — same decimals, same scaled-UI multiplier, a
pausable config, and the empty transfer-hook slot the real ones carry. Each has
a permanent delegate too, but not the issuer's: on the mirrors it is BELL's own
deploy key, `Dqp6…Ziqs`, and the page says so. SPYx's mirror carries
multiplier `1.005714560286254` because that was the real mint's multiplier in
force when it was mirrored. `scripts/mirror-ondo.ts` made the five Ondo
mirrors the same way, with Ondo's extension set: scaled UI amount, pausable,
default account state, confidential transfers and an empty transfer hook. Like
the real Ondo mints they have no permanent delegate. Every other authority on
all fourteen mirrors is the deploy key.

So: **the 136 program tests parse real mainnet mint bytes, and
`scripts/localnet.sh` clones the real mainnet accounts. The devnet deployment
does not.** Those are different claims and this README keeps them apart.

It buys one thing mainnet cannot: we hold the mirror mint authorities, so a
multiplier activation can be *scheduled on demand* and gate 4 filmed refusing
across it. On mainnet only the issuer's multiplier authority can schedule one.

---

## Why this matters

Tokenized equities on Solana have a liquidity problem and a timing problem.

| | |
|---|---|
| Solana xStocks | **928** |
| Total DEX liquidity across all 928 | **$27.69M** |
| Share held by the top 20 names | **98.37%** |
| Names with under $1,000 of liquidity | **883 / 928** |
| Names with zero organic buyers in 24h | **904 / 928** |
| Organic buyers in 24h, summed across all 928 | **926** |

From the census taken 2026-09-20 22:18Z, committed as
[`docs/census-2026-09-20T22-18Z.json`](docs/census-2026-09-20T22-18Z.json). In
the same snapshot a $1,000 buy of UBERx was quoted at 80.2% price impact and
ASTSx at 99.96%, and MRKx and ACNx had no route at all. The universe has grown
since: 1,124 listings on 23 September.

`node scripts/measure.ts` takes a fresh snapshot from the same public,
unauthenticated endpoints and writes it to `data/snapshots/`.

### The timing problem is worse, because it is silent

A thin pool is visible. A stale one is not. Off-hours the primary listing
exchange is shut and the pool still quotes a price — so a trade executes against
a number the primary market has not checked since its close. The pool cannot
tell the difference.

**What it cost, on a sample.** `scripts/overpay-census.ts` reads Solana
mainnet, read-only, for signed USDC buys of the fourteen listed tokens made
outside the regular session, and sets each one's price a share beside the
underlying's next regular-session open. Its run for 17–24 September sampled
630 transactions at 12 instants spread over the week's outside-session hours,
plus five quiet mints, and read 445. It left out pool-side legs (86) and
market makers' legs (7). It found 24 buys of $1 or more whose next open Nasdaq
had recorded: 20 wallets, $1,467.60.

| | |
|---|---|
| Paid more a share than the next open | **19 of 24 (79.2%)** |
| Median gap | **+44.1 bps** (quartiles +2.7 / +284.7) |
| Ondo's tokens: 18 buys, 15 wallets, $118 | median +66.6 bps |
| Backed's: 4 buys, $1,322.80 | median +0.3 bps |
| Weighted by dollars | +11.6 bps |

Read it with its limits. It is a small sample, weighted by time, not volume,
and most of it is small Ondo buys. It sees only buys paid in USDC by the
signer. And the gap includes whatever really happened overnight, not only the
pool's price. The run is committed as
[`reference/overpay-census-2026-09-24.json`](reference/overpay-census-2026-09-24.json);
`node scripts/overpay-census.ts --from <file>` recomputes the figures from it
with no RPC (it rewrites the figures in the file it reads, so run it on a
copy). `/overpay` asks the same question of one wallet.

The SEC's order on Tokenized Securities Venues (**34-106402**, 2026-09-17) makes
this a stated condition rather than a matter of taste. §II.H:

> "A TSV must stop trading in a Tokenized NMS Stock concurrently with any
> stoppage of trading in the underlying NMS stock on the primary listing
> exchange, which includes a halt or a suspension."

BELL enforces that sentence on-chain, without holding anyone's funds, and goes
further: it also holds orders while the regular session is closed, which the
order does not require, and fills them then only for a wallet that opted in,
inside a band of the official close. (BELL is not a TSV — a TSV must be a US person,
permissioned, and file a public notice — but the conditions are the ones a TSV
would have to meet; `NOTICE.md` answers them as BELL would.)

---

## The seven gates

Every trade passes one program. It refuses, in this order — cheapest and most
categorical first, so a refusal names the most fundamental reason rather than
whichever check happened to run first:

1. **State freshness** — an attestation older than 120s is not a green light. An
   attestor that goes dark closes the venue.
2. **Halt** — trading in the security is stopped: an exchange halt on its
   primary listing, or the issuer withdrawing its own token.
   **2b. Mint read fresh** — gates 3–6 are proven from the mint, but only as of
   the last read, so a read older than ten minutes is refused like a stale
   attestation. Anyone can re-read a mint, in front of their own transaction.
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
session and halt need an attestation. **Both fail closed when they go quiet**: a
stale attestation is treated as closed, and a mint nobody has re-read in ten
minutes is refused the same way.

That second half was learned the hard way. For the first hours of the devnet
deployment, nothing re-read the mints at all — the refresh instruction existed,
was permissionless, and nobody called it — so four gates were checking a
registration-day snapshot. The keeper now re-reads every mint every tick, and
the program refuses to trust a read that has gone stale. See `AUDIT.md`,
"Reopened after deploy".

`check_tradeable` is one function. `assert_tradeable`, `fill_order`,
`fill_sell_order` and `cross_orders` all call *it*, not a reimplementation of
it — two copies of a safety check are two things to keep in sync, and the
second one is where the bug lives.

### After the gate: the price, a breaker and a second opinion

The gate says whether the security may trade. A fill also needs a price. Every
fill and every cross runs one shared admission test (`admit` in `admit.rs`):
whether the order is due, then the gate, then these, in this order. The
breaker and the checker came with the upgrade of 24 September.

- **The mark** is the price a fill is measured against: one executable $200
  Jupiter quote per symbol, pushed by the keeper. It must be under 60 seconds
  old and no less certain than the order accepts.
- **The circuit breaker** (`push_mark`, `mark.rs`). A push may move the mark by
  at most 500 bps (`MAX_MARK_STEP_BPS`), scaled by how much observation time
  has passed since the mark on record, up to 60 seconds. So the mark moves at
  most one 5% step a minute, however the pushes are split. A bigger jump is
  held: the old rate stays, `conf_bps` is set to 65535, a `MarkTripped` event
  is emitted, and every fill refuses until a push lands inside the step, or
  the held mark is 300 seconds old and the next push sets the price afresh.
  The refusal is `MarkPaused` (6027); once the held observation is a minute
  old, `MarkStale` (6011) comes first (`admit.rs` checks age before the hold).
  Across 11,045 marks the hosted keeper had pushed, the
  largest step between consecutive marks was 228 bps (NVDAx), so none would
  have tripped.
- **The checker** (`check.rs`). A second key, with its own process and its own
  data, pushes its own view of each symbol: whether the market is open, and a
  reference price. Every fill and cross needs a check under 120 seconds old
  that agrees about the session (`CheckStale` 6030, `CheckerDisagrees` 6031).
  In session its reference, the last sale, must be under 300 seconds old and
  the mark within 300 bps of it (`MarkOffReference` 6032). A checker that goes
  dark refuses fills. It cannot make one: it signs no fill and sets no mark.

The breaker catches a faulty push and slows a bad one. It does not stop a
patient one: a mark nobody has pushed for 300 seconds is no longer anchored,
so the next push sets any price. What stops a wrong mark from pricing a fill is
the checker's band. `assert_tradeable` does not run this test: the gate an
integrator prepends reads the session and the mint, not the mark or the check.

### It composes without a wrapper

`assert_tradeable` is a plain instruction. Put it first in a transaction and
Solana's atomicity does the rest, so a wallet or router adopts this by
prepending one instruction to whatever it already builds. No integration, no
CPI, no permission — and the code is under the MIT licence (`LICENSE`).

---

## A refusal is not a dead end

This is the part that keeps "we refuse trades" from being a worse product.

A refused order becomes a **bell order**: it parks and fills when the market
opens. Funding is by SPL delegation — the user `approve`s a capped amount and
**keeps their tokens**. Nothing is escrowed.

An order can carry the buyer's own limit, "no more than this a share", which
the program enforces as the order's floor; our filler leaves a limit below the
market waiting until the price comes down to it. A recurring buy is one bell order per upcoming
open, from the exchange calendar, each held back by the program until its own
open and lapsing six hours after it, all under one approval.

A **sale** is the same queue with its legs swapped (`place_sell_order`,
`fill_sell_order`, `cancel_sell_order`). The user approves their **stock**
account (Token-2022) to the same per-owner authority, for what that account's
live sales still need; the demo-USDC approval that funds their buys is never
touched by a sale. It waits for the bell like a buy, behind the same gate. At
the fill the filler pays first: the program measures the quote that landed in
the seller's account, and only then takes the stock. It must be at least the
stock's value at the mark in force, less the order's band (30 bps from the
page), and never less than the order's floor: the seller's own minimum a share,
or three quarters of the price at placement, whichever is higher. Each of those
minimums rounds up, in the seller's favour. So if the stock opens more than 25%
down, or under the seller's minimum, our filler will not pay the floor, the
program refuses anything less, and no stock is taken.

That choice has consequences worth stating:

- **Cancel is `spl_token::revoke`** — one standard instruction from the user's
  own wallet, on the account the order draws on (the demo-USDC account for a
  buy, the stock account for a sale), sent as its own transaction before
  anything of BELL's. It works if this program is frozen and our keeper is
  dead. BELL is not in the cancel path at all; closing the order for its rent
  comes second, and a failure there cannot undo the revoke.
- **If no filler ever comes, nothing happened.** The funds were never
  immobilised.
- **Spending the money, or moving the shares a sale offers, elsewhere silently
  invalidates the order.** That is the design, not a failure.
- Escrow would strand funds in exactly the cases the gate exists to catch — a
  halt, a rebase, an expiry.

Fills are permissionless. Any filler re-runs the identical on-chain gate and is
paid by the spread, so where anyone can hold the stock the venue does not depend
on our server. A filler needs stock to fill buys and quote to fill sales. On
devnet only we can mint the mirror stock, so in practice the filler of buys
there is ours; the quote a sale is paid in is demo-USDC, which the faucet gives
any new wallet. That openness has a cost, stated under "What you must trust".

### Night mode: filled before the bell, inside a band

By default an order fills only in the regular session, where a wrong price can
be arbitraged against a live market. At night nothing does that, so night
fills are opt-in, per wallet, and held to more than a session fill.

A wallet opts in once with `opt_in_night` (the page's switch, or
`queue.ts night on`), which creates a small `NightOptIn` account at
`["night", owner]`. It covers every order the wallet has or will place,
including orders already live, and `opt_out_night` withdraws it for all of
them at once and returns the rent. An order not yet due still waits, so a
recurring buy's later orders keep their own opens. While the attested session
is shut, an opted-in wallet's order may fill only when (`admit.rs`,
`night.rs`):

- the gate passes in `Guarded` mode, which lifts only gate 7 (market open). A
  halt, a stale session, a pause, a dividend window, a moved multiplier and an
  armed hook still refuse;
- the checker agrees the market is closed, its check is under 120 seconds old,
  and its reference is under 12 hours old (`MAX_NIGHT_REF_AGE_SECONDS`);
- the mark sits within 150 bps of that reference (`MAX_NIGHT_GAP_BPS`);
- and the fill delivers, besides the order's own band and floor, at least what
  the reference less 150 bps says. So a night filler's spread is bounded by the
  checker's price, not by the keeper's alone.

Outside the session the checker's reference is the regular session's official
close, which Nasdaq stamps "Closed at … 4:00 PM ET", never an extended-hours
print (`src/sensor/nasdaq.ts`). Twelve hours after a 16:00 close is 04:00 ET,
so from 04:00 until the open, and from Saturday 04:00 until Monday's open,
orders wait for the bell. The first night fill
on devnet: $5 of demo-USDC for 647,002 raw SPYx at 18:20:28 ET on Thu 24 Sep
([transaction](https://explorer.solana.com/tx/dYzTs3SaS8Tmmmo3iDi3trWBiLAhzVZVqjDpZYV9svt5guocoBbL5nYrexZ4W2QSwANPj967dVrfXLi3BAYYqLS?cluster=devnet)).

### The opening cross: two users, no filler

When a buyer and a seller of the same stock are both waiting for the open, each
is the other's counterparty. `cross_orders` settles a due buy against a due
sell of the same symbol from two different owners, at the mark, with no filler
between them. The seller's stock goes to the buyer and the buyer's quote to the
seller, each leg moved by its own owner's delegation, between accounts the
orders pin. The buyer receives exactly the stock the mark gives for the quote
(what `fill_order` calls fair), and the seller at least what its own sell fill
would owe. Both orders' limits, floors and minimum fills are checked before
anything moves. An owner's buy cannot cross their own sell (`SelfCross`, 6033).
It is permissionless, and in session only: both orders are admitted as a
session fill, so the gate is `Strict` and the checker must say open. The
hosted crank tries crosses before fills.

The mark is an executable ask, not a mid, so a cross is "at the pool's price,
no filler spread", not "the fair price". One limit is plain: the page and
`queue.ts` place orders all-or-nothing by default. Such an order crosses only
if the other side can take all of it at once, so two of them cross only when
the buy's whole amount buys exactly the sale's whole amount at the mark, to
the raw unit, which almost never happens.
`queue.ts place … --partial` and `queue.ts sell … --partial` place orders that
can fill in parts; the page has no such option yet. A $10 SPYx buy (wallet
`zh2X…fwno`) and a partial sale of 0.02 SPYx (wallet `53UA…aU7P`) are parked
for Friday's open.

---

## How BELL would pay for itself

This is intent, not traction. Nobody pays BELL real money today: on devnet
every amount is test money.

**The band is where a filler earns.** A filler is paid by the gap between the
mark and what it delivers or pays. That gap is at most the order's band,
`max_slip_bps`: 30 bps from the page, before rounding, and the program allows
no more than 500. The hosted filler takes the whole band, or less where the
order's own floor asks for more (`scripts/crank.ts`), so on devnet the band is
what BELL's filler collects today, in test money. It is a margin before costs,
not a profit: on mainnet a filler would first have to buy the stock it delivers,
or sell the stock it takes, and neither is built. It is measured against a mark
the same operator attests (`NOTICE.md`, item l), though since the upgrade it
must also sit within the checker's band. It is also anyone's to take, because
fills are permissionless. A cross earns no one anything: the two owners trade
at the mark, with no band taken.

**The attestation is what an integrator relies on.** `assert_tradeable` takes
no fee, needs no permission and is under the MIT licence (`LICENSE`; how to
prepend it is in [`docs/INTEGRATE.md`](docs/INTEGRATE.md)), so the instruction
itself is not for sale. What a wallet or venue that prepends it depends on is
the keeper's session and halt attestation, pushed every 45 seconds. If it
stops, every symbol reads closed within 120 seconds and the gate refuses every
trade it guards. Nothing else the gate reads needs BELL to keep it fresh: an
integrator can carry its own mint re-read, which is permissionless, and the gate
does not read the marks, which price BELL's own orders. A venue that needs the attestation kept
up could pay for that. None does, and nothing on chain would make one.

**There is no per-fill fee.** None is implemented: the program has no fee
account and no instruction that takes one (`NOTICE.md`, item u).

---

## What is proven, not claimed

**On a local validator cloning the real mainnet mints** — the same bytes mainnet
has, not fixtures we wrote:

**Fail-closed, on a running validator.** Stop the keeper; once its last
attestation passes 120 seconds, every symbol refuses with `StateStale`,
including the deeply liquid ones. Nobody did anything. Silence closes the venue.

**A guarded trade, settled and aborted.** The same payload twice — the gate,
then a lamport transfer standing in for a swap: SPYx settled, IWMx aborted with
`MarketClosed`, recipient balance unchanged.

**The queue, end to end.**

```
market shut          → gate refuses
order queued         → by delegation; the quote never leaves the user's wallet
crank                → REFUSED  MarketClosed
attestor pushes open → crank → REFUSED  MarkStale
fresh mark lands     → crank → FILLED
```

The `MarkStale` step was not scripted. We rang the bell, expected a fill, and got
refused because the mark had aged past sixty seconds. An open market is not
enough; the price has to be fresh too.

**On a validator, recorded in `FRICTION.md` (22 September):**

**The revoke, proven the hard way.** Session forced open with a fresh mark so all
seven gates pass, order still standing on chain — and the fill still refuses,
with the token program's `OwnerMismatch` (custom 4, which the client names
`OwnerRevoked`), because the user revoked the delegation. The cancel genuinely
needs nothing from this program.

**On the live devnet deployment:**

- **A fill nobody watched.** On Wednesday 23 September the hosted crank — a
  Railway cron job every five minutes — filled an overnight $200 SPYx order in a
  block timestamped 09:35:24 ET, about five minutes after the bell: 200
  demo-USDC for 25,661,713 raw SPYx
  ([transaction](https://explorer.solana.com/tx/5mj8qKbkZLz1M4e8i1cA8rJRuQGkwrzC1QEgfbTvMNcrXabGrT79U8SBVzLgtfEBTP9zURvZxVaaBeQE7EwMCFqt?cluster=devnet)).
  It was not filmed; the transaction is the record.
- **The same, filmed.** On Thursday 24 September an overnight $200 SPYx order
  from the same wallet filled in a block timestamped 09:35:26 ET, five minutes
  after the bell: 200 demo-USDC for 25,915,945 raw SPYx
  ([transaction](https://explorer.solana.com/tx/5311pZ8D6WRdRyBZzSHM5VDHds4BmwUXagx17VjHTCHH2iqasHtANaiD8gzmdLXmBDMUx2qsjLiLKWKTbcd9xGVv?cluster=devnet)).
  The page was recorded from 09:25 ET, unattended, and the wallet signed
  nothing while it ran.
- **A sale.** 0.02 SPYx (1,988,635 raw) sold for 15.267831 demo-USDC, $763.39
  a share, 30 bps under the mark's $765.69, in a block timestamped 10:04:28 ET
  on Thu 24 Sep ([transaction](https://explorer.solana.com/tx/4trvXZHKDPrjqSjkwshjiiztct3uwPQUXdaTK8Td5i5v5yGGH6fZPmWsQd1gRf3L4eWCLGYNRon1qUYuWoEW9VDm?cluster=devnet)): the first sale on
  devnet. It was placed during the session with `queue.ts sell SPYx 0.02 700`,
  so it did not wait for a bell, and settled under a minute later by
  `scripts/crank.ts` run by hand, before the hosted crank had its sell loop. It
  was not filmed; the transaction is the record.
- **A refusal that landed.** Every client simulates before sending, so a
  refusal normally never reaches the chain. `BELL_ARM=1 node
  scripts/guarded-swap.ts --land SPYx` sends a refused leg past preflight: at
  16:26 ET the same day, from a throwaway wallet, it failed at the gate with
  `MarketClosed` (custom 6000), paid its 5,000-lamport fee, and the transfer in
  it never happened
  ([transaction](https://explorer.solana.com/tx/2Ue1towjdeQoG1Eeo7xC1tvfUpJ8VcBNxR14gXk8MiYnDyicQ4F4mtkXi4TVxx6ritLjkKGE5RZtCSs2Fq9Cr1pH?cluster=devnet)).
- **A new wallet's first order.** On the night of Tuesday 22 September a
  brand-new wallet — the scripted one in `scripts/demo/judge-path.ts` — was
  funded by the hosted faucet, placed an order on the live site and cancelled
  it, and recorded the revoke signed and landed first, on its own, then BELL's
  close.
- **A dividend, refused on both sides.** On Thu 24 Sep we scheduled a dividend
  step on the AAPLx mirror at 15:23:14 ET, effective 15:49:45 ET, multiplier
  ×1.00077
  ([transaction](https://explorer.solana.com/tx/nmPgh5nMoPMHyQAiV2tu9AWgrvDXdgX692mVHGDGLeaAAWMMFqqUMRMs5LWq4bQjUjZvdYz5nU3q7jZ3uigkmmW?cluster=devnet)).
  It is our mirror, not a real Apple dividend. The page refused the symbol as
  unclassified at 15:23:54. The attestor's key classified the step as a
  dividend at 15:27:29
  ([transaction](https://explorer.solana.com/tx/4RDQ2zqiEBsrWXkAb8oKgoeLDNyaFF5piWeBsXxatuRpiKzJEMicqAFd7aFYAYbqh4jkdu44BjZ8vyjToxNcSb6g?cluster=devnet)),
  and the page passed it again. Inside the window, 15:34:45 to 16:04:45 ET,
  it refused again; the page's first recorded still inside it is 15:35:04.
  The recording is not in this repository; the two transactions are the
  record.
- **The upgrade, and the checks.** At 18:02:52 ET the program data account was
  extended by 50,648 bytes
  ([transaction](https://explorer.solana.com/tx/2xCAD12UPf8miDXj9xuueGeXtdojzTUaaTuifc7pcBxtdG7mrYHV7gqyKhB9aXfZVbFGGsRjCWDD9D7gEAHQxtK8?cluster=devnet)).
  The upgrade landed in slot 503675389, at 18:04 ET
  ([transaction](https://explorer.solana.com/tx/5aM3UhZfADExNbRJMbRwmRt1TsAtMYJZWnDaXJ3ZeRwjb2wCo6k4Yz5x2pFfFoPzEwBP6bPRHKWkQHNFk8TGNcLH?cluster=devnet)).
  The first 462,456 bytes of the program on chain hash to the tested build,
  sha256 `51d509e3f7521484831260882113d9251bedcb3b98bc726298168360d931b4cc`;
  the rest is zero padding. The fourteen checks were opened at 18:05:49 and
  18:05:52 ET, in two transactions of eight and six `open_check`
  ([one](https://explorer.solana.com/tx/5ibXsi1E8m2EVjy6vumWYnD1Ah2Pv97jiFEEDpEPGbN6vSc7K8qPE1sG1HkLFLRxF9QLvjuh6SpDDKyDGXetrvCe?cluster=devnet),
  [two](https://explorer.solana.com/tx/3tmQBQx2iFWNu5QY1wV3XZnJtS6LXALN9SAhqxs4LuvXRPumnN4Kge8DbQtNJ9dRNKB5zC31pbARbpH7xTX4n1EW?cluster=devnet)).
  Each names the checker `FWQd…JVR`.
- **The first night fill.** $5 of demo-USDC for 647,002 raw SPYx at 18:20:28
  ET, for a wallet that had opted in at 18:19:54
  ([transaction](https://explorer.solana.com/tx/dYzTs3SaS8Tmmmo3iDi3trWBiLAhzVZVqjDpZYV9svt5guocoBbL5nYrexZ4W2QSwANPj967dVrfXLi3BAYYqLS?cluster=devnet)).
- **The first per-wallet message.** The keeper sent a Telegram message to a
  chat following the wallet whose order filled at 15:00:06 ET
  ([transaction](https://explorer.solana.com/tx/bEJXacdtQZtqcmag7Ak7JDDTQkRMoNBd82ht1xx9zeA92r3gTQwMkmd8TRJePVPrNqcYBQ22APZWCALwYaq17uA?cluster=devnet)).
- **The first cross.** [cross-fill] at [cross-fill-time] ET, Fri 25 Sep: the $10
  SPYx buy and the partial 0.02 SPYx sale parked for the open, from two
  wallets, crossed at the mark with no filler.

**The close, and the thing we did not expect.** At the 16:00 ET bell on Monday
21 September, the keeper's tick log recorded the two sources never agreeing on
SPYx (and the other four Backed names still trading):

| time (UTC) | Pyth | issuer | BELL |
|---|---|---|---|
| 19:54:51 | open | open | tradeable |
| 19:55:38 → 19:59:31 | **open** | **closed** | refused |
| 20:00:17 → | **closed** | **open** | refused |

Ticks are about 45 seconds apart, so the issuer stopped between 19:54:51 and
19:55:38 — at least 4m22s before the bell at 20:00:00. Pyth marked the session
shut at 20:00:17, 4m39s after the first tick that saw the issuer stopped, by
which time the issuer's 24/5 wrapper read open again. **No tick around the bell
shows both agreeing the market was closed.** A venue trusting Pyth alone keeps trading
after the issuer has stopped; one trusting the issuer alone keeps trading after
the market has shut. BELL refuses across the whole window, because in both
directions the safe reading is the same.

That is a better argument for reconciliation than how often the sources agree.
Mid-session on 23 September (15:51 ET), 675 of the 678 xStocks with a Pyth
US-equity feed agreed with the issuer about whether they could trade; the three
that did not — JPSTx, IWMx and TQQQx — were tokens Backed had stopped while Pyth
said the session was open
([`docs/agreement-2026-09-23T19-51Z.json`](docs/agreement-2026-09-23T19-51Z.json),
from `scripts/agreement.ts`). At the boundary, where it matters, they did not
agree at all.

`EVIDENCE.md` is generated from the tick log by `scripts/evidence.ts`. Every
number in it is counted, not written by hand.

**Tests.** 136 program tests (litesvm; `test_check.rs` 15, `test_cross.rs` 17,
`test_gates.rs` 23, `test_mark.rs` 15, `test_night.rs` 17, `test_ondo.rs` 8,
`test_queue.rs` 22, `test_sell.rs` 19) against the deployed binary — the first
462,456 bytes of the program on devnet hash to the tested build — parsing real
mainnet mint bytes, including a dividend walked end to end on the real AAPLx
mint's own scheduled step, and the five real Ondo mints. No Backed or Backpack
fixture is paused or hooked, so those two gates are tested on a real mint with
one field changed. Every refusal is asserted by its exact error code, never a
bare `is_err()`. 369 TypeScript tests (`node --test test/*.test.ts`),
including one file that removes Node's BigInt `Buffer` methods so browser-only
failures surface under Node, and checks every enum the client mirrors against
the program's IDL; 18 of the 369 cover `reference/session.ts`, a reference
model of the gates that nothing runs. The judge path is scripted too:
`scripts/demo/judge-path.ts` drives a real browser against the live site with
a scripted Wallet Standard wallet.

CI (`.github/workflows/ci.yml`) runs the TypeScript tests, both typechecks and
the web build on every push and pull request. It does not run `cargo test`,
which needs the Solana toolchain and the deployed binary, and that binary is not
committed. `.github/workflows/health.yml` reads the live deployment every 15
minutes, sends nothing, and fails — GitHub emails the owner — if an attestation
is over five minutes old, a mint has not been re-read in ten, a key or the
faucet pool runs low, or the site is down. It does not yet read the checks, or
the checker's balance.

**Reviewed before deploy — an automated adversarial review (84 AI agents), not a
third-party audit.** Six reviewers across the delegation and queue surface, each
finding then attacked by three more instructed to refute it. 26 findings raised:
5 confirmed + 1 hardened, all fixed — including one that let anyone disarm the
rebase gate on any mint, and one that meant the browser could not place or
cancel an order at all. `AUDIT.md` has each finding, its fix and why the rest
died — and two more found afterwards by checking the live deployment against
its own claims, one of them a finding the refuters had killed. A post-deploy
adversarial study (196 AI agents; 62 findings raised, 53 surviving refutation,
merged into 22 items) followed; its fixes are commits `c91ae43` and `29ce852`.
Sell orders came after both, and neither covered them. The upgrade of 24
September — the breaker, the checker, night fills and the cross — had its own
automated reviews before it deployed: two of the program, read independently,
then one each of the services and the page. They found the breaker could be
walked inside one transaction, and a transfer of a few lamports that would
have stopped the keeper, the crank, the checker and the page together. Both
are fixed. `AUDIT.md`, "Upgrade #2", has every finding, what was fixed, and
what was left and why.

---

## What you must trust

Stated plainly, because a guard product that hides its own trust assumptions is
worth less than no guard at all.

**The attestor is trusted, and here is exactly how far.** One hot key can open
or close a symbol (`push_session`), set its price, the *mark* (`push_mark`), and
classify a pending corporate action (`classify_rebase`). It cannot touch the
program, transfer anyone's tokens, or place or cancel an order in anyone's name.

`fill_order`, `fill_sell_order` and `cross_orders` are permissionless. Until the
upgrade of 24 September that meant a leaked attestor key could open a symbol,
push a bad price and fill parked orders against it itself. Since then it can
no longer do that alone. Every fill and every cross also needs the checker, a
second key, to agree (`admit.rs`):

- **about the session.** A session fill needs the checker to say open; a night
  fill needs it to say closed. So the attestor cannot open a symbol at night
  and fill orders that did not opt in, and cannot close one in session to fill
  opted-in orders as if it were night.
- **about the price.** The mark must sit within 300 bps of the checker's
  reference in session, and within 150 bps at night, where a night fill must
  also deliver at least the reference less 150 bps.
- **and the mark must not be held by the breaker**, which lets it move at most
  one 5% step a minute.

What a leaked attestor key can still do: close any symbol, or hold it shut;
clear a halt, since the checker does not read halts or issuer withdrawals; and
move the mark anywhere inside the checker's band, then fill against it. That
leaves an order open to about 3% off the checker's reference in session, plus
its own band, and about 1.5% at night. What bounds that further:

- **A loss floor on the order**, three quarters of what the mark said the order
  was worth at placement, or the buyer's own limit where that asks for more. On
  a sale the floor is a minimum price: three quarters of the price at
  placement, or the seller's own minimum where that is higher.
  The page and `scripts/queue.ts` set it; the program accepts any floor, and a
  buy placed when a symbol had no mark yet has none (a sale cannot be placed
  without a mark). Where there is one, a leaked key pushing a false price cannot
  fill the order for dust.
- **$1,000 per order** (`MAX_ORDER_IN`), enforced by the program. A sale is
  sized in shares, so its cap is its value at the mark in force when it is
  placed, rounded down. That mark needs a price, not a fresh one, so a sale
  placed while the mark is old is sized at the old price; the fill still
  refuses a stale mark.
- `Mode::Strict` limits session fills to when the attested market is live,
  which makes an honest mark arbitrageable. The same key attests the session,
  so on its own it is not a bound; the checker's agreement about the session
  is what makes it one.

So "fails closed" is true of a *silent* attestor — its attestations go stale and
everything refuses — and of a silent checker, whose checks go stale and stop
every fill. It is not true of a *leaked* attestor for anything the checker
does not read. And **a swap guarded by `assert_tradeable` elsewhere gets none
of the checker's protection**: the gate reads the attestation and the mint, not
the check, so for an integrator the attestor alone still says whether the
market is open. A wrongly opened symbol lets such a swap through, with neither
the floor nor the cap, limited only by its own slippage.

**What the checker is, and what it trusts.** The checker is
`FWQdNaez3rAUn9t4VCf1EPs2pB821yPk7vgTFk68uJVR`, run by `scripts/checker.ts` as
the Railway service "checker", pushing every 60 seconds. It reads none of the
keeper's feeds: Nasdaq's public quote and market-status endpoints, with
Yahoo's chart endpoint only where Nasdaq gives nothing
(`src/sensor/nasdaq.ts`). It also reads the local NYSE calendar
(`src/policy/calendar.ts`), a table in the code that the keeper reads too, so
a wrong entry there would mislead both. It says open only
when the calendar says open and Nasdaq says regular session. Its reference is
the last sale in session and, outside it, the regular session's official
close, never an extended-hours print. It pushes nothing for a symbol whose
reading it cannot stand behind, and that symbol's fills stop two minutes later.

Its independence is exactly this: its own key, its own process and its own
data. It is not an independent operator or host. We run it, on the same
Railway account as the keeper, so it guards against a leaked key or a faulty
feed, not against us: anyone who controls that account holds both keys. A
leaked checker key alone can stop fills, by reporting the wrong session or a
reference far from the mark; it cannot make one, since it signs no fill and
sets no mark. Measured in session on 24 September, the xStock marks sat 1–7 bps
from Nasdaq's last sale and Backpack's PFE and LMT 22–52 bps, inside the 300
bps band.

Only the program's upgrade authority can name a checker: `open_check` reads the
authority from the program's own ProgramData account, runs once per symbol, and
refuses a checker that is the symbol's attestor. There is no instruction to
rotate one; changing a checker takes an upgrade. So once the upgrade authority
is burned, the set of checkers is fixed for good, and a symbol whose checker
key is lost stays shut for good.

**The upgrade authority is live.** Until
`Dqp6DbUh6j5Jddff9VHPAK1UpByo85NhLVw83S58Ziqs` is burned, a malicious upgrade
could take whatever you currently have approved — your open orders plus any
approval not revoked — each order capped at $1,000 (a sale at its value when
placed). It could also remove the checker, the breaker or any other rule
above, and it alone opens checks. It is one key today. Burning it is the
production step and is named as such rather than quietly skipped.

**Who holds which key.** Five keys run the devnet deployment. Each hosted
process that signs loads exactly one, from a variable named after its key file
(`loadKeypair` in `src/chain/keys.ts`; the faucet reads its own in
`web/lib/faucet.ts`), and `.dockerignore` keeps every key file out of both
images.

| key | where it is held | what it can do |
|---|---|---|
| deploy, `Dqp6DbUh6j5Jddff9VHPAK1UpByo85NhLVw83S58Ziqs` | The author's laptop, as the Solana CLI's default key. Nothing hosted loads it: the keeper, the checker, the crank and the web server each read one other key, and the health workflow holds none. | Upgrade or close the program, and open a symbol's check, naming its checker. Mint demo-USDC, as that mint's authority. Every issuer power over the fourteen mirror mints: mint, pause, change the multiplier and set a transfer hook; and on the nine Backed and Backpack mirrors, move any holder's mirror tokens as the permanent delegate. |
| attestor, `EsZp7XusAj9fJ1ntQYCTMEw7h6L9mfZUtAvaXDxi4TcG` | Railway, the keeper's service (`BELL_KEY_ATTESTOR`). | Open or close a symbol, set its mark, and classify a pending corporate action. It cannot touch the program or move anyone's tokens. A leak can fill parked orders at a price inside the checker's band, bounded as above. |
| checker, `FWQdNaez3rAUn9t4VCf1EPs2pB821yPk7vgTFk68uJVR` | Railway, the checker's service (`BELL_KEY_CHECKER`), on the same Railway account as the keeper. | Push its own view of each symbol: whether the market is open, and a reference price. It cannot open a check, set a mark, sign a fill or move anyone's tokens. A leak can stop fills, not make them. |
| filler, `4v5r4eSnB7kmnAmJ6ia9X1Mhu7tZKpznLb3x5PdMjtN2` | Railway, the crank's cron service (`BELL_KEY_FILLER`). | Sign fills and crosses, which anyone may do, and spend its own mirror stock and demo-USDC. It has no power in the program that a stranger's filler lacks, so a leak loses its inventory and nothing of anyone else's. |
| faucet, `piSfW5NsLpC1eYCmouMjHj6EEn1SrsXjeZnv3jDmpt5` | Railway, the web service (`BELL_KEY_FAUCET`). | Spend its own pool of demo-USDC and its SOL. It cannot mint and cannot touch the program; the deploy key refills it. |

The attestor's and the filler's key files also stay on the laptop, gitignored,
for the scripts run by hand (`register.ts`, `classify.ts`, a hand-run crank).
The checker's and the faucet's files are kept outside the repository. The
program's own address keypair chose its address at the first deploy; the
upgradeable loader gives it no power after that.

**Planned, not done.** Today each of these keys acts alone (`NOTICE.md`, item
n). One change is planned: the upgrade authority is to move from the deploy key
to a Squads v4 multisig on devnet on Friday 25 September. It has not moved. An
upgrade would then need the multisig's threshold of signatures rather than one
key, but the authority would still be live, so "The upgrade authority is
live", above, would still say what it could do. Moving it does not move the
mint authorities: the mirror mints and demo-USDC stay with the deploy key
unless they are moved separately. The other change planned here before, a
second checker key held by a process apart from the keeper, is on chain since
the upgrade of 24 September. Until the multisig shows on chain, this section
describes the deployment as it is.

**One delegate slot per token account.** SPL delegation is per-owner, not
per-order, so a `revoke` unfunds every one of your orders at once, and placing
one re-approves the whole book, less any order that can no longer fill.
Cancelling one order therefore revokes, closes it, and only then re-approves the
others — never the other way round, which would leave the cancelled order
fillable until its close landed. Buys and sales never share a slot: a buy's
approval is on the demo-USDC account and a sale's on the stock account, so
cancelling a sale leaves every buy funded, and the reverse. A **Revoke all
funding** button is always on screen while BELL holds any approval, on either.

**What a sale trusts.** The same as a buy, with the legs swapped: the filler
pays first, and the program measures the quote that landed in the seller's
account before it moves any stock, so a short payment takes nothing. One
behaviour is documented rather than prevented. A filler may name the seller's
own stock account as where the stock goes; the take is then a transfer from
that account to itself, so the seller is paid, keeps the shares, and the order
closes, and only the filler loses. The seller's approval on that account then
stays standing until they revoke it, or place or cancel another sale from it,
which resets it to what their live sales need; the page shows it, and **Revoke
all funding** clears it (`AUDIT.md`, "Sell orders").

**Every Backed and Backpack mint has a `permanentDelegate`, and two keys cover
all nine.** Not some of them — all nine, verified against the real mainnet
accounts. Ondo's five have none (`test_ondo.rs` reads their real bytes).

| | |
|---|---|
| `5aMNNLQJwAEeoemTEMkv5NVjqKwvvefRYCQ5Z67HFvEq` | all seven Backed xStocks |
| `2cVYpagTt7ZGc3mmTXBa7fAznUtx5DUu6aCq8uVDaf4a` | both Backpack entitlements |

A permanent delegate can move tokens out of any holder's account without that
holder's signature, at any time, for any reason. So two keys can take any
holding of these nine tokens, after any fill, on any venue — and nothing about
BELL changes that. On the nine devnet mirrors of these the delegate is BELL's
own deploy key, `Dqp6…Ziqs`, the same key as the upgrade authority.

Reproduce it: `spl-token display <mint> --url mainnet-beta` against any of the
nine.

`TokenRisk` records it and the page shows it in a disclosure row, which is the
whole of what a guard can honestly do here. This is a disclosure, not a
mitigation, and it is the strongest reason to read these mints rather than trust
a price feed about them: **the risk that matters most is written on the mint, not
in any price.**

**An issuer can change a multiplier with no warning at all.** Gate 4 refuses
for fifteen minutes either side of a *scheduled* activation, and a scheduled one
is visible on the mint before it lands. But Token-2022 lets the multiplier
authority set an effective time of zero or in the past, and applies it
immediately — there is no pending state for any reader to see beforehand. Gate 4
measures its window from the time written on the mint, so zero, or a time more
than fifteen minutes gone, leaves no window to refuse in. The first sign is the
multiplier having moved, which gate 5 does catch for any order built on the old
one; a *new* trade after such a change is then not protected. Nothing on-chain can defend against the
issuer doing this, and BELL says so rather than implying otherwise. Ondo's
mints do this as a matter of course: they write each multiplier already in
force, so an Ondo step gives no notice on the mint before it lands, and gate 4
covers only the fifteen minutes after (`src/listings.ts`;
`an_ondo_multiplier_step_is_refused_only_after_it_lands`).

**Prices are not Pyth.** A free Pyth key returned 403 for every stock-related
feed we tried, and 200 for `Crypto.SOL/USD`. Sessions come from Pyth's free, keyless
`/v2/price_feeds` metadata, checked against a local NYSE calendar that also
stands in when a feed is missing, and marks from one executable Jupiter quote per
symbol; a mark's `conf_bps` is that quote's price impact, capped at 200, not a
disagreement between sources. See `docs/PYTH.md`. The disagreement between
sources is now the checker's job: its reference, from Nasdaq or Yahoo behind
it, is the second price every fill is held to.

**Ondo, and its limits.** SPYon, QQQon, AAPLon, NVDAon and TSLAon are Ondo
Global Markets tokens, not offered to US persons; each one's note on the page
says so (`src/listings.ts`).
Their session comes from the list Ondo's own web app loads
(`app.ondo.finance/api/v2/assets`), which is public but undocumented, so any
change in its shape closes them (`src/sensor/ondo.ts`). Their marks come from
Jupiter, and their Solana liquidity is thin: a $200 quote on 24 September moved
SPYon 75 bps, AAPLon 7.5%, QQQon 23%, NVDAon 60% and TSLAon 87%. Most get no
usable mark, and the checker's band refuses the outliers: NVDAon's mark read
about $2.25 million against NVDA's $224.

**Known, not yet fixed.**

- Registration is first-come, and the page and the filler do not verify a
  symbol's attestor (`guardInstructions` checks one when an integrator pins
  it). All fourteen live records name the right one.
- Session pushes do not require a newer timestamp than the one they replace.
  Mark and check pushes now ignore an older observation.
- The page and `queue.ts` place all-or-nothing orders by default, so crosses
  between them are rare; only `queue.ts --partial` places one that can fill in
  parts.
- The clients retry a send that timed out, and a transaction can land both
  times. A cross takes no amounts, so a retried cross whose first attempt had
  landed would cross whatever both orders still had left. Each owner is still
  held to their own minimums.
- The health check does not read the checks or the checker's balance.

---

## On the regulatory framing

BELL is **not** a registered TSV and must not be read as one. A TSV must be a
U.S. person, publish a public Notice, and give an issuer 30 days' notice in
which to object. BELL is none of those. It is a reference implementation of the
operating conditions, and a non-custodial guard any venue can adopt under the
MIT licence.

The order's §I excludes "securities where a third party issues a crypto asset
representing its own security that provides synthetic exposure to an underlying
security, such as a tokenized linked security or a tokenized security-based
swap." Backed's xStocks are Swiss tracker certificates, which on a plain reading
is that structure. **That reading is analysis, not a legal opinion**, and the
quote is there so you can judge it yourself. Ondo describes its tokens as
backed by the underlying security, which it holds for token holders, and does
not offer them to US persons; BELL lists them on devnet mirrors and says so.

One correction we made rather than buried: we first read Backed's
`isTradingHalted` as an exchange halt. It is not. Cross-checked on 21 September
against Nasdaq's UTP feed — which does carry NYSE Arca halts — IWM and JPST were
absent. The Russell 2000 ETF was not halted; Backed had withdrawn its own token.
Both stop a trade, but §II.H is about the exchange halt, and claiming one that
never happened would be a false statement about one of the world's most liquid
ETFs. They are distinct inputs now, with a test asserting the issuer case never
produces exchange wording.

The program's own message lagged that correction. Until 23 September,
`MarketClosed` (6000) read "Primary listing exchange has halted or suspended
this security" — printed for SPYx on any weeknight and for issuer withdrawals.
A message-only upgrade at 15:32:46 ET that day (slot 503099324) changed it to
"Market is closed or trading in this security is stopped", and `StateStale` to
"Session state is stale; treated as closed". Every error code kept its number.

---

## Run it

Requires Rust 1.89.0 (pinned in `rust-toolchain.toml`), Agave 4.1.2, Anchor
1.2.0 and Node 26 (which runs TypeScript natively — there is no build step).
Build the program first, as `docs/SETUP.md` describes: `localnet.sh` loads
`target/deploy/bell_session.so`, which is not committed.

```bash
pnpm install
solana-keygen new --no-bip39-passphrase -s -o .filler.json   # the filler's key
node scripts/seed-accounts.ts  # its stock inventory → localnet/ (see below)
./scripts/localnet.sh &        # validator cloning the real mainnet mints
./scripts/demo-setup.sh        # local quote asset → .demo.env and web/.env.local
node --env-file=.demo.env scripts/register.ts   # set up the fourteen symbols
BELL_ARM=1 node scripts/keeper.ts   # sense → reconcile → attest, every 45s

node scripts/gate.ts           # what the chain says about each symbol, right now
node --env-file=.demo.env scripts/queue.ts place SPYx 200
node --env-file=.demo.env scripts/crank.ts   # try to fill; watch it refuse and say why

cd web && pnpm dev             # the refusal screen, at :3100
```

**Fills need a checker, and the local validator as scripted cannot have one.**
`localnet.sh` loads the program with `--bpf-program`, which disables upgrades,
so no key can sign as its upgrade authority and `open_check` refuses. The crank
then reports every fill as "no checker yet" (`AccountNotInitialized`, 3012).
The gate itself works, so `gate.ts` and the page's refusals are unaffected. To
fill locally, start the validator with
`--upgradeable-program 56AUPR1c1Tq5AgMvAa3PASax61YYo1KTdocwW6pR7Pdx target/deploy/bell_session.so ~/.config/solana/id.json`
in place of the `--bpf-program` line, then:

```bash
solana-keygen new --no-bip39-passphrase -s -o .checker.json   # its own key
solana airdrop 1 $(solana-keygen pubkey .checker.json) --url localhost
node scripts/open-checks.ts $(solana-keygen pubkey .checker.json) --plan
node scripts/open-checks.ts $(solana-keygen pubkey .checker.json)
BELL_CHECKER_ARM=1 node scripts/checker.ts   # Nasdaq + the calendar, every 45s
```

`docs/SETUP.md` gives the order these must run in on a live deployment.

`demo-setup.sh` writes the quote mint and your quote account to `.demo.env`.
Nothing loads that file for you, hence `--env-file`. It refuses to run a second
time, because a second quote asset would orphan the marks bound to the first.

The filler's stock is not committed either. `seed-accounts.ts` writes it to
`localnet/` for your `.filler.json`, along with the `--account` flags that
`localnet.sh` reads from `localnet/accounts.flags`. To fill a sale the filler
pays instead, from its quote account (`BELL_FILLER_QUOTE`), which
`demo-setup.sh` creates empty: until buys have paid into it, or you send it
some, the crank reports the filler short, not the seller.

`queue.ts place` uses your wallet's own token accounts and creates the stock
one in the same transaction if it does not exist yet; `BELL_USER_QUOTE` and
`BELL_USER_STOCK_<SYMBOL>` override them. `queue.ts sell SPYx 0.1 [MIN_USD]`
sells stock the wallet already holds, from that same stock account, which it
does not create; `queue.ts cancel-sell NONCE` revokes the stock approval, then
closes the order. Either takes `--partial`, for an order that can fill in parts
of about a dollar, so another wallet's order can cross part of it.
`queue.ts night on` and `night off` opt the wallet in and out of night fills.
The wallet is `BELL_PAYER_KEYPAIR`, or the Solana CLI's default key when that
is unset (`FRICTION.md` has what that default cost us once).

Order matters: a mark binds its quote mint permanently, so the quote asset has
to exist before the symbols are registered. `register.ts` refuses rather than
binding a mark to a mint that is not there.

To see fail-closed: stop the keeper, wait three minutes, run `scripts/gate.ts`
again. Everything refuses.

---

## Architecture

```
sensors → policy/reconcile → keeper → [ bell-session program ] ← browser
Nasdaq + NYSE calendar → checker ─────→         ↑
                                    fillers and crosses (permissionless)
```

- **`programs/bell-session`** — the gate, the Token-2022 reader, the queue, the
  circuit breaker, the checks, night opt-ins and the cross, in one program.
  One deploy, one rent payment.
- **`src/sensor/`** — xStocks, Backpack, Ondo, Pyth, Nasdaq UTP halts, Jupiter,
  and for the checker Nasdaq's quote pages with Yahoo behind them. All public
  and unauthenticated, so the demo does not depend on anyone's API key.
- **`src/policy/reconcile.ts`** — merges the sources and closes a symbol when a
  source it needs is missing. Pyth knows the session, the issuer knows its own
  token, and Nasdaq's feed knows exchange halts. A local NYSE calendar
  (`src/policy/calendar.ts`) checks Pyth: if the two disagree about the
  session, the symbol closes. If Pyth's feed is missing, the calendar stands in
  rather than closing the venue for a vendor outage — a deliberate trade, and
  the one place it loosens anything: such a listing opens only when the
  calendar says the regular session is open *and* the issuer is trading, and
  the verdict is logged as degraded. **When the session is open and the issuer
  will not trade a name, that disagreement is the stop.**
- **`scripts/checker.ts`** — the second signer: its own key, its own process,
  none of the keeper's feeds (it shares only the local NYSE calendar). Every 60 seconds on the hosted service it pushes
  each symbol's check: open or not, and a reference price. Dry unless
  `BELL_CHECKER_ARM=1`.
- **`scripts/crank.ts`** — the filler, run by us as a five-minute cron job and
  by anyone else holding the stock, or the quote for sales (on devnet, only we
  can mint the stock). It tries crosses first, then buys, then sales. It
  re-runs the identical on-chain gate and re-reads the mint in the same
  transaction as each fill, and delivers the band edge or the buyer's floor,
  whichever is more. On a sale it pays the band edge or the seller's floor,
  whichever is more, rounded up exactly as the program rounds it, and waits
  while the seller's minimum is above the market. At night it fills only
  opted-in wallets, and adds the checker's reference minimum.
- **`src/alerts.ts`** — the per-wallet Telegram messages, run inside the keeper.
  It reads the program's finalized transactions after each tick and never
  blocks one.
- **`web/`** — Next.js. Orders go browser → wallet → chain with no server of
  ours in between; the server routes are the devnet faucet and three read-only
  views (the US reference price, the tape and the overpay lookup). The site
  keeps working whether or not our keeper is up, and when the keeper is down it
  correctly shows everything closed.

The front end imports the keeper's own modules from `src/` — one codec, one
client — and for the symbol on screen it asks the program itself, by simulating
`assert_tradeable`. A UI that reimplements the rules is a UI that will
eventually lie about them.

**Why Solana.** The guard is a plain instruction, callable by CPI as well as by
prepending it, so the protection composes into any lending market, vault or
wallet. `scaledUiAmount` is a Token-2022 extension, and the trap below is
specific to it. And the SEC's order makes it a condition that a TSV's
smart contracts be public and deployed on a public, permissionless ledger
(§II.A).

---

## The trap that justifies reading mints on-chain

`ScaledUiAmountConfig` carries **two** multipliers. The field named `multiplier`
is stale once `newMultiplierEffectiveTimestamp` has passed. NFLXx's mainnet mint
reports `multiplier 1.0` beside `new_multiplier 10.0` — so the obvious read is
wrong by an entire 10:1 split.

We only caught it because the tests use real mainnet mint bytes. A split and a
dividend are both just a multiplier change and they have opposite consequences
for an AMM: a split leaves value per raw unit invariant, while a dividend steps
it up at a known instant, leaving the pool stale-low by exactly the dividend
from the first block after activation.

More of these in `FRICTION.md`, including what building the front end found.
