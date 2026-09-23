# BELL — film script (draft 2)

Three minutes, ~400 words at a natural pace. The beats are fixed, and every
on-screen claim must be something the footage actually shows. Read it aloud once
before recording — anywhere a line feels like a mouthful, it is wrong, not you.

Recording notes for the voiceover: one take per section is fine; leave a
second of silence between sections so the cut can breathe. Speak it to one
person, not to a room.

---

### 1 · The problem (0:00–0:30)

*On screen: the live board at night, every symbol closed. Then the numbers.
Lower-third: "census of Sun 20 Sep 2026 · docs/census-2026-09-20T22-18Z.json".*

> Say you live outside the US and buy tokenized US stocks from a wallet. On
> Solana, a pool will sell you Lockheed while its exchange in New York is shut.
>
> On Sunday there were nine hundred and twenty-eight xStocks on Solana. Eight
> hundred and eighty-three had under a thousand dollars of liquidity.

### 2 · The rule (0:30–0:45)

*On screen: the SEC order, §II.H, the sentence highlighted. Lower-third:
"Order 34-106402, 17 Sep 2026 · applies to Tokenized NMS Stock; BELL applies it
to all nine".*

> On September 17th the SEC wrote it down: a venue must stop trading a
> tokenized stock whenever the real one is halted on its home exchange.
>
> BELL puts that sentence in a Solana program.

### 3 · The refusal (0:45–1:20)

*On screen: the gate panel on the page. Then the landed refusal in the
explorer — devnet, block time Wed 23 Sep 16:26 ET, sig `2Ue1to…Cr1pH`:
MarketClosed (custom 6000), "Market is closed or trading in this security is
stopped", fee 5,000 lamports, no transfer. Lower-third: "devnet · a lamport
transfer stands in for the swap; Jupiter is not on devnet".*

> Every trade through BELL passes seven gates. Is the market open. Is the stock
> halted. Has the issuer paused the token. Is a dividend or a split about to
> land.
>
> The last two are read off the token itself. That's the Solana part:
> Token-2022 puts the pause and the next multiplier change on the mint, where a
> program can read them.
>
> When a gate fails, the transaction fails on-chain. Here's one we sent anyway:
> the fee was paid, and the transfer never happened.

### 4 · The bell (1:20–1:50)

*On screen: an order queued at night; the wallet balance unchanged. Then the
fill in the explorer — devnet, block time Wed 23 Sep 09:35:24 ET, sig
`5mj8qK…CFqt`: 200 demo-USDC for 25,661,713 raw SPYx, sent by the hosted
crank. That fill was not filmed: show the explorer, never a staged fill in its
place. Lower-third: "devnet · the price mark is a live mainnet Jupiter quote;
the filler delivers mirror SPYx for demo-USDC".*

> A refusal isn't the end. The order parks for the opening bell, and your money
> stays in your wallet until it fills — it's a delegation, and one standard
> token instruction from your own wallet takes it back, without BELL.
>
> On Wednesday, just over five minutes after the bell, our crank filled an
> order placed overnight — unattended, and checked against a price no more than
> a minute old.

### 5 · The dividend (1:50–2:20)

*On screen: the live rebase on the Apple mirror — unclassified, pending, clear.
Lower-third, on screen the whole time: "devnet mirror of AAPLx · dividend
scheduled by us to show the gate; not a real Apple dividend".
The narration must not imply this was a real Apple dividend.*

> A dividend on an xStock steps a multiplier on the mint at a scheduled
> second. A pool doesn't see it, so right after, it's still priced on the old
> number.
>
> BELL refuses fifteen minutes either side. An order built on the old number is
> refused — it never fills at the wrong size — and you place it again. While a
> stock is refused, the page won't park an order across a scheduled change.

### 6 · Silence closes the venue (2:20–2:35)

*On screen: the keeper stopped; the board's badges turning to stale.*

> And if we disappear? Stop our keeper, and two minutes after its last word,
> every trade is refused. An unreachable truth is not permission to trade.

### 7 · What you still have to trust (2:35–3:00)

*On screen: the permanent-delegate row on the page; AUDIT.md; the README's
trust section, which also covers BELL's own keys (attestor, upgrade authority);
the repo.*

> What BELL can't fix: on mainnet, two issuer keys can take these stocks out of
> any wallet — it's written on the tokens. On our devnet mirrors, the key is
> ours.
>
> An automated adversarial review — eighty-four AI agents, not a third-party
> audit — confirmed five findings. We fixed them, and hardened a sixth anyway.
>
> BELL. The venue that knows what time it is.

---

**Verified** (against the code, a committed file, or the chain):

- 928 xStocks, 883 under $1,000 of liquidity — `docs/census-2026-09-20T22-18Z.json`
  (Sun 20 Sep). The universe has grown since (1,124 listings on 23 Sep), so the
  narration keeps it dated.
- Lockheed trades off-hours on Solana — the keeper prices LMT (Backpack's
  token) from an executable mainnet Jupiter quote (`readMarks` in
  `src/chain/keeper.ts`). At 16:41 ET Wed 23 Sep, after the close, Jupiter
  quoted $200 of USDC into LMT through a Raydium CLMM pool, and the devnet LMT
  mark was pushed at 16:44 ET.
- The SEC sentence — Order 34-106402, §II.H, quoted in `assert_tradeable.rs`
  gate 2. It names Tokenized NMS Stock, which excludes Backed's synthetic
  certificates (`src/listings.ts`); hence the lower-third.
- Seven gates — `check_tradeable`, numbered 1–7 (2b and 4b are sub-gates; the
  page shows them as separate rows, `web/lib/bell.ts`). The pause, the
  multiplier, the scheduled change and the hook are read from the mint
  (`verify_token_risk.rs`), not from an oracle; whether a change is a split or
  a dividend is attested (`classify_rebase`).
- The landed refusal — `2Ue1towjdeQoG1Eeo7xC1tvfUpJ8VcBNxR14gXk8MiYnDyicQ4F4mtkXi4TVxx6ritLjkKGE5RZtCSs2Fq9Cr1pH`
  (`scripts/guarded-swap.ts --land`): gate 7 (`assert_tradeable.rs:109`),
  custom 6000 with the new message, fee 5,000 lamports, the transfer absent.
  It landed after the message-only upgrade of 15:32 ET the same day.
- The fill — `5mj8qKbkZLz1M4e8i1cA8rJRuQGkwrzC1QEgfbTvMNcrXabGrT79U8SBVzLgtfEBTP9zURvZxVaaBeQE7EwMCFqt`:
  the user's account paid 200,000,000 raw demo-USDC (6 decimals) and received
  25,661,713 raw SPYx (8 decimals). The explorer's block time is 09:35:24 ET;
  the 5m27s measured on the day puts it at 09:35:27. "Just over five minutes"
  is true of both. The crank runs every five minutes.
- "No more than a minute old" — `MAX_MARK_AGE_SECONDS = 60`, checked in
  `fill_order` against the mark in force at fill time.
- Cancel — an SPL `revoke` sent alone from the user's wallet, before BELL's
  close (`cancelOrderTxs` in `web/lib/queue.ts`).
- Fifteen minutes either side — `REBASE_GUARD_SECONDS = 15 * 60`. The old-number
  refusal is gate 5, `MultiplierMoved`. The page refuses to place an order
  across a scheduled change while the stock is refused (`web/app/page.tsx`); an
  order placed while it is allowed is not checked there, and gate 5 is what
  stops it.
- "Two minutes after its last word" — `MAX_STATE_AGE_SECONDS = 120`, measured
  from the last attestation, not from when the keeper stops.
- The two keys — Backed `5aMN…FvEq` (seven xStocks) and Backpack `2cVY…af4a`
  (PFE, LMT) on mainnet; BELL's deploy key `Dqp6…Ziqs` on every devnet mirror
  (`web/lib/bell.ts`, the disclosure row).
- The review — `AUDIT.md`: 84 agents, 26 raised, five confirmed and fixed, #4
  refuted but hardened anyway.

**Still not verified — check against the final cut before recording:**

- That the footage shows each on-screen item: the night board, the gate panel,
  the queued order with the balance unchanged, the Apple-mirror rebase walked
  through its three states, and the keeper-stop sequence.
