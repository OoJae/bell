# BELL — film script (draft 5: the voiceover is final)

Three minutes, 423 spoken words at a natural pace. The beats are fixed,
and every on-screen claim must be something the footage actually shows. Read it
aloud once before recording. If a line feels like a mouthful, the line is
wrong, not you.

Recording notes for the voiceover: one take per section is fine; leave a
second of silence between sections so the cut can breathe. Speak it to one
person, not to a room. Everything the voiceover says is true tonight, Thu 24
Sep. The one thing still to happen, the cross, is described as a mechanism and
not as an event, so the line holds whether or not Friday's footage lands.

Where the footage comes from, all Thursday 24 Sep unless marked:

- The bell fill: the bell recording, 09:25–09:35 ET
  (`demo/recordings/page@ca5411….webm`, log `demo/recordings/bell-2026-09-24.log`).
- The receipt and the sale: stills from the live page at 10:14–10:15 ET
  (`demo/recordings/sell-live-*.png`). They show the header line from before the
  tagline became "trade", so crop to the order box and "Your fills".
- The dividend: `demo/recordings/rebase/`, 15:22–16:12 ET, a video and a
  full-page still about every 20 s (`demo/recordings/rebase.log`).
- The upgrade: 18:04 ET. Film the gate panel's new rows and the night switch on
  the live page after 18:06 ET, when the checks were opened.
- The night fill: on chain at 18:20 ET. An explorer capture of it can be taken
  at any time.
- The cross: Friday 25 Sep from 09:25 ET (`demo/recordings/cross-2026-09-25.log`).

Notifications are not in this script: the public channel @bellfills and the
per-wallet messages from @Bell_solbot.

---

### 1 · The problem (0:00–0:34)

*On screen: the live board at night, the New York clock reading closed. Then
the AMC chart. Lower-third: "tokenized AMC, Robinhood Chain, early Sep 2026 ·
IOSG's figures via crypto.news, 8 Sep". Then the census figures in a terminal
(`node scripts/overpay-census.ts --from <copy of the reviewed run>`). Lower-third,
two lines: "Solana mainnet, 17–24 Sep · a sample: 24 USDC buys of $1+ made
outside the session, 20 wallets, $1,468, 18 of them small Ondo buys" and "19
paid more a share than the next open · median +44.1 bps · the gap includes real
overnight moves".*

> You live in Lagos. You hold dollars in your wallet, and you want the S&P
> 500.
>
> On Solana you can buy it at any hour. But while New York is shut, the pool
> you're buying from has nothing to check its price against. In early
> September, a tokenized AMC traded at eighteen dollars, after the real stock
> had closed at two fifty-four.
>
> We checked twenty-four Solana buys made while New York was shut. Nineteen
> paid more than the next open.

### 2 · What BELL is (0:34–0:49)

*On screen: the page: the line under the title, the clock, the board of
fourteen. Lower-third: "devnet mirrors of 7 Backed xStocks, 2 Backpack tokens
and 5 Ondo tokens · Ondo's are not offered to US persons".*

> BELL is the safe way to trade US stocks from your own wallet, at any hour.
>
> In the regular session, it trades. When a stock is halted, or a dividend is
> due, it refuses, on-chain.

### 3 · The refusal (0:49–1:14)

*On screen: the gate panel lighting row by row. Then the landed refusal in the
explorer: devnet, Wed 23 Sep 16:26 ET, sig `2Ue1to…Cr1pH`: MarketClosed
(custom 6000), "Market is closed or trading in this security is stopped", fee
paid, no transfer. Lower-third: "devnet · a lamport transfer stands in for the
swap". Then the SEC order, §II.H highlighted. Lower-third: "Order 34-106402,
17 Sep 2026". A panel filmed after 18:06 ET also shows three fill rows under
the gates ("circuit breaker clear", "second source agrees", "within the band
of Nasdaq"); section 7 is where they belong, so hold on the first eight rows
here (attestation fresh down to market open).*

> In session, every trade passes seven gates. The pause, the dividend and the
> hook are read straight off the Token-2022 mint.
>
> On September 17th the SEC wrote that a tokenized-stock venue must stop
> trading whenever the real stock is halted. BELL does that, and goes further.
>
> When a gate fails, the transaction fails. Here's one we sent anyway: fee
> paid, nothing bought.

### 4 · The bell (1:14–1:56)

*On screen: an order queued at night with a limit price; the balance
unchanged. Cut to the bell: the badge turns tradeable, the order line goes, the
holding grows. Then the receipt under "Your fills", and the fill in the
explorer. Lower-third: "devnet · the price is a live mainnet Jupiter quote; the
filler delivers mirror SPYx for demo-USDC".*

*Then the night switch, "Fill my orders at night, inside the band", turned on;
the clock line "night band on: this wallet may fill within 150bps"; and the
night fill in the explorer. Lower-third: "devnet · Thu 24 Sep 18:20 ET · a
night fill: $5 of demo-USDC for 0.00647002 SPYx · sig dYzTs3…LqS".*

*Then the cross: [cross-fill] in the explorer, one `cross_orders` instruction,
the stock going from the seller to the buyer and the demo-USDC from the buyer
to the seller, with no filler account among them. Then its line under "Your
fills", which reads "crossed with another user at the pool's price, no filler
spread". Lower-third: "devnet · Fri 25 Sep [cross-fill-time] ET · a $10 SPYx
buy crossed against part of a 0.02 SPYx sale, two wallets · at the mark, a $200
Jupiter quote".*

> Buy or sell with a limit, and your order waits for the bell. What you trade
> stays in your wallet until it fills.
>
> On Thursday, an order placed the night before filled five minutes after the
> bell, with nobody at a keyboard.
>
> Turn on night mode, and it can fill at night, but only while the pool sits
> within one and a half percent of the stock's closing price. Otherwise, it
> waits for the bell.
>
> When a buyer and a seller are both waiting, at the bell they can meet at the
> pool's price, with no filler in between.

### 5 · The dividend (1:56–2:11)

*On screen: the Apple mirror's gate panel from `demo/recordings/rebase/`
(video `page@25469bd5….webm`, and a full-page still about every 20 s,
15:22:13–16:12:01 ET). The beats: 15:23:54, refused, "A corporate action is
pending and has not been identified yet"; 15:27:58, tradeable again, the row
reading "identified as a dividend"; from 15:35:04, refused, "A dividend or
split lands imminently and would change what you receive", the row "outside a
rebase window" naming the activation at 2026-09-24T19:49:45.000Z. Cut at or
before the 15:55:03 still. In the next one, 15:55:24 (board data from
15:55:16), SPYx, NVDAx, QQQx, TSLAx and AAPLx read "suspended" and IWMx
"withdrawn": that is a stop on the Backed names, not the dividend. Crop to the
AAPLx panel: from 15:35 the NVDAon tile reads about $2.25 million, a thin-pool
Jupiter quote. Lower-third, on screen the whole time: "devnet mirror of AAPLx ·
dividend scheduled by us to show the gate; not a real Apple dividend".*

> A dividend on an xStock changes a number on the token at a scheduled second.
> The exchange doesn't halt for an ordinary dividend, so BELL does: fifteen
> minutes either side, as the issuer advises.

### 6 · If we disappear (2:11–2:21)

*On screen: the keeper stopped; the badges turning to "stale". Not filmed yet
(see the last list).*

> Stop our keeper, and within two minutes every trade is refused. Your orders
> wait, and one tap in your own wallet cancels them.

### 7 · What you still trust (2:21–3:00)

*On screen: the permanent-delegate row. Then the three fill rows on the live
page after 18:06 ET: "circuit breaker clear", "second source agrees", "within
the band of Nasdaq". Then the checker's key in the explorer, signing a
`push_check` about once a minute. Lower-third: "checker FWQd…JVR · its own
key, process and data (Nasdaq and the NYSE calendar) · run by us, on the same
Railway account as the keeper". Then the README's trust section; the repo.*

> What BELL can't fix: two issuer keys can take the xStocks and Backpack's
> tokens out of any wallet. On our devnet mirrors, that key is ours.
>
> The key that says the market is open also sets the price, but not alone: a
> second key, with its own data, must agree, or nothing fills. We run both, so
> this guards against a leaked key or a fault, not against us. A jump of over
> five percent in a minute pauses the price.
>
> BELL. The venue that knows what time it is.

---

**Verified** (against the code, a committed file, the chain or a primary
source; chain reads on devnet unless marked, re-done on Thu 24 Sep between 19:10
and 19:30 ET):

- Tokenized AMC at $18.04 on Robinhood Chain — crypto.news, 8 Sep 2026
  (https://crypto.news/robinhood-amc-tokens-expose-limits-of-short-squeezes/):
  "IOSG researcher Mario Chow reported on Sept. 7 that the token reached $18.04
  after AMC Entertainment shares closed at $2.54 on Sept. 3." The article's
  opening places the episode "during the U.S. Labor Day weekend", but AMC
  closed near $2.65 on Fri 4 Sep (same article), so "Labor Day weekend" and
  "$2.54" together would not hold. The voiceover and lower-third say "early
  September" and "after the real stock had closed at $2.54", which is IOSG's
  own sentence. It happened on another chain: the lower-third says so, and the
  voiceover does not call it Solana.
- "Nothing to check its price against" — an AMM prices off its own pool; US
  exchanges trade about 32.5 of 168 hours a week (RedStone's COO, crypto.news,
  18 Sep 2026).
- "Twenty-four Solana buys … nineteen paid more than the next open" — the
  census (`scripts/overpay-census.ts`, over `src/overpay.ts`), run read-only
  against Solana mainnet on Thu 24 Sep, with market makers' legs told apart.
  The window is 17 Sep 17:01Z to 24 Sep 17:01Z: 12 instants spread over the
  week's outside-session hours plus five quiet mints; 630 transactions sampled,
  445 read; 86 pool-side and 7 market-maker legs skipped. It found 24 signed
  USDC buys of $1 or more made outside the session whose next open Nasdaq had
  recorded: 20 wallets, $1,467.60. 19 of 24 (79.2%) paid more a share than the
  next regular-session open; median +44.1 bps, quartiles +2.7 / +284.7 bps.
  Committed as `reference/overpay-census-2026-09-24.json`, and recomputed from
  a copy of it with no RPC
  (`node scripts/overpay-census.ts --from <file>`) to the same figures. Its
  limits (the lower-third names the sample, the Ondo share and the overnight
  moves; the rest stay here): it is a sample weighted by
  time, not volume; it sees only buys paid in USDC by the signer; the gap
  includes whatever really happened overnight, not only the pool's price; and
  it is mostly small Ondo buys (18 of 24, 15 wallets, $118, median +66.6 bps),
  while Backed's four ($1,322.80) paid a median +0.3 bps, so weighted by
  dollars the gap is +11.6 bps. "Solana" in the line is exact: these are
  mainnet Solana buys of the listed tokens. An earlier run, made before market
  makers' legs were told apart, recomputed to 29 buys, median +22.7 bps and
  65.5% paying more; it is not the one cited.
- The tagline — the page's line under the title (`.what` in `web/app/page.tsx`).
- Fourteen on the board — `LISTINGS` in `src/listings.ts`: SPYx, NVDAx, QQQx,
  TSLAx, AAPLx, IWMx, JPSTx (Backed), PFE, LMT (Backpack), SPYon, QQQon,
  AAPLon, NVDAon, TSLAon (Ondo; each note says "not offered to US persons").
  Ondo's five are devnet mirrors carrying the real mints' extension set
  (ScaledUiAmount, Pausable, DefaultAccountState, ConfidentialTransferMint, an
  empty transfer hook, no permanent delegate: `scripts/mirror-ondo.ts`,
  `programs/bell-session/tests/test_ondo.rs`). Their session comes from the
  list Ondo's web app loads, public but undocumented (`src/sensor/ondo.ts`);
  their marks from Jupiter. Solana liquidity in them is thin, so most show no
  usable price. The NVDAon tile read $2,250,194.84 at 15:35:04 ET; the
  "tradeable" badge beside it is the session gates, not the price. That was
  before the upgrade, when no band existed. Since the checks opened at 18:05
  ET a fill against such a mark refuses with MarkOffReference (6032): read on
  chain at 19:46 ET, NVDAon's mark ($2,250,347, last pushed 16:20 ET, so also
  stale) sat 9,999 bps (by rate) from the checker's NVDA close of $224.58.
- Seven gates — `check_tradeable`, numbered 1–7 (2b and 4b are sub-gates). The
  pause, the scheduled multiplier change and the hook are read from the mint
  (`verify_token_risk.rs`); whether a change is a split or a dividend is
  attested (`classify_rebase`). The mark, the breaker and the checker are
  checked after the gate, by every fill and cross (`admit.rs`), and are not
  counted among the seven. The panel's first eight rows are gates 1, 2, 2b, 3,
  4, 4b, 6 and 7; gate 5 depends on an order, so it has no row. "In session"
  because a night fill runs as Guarded, which skips gate 7 (the market being
  open) and passes the other six (`assert_tradeable.rs`, gate 7 runs only in
  Strict; `admit.rs`, step 2); in its place the checker must say closed.
- The SEC sentence — Order 34-106402, §II.H: stop "concurrently with any
  stoppage of trading in the underlying NMS stock on the primary listing
  exchange". It requires a stop on halts, not when the market is merely closed
  — hence "and goes further".
- The landed refusal — `2Ue1towjdeQoG1Eeo7xC1tvfUpJ8VcBNxR14gXk8MiYnDyicQ4F4mtkXi4TVxx6ritLjkKGE5RZtCSs2Fq9Cr1pH`,
  slot 503118640, 16:26:08 ET Wed 23 Sep: MarketClosed (custom 6000), fee
  5,000 lamports, transfer absent.
- "Buy or sell with a limit" — the page's Buy and Sell sides (`placeSell`
  in `web/app/page.tsx`; `placeSellInstructions` in `web/lib/queue.ts`). A
  buy's limit, "max $ /share", becomes its floor, which the program enforces
  (`orderFloor` in `src/policy/order.ts`); a sale's "min $/share" is one of
  the minimums in `sellOrderFloor`. The sale waits behind the same Strict gate
  (`fill_sell_order` runs `admit`, in `programs/bell-session/src/instructions/sell.rs`).
  The first devnet sale: `4trvXZHKDPrjqSjkwshjiiztct3uwPQUXdaTK8Td5i5v5yGGH6fZPmWsQd1gRf3L4eWCLGYNRon1qUYuWoEW9VDm`,
  slot 503501824, 0.02 SPYx for 15.267831 demo-USDC, 10:04:28 ET on Thu 24
  Sep, the line in the `sell-live-filled-141553Z.png` still.
- "What you trade stays in your wallet until it fills" — funding is an SPL
  delegation: a buy's approval is on the demo-USDC account, a sale's on the
  stock account, under Token-2022 (`web/lib/queue.ts`). The line says "what
  you trade" and not "nothing" because the owner does pay the order account's
  rent in SOL (`payer = owner` in `queue.rs`), returned to the owner when the
  order closes.
- Cancel — an SPL `revoke` sent alone from the user's wallet, before BELL's
  close (`cancelOrderTxs`, `cancelSellOrderTxs` in `web/lib/queue.ts`).
- Five minutes after the bell — Wednesday's overnight fill landed at 09:35:24 ET
  and Thursday's at 09:35:26 ET (`5311pZ8D6WRdRyBZzSHM5VDHds4BmwUXagx17VjHTCHH2iqasHtANaiD8gzmdLXmBDMUx2qsjLiLKWKTbcd9xGVv`,
  slot 503491348, block time checked on chain), the one the bell recording
  filmed. "Placed the night before": that order's account was created at
  20:40:49 ET on Wed 23 Sep
  (`4u6atyTnKLvjPRrWUc7RghXiBX2nvzuWUnaY6aEiobCxw6jwNguVc4dzgskRbh5kREyvKiCTnZidYMNtxvCi2XBn`,
  slot 503210876), and those are the order account's only two transactions. The hosted crank runs every five minutes; neither fill needed anyone
  to act.
- The receipt — "Your fills": when it filled, minutes after the bell, the price
  paid a share, and the bps over the mark it was checked against, with the
  transaction linked. It shows the price at the fill, not the price at night.
- Night mode — `opt_in_night` (`programs/bell-session/src/instructions/night.rs`)
  creates a per-wallet `NightOptIn`; it covers orders already placed, and the
  page's switch says so. Only while the attested session is shut, an opted-in
  owner's order is admitted as Guarded, which lifts gate 7 alone: a halt, a
  stale session, a pause, a dividend window, a moved multiplier and a hook
  still refuse (`admit.rs`, step 2). The checker must say closed, its
  reference must be under 12 hours old (`MAX_NIGHT_REF_AGE_SECONDS = 43_200`),
  and the mark must sit within `MAX_NIGHT_GAP_BPS = 150` of the reference, or
  the fill refuses (CheckerDisagrees 6031, CheckStale 6030, MarkOffReference
  6032).
  On top of the order's own band, the filler must deliver at least what the
  reference less 150 bps says (`fill.rs` and `sell.rs`, "a third minimum").
  "One and a half percent" is 150 bps; "the pool" is the mark, a $200 Jupiter
  quote. The band is measured on the rate (stock per dollar,
  `|mark - ref| <= ref × 150 / 10,000` in `admit.rs`, step 4), so in price
  terms the pool may sit from about 1.48% below to 1.52% above the close:
  "one and a half percent" to the nearest tenth. "Only while" is a condition,
  not a promise: inside the band, the other checks still apply. The 12-hour
  limit on a 16:00 close ends night fills at 04:00 ET, so the early morning
  and a weekend wait for the bell.
- "The stock's closing price" — outside the session the checker's reference
  is the regular session's official close, never an extended-hours print
  (`src/sensor/nasdaq.ts`, `scripts/checker.ts`; commit 65feb8d). On chain at
  19:30 ET all fourteen checks carried `ref_at` 16:00:00 ET; SPY's reference
  was $767.27.
- The first night fill — `dYzTs3SaS8Tmmmo3iDi3trWBiLAhzVZVqjDpZYV9svt5guocoBbL5nYrexZ4W2QSwANPj967dVrfXLi3BAYYqLS`,
  slot 503681235, block time 18:20:28 ET Thu 24 Sep: `FillOrder`, 5.000000
  demo-USDC for 647,002 raw SPYx (0.00647002, as RPC reports it) to wallet
  `JDAa…L4KQ`, which opted in at 18:19:54 ET and is still the only wallet with
  a `NightOptIn` on chain.
- The cross — `cross_orders` (`programs/bell-session/src/instructions/cross.rs`):
  a due buy and a due sell of the same symbol from two different owners
  (SelfCross, 6033, refuses one owner's pair), settled at the mark with no
  filler. Each leg is moved by its own owner's delegate authority, between
  accounts the orders pin. The buyer gets exactly the stock the mark gives
  for the quote, with no spread; the seller gets at least what its own sell
  fill would owe; both orders' floors, limits and minimum fills are checked
  before anything moves. Session only: both orders are admitted Strict and
  the checker must say open. The crank tries the cross before any fill
  (`scripts/crank.ts`). Orders are all-or-nothing by default, so a pair rarely
  crosses exactly; `scripts/queue.ts --partial` places one that fills in
  parts. The mark is an executable ask, so the line says "the pool's price",
  never "fair", and the page's line for a cross says the same. The pair
  parked for Friday, read on chain at 19:31 ET: a $10 SPYx buy,
  all-or-nothing (minimum fill 10,000,000 raw), from
  `zh2XejwZUh9zAjYiyKtstG8kwNLQxxxxJetAw8kfwno`, and a partial sale of
  1,988,635 raw SPYx (0.02 SPYx at the multiplier; minimum fill 129,810 raw)
  from `53UAaRAEbpBLCJyb7Scof1mcwPfMhgjzRvaEob6PaU7P`. Both expire Mon 28 Sep
  18:28 ET. They are the only buy and the only sale on the devnet book, and
  neither wallet has night fills on. The voiceover describes the mechanism and
  does not say a cross has happened. [cross-fill] at [cross-fill-time] ET goes
  here once it lands.
- "Two issuer keys" — Backed `5aMN…FvEq` over the seven xStocks and Backpack
  `2cVY…af4a` over its two, as permanent delegates on mainnet; BELL's deploy
  key `Dqp6…Ziqs` on each of those nine devnet mirrors. Ondo's five have no
  permanent delegate (the comment above them in `src/listings.ts`;
  `programs/bell-session/tests/test_ondo.rs`), which is why the line names
  the other two issuers.
- "Not alone: a second key must agree, or nothing fills" — `open_check` /
  `push_check` (`programs/bell-session/src/instructions/check.rs`) and step 4
  of `admit`. Only the program's upgrade authority can open a check, once per
  symbol, and the checker must not be the attestor. Every fill and every cross
  needs a check under 120 s old (`MAX_CHECK_AGE_SECONDS`) that agrees on the
  session. In session it also needs a reference under 300 s old
  (`MAX_SESSION_REF_AGE_SECONDS`) and the mark within 300 bps of it
  (`MAX_SESSION_GAP_BPS`); at night, 12 hours and 150 bps. A check that goes
  stale refuses fills (CheckStale); the checker signs no fill and sets no
  mark, so it can stop a fill but cannot make one. Checks opened at 18:05:49
  and 18:05:52 ET, eight and six `OpenCheck` instructions
  (`5ibXsi1E8m2EVjy6vumWYnD1Ah2Pv97jiFEEDpEPGbN6vSc7K8qPE1sG1HkLFLRxF9QLvjuh6SpDDKyDGXetrvCe`,
  `3tmQBQx2iFWNu5QY1wV3XZnJtS6LXALN9SAhqxs4LuvXRPumnN4Kge8DbQtNJ9dRNKB5zC31pbARbpH7xTX4n1EW`).
  At 19:30 ET all fourteen named
  `FWQdNaez3rAUn9t4VCf1EPs2pB821yPk7vgTFk68uJVR` and had been pushed 56 s
  earlier. What "agree" covers, exactly: the session (open or closed) and the
  price (the mark within the band of the checker's reference). The checker
  does not read halts or issuer withdrawals (`scripts/checker.ts`); those can
  only close a symbol, and gate 2 refuses them on the keeper's word alone.
- "With its own data", "we run both" — the checker (`scripts/checker.ts`)
  reads Nasdaq's quote and market-info endpoints and the local NYSE calendar,
  with Yahoo only where Nasdaq gives nothing (`src/sensor/nasdaq.ts`), and none
  of the keeper's sources. It runs as the Railway service "checker" on the same
  Railway account as the keeper. So its key, process and data are its own; its
  operator and host are not, and the voiceover says so.
- "A jump of over five percent in a minute pauses the price" — `push_mark`
  (`programs/bell-session/src/instructions/mark.rs`): a push may move the mark
  by at most `MAX_MARK_STEP_BPS` (500) scaled by the observation time elapsed,
  up to 60 s, so at most one 5% step a minute however the pushes are split. A
  bigger move is held: the old rate is kept, `conf_bps` is set to 65535 and a
  `MarkTripped` event is emitted, and every fill refuses MarkPaused (6027)
  until a push lands inside the step or 300 s pass
  (`MAX_MARK_STEP_AGE_SECONDS`). The line names a condition that always trips
  it, not the only one: a push 30 s after the last may move only 2.5%, and a
  mark last pushed over 300 s ago is not anchored, so the next push sets the
  price at any level (`anchored` in `mark.rs`); the checker's band is what
  catches a price walked that way. Calibration, as measured by the lead and not
  re-run for this script: across 11,045 hosted marks the largest step between
  consecutive marks was 228 bps (NVDAx), so none would have tripped.
- Fifteen minutes either side — `REBASE_GUARD_SECONDS = 15 * 60`, matching
  Backed's own advice: "we recommend that trading venues and protocols pause
  all interactions with the token for a brief window (e.g., 15 minutes) before
  and after each activation timestamp" (docs.xstocks.fi/developers/multipliers,
  read Thu 24 Sep). It is a recommendation with an example length, so the line
  says "as the issuer advises", not "as the issuer requires". Nasdaq's corporate-action halt
  covers dividends of 25% or more, not ordinary ones.
- The dividend footage — on the AAPLx mirror: the step scheduled at 15:23:14 ET
  (`nmPgh5nMoPMHyQAiV2tu9AWgrvDXdgX692mVHGDGLeaAAWMMFqqUMRMs5LWq4bQjUjZvdYz5nU3q7jZ3uigkmmW`,
  slot 503617127, `UpdateScale`) for 15:49:45 ET, multiplier
  1.0032690125398187 to 1.0040415296794742 (×1.00077); classified as a
  dividend at 15:27:29 ET
  (`4RDQ2zqiEBsrWXkAb8oKgoeLDNyaFF5piWeBsXxatuRpiKzJEMicqAFd7aFYAYbqh4jkdu44BjZ8vyjToxNcSb6g`,
  slot 503618675, `ClassifyRebase`). The page refused it as unclassified in
  the 15:23:54 still and passed it in the 15:27:58 still. The window runs
  15:34:45–16:04:45 ET; the page's first still inside it is 15:35:04
  (`demo/recordings/rebase.log`).
- "Within two minutes" — `MAX_STATE_AGE_SECONDS = 120`, from the last
  attestation. Gate 1 runs in Strict and Guarded alike, so night fills and
  crosses stop too. Fills stop sooner, at 60 s (`MAX_MARK_AGE_SECONDS`).
- The upgrade the new rows come from — Thu 24 Sep 18:04 ET, slot 503675389,
  `5aM3UhZfADExNbRJMbRwmRt1TsAtMYJZWnDaXJ3ZeRwjb2wCo6k4Yz5x2pFfFoPzEwBP6bPRHKWkQHNFk8TGNcLH`.
  Read from the ProgramData account tonight: deployment slot 503675389, the
  first 462,456 bytes of the program hash to the tested build's sha256
  `51d509e3f7521484831260882113d9251bedcb3b98bc726298168360d931b4cc`, and the
  upgrade authority is still the deploy key `Dqp6…Ziqs`. 136 program tests in
  `programs/bell-session/tests/` (check 15, cross 17, gates 23, mark 15,
  night 17, ondo 8, queue 22, sell 19).

**Not claimed:** the move of the upgrade authority to a Squads multisig is
planned for Friday and is not done. The film does not mention it. Nor does it
say a cross has happened, or call the cross price "fair".

**Still to confirm before the cut:**

- The cross. The buy and the sale are parked for Friday's open; film from
  09:25 ET and fill in [cross-fill] and [cross-fill-time]. If no cross lands,
  keep the line (it describes the mechanism), drop its lower-third and the
  "Your fills" shot, and cover it with `cross.rs` or the cross tests instead.
- The keeper-stop sequence in section 6: not filmed yet. Stopping the hosted
  keeper also stops night fills and, in session, every fill, for as long as
  it is down.
- The night switch on the live page, turned on, with the clock's "night band
  on" line: film it after 18:06 ET on a wallet with a live order.
- The limit shot. The order queued at 20:40 ET on Wed 23 Sep was placed before
  the limit field existed, so that footage shows no limit: film a new night
  queue with a limit, or cut "with a limit" from section 4's voiceover and
  "with a limit price" from its shot list.
- The census file. The reviewed run lives in the session's scratchpad; copy it
  somewhere lasting before the film is published, so the lower-third can be
  checked after tonight. `--from` rewrites the figures in the file it reads
  (the buys stay as they are), so run it on a copy.
