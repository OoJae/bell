# BELL — film script (draft 1)

Three minutes, ~430 words at a natural pace. **Draft**: the beats are fixed, the
wording gets tightened once Wednesday's footage exists, and every on-screen claim
is something the footage actually shows. Read it aloud once before recording —
anywhere a line feels like a mouthful, it is wrong, not you.

Recording notes for the voiceover: one take per section is fine; leave a
second of silence between sections so the cut can breathe. Speak it to one
person, not to a room.

---

### 1 · The problem (0:00–0:30)

*On screen: the live board at night, every symbol closed. Then the numbers.*

> Every venue on Solana will sell you Lockheed at three in the morning on a
> Sunday — against a pool nobody has arbitraged since Friday's close.
>
> There are nine hundred and twenty-eight tokenized stocks on Solana. Eight
> hundred and eighty-three of them have less than a thousand dollars of
> liquidity behind them. And not one app knows what time it is.

### 2 · The rule (0:30–0:45)

*On screen: the SEC order, §II.H, the sentence highlighted.*

> Last week the SEC wrote it down: a venue *must stop trading* a tokenized stock
> whenever trading stops on its home exchange.
>
> BELL is that sentence, as a Solana program.

### 3 · The refusal (0:45–1:15)

*On screen: the gate panel lighting row by row; the refused transaction in the
explorer.*

> Every trade passes seven gates. Is the market open. Is the stock halted. Has the
> issuer frozen the token. Is a dividend about to land. Some of these are read
> straight off the token itself — not from an oracle.
>
> When a gate fails, the transaction is refused *on-chain*. Not a warning. The
> trade does not happen.

### 4 · The bell (1:15–1:50)

*On screen: an order queued at night; the wallet balance unchanged; cut to
09:30; the filler fills it; the explorer.*

> But a refusal is never the end of it. The order parks for the opening bell —
> and your money never leaves your wallet. It's a delegation, and cancelling is
> one standard instruction from your own wallet that BELL plays no part in.
>
> Nine-thirty. The market opens. Four minutes later, a filler settles it — at a
> price that's fair *now*, not the one from last night.

### 5 · The dividend (1:50–2:20)

*On screen: the live rebase on the Apple mirror — unclassified, pending, clear.
Lower-third, on screen the whole time: "devnet mirror of AAPLx · dividend
scheduled by us to show the gate — Backed will not schedule one for a demo".
The narration must not imply this was a real Apple dividend.*

> Here's the trap nobody else reads. A dividend on these tokens is just a number
> on the token changing at a known second — and a pool doesn't see it. So the
> first trade after it is at yesterday's price.
>
> BELL sees it coming, refuses for fifteen minutes either side, and an order
> built on the old number is cancelled rather than filled at the wrong size.

### 6 · Silence closes the venue (2:20–2:40)

*On screen: the keeper stopped; the board going closed, symbol by symbol.*

> And if we disappear? Stop our keeper, and two minutes later everything reads
> closed. An unreachable truth is not permission to trade.

### 7 · What you still have to trust (2:40–3:00)

*On screen: AUDIT.md; the two keys; the repo.*

> We'll tell you what BELL can't fix. Two keys can take back every one of these
> stocks from any wallet — it's written on the tokens, and BELL shows it.
>
> We audited it adversarially: twenty-six findings, six real, all fixed — and two
> more we found ourselves, after it went live.
>
> BELL. The venue that knows what time it is.

---

**Claims to verify against the final cut before recording:** "four minutes"
(use the real fill latency from Wednesday); "seven gates" (the page shows the
sub-gates as separate rows — fine to say seven); the SEC quote wording against
the order's text; "two minutes" (MAX_STATE_AGE_SECONDS = 120).
