# Friction

Things that cost time or were wrong, and what they cost.

## 2026-09-21 — `scaledUiAmount` has two multipliers, and the obvious one is wrong

`ScaledUiAmountConfig` carries **both** `multiplier` and `new_multiplier`, plus
`new_multiplier_effective_timestamp`. Once that timestamp passes, the effective
value is `new_multiplier` — the field named `multiplier` is stale and stays
stale. Reading it is not a rounding error: Netflix's mint reports

```
multiplier      = 1.0
new_multiplier  = 10.0     (timestamp in the past — already in force)
```

so an integration that reads `multiplier` is wrong by the entire 10:1 split,
and would size every NFLXx order at one tenth of its intended share count.

Caught only because the tests run against **real mainnet mint bytes** rather
than a synthetic mint we built ourselves. A synthetic fixture would have
encoded our own misunderstanding and passed.

Note the asymmetry worth knowing: `api.xstocks.fi/.../multiplier` *pre-resolves*
this and returns `currentMultiplier: 10` for NFLXx, so the off-chain path looks
correct while the on-chain path is wrong. The two disagree precisely when it
matters most — inside the activation window.

**Fix:** `read_mint` takes `now` and resolves the effective multiplier itself.
Pending is now genuinely pending — scheduled but not yet in force.

## 2026-09-21 — litesvm cannot load an sbpf v3 program

`anchor build` emits sbpf **v3**. litesvm 0.10–0.13 reject it with a bare
`InvalidAccountData` from `add_program`, which reads like a corrupt file rather
than a version mismatch and sent me looking at the wrong thing. 0.16 supports
it but needs a newer Rust than the 1.89 that Anchor pins, so that door is shut
too.

**Fix:** build with `cargo build-sbf --arch v1 --tools-version v1.57`. Tests and
mainnet then run the *same* binary, and v1 is the more conservative deployment
format anyway. `--tools-version` is required: without it cargo-build-sbf tries
to download v1.54 and times out.

## 2026-09-21 — the Pyth key is entitled to crypto only

A free Pyth Terminal key authenticates but returns **403** for every feed in
this asset class — `Equity.US.AAPL/USD`, `Crypto.AAPLX/USD`, and the `.RR`
redemption-rate feed — while `Crypto.SOL/USD` returns 200. The docs describe the
key as simply something you view, which is true, and say nothing about
entitlement, which is what actually gates it.

**Fix:** sessions from Pyth's free `/v2/price_feeds` metadata (`market_hours`
plus the machine-readable `schedule`, across 1,245 equity feeds), prices from
Backpack's free `/api/v1/tickers`. See `docs/PYTH.md`.
