# Toolchain

Installed 2026-09-20.

| | |
|---|---|
| Rust | 1.89.0, pinned by `rust-toolchain.toml`; rustup switches to it inside the repo |
| Solana CLI | Agave 4.1.2 — **pinned by Anchor 1.2.0**, which repoints `active_release` on first run. Do not force a newer Agave. |
| Anchor | 1.2.0 via avm (`~/.avm/bin`) |
| platform-tools | v1.57, passed as `--tools-version` (without it cargo-build-sbf fetches v1.54) |
| Node | 26 — runs TypeScript natively, so there is no build step |

Every new shell needs:

```sh
export PATH="$HOME/.local/share/solana/install/active_release/bin:$HOME/.avm/bin:$HOME/.cargo/bin:$PATH"
```

The `anchor` shim resolves through avm. Its first invocation installs the
toolchain and initialises Agave, so that one call blocks for several minutes and
can look like it returned nothing. Afterwards it is instant.

## Commands

```sh
pnpm install
node --test test/*.test.ts
node scripts/measure.ts     # liquidity census -> data/snapshots/
node scripts/agreement.ts   # issuer vs Pyth sessions -> docs/; run mid-session

# Build the program. --arch v1 is required: anchor build emits sbpf v3, which
# litesvm cannot load, and v1 is the more conservative deployment format.
# --tools-version is required too, or cargo-build-sbf tries to fetch v1.54.
# These are a pair, and the order matters: anchor build regenerates the IDL but
# also drops an sbpf v3 .so that litesvm cannot load, and cargo build-sbf will
# then no-op because it thinks nothing changed.
anchor build                                         # IDL
touch programs/bell-session/src/lib.rs               # defeat the cache
cargo build-sbf --arch v1 --tools-version v1.57      # the .so we test and ship
cargo test -p bell-session                           # loads that .so
```

## Running it

BELL is deployed on devnet as `56AUPR1c1Tq5AgMvAa3PASax61YYo1KTdocwW6pR7Pdx`.
None of the xStocks or Backpack mints exist there, so it runs against mirror
mints whose decimals and extension configuration `scripts/mirror-mints.ts`
reproduced from the real ones; their authorities, the permanent delegate
included, are BELL's deploy key. The program tests parse the real mainnet mint
bytes, and a local validator clones the real accounts from mainnet.

### Localnet

After the build above:

```sh
# Once, on a fresh clone: a filler key and the stock inventory the validator
# loads at genesis. localnet.sh reads the --account flags seed-accounts.ts
# writes to localnet/accounts.flags, so they always match your key.
solana-keygen new --no-bip39-passphrase -s -o .filler.json
node scripts/seed-accounts.ts

./scripts/localnet.sh &                          # validator + 9 cloned mints + program
./scripts/demo-setup.sh                          # demo USDC -> .demo.env, web/.env.local
node --env-file=.demo.env scripts/register.ts    # bind symbols, open marks, fund attestor
node scripts/keeper.ts --once                    # dry run: decide and print, send nothing
BELL_ARM=1 node scripts/keeper.ts                # the loop, every 45s

node scripts/gate.ts                             # ask assert_tradeable about every symbol
node --env-file=.demo.env scripts/queue.ts place SPYx 200
node --env-file=.demo.env scripts/crank.ts       # dry run; BELL_ARM=1 to fill
cd web && pnpm dev                               # the page, at :3100
```

`demo-setup.sh` must run before `register.ts`: a mark binds its quote mint
permanently. `localnet.sh` starts from an empty ledger (`-r`), so after a
restart the mint in `.demo.env` is gone: run
`BELL_FORCE=1 ./scripts/demo-setup.sh`, then `register.ts` again.

### Devnet

```sh
export BELL_CLUSTER=devnet BELL_RPC_URL=https://api.devnet.solana.com
node scripts/gate.ts                                  # the live gate, simulated
node --env-file=.demo.devnet.env scripts/crank.ts     # dry run against the live book
```

`gate.ts` needs only a keypair at `~/.config/solana/id.json` to name as the
simulation's payer. The crank line needs the operator's `.filler.json` and
`.demo.devnet.env`, both gitignored; `demo-setup.sh devnet` wrote the env file
during the deploy.

`scripts/deploy-devnet.sh` is the one-pass deploy: program, demo USDC, mirror
mints, registration and filler inventory, derived from a running, registered
localnet. It is not idempotent — the program has no close instruction for the
accounts `register.ts` creates — so read its header first. The hosted keeper
(`Dockerfile.keeper`) and the crank, a Railway cron every five minutes, run
these same scripts armed.

`BELL_ARM=1` is required for `keeper.ts`, `crank.ts`, `classify.ts` and
`guarded-swap.ts` to send anything; without it they decide, print and write
nothing on chain. `demo-setup.sh`, `register.ts` and `queue.ts` write when run.

The deploy authority and the attestor are separate keys, deliberately. The
deploy authority is `~/.config/solana/id.json`, which on devnet is also the
program's upgrade authority; the attestor is `.attestor.json`, which
`register.ts` generates. (The filler signs fills from `.filler.json`.) The
attestor can open or close a symbol (`push_session`), set its price
(`push_mark`) and classify a pending corporate action (`classify_rebase`). It
cannot touch the program, transfer anyone's tokens, or place or cancel an order
in anyone's name. But `fill_order` is permissionless, so a leaked attestor key
can open a symbol, push a bad price and fill parked orders itself, bounded by
each order's loss floor and the $1,000 per-order cap. Fail-closed covers a silent attestor, not a leaked one:
attestations that stop arriving go stale, and every symbol refuses within 120
seconds.

`register.ts` funds the attestor to 0.05 SOL. That is a starting balance: an
armed keeper signs three transactions a tick (sessions, the token-risk refresh,
marks), 15,000 lamports every 45 seconds or about 0.029 SOL a day, so 0.05 SOL
lasts under two days. `scripts/health.ts` fails below the same 0.05, so top it
up past that before arming the keeper.

## External dependencies

All read-only and unauthenticated:

- `api.xstocks.fi/api/v2/public` — the universe, per-asset session and halt state,
  and the rebase multiplier. BELL sends a browser user agent; the API has
  refused other agents with 403, though it answered curl on 23 Sep.
- `hermes.pyth.network/v2/price_feeds` — whether each US equity session is open
  (`market_hours`). BELL reads no Pyth price and needs no Pyth key; see
  `docs/PYTH.md`. It is no longer tick-fatal: a local NYSE calendar
  (`src/policy/calendar.ts`, 2026 and 2027) checks it, and stands in when a
  feed or the whole list is missing.
- `www.nasdaqtrader.com` trade-halt RSS — exchange halts for any NMS security,
  whoever tokenized it.
- `api.backpack.exchange/api/v1` — sessions, holidays, securities, assets.
  BELL calls no private endpoint, so there is no API-key or KYC dependency.
- `lite-api.jup.ag` — depth and executable quotes. The keeper's marks are
  Jupiter quotes.
- `api.nasdaq.com/api/quote` — the last US sale of each underlying, read by the
  web server for `/api/reference` and shown beside the pool's price. Display
  only; nothing on the trade path reads it.

Optional: `BELL_TELEGRAM_BOT_TOKEN` and `BELL_TELEGRAM_CHAT_ID`, on the keeper
and the crank, post halts, the open and close, rebase windows and fills to one
Telegram channel (`src/notify.ts`). Without both, nothing is sent. As of 24
Sep neither is set on the hosted services.
