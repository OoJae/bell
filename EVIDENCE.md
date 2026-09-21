# Evidence

Generated from `data/bell.db` by `scripts/evidence.ts`. Every number below is
counted from the tick log, not written by hand.

**Observation window:** 2026-09-21 19:29:56 → 2026-09-21 19:30:56 UTC (0.0h, 27 ticks)

## Per symbol

| symbol | issuer | ticks | tradeable | refused | pushes |
|---|---|---|---|---|---|
| AAPLx | backed | 3 | 3 (100%) | 0 | 2 |
| IWMx | backed | 3 | 0 (0%) | 3 | 2 |
| JPSTx | backed | 3 | 0 (0%) | 3 | 2 |
| LMT | backpack | 3 | 3 (100%) | 0 | 2 |
| NVDAx | backed | 3 | 3 (100%) | 0 | 2 |
| PFE | backpack | 3 | 3 (100%) | 0 | 2 |
| QQQx | backed | 3 | 3 (100%) | 0 | 2 |
| SPYx | backed | 3 | 3 (100%) | 0 | 2 |
| TSLAx | backed | 3 | 3 (100%) | 0 | 2 |

Across the window, **6 of 27** symbol-observations were not tradeable.

## Confidence

How much corroboration each verdict had. `degraded` means a single source —
for a non-US listing no `Equity.US.*` Pyth feed exists, so there is nothing to
confirm against and the log says so rather than implying agreement.

| confidence | ticks |
|---|---|
| confirmed | 27 |

## Source disagreement

Ticks where Pyth and the issuer disagreed about whether the session was open.
This is not noise to be smoothed over — it is how a halt shows up when nobody
publishes a reason code.

| symbol | ticks |
|---|---|
| IWMx | 3 |
| JPSTx | 3 |

## Transitions

No state change observed in this window.

