# Getting a Pyth API key

## Why this is on the critical path

The **Pyth Core upgrade of 2026-08-26** put every Hermes *price* route behind an
API key. Verified just now:

```
GET https://hermes.pyth.network/v2/updates/price/latest?ids[]=<AAPL feed>   → 401
GET https://hermes.pyth.network/v2/price_feeds                              → 200
```

Feed *metadata* is still public — which is how we read each feed's
machine-readable `schedule` string — but you cannot read a price without a key.

You also cannot fall back to the on-chain sponsored feeds: the push-oracle
accounts for equities are abandoned. `Equity.US.AAPL/USD` was last updated ~37
days ago and `Crypto.AAPLON/USD` has no account at all. Anything real has to
pull from Hermes and post the update itself.

## Steps

1. Sign up at **<https://pythdata.app>** (Pyth Terminal). The account itself is free.
2. In the dashboard, click **🔑 View your API key**.
3. Test it:

   ```sh
   PYTH_API_KEY=... node scripts/check-pyth.ts
   ```

4. Use it against `https://pyth.dourolabs.app/hermes` with
   `Authorization: Bearer <key>`.

## The catch, stated honestly

Pyth's own docs describe the Terminal account as free and the key as something
you simply view. Independent coverage of the Core upgrade says the opposite for
*API* access — that free Terminal is view-and-explore only, and live API reads
need a **Starter or Pro** subscription starting around **$500/month**.

These two claims conflict, so `scripts/check-pyth.ts` settles it empirically
rather than trusting either: it reads a real equity price and reports what
actually comes back.

If the free key turns out to be view-only, the routes are:

- **Ask the sponsor.** Pyth is a Stocklana sponsor and the bounty prize is
  literally *three months of Pyth Pro*, so they know the data is gated. A
  hackathon key is a reasonable ask in the hackathon channel.
- **Ship without it.** See below — this does not block the build.

## BELL does not block on Pyth

Deliberate design consequence, not a consolation. The gates that make BELL
distinctive need **no oracle at all**:

| Gate | Needs a price? |
|---|---|
| Session / halt | no — issuer + exchange feeds |
| Issuer pause | no — read from the Token-2022 mint |
| Rebase window | no — read from the mint |
| Transfer hook armed | no — read from the mint |
| Multiplier moved | no — read from the mint |
| Oracle freshness / confidence | **yes** |
| Basis vs reference | **yes** |
| Price impact | no — router quote |

So the halt demo, the rebase demo and the on-chain revert all work with zero
Pyth access.

For the two gates that do need a mark, there is a free fallback: Backpack's
`GET /api/v1/tickers` is unauthenticated and returns live prices for **21 stock
markets**, including 24/7 equity perps (SPY, QQQ, NVDA, TSLA, AMD, INTC, MU).
That covers the majors around the clock. It is narrower than Pyth's ~1,045 US
equity feeds, so Pyth remains the right answer for breadth — but the demo is not
hostage to it.
