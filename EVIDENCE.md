# Evidence

Generated from `data/bell.db` by `scripts/evidence.ts`. Every number below is
counted from the tick log, not written by hand.

**Observation window:** 2026-09-21 19:29:56 → 2026-09-22 01:59:19 UTC (6.5h, 5103 ticks)

## Per symbol

| symbol | issuer | ticks | tradeable | refused | pushes |
|---|---|---|---|---|---|
| AAPLx | backed | 567 | 34 (6%) | 533 | 284 |
| IWMx | backed | 567 | 0 (0%) | 567 | 283 |
| JPSTx | backed | 567 | 0 (0%) | 567 | 283 |
| LMT | backpack | 567 | 40 (7%) | 527 | 284 |
| NVDAx | backed | 567 | 34 (6%) | 533 | 284 |
| PFE | backpack | 567 | 40 (7%) | 527 | 284 |
| QQQx | backed | 567 | 34 (6%) | 533 | 284 |
| SPYx | backed | 567 | 34 (6%) | 533 | 284 |
| TSLAx | backed | 567 | 34 (6%) | 533 | 284 |

Across the window, **4853 of 5103** symbol-observations were not tradeable.

## Confidence

How much corroboration each verdict had. `degraded` means a single source —
for a non-US listing no `Equity.US.*` Pyth feed exists, so there is nothing to
confirm against and the log says so rather than implying agreement.

| confidence | ticks |
|---|---|
| conflict | 2660 |
| confirmed | 2443 |

## Source disagreement

Ticks where Pyth and the issuer disagreed about whether the session was open.
This is not noise to be smoothed over — it is how a halt shows up when nobody
publishes a reason code.

| symbol | ticks |
|---|---|
| AAPLx | 532 |
| NVDAx | 532 |
| QQQx | 532 |
| SPYx | 532 |
| TSLAx | 532 |
| IWMx | 40 |
| JPSTx | 40 |

## Transitions

| when (UTC) | symbol | change | reason |
|---|---|---|---|
| 2026-09-21 19:55:38 | SPYx | open → closed, halt None → Unspecified | session is open but the issuer will not trade this security |
| 2026-09-21 19:55:38 | NVDAx | open → closed, halt None → Unspecified | session is open but the issuer will not trade this security |
| 2026-09-21 19:55:38 | QQQx | open → closed, halt None → Unspecified | session is open but the issuer will not trade this security |
| 2026-09-21 19:55:38 | TSLAx | open → closed, halt None → Unspecified | session is open but the issuer will not trade this security |
| 2026-09-21 19:55:38 | AAPLx | open → closed, halt None → Unspecified | session is open but the issuer will not trade this security |
| 2026-09-21 20:00:17 | SPYx | closed → closed, halt Unspecified → None | issuer is open 24/5 but the primary market is closed |
| 2026-09-21 20:00:17 | NVDAx | closed → closed, halt Unspecified → None | issuer is open 24/5 but the primary market is closed |
| 2026-09-21 20:00:17 | QQQx | closed → closed, halt Unspecified → None | issuer is open 24/5 but the primary market is closed |
| 2026-09-21 20:00:17 | TSLAx | closed → closed, halt Unspecified → None | issuer is open 24/5 but the primary market is closed |
| 2026-09-21 20:00:17 | AAPLx | closed → closed, halt Unspecified → None | issuer is open 24/5 but the primary market is closed |
| 2026-09-21 20:00:17 | PFE | open → closed | session closed |
| 2026-09-21 20:00:17 | LMT | open → closed | session closed |

