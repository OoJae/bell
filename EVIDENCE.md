# Evidence

Generated from the hosted keeper's tick log on devnet (Railway service `keeper`, `/data/bell.db`) by `scripts/evidence.ts`. Every number below is
counted from the tick log, not written by hand.

**Observation window:** 2026-09-22 11:39:09 → 2026-09-24 14:19:57 UTC (50.7h, 3845 ticks, 34605 symbol-observations)

## Per symbol

| symbol | issuer | ticks | tradeable | refused | session pushes |
|---|---|---|---|---|---|
| AAPLx | backed | 3845 | 1000 (26%) | 2845 | 3604 |
| IWMx | backed | 3845 | 67 (2%) | 3778 | 3603 |
| JPSTx | backed | 3845 | 0 (0%) | 3845 | 3603 |
| LMT | backpack | 3845 | 1015 (26%) | 2830 | 3603 |
| NVDAx | backed | 3845 | 1000 (26%) | 2845 | 3604 |
| PFE | backpack | 3845 | 1015 (26%) | 2830 | 3603 |
| QQQx | backed | 3845 | 1000 (26%) | 2845 | 3604 |
| SPYx | backed | 3845 | 997 (26%) | 2848 | 3603 |
| TSLAx | backed | 3845 | 1001 (26%) | 2844 | 3604 |

Across the window, **27510 of 34605** symbol-observations were not tradeable.

## Confidence

How much corroboration each verdict had. `degraded` means a single source —
for a non-US listing no `Equity.US.*` Pyth feed exists, so there is nothing to
confirm against and the log says so rather than implying agreement.

| confidence | symbol-observations |
|---|---|
| confirmed | 20453 |
| conflict | 13790 |
| unavailable | 362 |

## Source disagreement

Ticks where Pyth and the issuer disagreed about whether the session was open,
in each direction.

- **Market open, issuer not trading.** Not noise to be smoothed over: this is
  how a halt shows up when nobody publishes a reason code. It is not only that,
  since anything that stops the issuer's token during the session reads the
  same way; the transitions below give the verdict each time it changed.
- **Market closed, issuer trading.** An issuer whose token trades around the
  clock while the primary market is shut. Expected every weeknight for a 24/5
  wrapper, and not a halt; the gate refuses those ticks because the market is
  closed.

| symbol | market open, issuer not trading | market closed, issuer trading |
|---|---|---|
| JPSTx | 1010 | 0 |
| IWMx | 945 | 59 |
| TSLAx | 12 | 2735 |
| AAPLx | 12 | 2734 |
| NVDAx | 12 | 2734 |
| QQQx | 12 | 2734 |
| SPYx | 12 | 2734 |

## Transitions

| when (UTC) | symbol | change | reason |
|---|---|---|---|
| 2026-09-22 13:30:46 | SPYx | closed → open | session open, issuer trading |
| 2026-09-22 13:30:46 | NVDAx | closed → open | session open, issuer trading |
| 2026-09-22 13:30:46 | QQQx | closed → open | session open, issuer trading |
| 2026-09-22 13:30:46 | TSLAx | closed → open | session open, issuer trading |
| 2026-09-22 13:30:46 | AAPLx | closed → open | session open, issuer trading |
| 2026-09-22 13:30:46 | PFE | closed → open | session open, issuer trading |
| 2026-09-22 13:30:46 | LMT | closed → open | session open, issuer trading |
| 2026-09-22 19:55:24 | SPYx | open → closed, halt None → Unspecified | session is open but the issuer will not trade this security |
| 2026-09-22 19:55:24 | NVDAx | open → closed, halt None → Unspecified | session is open but the issuer will not trade this security |
| 2026-09-22 19:55:24 | QQQx | open → closed, halt None → Unspecified | session is open but the issuer will not trade this security |
| 2026-09-22 19:55:24 | TSLAx | open → closed, halt None → Unspecified | session is open but the issuer will not trade this security |
| 2026-09-22 19:55:24 | AAPLx | open → closed, halt None → Unspecified | session is open but the issuer will not trade this security |
| 2026-09-22 20:00:16 | SPYx | closed → closed, halt Unspecified → None | issuer is open 24/5 but the primary market is closed |
| 2026-09-22 20:00:16 | NVDAx | closed → closed, halt Unspecified → None | issuer is open 24/5 but the primary market is closed |
| 2026-09-22 20:00:16 | QQQx | closed → closed, halt Unspecified → None | issuer is open 24/5 but the primary market is closed |
| 2026-09-22 20:00:16 | TSLAx | closed → closed, halt Unspecified → None | issuer is open 24/5 but the primary market is closed |
| 2026-09-22 20:00:16 | AAPLx | closed → closed, halt Unspecified → None | issuer is open 24/5 but the primary market is closed |
| 2026-09-22 20:00:16 | PFE | open → closed | session closed |
| 2026-09-22 20:00:16 | LMT | open → closed | session closed |
| 2026-09-23 13:30:36 | SPYx | closed → open | session open, issuer trading |
| 2026-09-23 13:30:36 | NVDAx | closed → open | session open, issuer trading |
| 2026-09-23 13:30:36 | QQQx | closed → open | session open, issuer trading |
| 2026-09-23 13:30:36 | TSLAx | closed → open | session open, issuer trading |
| 2026-09-23 13:30:36 | AAPLx | closed → open | session open, issuer trading |
| 2026-09-23 13:30:36 | PFE | closed → open | session open, issuer trading |
| 2026-09-23 13:30:36 | LMT | closed → open | session open, issuer trading |
| 2026-09-23 16:05:36 | SPYx | open → closed, halt None → Unspecified | no issuer reading; closed until one arrives |
| 2026-09-23 16:05:36 | NVDAx | open → closed, halt None → Unspecified | no issuer reading; closed until one arrives |
| 2026-09-23 16:05:36 | QQQx | open → closed, halt None → Unspecified | no issuer reading; closed until one arrives |
| 2026-09-23 16:05:36 | TSLAx | open → closed, halt None → Unspecified | no issuer reading; closed until one arrives |
| 2026-09-23 16:05:36 | AAPLx | open → closed, halt None → Unspecified | no issuer reading; closed until one arrives |
| 2026-09-23 16:06:03 | NVDAx | closed → open, halt Unspecified → None | session open, issuer trading |
| 2026-09-23 16:06:03 | QQQx | closed → open, halt Unspecified → None | session open, issuer trading |
| 2026-09-23 16:06:03 | TSLAx | closed → open, halt Unspecified → None | session open, issuer trading |
| 2026-09-23 16:06:03 | AAPLx | closed → open, halt Unspecified → None | session open, issuer trading |
| 2026-09-23 16:06:40 | SPYx | closed → open, halt Unspecified → None | session open, issuer trading |
| 2026-09-23 16:15:09 | SPYx | open → closed, halt None → Unspecified | no issuer reading; closed until one arrives |
| 2026-09-23 16:15:47 | SPYx | closed → open, halt Unspecified → None | session open, issuer trading |
| 2026-09-23 16:30:48 | QQQx | open → closed, halt None → Unspecified | no issuer reading; closed until one arrives |
| 2026-09-23 16:31:23 | QQQx | closed → open, halt Unspecified → None | session open, issuer trading |
| 2026-09-23 17:02:20 | SPYx | open → closed, halt None → Unspecified | no issuer reading; closed until one arrives |
| 2026-09-23 17:02:54 | SPYx | closed → open, halt Unspecified → None | session open, issuer trading |
| 2026-09-23 17:59:18 | SPYx | open → closed, halt None → Unspecified | no issuer reading; closed until one arrives |
| 2026-09-23 17:59:18 | AAPLx | open → closed, halt None → Unspecified | no issuer reading; closed until one arrives |
| 2026-09-23 17:59:56 | SPYx | closed → open, halt Unspecified → None | session open, issuer trading |
| 2026-09-23 17:59:56 | AAPLx | closed → open, halt Unspecified → None | session open, issuer trading |
| 2026-09-23 18:02:17 | NVDAx | open → closed, halt None → Unspecified | no issuer reading; closed until one arrives |
| 2026-09-23 18:02:53 | NVDAx | closed → open, halt Unspecified → None | session open, issuer trading |
| 2026-09-23 18:39:03 | AAPLx | open → closed, halt None → Unspecified | no issuer reading; closed until one arrives |
| 2026-09-23 18:39:38 | AAPLx | closed → open, halt Unspecified → None | session open, issuer trading |
| 2026-09-23 19:18:03 | SPYx | open → closed, halt None → Unspecified | no issuer reading; closed until one arrives |
| 2026-09-23 19:18:38 | SPYx | closed → open, halt Unspecified → None | session open, issuer trading |
| 2026-09-23 19:21:47 | TSLAx | open → closed, halt None → Unspecified | no issuer reading; closed until one arrives |
| 2026-09-23 19:22:23 | TSLAx | closed → open, halt Unspecified → None | session open, issuer trading |
| 2026-09-23 19:25:33 | QQQx | open → closed, halt None → Unspecified | no issuer reading; closed until one arrives |
| 2026-09-23 19:26:18 | NVDAx | open → closed, halt None → Unspecified | no issuer reading; closed until one arrives |
| 2026-09-23 19:26:18 | QQQx | closed → open, halt Unspecified → None | session open, issuer trading |
| 2026-09-23 19:26:53 | NVDAx | closed → open, halt Unspecified → None | session open, issuer trading |
| 2026-09-23 19:55:25 | SPYx | open → closed, halt None → Unspecified | session is open but the issuer will not trade this security |
| 2026-09-23 19:55:25 | NVDAx | open → closed, halt None → Unspecified | session is open but the issuer will not trade this security |
| 2026-09-23 19:55:25 | QQQx | open → closed, halt None → Unspecified | session is open but the issuer will not trade this security |
| 2026-09-23 19:55:25 | TSLAx | open → closed, halt None → Unspecified | session is open but the issuer will not trade this security |
| 2026-09-23 19:55:25 | AAPLx | open → closed, halt None → Unspecified | session is open but the issuer will not trade this security |
| 2026-09-23 20:00:39 | SPYx | closed → closed, halt Unspecified → None | issuer is open 24/5 but the primary market is closed |
| 2026-09-23 20:00:39 | NVDAx | closed → closed, halt Unspecified → None | issuer is open 24/5 but the primary market is closed |
| 2026-09-23 20:00:39 | QQQx | closed → closed, halt Unspecified → None | issuer is open 24/5 but the primary market is closed |
| 2026-09-23 20:00:39 | TSLAx | closed → closed, halt Unspecified → None | issuer is open 24/5 but the primary market is closed |
| 2026-09-23 20:00:39 | AAPLx | closed → closed, halt Unspecified → None | issuer is open 24/5 but the primary market is closed |
| 2026-09-23 20:00:39 | PFE | open → closed | session closed |
| 2026-09-23 20:00:39 | LMT | open → closed | session closed |
| 2026-09-23 21:27:07 | NVDAx | closed → closed, halt None → Unspecified | no issuer reading; closed until one arrives |
| 2026-09-23 21:27:43 | NVDAx | closed → closed, halt Unspecified → None | issuer is open 24/5 but the primary market is closed |
| 2026-09-24 08:35:56 | SPYx | closed → closed, halt None → Unspecified | no issuer reading; closed until one arrives |
| 2026-09-24 08:35:56 | NVDAx | closed → closed, halt None → Unspecified | no issuer reading; closed until one arrives |
| 2026-09-24 08:35:56 | QQQx | closed → closed, halt None → Unspecified | no issuer reading; closed until one arrives |
| 2026-09-24 08:35:56 | TSLAx | closed → closed, halt None → Unspecified | no issuer reading; closed until one arrives |
| 2026-09-24 08:35:56 | AAPLx | closed → closed, halt None → Unspecified | no issuer reading; closed until one arrives |
| 2026-09-24 08:37:26 | SPYx | closed → closed, halt Unspecified → None | issuer is open 24/5 but the primary market is closed |
| 2026-09-24 08:37:26 | NVDAx | closed → closed, halt Unspecified → None | issuer is open 24/5 but the primary market is closed |
| 2026-09-24 08:37:26 | TSLAx | closed → closed, halt Unspecified → None | issuer is open 24/5 but the primary market is closed |
| 2026-09-24 08:38:11 | SPYx | closed → closed, halt None → Unspecified | no issuer reading; closed until one arrives |
| 2026-09-24 08:38:11 | NVDAx | closed → closed, halt None → Unspecified | no issuer reading; closed until one arrives |
| 2026-09-24 08:38:11 | TSLAx | closed → closed, halt None → Unspecified | no issuer reading; closed until one arrives |
| 2026-09-24 08:44:56 | NVDAx | closed → closed, halt Unspecified → None | issuer is open 24/5 but the primary market is closed |
| 2026-09-24 08:44:56 | TSLAx | closed → closed, halt Unspecified → None | issuer is open 24/5 but the primary market is closed |
| 2026-09-24 08:44:56 | AAPLx | closed → closed, halt Unspecified → None | issuer is open 24/5 but the primary market is closed |
| 2026-09-24 08:45:41 | NVDAx | closed → closed, halt None → Unspecified | no issuer reading; closed until one arrives |
| 2026-09-24 08:45:41 | TSLAx | closed → closed, halt None → Unspecified | no issuer reading; closed until one arrives |
| 2026-09-24 08:45:41 | AAPLx | closed → closed, halt None → Unspecified | no issuer reading; closed until one arrives |
| 2026-09-24 09:08:17 | SPYx | closed → closed, halt Unspecified → None | issuer is open 24/5 but the primary market is closed |
| 2026-09-24 09:08:17 | NVDAx | closed → closed, halt Unspecified → None | issuer is open 24/5 but the primary market is closed |
| 2026-09-24 09:08:17 | QQQx | closed → closed, halt Unspecified → None | issuer is open 24/5 but the primary market is closed |
| 2026-09-24 09:08:17 | TSLAx | closed → closed, halt Unspecified → None | issuer is open 24/5 but the primary market is closed |
| 2026-09-24 09:08:17 | AAPLx | closed → closed, halt Unspecified → None | issuer is open 24/5 but the primary market is closed |
| 2026-09-24 09:22:26 | SPYx | closed → closed, halt None → Unspecified | no issuer reading; closed until one arrives |
| 2026-09-24 09:22:26 | NVDAx | closed → closed, halt None → Unspecified | no issuer reading; closed until one arrives |
| 2026-09-24 09:22:26 | QQQx | closed → closed, halt None → Unspecified | no issuer reading; closed until one arrives |
| 2026-09-24 09:22:26 | TSLAx | closed → closed, halt None → Unspecified | no issuer reading; closed until one arrives |
| 2026-09-24 09:22:26 | AAPLx | closed → closed, halt None → Unspecified | no issuer reading; closed until one arrives |
| 2026-09-24 09:26:21 | QQQx | closed → closed, halt Unspecified → None | issuer is open 24/5 but the primary market is closed |
| 2026-09-24 09:26:56 | SPYx | closed → closed, halt Unspecified → None | issuer is open 24/5 but the primary market is closed |
| 2026-09-24 09:26:56 | NVDAx | closed → closed, halt Unspecified → None | issuer is open 24/5 but the primary market is closed |
| 2026-09-24 09:26:56 | TSLAx | closed → closed, halt Unspecified → None | issuer is open 24/5 but the primary market is closed |
| 2026-09-24 09:26:56 | AAPLx | closed → closed, halt Unspecified → None | issuer is open 24/5 but the primary market is closed |
| 2026-09-24 12:40:20 | IWMx | closed → closed, halt Unspecified → None | issuer is open 24/5 but the primary market is closed |
| 2026-09-24 13:30:36 | SPYx | closed → open | session open, issuer trading |
| 2026-09-24 13:30:36 | NVDAx | closed → open | session open, issuer trading |
| 2026-09-24 13:30:36 | QQQx | closed → open | session open, issuer trading |
| 2026-09-24 13:30:36 | TSLAx | closed → open | session open, issuer trading |
| 2026-09-24 13:30:36 | AAPLx | closed → open | session open, issuer trading |
| 2026-09-24 13:30:36 | IWMx | closed → open | session open, issuer trading |
| 2026-09-24 13:30:36 | PFE | closed → open | session open, issuer trading |
| 2026-09-24 13:30:36 | LMT | closed → open | session open, issuer trading |

## Stoppages

Every interval in which the keeper attested a halt for a symbol, meaning a
`HaltState` other than `None`, kept in the form footnote 84 of SEC Order
34-106402 asks of a venue's books and records: the security, the reasons,
when the stoppage started and ended, and why trading resumed. BELL is not a
Tokenized Securities Venue; this is the record it would keep if it were.

A stoppage here is anything that made the keeper attest a halt, and the
reason column says which: a halt of the underlying on its primary listing
exchange, from Nasdaq's feed (the §II.H case); the issuer withdrawing its own
token; the issuer not trading while the session is open; or no reading from
the issuer at all. An ordinary close, the regular session ending with no
halt, is not a stoppage and is counted separately below.

Each time is a tick. A start or end reads "A – B": the tick at A had not seen
the change and the tick at B had, so it happened between them. Ticks are
about 45 seconds apart, and a wider gap means no tick completed in between. A
stoppage in force at a symbol's first tick began before the log did, and one
still in force at its last tick has not ended in it; either way its length is
a lower bound.

Notices: BELL keeps no list of participants, and notified none of them
individually. Each stoppage was public from the tick that first saw it, as the
session attestation on chain, linked below where that tick pushed one, and on
the page, which reads that attestation.

| symbol | halt | reason | started (UTC) | ended (UTC) | lasted | how it ended | attested |
|---|---|---|---|---|---|---|---|
| IWMx | Unspecified | issuer has withdrawn this token; the underlying is not exchange-halted | in force at its first tick, 2026-09-22 11:39:09 | 2026-09-24 12:39:35 – 12:40:20 | at least 2d 1h | lifted with the market closed: issuer is open 24/5 but the primary market is closed | — → [4KQaHLV1…](https://explorer.solana.com/tx/4KQaHLV1MSz5kddVXueAg9e2nJJtEwxhbKUUCKRJ2oi1gmtGx9Q9RDxpPT5EBzexMqbwcAc7JNvWXDaPJ2jx6rNo?cluster=devnet) |
| JPSTx | Unspecified | issuer has withdrawn this token; the underlying is not exchange-halted | in force at its first tick, 2026-09-22 11:39:09 | not in the log; still in force at 2026-09-24 14:19:57 | at least 2d 2h | — | — |
| AAPLx | Unspecified | session is open but the issuer will not trade this security | 2026-09-22 19:54:26 – 19:55:24 | 2026-09-22 19:59:18 – 20:00:16 | 4m 52s | lifted with the market closed: issuer is open 24/5 but the primary market is closed | [124DLkJ3…](https://explorer.solana.com/tx/124DLkJ33ovSPeD1T49iJXDD4JMdBoNwNynJmXhovTchXE7eTYe4cSPkcN6rT1dw6NNq5vXNXiFmacNum7egR7VD?cluster=devnet) → [2Jg5s5C8…](https://explorer.solana.com/tx/2Jg5s5C8ahi3wk9Hxuy7adCJTyrk9QSiGctc9pBb6DoNTNGxFXX6bTBybazZywn5AvbysiNurimKxhGNT61rzPb3?cluster=devnet) |
| NVDAx | Unspecified | session is open but the issuer will not trade this security | 2026-09-22 19:54:26 – 19:55:24 | 2026-09-22 19:59:18 – 20:00:16 | 4m 52s | lifted with the market closed: issuer is open 24/5 but the primary market is closed | [124DLkJ3…](https://explorer.solana.com/tx/124DLkJ33ovSPeD1T49iJXDD4JMdBoNwNynJmXhovTchXE7eTYe4cSPkcN6rT1dw6NNq5vXNXiFmacNum7egR7VD?cluster=devnet) → [2Jg5s5C8…](https://explorer.solana.com/tx/2Jg5s5C8ahi3wk9Hxuy7adCJTyrk9QSiGctc9pBb6DoNTNGxFXX6bTBybazZywn5AvbysiNurimKxhGNT61rzPb3?cluster=devnet) |
| QQQx | Unspecified | session is open but the issuer will not trade this security | 2026-09-22 19:54:26 – 19:55:24 | 2026-09-22 19:59:18 – 20:00:16 | 4m 52s | lifted with the market closed: issuer is open 24/5 but the primary market is closed | [124DLkJ3…](https://explorer.solana.com/tx/124DLkJ33ovSPeD1T49iJXDD4JMdBoNwNynJmXhovTchXE7eTYe4cSPkcN6rT1dw6NNq5vXNXiFmacNum7egR7VD?cluster=devnet) → [2Jg5s5C8…](https://explorer.solana.com/tx/2Jg5s5C8ahi3wk9Hxuy7adCJTyrk9QSiGctc9pBb6DoNTNGxFXX6bTBybazZywn5AvbysiNurimKxhGNT61rzPb3?cluster=devnet) |
| SPYx | Unspecified | session is open but the issuer will not trade this security | 2026-09-22 19:54:26 – 19:55:24 | 2026-09-22 19:59:18 – 20:00:16 | 4m 52s | lifted with the market closed: issuer is open 24/5 but the primary market is closed | [124DLkJ3…](https://explorer.solana.com/tx/124DLkJ33ovSPeD1T49iJXDD4JMdBoNwNynJmXhovTchXE7eTYe4cSPkcN6rT1dw6NNq5vXNXiFmacNum7egR7VD?cluster=devnet) → [2Jg5s5C8…](https://explorer.solana.com/tx/2Jg5s5C8ahi3wk9Hxuy7adCJTyrk9QSiGctc9pBb6DoNTNGxFXX6bTBybazZywn5AvbysiNurimKxhGNT61rzPb3?cluster=devnet) |
| TSLAx | Unspecified | session is open but the issuer will not trade this security | 2026-09-22 19:54:26 – 19:55:24 | 2026-09-22 19:59:18 – 20:00:16 | 4m 52s | lifted with the market closed: issuer is open 24/5 but the primary market is closed | [124DLkJ3…](https://explorer.solana.com/tx/124DLkJ33ovSPeD1T49iJXDD4JMdBoNwNynJmXhovTchXE7eTYe4cSPkcN6rT1dw6NNq5vXNXiFmacNum7egR7VD?cluster=devnet) → [2Jg5s5C8…](https://explorer.solana.com/tx/2Jg5s5C8ahi3wk9Hxuy7adCJTyrk9QSiGctc9pBb6DoNTNGxFXX6bTBybazZywn5AvbysiNurimKxhGNT61rzPb3?cluster=devnet) |
| AAPLx | Unspecified | no issuer reading; closed until one arrives | 2026-09-23 16:04:24 – 16:05:36 | 2026-09-23 16:05:36 – 16:06:03 | 27s | trading resumed: session open, issuer trading | [5P2z14T7…](https://explorer.solana.com/tx/5P2z14T7k8u4nVpNgCdT7ofJx8HM8Jt8Pu4Hdo8jvAMt8AecwK7gYeyFQxaB4pJ6YymD2iJ9xuLaUGKgydzGfp54?cluster=devnet) → [V9ujKeto…](https://explorer.solana.com/tx/V9ujKetoFJHc4JW5F85CSwKhiWQZcj38PuQH4Pfv7Ks73o7mov43si5XbxFoje6gRqTqAtfo8fY6vuaViD315f3?cluster=devnet) |
| NVDAx | Unspecified | no issuer reading; closed until one arrives | 2026-09-23 16:04:24 – 16:05:36 | 2026-09-23 16:05:36 – 16:06:03 | 27s | trading resumed: session open, issuer trading | [5P2z14T7…](https://explorer.solana.com/tx/5P2z14T7k8u4nVpNgCdT7ofJx8HM8Jt8Pu4Hdo8jvAMt8AecwK7gYeyFQxaB4pJ6YymD2iJ9xuLaUGKgydzGfp54?cluster=devnet) → [V9ujKeto…](https://explorer.solana.com/tx/V9ujKetoFJHc4JW5F85CSwKhiWQZcj38PuQH4Pfv7Ks73o7mov43si5XbxFoje6gRqTqAtfo8fY6vuaViD315f3?cluster=devnet) |
| QQQx | Unspecified | no issuer reading; closed until one arrives | 2026-09-23 16:04:24 – 16:05:36 | 2026-09-23 16:05:36 – 16:06:03 | 27s | trading resumed: session open, issuer trading | [5P2z14T7…](https://explorer.solana.com/tx/5P2z14T7k8u4nVpNgCdT7ofJx8HM8Jt8Pu4Hdo8jvAMt8AecwK7gYeyFQxaB4pJ6YymD2iJ9xuLaUGKgydzGfp54?cluster=devnet) → [V9ujKeto…](https://explorer.solana.com/tx/V9ujKetoFJHc4JW5F85CSwKhiWQZcj38PuQH4Pfv7Ks73o7mov43si5XbxFoje6gRqTqAtfo8fY6vuaViD315f3?cluster=devnet) |
| SPYx | Unspecified | no issuer reading; closed until one arrives | 2026-09-23 16:04:24 – 16:05:36 | 2026-09-23 16:06:03 – 16:06:40 | 1m 04s | trading resumed: session open, issuer trading | [5P2z14T7…](https://explorer.solana.com/tx/5P2z14T7k8u4nVpNgCdT7ofJx8HM8Jt8Pu4Hdo8jvAMt8AecwK7gYeyFQxaB4pJ6YymD2iJ9xuLaUGKgydzGfp54?cluster=devnet) → [3JfRSHv3…](https://explorer.solana.com/tx/3JfRSHv3k7oPYDiTSZrvYvEPrFsDKGpH4jMobh3SfyGCAsPXpRR2Svp2yyxaVd6eerb3bLWNnTSg8ajDUUSppmWP?cluster=devnet) |
| TSLAx | Unspecified | no issuer reading; closed until one arrives | 2026-09-23 16:04:24 – 16:05:36 | 2026-09-23 16:05:36 – 16:06:03 | 27s | trading resumed: session open, issuer trading | [5P2z14T7…](https://explorer.solana.com/tx/5P2z14T7k8u4nVpNgCdT7ofJx8HM8Jt8Pu4Hdo8jvAMt8AecwK7gYeyFQxaB4pJ6YymD2iJ9xuLaUGKgydzGfp54?cluster=devnet) → [V9ujKeto…](https://explorer.solana.com/tx/V9ujKetoFJHc4JW5F85CSwKhiWQZcj38PuQH4Pfv7Ks73o7mov43si5XbxFoje6gRqTqAtfo8fY6vuaViD315f3?cluster=devnet) |
| SPYx | Unspecified | no issuer reading; closed until one arrives | 2026-09-23 16:14:08 – 16:15:09 | 2026-09-23 16:15:09 – 16:15:47 | 38s | trading resumed: session open, issuer trading | [4Wbk2QLR…](https://explorer.solana.com/tx/4Wbk2QLRTnhZbV1NGaNdeRDA8xsNM7bme5LAk6XnW8kdUzH6t4PXnyFdBw6t5HJ5nLGe3ZYNCZJkW963ke3avL9r?cluster=devnet) → [X6KTE4kA…](https://explorer.solana.com/tx/X6KTE4kAomGBaguZtbuXTEy8fEyVSy1PrCAth9n7cVUu5S8PD6tziXLp2vBoAPk5U6TUMjoAShN9Un8F5DKNJHR?cluster=devnet) |
| QQQx | Unspecified | no issuer reading; closed until one arrives | 2026-09-23 16:29:53 – 16:30:48 | 2026-09-23 16:30:48 – 16:31:23 | 35s | trading resumed: session open, issuer trading | [2iMZtZ1Y…](https://explorer.solana.com/tx/2iMZtZ1YYrgSFbyU7FqF53FbrCPzmSBFJcz8YJh5pMX3KfqbnjZaDBpHymVqNUzb92NTTBGYJmbyhvN8yGRr2gev?cluster=devnet) → [2k1LnrRi…](https://explorer.solana.com/tx/2k1LnrRicLadCRBCaLqjPjzZhtUMQinvM6U7oj6xD9NXzC35nejhB6qjDxFTkobVwEwYvXFR3BK2aHnBJ8NUxysp?cluster=devnet) |
| SPYx | Unspecified | no issuer reading; closed until one arrives | 2026-09-23 17:01:23 – 17:02:20 | 2026-09-23 17:02:20 – 17:02:54 | 34s | trading resumed: session open, issuer trading | [3MtmysQg…](https://explorer.solana.com/tx/3MtmysQgatPXN9mgSxbjtwkpXecxUGcMZZV5Rg4zrYfiQvHHDgAP6id2zRXBynLJjnPj24BH1Vbnu1Pm1aqxvt9K?cluster=devnet) → [2jc5MsBK…](https://explorer.solana.com/tx/2jc5MsBK7mFGsT7Dwni5yYr7adjtwUDFekMUtoPkGSC7TaAQAAHXaGRoGtYSynCJp5JTqhEhcy6tc6FyR678J71U?cluster=devnet) |
| AAPLx | Unspecified | no issuer reading; closed until one arrives | 2026-09-23 17:58:23 – 17:59:18 | 2026-09-23 17:59:18 – 17:59:56 | 38s | trading resumed: session open, issuer trading | [KzBzGpuk…](https://explorer.solana.com/tx/KzBzGpukRyfvzGtVHuknMYhdT7FdF6pJ5S46thwpMAA51AA9iepE9rnCdsA8T2nmfbzpxXvXZPqtWkBs6DbrXdX?cluster=devnet) → [62ntfTDQ…](https://explorer.solana.com/tx/62ntfTDQ79GpD4NpHJ6DAyQ6aWoG5JQd4nKcNxzNtfExLhcBqiJbnLr3XAQk2sTTrNyNiQX7CNrMs1jBs1kp2MdJ?cluster=devnet) |
| SPYx | Unspecified | no issuer reading; closed until one arrives | 2026-09-23 17:58:23 – 17:59:18 | 2026-09-23 17:59:18 – 17:59:56 | 38s | trading resumed: session open, issuer trading | [KzBzGpuk…](https://explorer.solana.com/tx/KzBzGpukRyfvzGtVHuknMYhdT7FdF6pJ5S46thwpMAA51AA9iepE9rnCdsA8T2nmfbzpxXvXZPqtWkBs6DbrXdX?cluster=devnet) → [62ntfTDQ…](https://explorer.solana.com/tx/62ntfTDQ79GpD4NpHJ6DAyQ6aWoG5JQd4nKcNxzNtfExLhcBqiJbnLr3XAQk2sTTrNyNiQX7CNrMs1jBs1kp2MdJ?cluster=devnet) |
| NVDAx | Unspecified | no issuer reading; closed until one arrives | 2026-09-23 18:01:24 – 18:02:17 | 2026-09-23 18:02:17 – 18:02:53 | 36s | trading resumed: session open, issuer trading | [4czEST6a…](https://explorer.solana.com/tx/4czEST6aQFoPTCSvU4sGocF9G4Rt39zdgBawEcu9XmZMDWj1bbexQPjAVze1k7uVYxgjFoDJkv6w5QLbmFb9nWxr?cluster=devnet) → [5Lvrwx8K…](https://explorer.solana.com/tx/5Lvrwx8K623p2DEP5TMv64wvbcKT7WS357pcoyNz2VKA2rGJhRAioxBvXUgfAMwZWz2bFqHBR7gR9qzzmpMbD8fi?cluster=devnet) |
| AAPLx | Unspecified | no issuer reading; closed until one arrives | 2026-09-23 18:38:09 – 18:39:03 | 2026-09-23 18:39:03 – 18:39:38 | 35s | trading resumed: session open, issuer trading | [3dcsWPUm…](https://explorer.solana.com/tx/3dcsWPUm3qgBbeNUJw9Tr8Kcv4ikp8NSEo6VaqzkuMxPyaXpPrTmEMYrkN4FeBpfR3VaSgPQuFLM3gMLArksVKBW?cluster=devnet) → [gD6fjars…](https://explorer.solana.com/tx/gD6fjars2CX8LXKo2tMfPTmuTSDM9GfmYiUZdfXjdvz7hzzVYJfindaEzLETkaXc4VnLd5oKvdVb7LxXgojMKQC?cluster=devnet) |
| SPYx | Unspecified | no issuer reading; closed until one arrives | 2026-09-23 19:17:08 – 19:18:03 | 2026-09-23 19:18:03 – 19:18:38 | 35s | trading resumed: session open, issuer trading | [5Xr4oeEk…](https://explorer.solana.com/tx/5Xr4oeEk5p6UzN3AYng96P2MrWCz2DoqmNHBxtHkfhAvXhuzWJ58xiF8rFL8shWFxeUBqJtqfpejRcWRBS4ok4Dr?cluster=devnet) → [4xr6yELy…](https://explorer.solana.com/tx/4xr6yELy3f7JXCnbYPbHXLbF8NVDCpP9vTrJ69A8px2BS2HQofRvq71nZfQ55ov67qyRBMKu9JC6zcfCGH5myKzU?cluster=devnet) |
| TSLAx | Unspecified | no issuer reading; closed until one arrives | 2026-09-23 19:20:53 – 19:21:47 | 2026-09-23 19:21:47 – 19:22:23 | 36s | trading resumed: session open, issuer trading | [5puoNA4G…](https://explorer.solana.com/tx/5puoNA4GNYuDUJw3tJG1osrwYCFo5YeoyQFvKvuz1hhrP2QaJxdpHRGpF4XvJPBQJdFCm8hj7iigtKTYazdJGKXC?cluster=devnet) → [4n1EUiQr…](https://explorer.solana.com/tx/4n1EUiQrKqtftEGW9ArCPvGQHwiEMgFx7NQdbuWZ1czgsvHgZ7FdvueJqX1qa7wqBCszzM1KXr1jnk36XjFTxxkU?cluster=devnet) |
| QQQx | Unspecified | no issuer reading; closed until one arrives | 2026-09-23 19:24:38 – 19:25:33 | 2026-09-23 19:25:33 – 19:26:18 | 45s | trading resumed: session open, issuer trading | [3Scbnjb5…](https://explorer.solana.com/tx/3Scbnjb5o2mM7Ubc15JYXcCbaTEgXdJwtRS4awrETNoZjktArU6pA63jL2iUKediSS9Vwi1HZA5zowEd5qcJvGHS?cluster=devnet) → [54A6JEMK…](https://explorer.solana.com/tx/54A6JEMKWwzzpzYn7y7RZrXFJRNeCkN1fybuGySn6J9avtCpfmupW9ykatmkqKPa58rDbZdtpEXSURvvZuNoGL1A?cluster=devnet) |
| NVDAx | Unspecified | no issuer reading; closed until one arrives | 2026-09-23 19:25:33 – 19:26:18 | 2026-09-23 19:26:18 – 19:26:53 | 35s | trading resumed: session open, issuer trading | [54A6JEMK…](https://explorer.solana.com/tx/54A6JEMKWwzzpzYn7y7RZrXFJRNeCkN1fybuGySn6J9avtCpfmupW9ykatmkqKPa58rDbZdtpEXSURvvZuNoGL1A?cluster=devnet) → [3FHg4849…](https://explorer.solana.com/tx/3FHg4849gbt2uAEa2s9YTfLGobmqKJqx4vRDV5mYRVSM8TmnJ6MTyUBYy2GekoFdiZ8txWJ1cV1rVRh8KUAa2j3F?cluster=devnet) |
| AAPLx | Unspecified | session is open but the issuer will not trade this security | 2026-09-23 19:54:41 – 19:55:25 | 2026-09-23 19:59:54 – 20:00:39 | 5m 14s | lifted with the market closed: issuer is open 24/5 but the primary market is closed | [3kr3hmAp…](https://explorer.solana.com/tx/3kr3hmAp8nEQap1WvYvrLYZFqNtxr8LGivaRezUc4BBtyYqn9BcomHyfFi3gZdKA49QVwAN395sd8PjvnxW6WGtf?cluster=devnet) → [FwT9QrBY…](https://explorer.solana.com/tx/FwT9QrBYNube39vY6wTwCD7XZHwbfEvVAwgBMHxXVYH7UH8UJHALaqfn44x5hmJD2z3PmFfugR9M2RKLWqTYoiE?cluster=devnet) |
| NVDAx | Unspecified | session is open but the issuer will not trade this security | 2026-09-23 19:54:41 – 19:55:25 | 2026-09-23 19:59:54 – 20:00:39 | 5m 14s | lifted with the market closed: issuer is open 24/5 but the primary market is closed | [3kr3hmAp…](https://explorer.solana.com/tx/3kr3hmAp8nEQap1WvYvrLYZFqNtxr8LGivaRezUc4BBtyYqn9BcomHyfFi3gZdKA49QVwAN395sd8PjvnxW6WGtf?cluster=devnet) → [FwT9QrBY…](https://explorer.solana.com/tx/FwT9QrBYNube39vY6wTwCD7XZHwbfEvVAwgBMHxXVYH7UH8UJHALaqfn44x5hmJD2z3PmFfugR9M2RKLWqTYoiE?cluster=devnet) |
| QQQx | Unspecified | session is open but the issuer will not trade this security | 2026-09-23 19:54:41 – 19:55:25 | 2026-09-23 19:59:54 – 20:00:39 | 5m 14s | lifted with the market closed: issuer is open 24/5 but the primary market is closed | [3kr3hmAp…](https://explorer.solana.com/tx/3kr3hmAp8nEQap1WvYvrLYZFqNtxr8LGivaRezUc4BBtyYqn9BcomHyfFi3gZdKA49QVwAN395sd8PjvnxW6WGtf?cluster=devnet) → [FwT9QrBY…](https://explorer.solana.com/tx/FwT9QrBYNube39vY6wTwCD7XZHwbfEvVAwgBMHxXVYH7UH8UJHALaqfn44x5hmJD2z3PmFfugR9M2RKLWqTYoiE?cluster=devnet) |
| SPYx | Unspecified | session is open but the issuer will not trade this security | 2026-09-23 19:54:41 – 19:55:25 | 2026-09-23 19:59:54 – 20:00:39 | 5m 14s | lifted with the market closed: issuer is open 24/5 but the primary market is closed | [3kr3hmAp…](https://explorer.solana.com/tx/3kr3hmAp8nEQap1WvYvrLYZFqNtxr8LGivaRezUc4BBtyYqn9BcomHyfFi3gZdKA49QVwAN395sd8PjvnxW6WGtf?cluster=devnet) → [FwT9QrBY…](https://explorer.solana.com/tx/FwT9QrBYNube39vY6wTwCD7XZHwbfEvVAwgBMHxXVYH7UH8UJHALaqfn44x5hmJD2z3PmFfugR9M2RKLWqTYoiE?cluster=devnet) |
| TSLAx | Unspecified | session is open but the issuer will not trade this security | 2026-09-23 19:54:41 – 19:55:25 | 2026-09-23 19:59:54 – 20:00:39 | 5m 14s | lifted with the market closed: issuer is open 24/5 but the primary market is closed | [3kr3hmAp…](https://explorer.solana.com/tx/3kr3hmAp8nEQap1WvYvrLYZFqNtxr8LGivaRezUc4BBtyYqn9BcomHyfFi3gZdKA49QVwAN395sd8PjvnxW6WGtf?cluster=devnet) → [FwT9QrBY…](https://explorer.solana.com/tx/FwT9QrBYNube39vY6wTwCD7XZHwbfEvVAwgBMHxXVYH7UH8UJHALaqfn44x5hmJD2z3PmFfugR9M2RKLWqTYoiE?cluster=devnet) |
| NVDAx | Unspecified | no issuer reading; closed until one arrives | 2026-09-23 21:26:13 – 21:27:07 | 2026-09-23 21:27:07 – 21:27:43 | 36s | lifted with the market closed: issuer is open 24/5 but the primary market is closed | [JU1RcNzh…](https://explorer.solana.com/tx/JU1RcNzhx5o9tehqFzZvrJBsNMWXPYXkPQeUoSGFdz8ZoQAtCwt3pcGQk8P5woNTmKqx9nbGQmsz1BLNYKD4J58?cluster=devnet) → [3ygCrH8b…](https://explorer.solana.com/tx/3ygCrH8bQryff4Q9sfvosUTvf6Hvjge2Tx5q4RE17XDDrNGgwjBKwDkUGc39zSF8JaHRZLCJWQqvZZmKHruYq4Zk?cluster=devnet) |
| AAPLx | Unspecified | no issuer reading; closed until one arrives | 2026-09-24 08:35:13 – 08:35:56 | 2026-09-24 08:44:11 – 08:44:56 | 9m 00s | lifted with the market closed: issuer is open 24/5 but the primary market is closed | [5Qpoer1T…](https://explorer.solana.com/tx/5Qpoer1Tf496bwg3GKad3YjunQRP29KP1CRLwF19tGfCsGiqgA2uVVp4rZiWYRtKuetuBzSNxUoiF3EsYVDyNiBu?cluster=devnet) → [4kdno55P…](https://explorer.solana.com/tx/4kdno55P6orDAT3djU3DfVMQEqvdyLoybJpfftzsdA4jFdkGQccibbcHuBqY2TRfhoXqZTTWaAHcy7JycNtAjS4S?cluster=devnet) |
| NVDAx | Unspecified | no issuer reading; closed until one arrives | 2026-09-24 08:35:13 – 08:35:56 | 2026-09-24 08:36:41 – 08:37:26 | 1m 30s | lifted with the market closed: issuer is open 24/5 but the primary market is closed | [5Qpoer1T…](https://explorer.solana.com/tx/5Qpoer1Tf496bwg3GKad3YjunQRP29KP1CRLwF19tGfCsGiqgA2uVVp4rZiWYRtKuetuBzSNxUoiF3EsYVDyNiBu?cluster=devnet) → [65YA6JjK…](https://explorer.solana.com/tx/65YA6JjKecqpnd7dxpdaDSMA9eHXES17o1GGK7T9ZXeGwoeVna3nYk3XYZhMYF8fEPL6kwLswkHJ1Fymt8gMGmjR?cluster=devnet) |
| QQQx | Unspecified | no issuer reading; closed until one arrives | 2026-09-24 08:35:13 – 08:35:56 | 2026-09-24 09:07:26 – 09:08:17 | 32m 21s | lifted with the market closed: issuer is open 24/5 but the primary market is closed | [5Qpoer1T…](https://explorer.solana.com/tx/5Qpoer1Tf496bwg3GKad3YjunQRP29KP1CRLwF19tGfCsGiqgA2uVVp4rZiWYRtKuetuBzSNxUoiF3EsYVDyNiBu?cluster=devnet) → [2V3VRueC…](https://explorer.solana.com/tx/2V3VRueCxE2SqfjiA6zqSXqFNVsjiHDcdWLUJhh6B3s9m3tEpqHKKa53VuBfSA9qudhd9BnKcJFynsW71EiGbrqa?cluster=devnet) |
| SPYx | Unspecified | no issuer reading; closed until one arrives | 2026-09-24 08:35:13 – 08:35:56 | 2026-09-24 08:36:41 – 08:37:26 | 1m 30s | lifted with the market closed: issuer is open 24/5 but the primary market is closed | [5Qpoer1T…](https://explorer.solana.com/tx/5Qpoer1Tf496bwg3GKad3YjunQRP29KP1CRLwF19tGfCsGiqgA2uVVp4rZiWYRtKuetuBzSNxUoiF3EsYVDyNiBu?cluster=devnet) → [65YA6JjK…](https://explorer.solana.com/tx/65YA6JjKecqpnd7dxpdaDSMA9eHXES17o1GGK7T9ZXeGwoeVna3nYk3XYZhMYF8fEPL6kwLswkHJ1Fymt8gMGmjR?cluster=devnet) |
| TSLAx | Unspecified | no issuer reading; closed until one arrives | 2026-09-24 08:35:13 – 08:35:56 | 2026-09-24 08:36:41 – 08:37:26 | 1m 30s | lifted with the market closed: issuer is open 24/5 but the primary market is closed | [5Qpoer1T…](https://explorer.solana.com/tx/5Qpoer1Tf496bwg3GKad3YjunQRP29KP1CRLwF19tGfCsGiqgA2uVVp4rZiWYRtKuetuBzSNxUoiF3EsYVDyNiBu?cluster=devnet) → [65YA6JjK…](https://explorer.solana.com/tx/65YA6JjKecqpnd7dxpdaDSMA9eHXES17o1GGK7T9ZXeGwoeVna3nYk3XYZhMYF8fEPL6kwLswkHJ1Fymt8gMGmjR?cluster=devnet) |
| NVDAx | Unspecified | no issuer reading; closed until one arrives | 2026-09-24 08:37:26 – 08:38:11 | 2026-09-24 08:44:11 – 08:44:56 | 6m 45s | lifted with the market closed: issuer is open 24/5 but the primary market is closed | [2nfYd5j7…](https://explorer.solana.com/tx/2nfYd5j7biYVckgMmGsGBZvx6vJbrxe7SuTovNnPusNn1ij6W2xUZiTnRughkA244Gza2MY94QZ86D51euiadf4z?cluster=devnet) → [4kdno55P…](https://explorer.solana.com/tx/4kdno55P6orDAT3djU3DfVMQEqvdyLoybJpfftzsdA4jFdkGQccibbcHuBqY2TRfhoXqZTTWaAHcy7JycNtAjS4S?cluster=devnet) |
| SPYx | Unspecified | no issuer reading; closed until one arrives | 2026-09-24 08:37:26 – 08:38:11 | 2026-09-24 09:07:26 – 09:08:17 | 30m 06s | lifted with the market closed: issuer is open 24/5 but the primary market is closed | [2nfYd5j7…](https://explorer.solana.com/tx/2nfYd5j7biYVckgMmGsGBZvx6vJbrxe7SuTovNnPusNn1ij6W2xUZiTnRughkA244Gza2MY94QZ86D51euiadf4z?cluster=devnet) → [2V3VRueC…](https://explorer.solana.com/tx/2V3VRueCxE2SqfjiA6zqSXqFNVsjiHDcdWLUJhh6B3s9m3tEpqHKKa53VuBfSA9qudhd9BnKcJFynsW71EiGbrqa?cluster=devnet) |
| TSLAx | Unspecified | no issuer reading; closed until one arrives | 2026-09-24 08:37:26 – 08:38:11 | 2026-09-24 08:44:11 – 08:44:56 | 6m 45s | lifted with the market closed: issuer is open 24/5 but the primary market is closed | [2nfYd5j7…](https://explorer.solana.com/tx/2nfYd5j7biYVckgMmGsGBZvx6vJbrxe7SuTovNnPusNn1ij6W2xUZiTnRughkA244Gza2MY94QZ86D51euiadf4z?cluster=devnet) → [4kdno55P…](https://explorer.solana.com/tx/4kdno55P6orDAT3djU3DfVMQEqvdyLoybJpfftzsdA4jFdkGQccibbcHuBqY2TRfhoXqZTTWaAHcy7JycNtAjS4S?cluster=devnet) |
| AAPLx | Unspecified | no issuer reading; closed until one arrives | 2026-09-24 08:44:56 – 08:45:41 | 2026-09-24 09:07:26 – 09:08:17 | 22m 36s | lifted with the market closed: issuer is open 24/5 but the primary market is closed | [3YTxTzwQ…](https://explorer.solana.com/tx/3YTxTzwQSSyivkf4d8Wc7whUN2meG82dSc5SLzquFot9p8zyqoiF3SAn3Y7gRZ9DGAbzzR4aVHXtSpFKubrtZkp6?cluster=devnet) → [2V3VRueC…](https://explorer.solana.com/tx/2V3VRueCxE2SqfjiA6zqSXqFNVsjiHDcdWLUJhh6B3s9m3tEpqHKKa53VuBfSA9qudhd9BnKcJFynsW71EiGbrqa?cluster=devnet) |
| NVDAx | Unspecified | no issuer reading; closed until one arrives | 2026-09-24 08:44:56 – 08:45:41 | 2026-09-24 09:07:26 – 09:08:17 | 22m 36s | lifted with the market closed: issuer is open 24/5 but the primary market is closed | [3YTxTzwQ…](https://explorer.solana.com/tx/3YTxTzwQSSyivkf4d8Wc7whUN2meG82dSc5SLzquFot9p8zyqoiF3SAn3Y7gRZ9DGAbzzR4aVHXtSpFKubrtZkp6?cluster=devnet) → [2V3VRueC…](https://explorer.solana.com/tx/2V3VRueCxE2SqfjiA6zqSXqFNVsjiHDcdWLUJhh6B3s9m3tEpqHKKa53VuBfSA9qudhd9BnKcJFynsW71EiGbrqa?cluster=devnet) |
| TSLAx | Unspecified | no issuer reading; closed until one arrives | 2026-09-24 08:44:56 – 08:45:41 | 2026-09-24 09:07:26 – 09:08:17 | 22m 36s | lifted with the market closed: issuer is open 24/5 but the primary market is closed | [3YTxTzwQ…](https://explorer.solana.com/tx/3YTxTzwQSSyivkf4d8Wc7whUN2meG82dSc5SLzquFot9p8zyqoiF3SAn3Y7gRZ9DGAbzzR4aVHXtSpFKubrtZkp6?cluster=devnet) → [2V3VRueC…](https://explorer.solana.com/tx/2V3VRueCxE2SqfjiA6zqSXqFNVsjiHDcdWLUJhh6B3s9m3tEpqHKKa53VuBfSA9qudhd9BnKcJFynsW71EiGbrqa?cluster=devnet) |
| AAPLx | Unspecified | no issuer reading; closed until one arrives | 2026-09-24 09:21:44 – 09:22:26 | 2026-09-24 09:26:21 – 09:26:56 | 4m 30s | lifted with the market closed: issuer is open 24/5 but the primary market is closed | [46tEx6Nc…](https://explorer.solana.com/tx/46tEx6NcwsgNSkNNw6ChF8gVx1XFm6oY3Yt6ujR2jFeor6q1xs3Ud4CJKhHxEAtqaaRyL8MTZe8uXSkRJR2cxNvj?cluster=devnet) → [5vmoCzTC…](https://explorer.solana.com/tx/5vmoCzTCm8KUF8jqcJBZHkwtVQcWbLM9o69Jx3DWxUuWt5UaKSdTykifeuyQWgzuCt83697HhxnGETj8u8JwkAdY?cluster=devnet) |
| NVDAx | Unspecified | no issuer reading; closed until one arrives | 2026-09-24 09:21:44 – 09:22:26 | 2026-09-24 09:26:21 – 09:26:56 | 4m 30s | lifted with the market closed: issuer is open 24/5 but the primary market is closed | [46tEx6Nc…](https://explorer.solana.com/tx/46tEx6NcwsgNSkNNw6ChF8gVx1XFm6oY3Yt6ujR2jFeor6q1xs3Ud4CJKhHxEAtqaaRyL8MTZe8uXSkRJR2cxNvj?cluster=devnet) → [5vmoCzTC…](https://explorer.solana.com/tx/5vmoCzTCm8KUF8jqcJBZHkwtVQcWbLM9o69Jx3DWxUuWt5UaKSdTykifeuyQWgzuCt83697HhxnGETj8u8JwkAdY?cluster=devnet) |
| QQQx | Unspecified | no issuer reading; closed until one arrives | 2026-09-24 09:21:44 – 09:22:26 | 2026-09-24 09:25:36 – 09:26:21 | 3m 55s | lifted with the market closed: issuer is open 24/5 but the primary market is closed | [46tEx6Nc…](https://explorer.solana.com/tx/46tEx6NcwsgNSkNNw6ChF8gVx1XFm6oY3Yt6ujR2jFeor6q1xs3Ud4CJKhHxEAtqaaRyL8MTZe8uXSkRJR2cxNvj?cluster=devnet) → [jkNpAdse…](https://explorer.solana.com/tx/jkNpAdseduVCDZPdcDRiRHoxrUT2U8h9Wp91vNqSqsdxvQAncv7ayXSngTe2jyQ4adCzBGn1FWFirggQREFMQrL?cluster=devnet) |
| SPYx | Unspecified | no issuer reading; closed until one arrives | 2026-09-24 09:21:44 – 09:22:26 | 2026-09-24 09:26:21 – 09:26:56 | 4m 30s | lifted with the market closed: issuer is open 24/5 but the primary market is closed | [46tEx6Nc…](https://explorer.solana.com/tx/46tEx6NcwsgNSkNNw6ChF8gVx1XFm6oY3Yt6ujR2jFeor6q1xs3Ud4CJKhHxEAtqaaRyL8MTZe8uXSkRJR2cxNvj?cluster=devnet) → [5vmoCzTC…](https://explorer.solana.com/tx/5vmoCzTCm8KUF8jqcJBZHkwtVQcWbLM9o69Jx3DWxUuWt5UaKSdTykifeuyQWgzuCt83697HhxnGETj8u8JwkAdY?cluster=devnet) |
| TSLAx | Unspecified | no issuer reading; closed until one arrives | 2026-09-24 09:21:44 – 09:22:26 | 2026-09-24 09:26:21 – 09:26:56 | 4m 30s | lifted with the market closed: issuer is open 24/5 but the primary market is closed | [46tEx6Nc…](https://explorer.solana.com/tx/46tEx6NcwsgNSkNNw6ChF8gVx1XFm6oY3Yt6ujR2jFeor6q1xs3Ud4CJKhHxEAtqaaRyL8MTZe8uXSkRJR2cxNvj?cluster=devnet) → [5vmoCzTC…](https://explorer.solana.com/tx/5vmoCzTCm8KUF8jqcJBZHkwtVQcWbLM9o69Jx3DWxUuWt5UaKSdTykifeuyQWgzuCt83697HhxnGETj8u8JwkAdY?cluster=devnet) |

Per symbol, with the ordinary closes kept apart:

| symbol | stoppages | time stopped | ordinary closes, not stoppages |
|---|---|---|---|
| AAPLx | 8 | 47m 52s | 0 |
| IWMx | 1 | at least 2d 1h | 0 |
| JPSTx | 1 | at least 2d 2h | 0 |
| LMT | 0 | — | 2 |
| NVDAx | 10 | 47m 41s | 0 |
| PFE | 0 | — | 2 |
| QQQx | 7 | 48m 09s | 0 |
| SPYx | 10 | 49m 41s | 0 |
| TSLAx | 8 | 46m 30s | 0 |

## What a night buyer would have paid

Every mark the keeper saw confirmed on chain while the US regular session was
closed, from 16:00 ET until 09:30 ET on the next trading day, is compared with
the same symbol's first mark from 09:35 to 10:00 ET that trading morning, five
minutes in so that the pool has had time to be arbitraged against a market
that is trading again. A weekend or a holiday is part of the night it falls
in. On an early-close day the hours from the early close to 16:00 ET are
left out, counted as neither night nor open. Positive means the night buyer
would have paid more per share: +50 bps is 0.5% more, so the same dollars
would have bought about 0.5% fewer shares. The median and the worst are taken
over every sample, not per night, so a weekend, being longer, weighs more than
a weeknight.

What this measures is what the same dollars would have bought at night against
at the open: the gap a buyer who traded the pool overnight saw against one who
waited, which is what BELL makes them do. It includes genuine overnight news
as well as pool staleness, and nothing here can tell the two apart, so it is
not a measure of mispricing alone. A mark is an executable quote at a fixed
reference size, not a fill, and a larger order moves the pool further at any
hour. Marks came from: Jupiter.

A night counts for a symbol only when the log covers both ends of it: a mark
during the regular session before it, and one from 09:35 to 10:00 ET the next
trading morning. A weekday counts as a holiday only when some tick between
09:35 and 15:30 ET that day saw the session closed and none saw it open.

No complete overnight window in the log yet, so there is no number to print:
the 9792 marks recorded so far do not cover any night at both ends.

9323 overnight marks left out because the log did not cover that night at both ends.

