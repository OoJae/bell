# Getting a Pyth API key

> **Historical.** Committed on 21 Sep, when the plan assumed BELL would read
> prices from Pyth. It does not, and it needs no key. BELL uses Pyth for one
> thing: whether a US equity session is open, from the free, keyless
> `hermes.pyth.network/v2/price_feeds` metadata (`market_hours` on each equity
> feed). Prices come from the keeper: one executable Jupiter quote per symbol
> for $200 of USDC, attested on chain as the mark, whose `conf_bps` is that
> quote's price impact, capped at 200. What a free key turned out to unlock is
> below.

## Why this was on the critical path

The **Pyth Core upgrade of 2026-08-26** put every Hermes *price* route behind an
API key. Re-checked 23 Sep:

```
GET https://hermes.pyth.network/v2/updates/price/latest?ids[]=<AAPL feed>   → 401
GET https://hermes.pyth.network/v2/price_feeds                              → 200
```

Feed *metadata* is still public — which is where BELL reads each feed's
`market_hours` — but you cannot read a price without a key.

You also cannot fall back to the on-chain sponsored feeds. On mainnet the
push-oracle account for `Equity.US.AAPL/USD` was last updated on 14 Aug, and
`Crypto.AAPLON/USD` has no account at all (both checked 23 Sep).

## Checking a key

1. A key comes with a free Pyth Terminal account at <https://pythdata.app>.
2. Test it:

   ```sh
   PYTH_API_KEY=... node scripts/check-pyth.ts
   ```

   It probes the public routes, then the keyed one
   (`https://pyth.dourolabs.app/hermes` with `Authorization: Bearer <key>`),
   and prints what comes back.

## What the key unlocked

Whether a free key could read prices was unclear, so we asked the API. A free
key authenticates but is entitled to crypto only: **403** for
`Equity.US.AAPL/USD`, `Crypto.AAPLX/USD` and the `.RR` redemption-rate feed, 200
for `Crypto.SOL/USD` (`FRICTION.md`, 2026-09-21).

## The gate reads no price

`assert_tradeable` runs these checks, in this order, and none of them reads a
price:

| Gate | Refuses with | Reads |
|---|---|---|
| 1. Session attestation older than 120s | `StateStale` | the attestation |
| 2. Attested halt state is not `None` (exchange halt, issuer not trading it, or no issuer reading) | `MarketClosed` | the attestation |
| 2b. Mint state last read more than 600s ago | `RiskStale` | the `TokenRisk` record |
| 3. Issuer pause | `IssuerPaused` | `TokenRisk`, as last read from the Token-2022 mint |
| 4. Within 15 minutes either side of a multiplier change's activation | `RebasePending` | `TokenRisk` |
| 4b. A pending change still unclassified (`Unknown`) | `RebaseUnclassified` | `TokenRisk`, including the attestor's classification |
| 5. Multiplier moved since the order was built | `MultiplierMoved` | `TokenRisk` |
| 6. Transfer hook armed | `HookArmed` | `TokenRisk` |
| 7. Strict mode only: session not open | `MarketClosed` | the attestation |

Pyth sits upstream of gates 2 and 7: the keeper's session verdict combines
Pyth's `market_hours` with the issuer's state and Nasdaq's halt feed, and a
listing with no Pyth feed is closed. If `/v2/price_feeds` cannot be read, the
tick sends nothing and every symbol refuses with `StateStale` within 120
seconds. Nothing waits on a Pyth key.

On the trade path, the program checks a price only when a parked order fills.
`fill_order` runs the same gate in strict mode, then requires the mark to be at most 60 seconds old
(`MarkStale`) and its `conf_bps` within the order's cap (`MarkTooWide`), and
refuses a delivery below the greater of the order's band and its loss floor
(`PriceOutOfBand`). The mark is the keeper's Jupiter quote. Backpack's free
tickers, the fallback this page once proposed, are not used: most are
perpetuals trading 38–275bps below spot, and a low mark is the unsafe direction
(`src/chain/keeper.ts`).
