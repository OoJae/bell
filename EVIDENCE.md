# Evidence

Generated from `data/bell.db` by `scripts/evidence.ts`. Every number below is
counted from the tick log, not written by hand.

**Observation window:** 2026-09-21 19:29:56 → 2026-09-22 00:26:18 UTC (4.9h, 3258 ticks)

## Per symbol

| symbol | issuer | ticks | tradeable | refused | pushes |
|---|---|---|---|---|---|
| AAPLx | backed | 362 | 34 (9%) | 328 | 184 |
| IWMx | backed | 362 | 0 (0%) | 362 | 183 |
| JPSTx | backed | 362 | 0 (0%) | 362 | 183 |
| LMT | backpack | 362 | 40 (11%) | 322 | 184 |
| NVDAx | backed | 362 | 34 (9%) | 328 | 184 |
| PFE | backpack | 362 | 40 (11%) | 322 | 184 |
| QQQx | backed | 362 | 34 (9%) | 328 | 184 |
| SPYx | backed | 362 | 34 (9%) | 328 | 184 |
| TSLAx | backed | 362 | 34 (9%) | 328 | 184 |

Across the window, **3008 of 3258** symbol-observations were not tradeable.

## Confidence

How much corroboration each verdict had. `degraded` means a single source —
for a non-US listing no `Equity.US.*` Pyth feed exists, so there is nothing to
confirm against and the log says so rather than implying agreement.

| confidence | ticks |
|---|---|
| conflict | 1635 |
| confirmed | 1623 |

## Source disagreement

Ticks where Pyth and the issuer disagreed about whether the session was open.
This is not noise to be smoothed over — it is how a halt shows up when nobody
publishes a reason code.

| symbol | ticks |
|---|---|
| AAPLx | 327 |
| NVDAx | 327 |
| QQQx | 327 |
| SPYx | 327 |
| TSLAx | 327 |
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

