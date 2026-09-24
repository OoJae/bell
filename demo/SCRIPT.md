# BELL — film script (draft 3)

Three minutes, about 400 words at a natural pace. The beats are fixed, and every
on-screen claim must be something the footage actually shows. Read it aloud once
before recording — anywhere a line feels like a mouthful, it is wrong, not you.

Recording notes for the voiceover: one take per section is fine; leave a
second of silence between sections so the cut can breathe. Speak it to one
person, not to a room.

The limit price, the recurring buy and the receipt shipped in the push at
09:43 ET on Thursday 24 Sep, after the bell recording, so film those shots on
the live page, not from the bell recording. Selling went live with the program
upgrade at 09:49 ET and the push at 10:08 ET; the sell shot in section 7 is
filmed on the live page. Notifications (the Telegram channel @bellfills) are not
in this script.

---

### 1 · The problem (0:00–0:25)

*On screen: the live board at night, the New York clock reading closed. Then
the AMC chart. Lower-third: "tokenized AMC, Robinhood Chain, Labor Day weekend
2026 · crypto.news, 8 Sep".*

> You live in Lagos. You hold dollars in your wallet, and you want the S&P
> 500.
>
> On Solana you can buy it at any hour. Wall Street closes; Solana doesn't.
> But while New York is shut, the pool you're buying from has nothing to check
> its price against. Over Labor Day weekend, a tokenized AMC traded at eighteen
> dollars. The real stock had closed at two fifty-four.

### 2 · What BELL is (0:25–0:45)

*On screen: the page — the line under the title, the clock, the board.*

> BELL is the safe way to trade US stocks from your own wallet, at any hour.
>
> In the regular session, it trades. When the stock is halted, or a dividend
> is about to change the token under you, it refuses — on-chain. And while New
> York is shut, it holds your order for a real price.

### 3 · The refusal (0:45–1:15)

*On screen: the gate panel lighting row by row. Then the landed refusal in the
explorer — devnet, Wed 23 Sep 16:26 ET, sig `2Ue1to…Cr1pH`: MarketClosed
(custom 6000), "Market is closed or trading in this security is stopped", fee
paid, no transfer. Lower-third: "devnet · a lamport transfer stands in for the
swap". Then the SEC order, §II.H highlighted. Lower-third: "Order 34-106402,
17 Sep 2026".*

> Every trade passes seven gates. The pause, the dividend and the hook are
> read straight off the token: Token-2022 puts them on the mint, where a Solana
> program can check them.
>
> On September 17th the SEC wrote that a tokenized-stock venue must stop
> trading whenever the real stock is halted. BELL does that, and goes further.
>
> When a gate fails, the transaction fails. Here's one we sent anyway: fee
> paid, nothing bought.

### 4 · The bell (1:15–1:55)

*On screen: an order queued at night with a limit price; the balance
unchanged. Cut to the bell: the badge turns tradeable, the order line goes, the
holding grows. Then the receipt under "Your fills" (filmed after the push), and
the fill in the explorer.
Lower-third: "devnet · the price is a live mainnet Jupiter quote; the filler
delivers mirror SPYx for demo-USDC".*

> A refusal isn't the end. Set your limit, and your order waits for the
> opening bell. Your money stays in your wallet until it fills, and cancelling
> is one standard instruction BELL plays no part in.
>
> Thursday morning, five minutes after the bell, our filler settled an order
> placed the night before. Nobody was at a keyboard. The receipt shows what
> it paid a share, and how close that came to the price it was checked
> against.
>
> Or have it buy at each of the next five opens, from one approval.

### 5 · The dividend (1:55–2:20)

*On screen: the live rebase on the Apple mirror — unclassified, pending, clear —
and the page refusing to queue across it. Lower-third, on screen the whole
time: "devnet mirror of AAPLx · dividend scheduled by us to show the gate; not a
real Apple dividend".*

> A dividend on an xStock changes a number on the token at a scheduled second.
> The exchange doesn't halt for an ordinary dividend, so BELL does: fifteen
> minutes either side, exactly as the issuer advises. An order built on the old
> number never fills at the wrong size.

### 6 · If we disappear (2:20–2:35)

*On screen: the keeper stopped; the badges turning to stale.*

> Stop our keeper, and within two minutes every trade is refused. Your orders
> just wait, and one tap in your own wallet cancels them.

### 7 · What you still trust (2:35–3:00)

*On screen: the permanent-delegate row; the README's trust section; the repo.
Under the sell line (to be filmed after the sell upgrade): the order box
switched to Sell, a sale queued with a minimum price a share, the shares still
in the wallet, then its line under "Your fills" — "sold … for …" — and the fill
in the explorer.*

> What BELL can't fix: two issuer keys can take these stocks out of any
> wallet. On our devnet mirrors, that key is ours. And the key that tells BELL
> the market is open also sets its price, so a price floor on every order and
> a thousand-dollar cap bound what it can do.
>
> You can sell the same way. The twenty-three-hour sessions from December are
> next.
>
> BELL. The venue that knows what time it is.

---

**Verified** (against the code, a committed file, or a primary source):

- Tokenized AMC at $18.04, Labor Day weekend 2026, on Robinhood Chain, after
  the stock closed at $2.54 on Thu 3 Sep (IOSG's figures) — crypto.news, 8 Sep 2026
  (https://crypto.news/robinhood-amc-tokens-expose-limits-of-short-squeezes/).
  It happened on another chain: the lower-third says so, and the voiceover does
  not call it Solana.
- "Wall Street closes; Solana doesn't" — the host's own framing (@solana,
  September 2026). The line agrees with it rather than arguing.
- "Nothing to check its price against" — an AMM prices off its own pool; US
  exchanges trade about 32.5 of 168 hours a week (RedStone's COO, crypto.news,
  18 Sep 2026). Weekday nights get exchange sessions from 6 Dec 2026 (Nasdaq
  ETA 2026-46), which is why section 7 names them.
- Seven gates — `check_tradeable`, numbered 1–7 (2b and 4b are sub-gates). The
  pause, the scheduled multiplier change and the hook are read from the mint
  (`verify_token_risk.rs`); whether a change is a split or a dividend is
  attested (`classify_rebase`).
- The SEC sentence — Order 34-106402, §II.H: stop "concurrently with any
  stoppage of trading in the underlying NMS stock on the primary listing
  exchange". It requires a stop on halts, not when the market is merely closed
  — hence "and goes further".
- The landed refusal — `2Ue1towjdeQoG1Eeo7xC1tvfUpJ8VcBNxR14gXk8MiYnDyicQ4F4mtkXi4TVxx6ritLjkKGE5RZtCSs2Fq9Cr1pH`:
  MarketClosed (custom 6000), fee 5,000 lamports, transfer absent.
- The limit — "max $ /share" on the page; it becomes the order's floor, which
  the program enforces (`orderFloor` in `src/policy/order.ts`), and the filler
  waits while it is below the market (`scripts/crank.ts`).
- Five minutes after the bell — Wednesday's overnight fill landed at 09:35:24 ET
  and Thursday's at 09:35:26 ET (`5311pZ8D6WRdRyBZzSHM5VDHds4BmwUXagx17VjHTCHH2iqasHtANaiD8gzmdLXmBDMUx2qsjLiLKWKTbcd9xGVv`),
  the one the bell recording filmed. The hosted crank runs every five minutes;
  neither fill needed anyone to act.
- The receipt — "Your fills": when it filled, minutes after the bell, the price
  paid a share, and the bps over the mark it was checked against, with the
  transaction linked. It shows the price at the fill, not the price at night.
- Five opens, one approval — the "up to 5 opens" option (placed at night it
  schedules five; placed during a session, four fit inside an order's
  lifetime, and the page says four): one approval, then one
  order per open from the exchange calendar, each held by `not_before` until
  its open (`recurringSlots` in `web/lib/queue.ts`). Placed on a Thursday
  night, the five run into the next week, so not "every open this week".
- Cancel — an SPL `revoke` sent alone from the user's wallet, before BELL's
  close (`cancelOrderTxs` in `web/lib/queue.ts`).
- "You can sell the same way" — the page's Sell side (`placeSell` in
  `web/app/page.tsx`). The approval is on the wallet's stock account, under
  Token-2022, never the demo-USDC account that funds buys
  (`placeSellInstructions` in `web/lib/queue.ts`). The sale waits for the bell
  behind the same Strict gate (`fill_sell_order` calls `check_tradeable`, in
  `programs/bell-session/src/instructions/sell.rs`), and at the fill the filler
  pays first: the program measures the quote that landed, then takes the stock.
  The least it accepts is the price at the fill less 30 bps, and never under
  the floor, the "min $/share" or three quarters of the placement price,
  whichever is higher (`sellOrderFloor` in `src/policy/order.ts`); each
  minimum rounds up (`stock_to_quote_ceil`, `mul_shr64_ceil`). Its cancel
  revokes the stock account alone, first (`cancelSellOrderTxs`). The first
  devnet sale: `4trvXZHKDPrjqSjkwshjiiztct3uwPQUXdaTK8Td5i5v5yGGH6fZPmWsQd1gRf3L4eWCLGYNRon1qUYuWoEW9VDm`,
  0.02 SPYx for 15.267831 demo-USDC, 10:04:28 ET on Thu 24 Sep.
- Fifteen minutes either side — `REBASE_GUARD_SECONDS = 15 * 60`, matching
  Backed's own advice to pause "~15 minutes before and after each activation"
  (docs.xstocks.fi/developers/multipliers). Nasdaq's corporate-action halt
  covers dividends of 25% or more, not ordinary ones.
- "Within two minutes" — `MAX_STATE_AGE_SECONDS = 120`, from the last
  attestation.
- The keys — Backed `5aMN…FvEq` and Backpack `2cVY…af4a` on mainnet; BELL's
  deploy key `Dqp6…Ziqs` on every devnet mirror. The attestor sets both the
  session and the mark; each order's floor and the $1,000 cap bound a wrong
  price, a sale's cap being its value at the mark when placed (README, "What
  you must trust").

**Still to confirm before recording:**

- The limit shot. The order queued at 20:40 ET on Wed 23 Sep was placed
  before the limit field existed, so that footage shows no limit: either film
  a new night queue with a limit after 16:00 ET on Thursday, or cut "Set your
  limit," from section 4 and "with a limit price" from its shot list.
- The receipt and the five-opens shots, on the live page after the push.
- The sell shot in section 7. The devnet program has taken sales since the
  upgrade at 09:49 ET on Thu 24 Sep, and the first filled at 10:04:28 ET; the
  page offers them once the sell branch is deployed, so film it after that.
- That the footage shows each on-screen item, including the Apple-mirror rebase
  (still to be filmed) and the keeper-stop sequence.
