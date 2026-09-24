# BELL: a draft of the order's public Notice

> **Unofficial draft. This is not a Notice under the TSV Exemption, and it has
> not been filed or published as one.** BELL is not a Tokenized Securities
> Venue, is not registered with the Securities and Exchange Commission in any
> capacity, and does not rely on SEC Order 34-106402. No written notice has been
> sent to the Commission, and no Issuer Notice to any issuer. Nothing here is
> approved or endorsed by the Commission, and nothing here says BELL is eligible
> for the exemption. It is not: see the table below. Nothing here is a legal
> opinion.

The SEC's order of 17 September 2026 ([Release No. 34-106402](https://www.sec.gov/files/rules/exorders/2026/34-106402.pdf))
exempts Tokenized Securities Venues from the definition of "exchange", on
conditions. One condition (§II.C) is that a TSV publish a Notice answering the
items listed in §III, lettered a to dd. This document answers those items as
BELL would, in the order's own letters and wording. It exists to show plainly
which conditions a non-custodial guard meets, which it exceeds, and which it
does not meet at all.

The order was read from the PDF at the link above, fetched on 24 September 2026
(60 pages, SHA-256 `67bfb89a0d2497787e6366c716312097e921198b82cb152491b7cf7a30360b18`).
Where an answer describes the live deployment, it is the devnet deployment as
read from the chain on 24 September 2026. Every other answer is checkable
against the file it names in this repository.

---

## Where BELL stands against the conditions (§II)

| § | Condition, in short | BELL |
|---|---|---|
| A | Smart contracts auditable, public, on a public permissionless ledger | **Partly.** The source is public under the MIT licence and the IDL is on chain. The live deployment is on Solana **devnet**, a public test network, not mainnet. |
| B | The TSV must be a U.S. person, and so comply with OFAC sanctions | **No.** BELL is not an entity of any kind (item c), so it is not one organized under U.S. law, and it screens no one against the SDN List. *[Whether the person who runs it is a U.S. person is for the operator to state; the code cannot check it.]* |
| C | Publish a Notice 30 days before operating; tell the Commission within one business day | **No.** This draft is unpublished, and BELL has operated without one. |
| D | Issuer Notice 30 days before trading a third-party token; honour objections | **No.** No issuer has been sent an Issuer Notice. |
| E | No primary issuance; verify the token carries the same rights as the stock | BELL issues nothing on mainnet. It has **not** verified holder rights, and the seven Backed tokens are, on a plain reading, the synthetic structure §I excludes (item h). |
| F | At most 75 Tier 1 and 250 Tier 2 symbols; volume under 0.25% / 2.5% of ADV | Nine symbols. BELL does **not** measure its volume against average daily volume. |
| G | USD transaction data for 30 days, updated within ten minutes | **Partly.** `/api/tape` serves it (item t), refreshed at most once a minute. On devnet the paired asset has no dollar value, BELL has no pool to report the size of, and nothing alerts anyone if the tape falls behind. |
| H | Stop concurrently with any halt or suspension on the primary listing exchange, and notify participants immediately | **Partly.** It stops within one keeper tick of a halt appearing in Nasdaq's feed, not at the same instant, and it stops for more than §II.H asks (item cc). The page shows each stop to anyone who looks. BELL keeps no list of participants and notifies none of them individually. |
| I | Notify participants immediately, and the Commission promptly, of a significant operational event | **No.** BELL has no such procedure. A health check emails the operator, and no one else. |
| J | No borrowing, hypothecation or credit | BELL borrows nothing and extends no credit. |
| K | No claim of registration, approval or endorsement; disclose non-registration | Stated at the top of this document. |
| L | Books and records, kept three years, in the U.S., open to examination | **Partly.** The chain holds every transaction, the keeper keeps a tick log, and `scripts/evidence.ts` writes a record of every stoppage in that log into `EVIDENCE.md` (item cc). There is no retention policy, and nothing keeps the records in the U.S. |

Two parts of the definition itself fit BELL least of all. A TSV is by definition
**permissioned**: it sets standards for who may trade (§I.A). BELL is
permissionless: anyone with a Solana wallet can place an order, and anyone
holding the stock, or for a sale the paired asset, can fill one. And BELL provides **no AMM liquidity pool**. A
filler delivers the stock from its own inventory and is paid from the buyer's
delegation. On a sale it is the other way round: the filler pays the paired
asset from its own account and takes the stock by the seller's delegation.
Several items below ask about a pool, and BELL answers that it has none.

---

## The items of §III

### a. Disclaimer

*The order asks a TSV to state that it is not registered with the Commission
and that the Commission has not passed upon the merits or accuracy of the
Notice; that it is not subject to fair access requirements, and that its denials
or limitations of access are not subject to SEC review; and that it is not
subject to Regulation NMS.*

BELL is not registered with the Commission in any capacity. The Commission has
not passed upon the merits or accuracy of anything in this document, which has
not been sent to it. BELL has no access standards at all (item f), so it denies
and limits no one's access. This draft makes no claim about how Regulation NMS,
or any other rule, applies to BELL. That is a legal question, and nothing here
answers it.

### b. Use of the Exemption

*Acknowledge that use of the exemption is subject to Commission oversight, and
that operating inconsistently with it could result in enforcement action.*

BELL does not use the TSV Exemption. If it ever did, it would make that
acknowledgement here.

### c. Overview of the Tokenized Securities Venue

*Structure, organization, products, services and operations; ownership and
governance, onchain and offchain; any affiliated TSV; governance rights of LP
tokens.*

BELL is a project with one author. Every commit in its history is by `OoJae`,
the copyright holder named in `LICENSE`. It has four parts:

- **The program**, `bell-session`, at
  [`56AUPR1c1Tq5AgMvAa3PASax61YYo1KTdocwW6pR7Pdx`](https://explorer.solana.com/address/56AUPR1c1Tq5AgMvAa3PASax61YYo1KTdocwW6pR7Pdx?cluster=devnet)
  on Solana devnet. It is the gate, a reader of Token-2022 mints, and a book of
  parked buy and sell orders ("bell orders"), in one program.
- **The keeper** (`scripts/keeper.ts`, `src/chain/keeper.ts`). Every 45 seconds
  it reads the market-data sources in item s, reconciles them, and writes each
  symbol's session state and price on chain. It also re-reads every mint.
- **The filler** (`scripts/crank.ts`), which BELL runs as a cron job every five
  minutes. It settles orders that are due. Anyone may run one.
- **The page** (`web/`), where a user connects a wallet, reads the gate for
  each symbol, and places or cancels orders. It reads the chain directly, and
  the user's wallet signs and submits.

There is no company, no governance token, no liquidity pool, no LP token and
no governance of any kind, onchain or offchain. Control rests with the keys
named in item n. There is no affiliated TSV.

### d. Non-Exempt Activities

*Whether the TSV, or any person in a group comprising it, is registered with
the Commission in any capacity, and if so, which activities require it.*

BELL is not registered with the Commission in any capacity. *[The operator must
confirm, before this draft is used for anything, that no person who runs BELL
is registered either. This document cannot check that.]*

### e. TSV Participants

*The types of persons eligible to access and participate, including by way of a
broker-dealer.*

Anyone with a Solana wallet, of any type and from anywhere, can place an order.
Anyone holding the stock can fill one, because `fill_order` is permissionless.
On devnet only BELL can mint the mirror stock, so in practice the filler there
is BELL's. A sale is filled by anyone holding the paired asset, because
`fill_sell_order` is permissionless too; on devnet that is demo-USDC, which the
faucet hands to any new wallet. There is no route in by way of a broker-dealer.

### f. Permission Trading Access Eligibility

*The criteria for granting access; procedures for approving persons or wallet
addresses, including identity verification; the conditions for denying or
limiting access, including for OFAC and AML/CFT compliance.*

**None.** BELL has no access criteria. It verifies no one's identity, keeps no
list of approved wallets, screens no address against OFAC's SDN List, and runs
no AML/CFT programme. The program checks an order's funding, its token
accounts and its parameters, and nothing about who placed it
(`programs/bell-session/src/instructions/queue.rs`). This is the widest gap
between BELL and a TSV, which must be permissioned.

### g. Securities, Non-Security Crypto Assets, and Tokenized Money Market Funds Traded

*The Tokenized NMS Stocks and paired assets available, and any pause under the
volume limits.*

Nine listings, pinned by mint address in `src/listings.ts`:

| symbol | underlying | issuer | what the token is |
|---|---|---|---|
| SPYx | SPY (NYSE Arca) | Backed | tracker certificate |
| NVDAx | NVDA (Nasdaq) | Backed | tracker certificate |
| QQQx | QQQ (Nasdaq) | Backed | tracker certificate |
| TSLAx | TSLA (Nasdaq) | Backed | tracker certificate |
| AAPLx | AAPL (Nasdaq) | Backed | tracker certificate |
| IWMx | IWM (NYSE Arca) | Backed | tracker certificate. **Withdrawn by Backed**, and refused. |
| JPSTx | JPST (NYSE Arca) | Backed | tracker certificate. **Withdrawn by Backed**, and refused. |
| PFE | PFE (NYSE) | Backpack | entitlement to the share under UCC Article 8 |
| LMT | LMT (NYSE) | Backpack | entitlement to the share under UCC Article 8 |

None of these securities exists on devnet. The live deployment trades
**mirror** mints that BELL created (`src/mirrors.json`), not the securities.
The only paired asset is **demo-USDC**
([`8QhSxevJerJq8khpNsfW69bUPvcBjMRTXPKrxYQAtAaX`](https://explorer.solana.com/address/8QhSxevJerJq8khpNsfW69bUPvcBjMRTXPKrxYQAtAaX?cluster=devnet)),
a devnet token BELL issued, worth nothing. It is not USDC. No tokenized money
market fund is available. BELL has never paused a symbol under the volume
limits, because it does not measure them.

### h. Tokenization of Securities

*Whether each token is issued by or for the issuer or by an unaffiliated third
party; the tokenizing process; how the TSV evaluates legal status, technical
soundness and operational integrity; and the ledger on which it is issued.*

None of the nine is tokenized by the issuer of the underlying. Backed tokenizes
the seven xStocks and Backpack tokenizes PFE and LMT, and BELL knows of no
affiliation between either and the companies or funds behind the stock. BELL
tokenizes nothing on mainnet, and knows only what these two publish about
their processes.

The order's footnote 101 says that listing a third party's token in a Notice
represents that an Issuer Notice was sent. **None was.** And §I excludes
"securities where a third party issues a crypto asset representing its own
security that provides synthetic exposure to an underlying security". Backed's
xStocks are Swiss tracker certificates, which on a plain reading is that
structure. That reading is analysis, not a legal opinion.

BELL has no procedure for judging a token's legal status. It does check the
technical state of each token, on chain, all the time. The program reads every
mint's Token-2022 extensions itself (`verify_token_risk.rs`): whether the
issuer has paused it, its scaled-UI multiplier and any pending change to it,
whether a transfer hook is armed, and whether a permanent delegate exists. Its
gates refuse on the first four. The keeper re-reads every mint each tick, and
the program refuses a reading more than ten minutes old. All nine are
Token-2022 mints on Solana mainnet. On devnet they are BELL's mirrors of those
mints.

### i. Tokenization

*The steps (audits, certifications, attestations) taken to verify that the
token gives holders the same rights and privileges as the traditional stock.*

**None.** BELL has taken no step to verify holder rights. It discloses one fact
that bears on them. Every one of the nine mainnet mints has a **permanent
delegate**, a key that can move tokens out of any holder's account without the
holder's signature: `5aMNNLQJwAEeoemTEMkv5NVjqKwvvefRYCQ5Z67HFvEq` for the seven
Backed tokens and `2cVYpagTt7ZGc3mmTXBa7fAznUtx5DUu6aCq8uVDaf4a` for Backpack's
two (README, "What you must trust"). A share of the underlying stock carries no
such power.

### j. Notice of Issuer Objection

*Any issuer that has objected in time.*

None. No issuer has objected. None could have, because no issuer was sent an
Issuer Notice (item h).

### k. Tokenization by the TSV or its Affiliates

*Whether the TSV or its affiliates issued or tokenized any token traded on it,
and any difference in treatment.*

On mainnet, no. On devnet, BELL created all nine mirror mints. On the SPYx
mirror, read from its bytes (`test/fixtures/spyx-mirror-mint.json`), BELL's
deploy key `Dqp6DbUh6j5Jddff9VHPAK1UpByo85NhLVw83S58Ziqs` holds the mint
authority, the pause authority, the scaled-UI multiplier authority and the
transfer-hook authority, and is the permanent delegate. The other eight were
created by the same script (`scripts/mirror-mints.ts`), and the chain shows the
same permanent delegate on all nine. The mirrors are test tokens, not
securities. The gates treat them exactly as they treat the real mints.

### l. Trading Activities of the TSV and Its Affiliates

*Whether the TSV or its affiliates can display or enter trading interest, and in
what capacity.*

**Yes.** BELL runs the hosted filler, which fills orders from its own inventory
as a liquidity provider: stock for buys, demo-USDC for sales. It earns the band
between the price mark and what it delivers or pays (item u). BELL also runs
the keeper that attests those price marks.
**The same operator sets the price a fill is measured against and fills at
it.** Each order's own bounds limit what that conflict can cost the buyer or
seller (items cc and z), but they do not remove it.

### m. Differences in Treatment of TSV Participants

*Standards for differentiating among participants, and any differences in
access, entry or display of trading interest, onchain or offchain procedures,
market data and fees.*

The program treats every buyer and seller alike and every filler alike. It
prefers no filler. The hosted filler still has two advantages over any other.
It runs on a schedule next to a keeper run by the same operator. And on devnet
it is the only party that can mint the stock at all. There are no fees to differ (item u).

### n. Distributed Ledger Technology

*The distributed ledger applications and the ledger they run on; cryptographic
protocols; smart contract addresses; user interfaces, wallets and other
applications, and who provides them; interoperability; custom integrations;
and the circumstances under which the applications can be upgraded, modified,
suspended, overridden or ceased, who can do it, and how.*

**Ledger and contracts.** One program on Solana devnet, a public network that
anyone can read and write without authorization. Transactions are signed with
Ed25519 keys. The program is at
`56AUPR1c1Tq5AgMvAa3PASax61YYo1KTdocwW6pR7Pdx`, and its program data at
`AggWzMxY25L17RP1UJPa1wBpxmDsi4rGNE4cfg9FY8nE`. Its IDL is on chain through the
Program Metadata program, at `C1dLwNvn2sMeNK8e8VhtfpoE7dRykTGYnM3YLzUq3Up8`. Token
movements go through the SPL Token and Token-2022 programs, which the program
checks by address (`constants.rs`). The source is in `programs/bell-session`,
under the MIT licence.

**Applications, and who provides them.** BELL provides the page, the keeper,
the hosted filler and a devnet faucet. Third parties provide the user's wallet
(any Solana wallet the page's wallet adapter supports) and the RPC nodes
everything reads and writes through.

**Interoperability and direct access.** Everything the page does, anyone can do
by calling the program directly. `scripts/queue.ts` places and cancels orders
from a terminal, and `scripts/crank.ts` fills them. `assert_tradeable` is a
plain instruction. Another program can call it by CPI, or anyone can put it
first in their own transaction, so any venue can adopt the gate with no
integration and no permission.

**Who can upgrade, modify, suspend, override or cease it.** Each of these keys
acts alone. None is a multisig, and none is timelocked.

- **The upgrade authority, `Dqp6DbUh6j5Jddff9VHPAK1UpByo85NhLVw83S58Ziqs`**,
  BELL's deploy key. The chain names it as the program's upgrade authority on
  24 September 2026. It can replace the program at any moment, without notice,
  through the upgradeable loader, and it can close the program. Until it is
  burned, a malicious upgrade could take whatever a user currently has
  approved: their open orders plus any approval not revoked, each order capped
  at $1,000 (a sale at its value when placed). Burning it is the production
  step, and it has not been taken. On
  devnet the same key also holds every issuer power over the mirror mints (item
  k), including moving any holder's mirror tokens as the permanent delegate.
- **The attestor, `EsZp7XusAj9fJ1ntQYCTMEw7h6L9mfZUtAvaXDxi4TcG`**, a hot key
  held by the keeper. The chain names it as the attestor of all nine symbols
  and all nine risk records. It can open or close a symbol (`push_session`),
  set its price, the *mark* (`push_mark`), and classify a pending corporate
  action (`classify_rebase`). It cannot touch the program, transfer anyone's
  tokens, or place or cancel an order in anyone's name. If it goes silent,
  every symbol reads closed once its last attestation is 120 seconds old.
  That is how BELL suspends, and it needs no one's action. But `fill_order` and
  `fill_sell_order` are permissionless, so a *leaked* attestor key can open a
  symbol, push a bad price and fill parked orders against it itself. Two things
  bound that. One is each order's **loss floor**: three quarters of what the
  mark said the order was worth when it was placed, which on a sale is the
  least it may be paid. The page and `scripts/queue.ts` set it. The program
  accepts any floor, and a buy placed while its symbol had no mark has none; a
  sale cannot be placed without a mark. The other is the **$1,000 cap** per
  order (`MAX_ORDER_IN`), which the program enforces, on a sale against its
  value at the mark when it is placed. `Mode::Strict` is not an independent
  bound, because the same key attests the session. So "fails closed" is true
  of a silent attestor and not of a leaked one. A swap guarded by `assert_tradeable` elsewhere gets neither
  the floor nor the cap.
- **Anyone** can re-read a mint into its risk record (`refresh_token_risk`),
  which can only make the record fresher. Anyone can fill a due order, which
  re-runs the same gate. Anyone can close an order that has expired or lost its
  funding, and its rent always returns to its owner. Anyone can register an
  unused ticker, first come, first served. That confers no power over the nine
  listed symbols, and a fill on such a ticker never reaches the tape.
- **Each user** can cancel their own orders with the token program's `revoke`,
  from their own wallet, with nothing from BELL. It works if the program is
  frozen and every server BELL runs is down. One token account has one delegate
  slot, so a revoke unfunds all of that user's orders on that account at once:
  their buys on the demo-USDC account, or their sales of one stock on its
  account.

**Where the keys are held.** The deploy key is the Solana CLI's default key on
the author's laptop, and nothing hosted loads it. The attestor's key is on
Railway, in the keeper's environment (`BELL_KEY_ATTESTOR`). Two more keys run
services and hold no power in the program. The hosted filler's,
`4v5r4eSnB7kmnAmJ6ia9X1Mhu7tZKpznLb3x5PdMjtN2`, is on Railway in the crank's
environment (`BELL_KEY_FILLER`); it can do nothing a stranger's filler cannot,
and a leak loses only its own inventory. The faucet's,
`piSfW5NsLpC1eYCmouMjHj6EEn1SrsXjeZnv3jDmpt5`, is on Railway in the web
server's (`BELL_KEY_FAUCET`); it owns a pool of demo-USDC and some SOL, is not
the demo-USDC mint authority (the deploy key is), and cannot touch the program.
Each hosted process that signs loads one key (`src/chain/keys.ts`,
`web/lib/faucet.ts`), and no key file is in either image (`.dockerignore`). Two
changes are planned and not made. The upgrade authority is to move to a Squads
multisig on Friday 25 September 2026, before submission. An upgrade would then
need the multisig's threshold of signatures rather than one key, and the
authority would still not be burned. Moving it would not move the mint
authorities. And a second, independent checker key is to be added beside the
attestor; the program has no instruction for it yet. Until
each shows on chain, this item describes the deployment as it is (README,
"What you must trust", under "Who holds which key").

### o. Entry of Trading Interest

*Procedures and functionality for entering trading interest, the information
asked of participants, how transactions are approved and confirmed on the
ledger, and the price and size parameters, limits, and messages or flags given
to users.*

A user picks a symbol and a dollar amount and signs once. That one transaction
approves a delegation of the user's demo-USDC for their whole book of orders
and places the order (`place_order`). The funds stay in the user's wallet. The
program refuses the order unless the delegation already covers it, so an
unfunded order cannot exist. The page sets every other parameter
(`web/lib/queue.ts`, `src/policy/order.ts`, `src/policy/expiry.ts`):

- **Size:** above zero and at most 1,000 demo-USDC, which the program enforces
  as `MAX_ORDER_IN`. There is no daily limit. Each order fills all at once or
  not at all.
- **Band:** at most 30 bps below the mark's fair size, by default. The program
  allows up to 500.
- **Price uncertainty accepted:** at most 50 bps, or 100 for PFE and LMT. The
  program allows up to 200.
- **Loss floor:** three quarters of the order's value at the placement-time
  mark. A user may also give a limit price per share. The floor is then
  whichever of the two asks for more stock, so a limit can only tighten it
  (`orderFloor` in `src/policy/order.ts`). While a limit is below the market,
  the hosted filler leaves the order waiting (`scripts/crank.ts`).
- **Expiry:** six hours after the next open, and at least a day away. When the
  next open is not known it is four days. It is never beyond the program's
  seven-day ceiling.
- **Repeat:** instead of one order, a user may place one at each of the next
  few opens that fall inside that ceiling, taken from the NYSE calendar, under
  one approval. Each is held back until its own open by the order's
  `not_before`, which the program enforces, and lapses six hours after it
  (`recurringSlots` in `web/lib/queue.ts`). When the approval and the orders do
  not fit in one transaction, the page sends them as several, in order, and
  most wallets sign them in one prompt.

A user may also sell stock they hold, in the same way, in shares rather than
dollars (`placeSellInstructions` in `web/lib/queue.ts`, `sell` in
`scripts/queue.ts`). The one transaction approves the user's **stock** account,
under Token-2022, for what that account's live sales still need, and places the
order (`place_sell_order`). It never touches the demo-USDC approval that funds
the user's buys. The shares stay in the user's wallet, and the program refuses
the sale unless the stock delegation already covers it. The band, the price
uncertainty and the expiry are a buy's. The rest differs:

- **Size:** a number of shares, converted to raw units through the multiplier
  in force and rounded down (`sharesToRaw` in `src/policy/order.ts`). The
  program caps the sale's value at 1,000 demo-USDC, measured at the mark when
  it is placed and rounded down, and refuses a sale while that mark carries no
  price. The page's "max" offers at most about $990, so that a tick up before
  the wallet signs does not push it over. Each sale fills all at once or not at
  all.
- **Loss floor:** the least the sale may be paid a share, where a buy's limit
  is the most it may pay: three quarters of the placement-time price, or the
  user's own minimum price per share where that is higher (`sellOrderFloor` in
  `src/policy/order.ts`). While the minimum is
  above the market, the hosted filler leaves the sale waiting. Every minimum on
  a sale, the band's and the floor's, rounds up, in the seller's favour.
- **Repeat:** none. A sale is of shares already held.

When the gate refuses, the page names the refusal by the program's own error
(`MarketClosed`, `StateStale`, `RebasePending` and so on) and says what it
means. Solana's validators confirm transactions. The program settles a fill
atomically. On a buy the stock is delivered and measured first, then the
demo-USDC is taken; on a sale the demo-USDC is paid and measured first, then
the stock is taken (item y).

### p. AMM Liquidity Pool Trading Procedures

*Procedures for creating, modifying, accessing and funding pools; purchasing
and selling through a pool, including pricing models, priority, order types,
trading rules, allocation and execution; and pool customization.*

**BELL provides no AMM liquidity pool,** so there is no pool to create, fund or
customize, and no pricing curve. There are two order types, a buy and a sale.
The program fills a buy by measuring what landed in the buyer's account after
the transfer. It must be at least the band below the fair size at the mark in
force when the fill lands, and at least the order's floor
(`programs/bell-session/src/instructions/fill.rs`). It fills a sale by
measuring the demo-USDC that landed in the seller's account before any stock
moves. That must be at least the band below the stock's value at the mark in
force, and at least the order's floor, each rounded up
(`programs/bell-session/src/instructions/sell.rs`). Fillers have no priority
among themselves: the first valid fill to land settles the order.

### q. Offchain Trading Procedures

*Offchain functionality used to facilitate trading, where in a trade's
lifecycle it is used, and how participants access it.*

Three offchain processes, all BELL's:

- **The keeper** senses and attests market state before any trade (items r and
  s). A user never calls it.
- **The hosted filler** chooses when to fill, sources the stock for a buy and
  pays the demo-USDC for a sale. On devnet it fills buys from inventory BELL
  minted, and pays for sales from its own demo-USDC account. Filling on
  mainnet, by buying the stock first, is not built.
- **The page's server.** It has three routes: a devnet faucet (`/api/faucet`)
  that hands a new wallet test funds, the tape (`/api/tape`, item t), and the
  last US price of each underlying (`/api/reference`, item s), which the page
  shows beside the pool's price. None is in the order, fill or cancel path.

### r. Hours of Operations

*State the hours of operation, including whether the TSV offers trading on a
24/7 basis.*

**BELL does not offer trading on a 24/7 basis.** It fills trades only in the
regular session of the underlying's primary listing exchange: 09:30 to 16:00
New York time on a trading day, to within one keeper tick. Pyth's market-hours
metadata says when that session is open, and BELL checks it against its own
copy of the NYSE calendar, with the 2026 and 2027 holidays and 13:00 early
closes (`src/policy/calendar.ts`). If the two disagree, the symbol is closed.
Where Pyth has no feed for a listing, the calendar alone says when the session
is open. The issuer must also be trading. A fill also needs no halt, and a price mark
at most 60 seconds old.

The chain runs around the clock, so an order can be **placed or cancelled at
any hour**. Outside the regular session, the page refuses a trade and offers to
queue it for the opening bell. A queued order waits, funded by delegation, and
fills on the first filler pass after the open once a fresh mark lands. The
hosted filler runs every five minutes. On 23 September 2026 it filled an
overnight $200 SPYx order in a block timestamped 09:35:24 ET, five minutes
after the bell
([transaction](https://explorer.solana.com/tx/5mj8qKbkZLz1M4e8i1cA8rJRuQGkwrzC1QEgfbTvMNcrXabGrT79U8SBVzLgtfEBTP9zURvZxVaaBeQE7EwMCFqt?cluster=devnet)).
A sale waits and fills the same way. The first sale on devnet, 0.02 SPYx for
15.267831 demo-USDC, is in a block timestamped 10:04:28 ET on Thu 24 Sep
([transaction](https://explorer.solana.com/tx/4trvXZHKDPrjqSjkwshjiiztct3uwPQUXdaTK8Td5i5v5yGGH6fZPmWsQd1gRf3L4eWCLGYNRon1qUYuWoEW9VDm?cluster=devnet)); it was placed during the session, so
it did not wait for a bell.

This is stricter than §II.H requires. §II.H requires a TSV to stop when trading
in the underlying stops on its primary listing exchange, "which includes a halt
or a suspension". It does not require a stop merely because that exchange is
closed, and the order counts "around-the-clock trading" among a TSV's potential
benefits (§I.B). BELL refuses the closed market anyway. That is the hours when
an AMM pool has nothing to check its price against, and the refusal becomes an
order that waits for the bell. Backed's own API reports its tokens open around
the clock on weekdays. BELL does not trade them in those hours.

### s. Use of Market Data

*Whether and how the TSV uses external market data, such as oracles; the
third-party providers and their sources; the purposes of the data; and how
oracles are used.*

BELL is its own oracle. The keeper reads the sources below every 45 seconds,
reconciles them in `src/policy/reconcile.ts`, and writes the result on chain,
signed by the attestor. It writes each symbol's session state (`push_session`:
open or closed, and the halt state, if any) and its price mark (`push_mark`).
The program trusts nothing the keeper wrote beyond a fixed age. A session
state more than 120 seconds old reads as closed. A mark more than 60 seconds
old cannot price a fill. Every source is public, and none needs an API key.

| provider | what BELL reads | what for |
|---|---|---|
| **Pyth Network**, Hermes `/v2/price_feeds?asset_type=equity` | each US equity feed's market-hours metadata: open now, next open, next close, schedule | whether the regular session is open. **No Pyth price is read.** A free key returned 403 for every stock feed tried (`docs/PYTH.md`). |
| **Backed** (xStocks), `api.xstocks.fi/api/v2/public/assets/{symbol}` | the issuer's own flags for each token: open now, halted, next change | whether the issuer will trade its own token |
| **Backpack**, `api.backpack.exchange/api/v1` `market-sessions`, `market-holidays`, `securities` | the session calendar for its two listings | the same, for Backpack's listings, which publish no halt flag |
| **Nasdaq**, the Nasdaq Trader trade-halt RSS feed | every published halt, with its reason code and resumption time. UTP carries Nasdaq-listed and other exchange-listed issues. | exchange halts on the primary listing: the §II.H input |
| **Jupiter**, `lite-api.jup.ag/swap/v1/quote` | one executable $200 USDC-to-stock quote per symbol, on mainnet | the price mark, and its uncertainty (the quote's price impact, capped at 200 bps) |
| **Nasdaq**, the public quote endpoint `api.nasdaq.com/api/quote/{symbol}/info` | the last sale of each underlying, delayed in the session, with Nasdaq's own market-status label | display only: the page shows it beside the pool's price. No gate, order or fill reads it. |
| **BELL's own table**, the NYSE calendar in `src/policy/calendar.ts`, copied from the holiday pages NYSE and Nasdaq publish | the regular session, holidays and early closes, for 2026 and 2027 | a second opinion on the session. Where Pyth has a feed, it can only close a symbol that Pyth would open. It stands in when a US listing's Pyth feed is missing. |

The rules fail closed (`reconcile.ts`). An exchange halt stops the symbol, with
the kind its reason code maps to. So does an issuer withdrawing its token. So does the session
being open while the issuer will not trade: that gap is how a halt shows up
when nobody publishes a reason. A missing issuer reading stops the symbol too.
If Pyth and the calendar disagree about the session, the symbol closes. If a
US listing has no Pyth feed, or Pyth's list cannot be read at all, the calendar
stands in, so the symbol opens only in the regular session. A halt feed that
cannot be read fails the whole tick, so nothing is attested and every symbol
closes 120 seconds later.

The mark serves three purposes. It sets the **band** a fill must land inside.
It anchors the **loss floor** when the order is placed. And a stale mark cannot
settle anything. It comes from one source, the Jupiter quote, with no second
price to check it against (item z).

The program also reads the Token-2022 mint itself: pause, multiplier, transfer
hook and permanent delegate (item h). That is not market data and not an
oracle. The chain proves those facts, which no attestor can misreport.

### t. Display

*What trading interest is displayed, when, onchain or offchain, and how it is
accessed; and what information a transaction disseminates, by whom, to whom,
when and how.*

Every order is an account on chain, and anyone can read it (`readOrders` and,
for sales, `readSellOrders` in `src/chain/client.ts`). Its owner, symbol, size,
floor and expiry are all public from the moment it is placed. The page shows a user only their own
orders. For each symbol it shows the attested state, the mark, and the gate's
verdict, which it gets by simulating `assert_tradeable` against the chain.

Every fill emits an event on chain: `OrderFilled` for a buy, `SellOrderFilled`
for a sale. It carries the symbol, the amounts, and the mark that priced the
fill. The page's server has a route,
`/api/tape` (`web/app/api/tape/route.ts`), that turns those events into §II.G's
fields. It serves every fill of a listed symbol from the last 30 days, as JSON
or, with `?format=csv`, as CSV. Each row has the symbol and paired asset, the
price per share, the size, the block time in UTC, the direction (`buy`: the
buyer contributes demo-USDC and withdraws the stock; `sell`: the seller
contributes the stock and withdraws demo-USDC), and the order, program, filler
and transaction addresses. The route also gives each pair's volume over the
last 24 hours, buys and sales together. It serves everyone the same data at
the same time, reads only finalized transactions, and refreshes from the chain
at most once a minute. The public rows leave off the buyer's and the seller's
wallet. A request for one wallet's purchases (`?buyer=`), sales (`?seller=`) or
both returns those rows with it, which is how the page shows a user their
receipts; anyone could find the same rows by following the transactions. Its limits are stated in the response itself. On devnet the paired
asset has no dollar value. There is no pool whose end-of-day size could be
reported. And after a restart, or a burst of transactions, it catches up in
bounded steps and says it is incomplete until it has.

### u. Fees

*The fee structure: charges, fees, rebates, discounts and other compensation,
their source, any sharing with participants, and the formulas used.*

**BELL charges no fee.** A filler is paid by the band. On a buy the program
requires it to deliver at least `fair × (1 − max_slip_bps / 10,000)` of the
stock, where `fair` is the order's size at the mark, and at least the order's
floor. The hosted filler delivers exactly the larger of the two
(`scripts/crank.ts`), and waits rather than fill when the floor asks for more
stock than the mark gives, which is a limit below the market. A sale runs the
other way: the filler must pay at least `fair × (1 − max_slip_bps / 10,000)` of
demo-USDC, where `fair` is the stock's value at the mark, and at least the
order's floor, each figure rounded up (`sell.rs`). The hosted filler pays
exactly the larger, and waits while the floor asks for more than the mark says
the stock is worth, which is a minimum above the market. So an order's band,
30 bps by default, is the most the buyer or seller pays the filler against the
mark at the fill. The 23 September fill recorded a realized cost of 31 bps
against its mark, rounding included. The signer pays Solana's network fee,
5,000 lamports per signature. An order account holds about 0.002 SOL of rent,
which returns to its owner when the order fills or closes. A first sale from a
wallet with no demo-USDC account also creates that account, the user's own,
for the proceeds; it holds 2,039,280 lamports of rent. Nothing is shared with
anyone. On devnet, all of it is test money.

**No per-fill fee is implemented.** The program has no fee account and no
instruction that takes one. So the band is the most a filler earns against the
mark, and it goes to whichever filler lands the fill; BELL's hosted filler is
one (item l). As intent only, BELL might charge a venue or wallet that puts the
gate in front of its own trades (`docs/INTEGRATE.md`) for keeping fresh the
session attestations that gate reads. No such arrangement exists.
`assert_tradeable` takes no fee and needs no permission, so nothing on chain
would enforce one (README, "How BELL would pay for itself").

### v. Complaints and Disputes

*Procedures for resolving complaints, execution errors and disputes; if none,
state so.*

BELL has no procedures for resolving participant complaints, execution errors
or disputes.

### w. Procedures to Protect TSV Participant Information

*Procedures and safeguards for participants' confidential information and PII,
whether it is shared with other parties, and any policies and procedures to
address Maximal Extractable Value (MEV); if none, state so.*

**Participant information.** BELL has no accounts. It asks for no name, email
address or identity document, and holds no confidential trading information,
because an order holds nothing that is not public on chain (item t). It
provides no wallet. The only server route that keeps anything about a visitor
is the devnet faucet. It keeps the wallet address and the requesting IP address
in memory, only to rate-limit grants, and loses them on every redeploy
(`web/lib/faucet.ts`). BELL shares no participant information with anyone,
because it has none to share. It has no further procedures or safeguards for
participant information.

**MEV.** BELL has **no policies and procedures designed to address MEV.** What
its design does, and does not do, is mechanical:

- **The price is fixed by the mark, not the order of transactions.** A fill
  never trades against a pool. The program measures what reached the buyer, or
  on a sale the seller, and it must be at least the band below the fair value
  at the mark, and at least the floor. A transaction placed in front of or
  behind a fill cannot change what the user is owed. So a sandwich of the
  user's own fill does not exist here.
- **The filler holds a timing option.** Any filler may choose when to fill a
  due order. The mark changes with every keeper tick, so a filler can wait for
  the mark that suits it best. The band and the floor bound that choice. They
  do not remove it.
- **The mark can be moved at its source.** It is one executable quote from
  mainnet pools. Someone who moves those pools as the keeper quotes them moves
  the mark. The uncertainty cap measures the quote's price impact, which does
  not reveal a moved pool. Only the order's floor bounds the result.
- **The book is public.** Every pending order's size, symbol, floor and expiry
  can be read before the open.
- **Submission is ordinary.** The page's user and the hosted filler submit
  through RPC nodes like any other transaction. BELL uses no private relay and
  no bundle service.

### x. Systems Safeguards

*Procedures for capacity, integrity, resiliency, availability and security:
code review, audits, pre-trade risk assessment, post-deployment monitoring,
authorization controls, stress tests, business continuity and disaster
recovery, incident response; if none, state so; and who performs each.*

One developer does all of this, with automated tools. There has been
**no third-party audit**. BELL has not had a security audit, a SOC 2 audit, a
stress test, or a business continuity or disaster recovery plan, tested or
not. It has no incident response procedure.

- **Code review:** an automated adversarial review by 84 AI agents before the
  devnet deploy. It raised 26 findings; 5 were confirmed and 1 more was
  hardened, and all were fixed. A post-deploy adversarial study by 196 AI
  agents followed. It raised 62 findings, 53 survived refutation, and they were
  merged into 22 items (`AUDIT.md`). One item found since is fixed, in the
  commit that added sell orders (`64549f0`). Sell orders came after both
  reviews, and neither covered them.
- **Tests:** 64 program tests against the deployed binary, parsing real mainnet
  mint bytes (`programs/bell-session/tests/`), 19 of them on sell orders. They
  assert every refusal by its exact error code. There is also a TypeScript
  suite of 204 tests (`node --test test/*.test.ts`). CI runs the TypeScript tests, both typechecks and the web
  build on every push. It does not run the program tests.
- **Pre-trade risk checks:** the gates, on every fill (item cc).
- **Post-deployment monitoring:** `.github/workflows/health.yml` reads the live
  deployment every 15 minutes. It emails the operator if an attestation is over
  five minutes old, a mint has not been re-read in ten, a key or the faucet
  pool runs low, or the site is down. The keeper exits to be restarted when it
  stops completing ticks, and the filler abandons a pass that runs over four
  minutes.
- **Authorization controls:** the keys in item n, each held alone. The upgrade
  authority is live.
- **Availability:** a failure closes the venue. If the keeper stops, every
  symbol reads closed within 120 seconds. If the filler stops, orders wait.
  Nobody has to act for either.

### y. Clearing procedures and arrangements

*Procedures or material arrangements to facilitate clearance and settlement,
and any requirements on participants.*

There is no clearing agency and no central counterparty. A fill settles
atomically in one Solana transaction. On a buy, the filler's stock is delivered
and measured first, then the buyer's demo-USDC is taken under the delegation.
On a sale, the filler's demo-USDC is paid and measured first, then the seller's
stock is taken under the delegation. If the delivery or the payment falls
short, the whole transaction fails and nothing moves. A buyer needs a token
account for the stock, which placing the order creates, and an approval that
still covers their orders. A seller needs the shares, a demo-USDC account for
the proceeds, which placing the sale creates, and an approval on the stock
account that still covers their sales.

### z. Risks

*Known material risks to participants or the market's integrity, the actions
taken to mitigate them, and any compensation for losses.*

BELL compensates no one for any loss. These are the risks it knows of, with
what bounds each (README, "What you must trust"; `AUDIT.md`):

- **A leaked attestor key** can open a symbol, push a bad price and fill parked
  orders itself. Each order's loss floor bounds it, where the order has one, as
  does the $1,000 cap. A sale placed by the page or `scripts/queue.ts` always
  has a floor; a sale's cap is its value at the mark when placed, and that mark
  need not be fresh.
- **The live upgrade authority** can replace the program and take whatever a
  user has approved (item n).
- **Permanent delegates.** The issuer's key can move any holder's tokens on all
  nine mainnet mints, after any fill, on any venue. BELL discloses this and
  cannot prevent it (item i).
- **Instant corporate actions.** An issuer can set a new multiplier effective
  immediately, leaving no window for the rebase gate. Gate 5 then refuses any
  order built on the old multiplier, but a new trade is not protected.
- **Oracle manipulation.** The mark comes from one source (item w). Only the
  floor bounds a moved mark: a fill can deliver as little as three quarters of
  what the order was worth at the mark when it was placed, and a sale can be
  paid as little as three quarters of the price when it was placed.
- **Liveness.** A silent keeper closes everything. An absent filler leaves
  orders to wait and expire. Neither loses funds.
- **Smart contract bugs.** There has been no third-party audit (item x), and
  neither review in item x covered sell orders. The known unfixed issues
  are listed in the README. Clients do not verify a symbol's attestor. Pushes
  do not require a newer timestamp. One sale behaviour is documented rather
  than prevented: a filler that sends the stock back to the seller's own
  account pays for nothing, and the seller's approval on that account stays
  standing until they revoke it (`AUDIT.md`, "Sell orders").
- **Information leakage.** The book is public before the open (item t).
- **A test network.** On devnet the tokens are mirrors and the money is not
  money. Nothing on devnet has value.

### aa. Service Providers

*Entities other than the TSV that support its services, and their roles.*

- **Railway** hosts the page, the keeper and the hosted filler.
- **GitHub Actions** runs CI and the 15-minute health check.
- **Solana RPC providers** serve every read and write.
- **Pyth Network, Backed, Backpack, Nasdaq and Jupiter** provide the market data
  in item s.
- **The user's wallet** belongs to whichever provider the user chose.

No one provides permissioning, surveillance, cyber-risk or clearing services,
because BELL has none of those functions.

### bb. Trading Oversight

*Monitoring for fraud, manipulation, illegal trading and other abuse; if none,
state so.*

BELL does not monitor for fraudulent or manipulative trading, illegal trading
or any other market abuse. The keeper records what the market-data sources said
and what BELL decided. It does not look at who traded.

### cc. Stoppage of Trading

*The circumstances in which the TSV would stop trading or displaying trading
interest; risk controls, including circuit breakers and reference price bands;
procedures for volatility and for corporate actions when the underlying market
is closed; and the circumstances and procedures for resuming.*

**When BELL stops.** Every fill, a buy's or a sale's, runs the same gate as
`assert_tradeable`: one function, in `assert_tradeable.rs`, that
`assert_tradeable`, `fill_order` and `fill_sell_order` all call. It refuses, in
this order, numbered as the README numbers the gates:

- **1. The state is stale.** An attestation more than 120 seconds old reads as
  closed. So a dead keeper, or a source outage that fails the tick, closes the
  symbol by itself.
- **2. Trading is stopped.** An exchange halt or suspension on the primary
  listing, attested with a kind the keeper classifies from Nasdaq's reason code:
  a volatility pause, news pending, a market-wide circuit breaker, a suspension,
  or unspecified for any other code (`src/sensor/halts.ts`). Or the issuer withdrawing its
  token, the issuer not trading while the session is open, or no reading from
  the issuer at all.
- **2b. The mint was not read recently.** A risk record more than 10 minutes
  old is refused.
- **3. The issuer has paused the mint.**
- **4. A corporate action is near.** A scaled-UI multiplier change is scheduled
  within 15 minutes either side of now, or a pending change is not yet
  classified as a split or a dividend.
- **5. The multiplier moved** since the order was built.
- **6. A transfer hook is armed.**
- **7. The regular session is closed** (item r).

A fill also refuses a mark more than 60 seconds old, a mark more uncertain than
the order accepts, a fill below the band or the floor, an order not yet due
(its `not_before`), and an expired order.

§II.H asks for a stop "concurrently with any stoppage of trading in the
underlying NMS stock on the primary listing exchange". BELL stops **within one
keeper tick of the halt appearing in Nasdaq's feed**, not at the same instant.
The keeper reads the feed every 45 seconds, and the attestation then has to
land. A fill already in flight in that
interval can still settle. BELL never stops to stay under a volume threshold,
because it does not measure them.

**Risk controls.** BELL has no circuit breaker of its own. It has one reference
price band: every fill must land within the order's band of the attested mark
(30 bps by default, at most 500). Each order carries a loss floor at three
quarters of its value at the placement-time mark, and a $1,000 cap; on a sale
the floor is the least it may be paid, and the cap is its value at that mark.
All of these are the program's checks, in `fill.rs`, `queue.rs` and `sell.rs`.

**Corporate actions while the market is closed.** The rebase gate measures its
window from the activation time written on the mint, so it holds at any hour.
An activation scheduled overnight is refused for 15 minutes either side of it,
whether or not the market is open. An order parked across a corporate action
is not filled at a new size: gate 5 refuses it for good, and its owner can
cancel it. One case is not covered. An issuer can make a change take effect
immediately, with no window at all (item z).

**Resuming.** It is automatic, and no one decides it. When the keeper next
reads the stop as over, it attests that. For an exchange halt, that means once
Nasdaq has published a resumption time and it has passed. Trading then resumes
if every other gate passes. A parked order fills on the next filler pass after
a fresh mark lands. Displaying resumes the same way, since the page shows
whatever the chain holds.

**Notices and records.** BELL keeps no list of participants, and notifies none
of them individually of a stoppage. Each stop is public from the tick that
first sees it, as the attestation on chain, and on the page, which reads it. For the record the order's footnote 84
asks a venue to keep, `scripts/evidence.ts` writes a **Stoppages** section into
`EVIDENCE.md` from the keeper's log. For every interval in which a halt was
attested, it gives the symbol, the reason, the start and end, why trading
resumed, and the transaction that carried each change. It keeps ordinary
closes apart.

### dd. Exclusive or Predominant Venue for Trading of a Tokenized NMS Stock

*Whether the TSV may be the exclusive or predominant venue for a token, the
risks of that, and procedures to address them.*

No. Nothing in these tokens ties them to BELL. The mainnet tokens trade on
other venues, and a buyer holds what they bought in their own wallet, free to
take it anywhere. On devnet the mirror tokens trade nowhere else, but they have
no value.

---

## What this draft leaves out

- **Contact details** for the Commission and for issuers (§II.C, §II.D).
  BELL has not given any, because it has not filed.
- **A revision history** (§II.C). There is none, because nothing has been
  published.
