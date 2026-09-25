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
None of the xStocks, Backpack or Ondo mints exist there, so it runs against
mirror mints whose decimals and extension configuration `scripts/mirror-mints.ts`
and, for Ondo's five, `scripts/mirror-ondo.ts` reproduced from the real ones;
their authorities, the permanent delegate included where the real mint has
one, are BELL's deploy key. The program tests parse the real mainnet mint
bytes, and a local validator clones the real accounts from mainnet.

### Localnet

After the build above:

```sh
# Once, on a fresh clone: a filler key and the stock inventory the validator
# loads at genesis. localnet.sh reads the --account flags seed-accounts.ts
# writes to localnet/accounts.flags, so they always match your key.
solana-keygen new --no-bip39-passphrase -s -o .filler.json
node scripts/seed-accounts.ts

./scripts/localnet.sh &                          # validator + 14 cloned mints + program
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

A filler needs stock to fill buys and quote to fill sales. `seed-accounts.ts`
gives it the stock. `demo-setup.sh` creates its quote account
(`BELL_FILLER_QUOTE`) empty: buys pay into it and sales are paid for from it, so
until a buy has filled, or you send it some, the crank reports the filler short
of quote and leaves every sale waiting.
`node --env-file=.demo.env scripts/queue.ts sell SPYx 0.1` sells from the
wallet's stock account once a buy has filled into it.

**No fill settles on localnet as scripted.** Every fill and cross needs the
symbol's check, and only the program's upgrade authority can open one.
`localnet.sh` loads the program with `--bpf-program`, which disables upgrades,
so no key can sign as its upgrade authority: `open-checks.ts` refuses, and the
crank reports each fill as "no checker yet" (`AccountNotInitialized`, 3012).
The gate, `gate.ts` and the page's refusals are unaffected. To fill locally,
replace that flag in `localnet.sh` with
`--upgradeable-program 56AUPR1c1Tq5AgMvAa3PASax61YYo1KTdocwW6pR7Pdx target/deploy/bell_session.so ~/.config/solana/id.json`,
restart it, and after `register.ts`:

```sh
solana-keygen new --no-bip39-passphrase -s -o .checker.json   # not the attestor, not id.json
solana airdrop 1 $(solana-keygen pubkey .checker.json) --url localhost
node scripts/open-checks.ts $(solana-keygen pubkey .checker.json) --plan
node scripts/open-checks.ts $(solana-keygen pubkey .checker.json)
BELL_CHECKER_ARM=1 node scripts/checker.ts --once   # one pass by hand first
BELL_CHECKER_ARM=1 node scripts/checker.ts          # then the loop, every 45s
```

The checker reads Nasdaq and the local calendar, not the local validator's
session, so in session it says open and at night closed, as on devnet.

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
mints, registration and the filler's stock inventory, derived from a running,
registered localnet. It gives the filler stock only; the filler pays for sales
from its demo-USDC account, which starts empty and is filled by the buys it
settles. It is not idempotent — the program has no close instruction for the
accounts `register.ts` creates — so read its header first. It opens no checks;
see "The checker" below. The hosted keeper (`Dockerfile.keeper`), the checker
(the same image) and the crank, a Railway cron every five minutes, run these
same scripts armed.

`BELL_ARM=1` is required for `keeper.ts`, `crank.ts`, `classify.ts` and
`guarded-swap.ts` to send anything; without it they decide, print and write
nothing on chain. The checker has its own switch, `BELL_CHECKER_ARM=1`, and
`--dry` overrides it. `demo-setup.sh`, `register.ts`, `queue.ts` and
`open-checks.ts` (without `--plan`) write when run.

The deploy authority, the attestor and the checker are separate keys,
deliberately. The deploy authority is `~/.config/solana/id.json`, which on
devnet is also the program's upgrade authority; the attestor is
`.attestor.json`, which `register.ts` generates; the checker is
`.checker.json`, which you generate. (The filler signs fills from
`.filler.json`.) The attestor can open or close a symbol (`push_session`), set
its price (`push_mark`) and classify a pending corporate action
(`classify_rebase`). It cannot touch the program, transfer anyone's tokens, or
place or cancel an order in anyone's name. `fill_order`, `fill_sell_order` and
`cross_orders` are permissionless, but each also needs the checker to agree
about the session and the mark to sit within its band, so a leaked attestor
key alone can fill parked orders only at a mark inside the checker's band,
bounded again by each order's loss floor and the $1,000 per-order cap. The
README's "What you must trust" has the full account. Fail-closed covers a
silent attestor and a silent checker, not a leaked key: attestations that stop
arriving go stale, and every symbol refuses within 120 seconds; checks that
stop arriving stop every fill within 120 seconds.

### The checker

`scripts/checker.ts` is the program's second signer. It runs as its own
process, holds its own key, and reads none of the keeper's feeds: Nasdaq's
`/api/market-info` and `/api/quote/{T}/info`, and Yahoo's chart endpoint only
where Nasdaq gives nothing. It also reads the local NYSE calendar
(`src/policy/calendar.ts`), which the keeper reads too. Each pass it pushes
`push_check` for every registered symbol whose check names its key.

```sh
node scripts/checker.ts --once                       # dry: prints what it would push, beside the keeper's view
BELL_CHECKER_ARM=1 node scripts/checker.ts --once    # one armed pass
BELL_CHECKER_ARM=1 node scripts/checker.ts           # the loop
BELL_CHECKER_ARM=1 node scripts/checker.ts --dry     # the armed environment, still dry
```

Its key comes from `.checker.json` (`BELL_CHECKER_KEYPAIR` to point elsewhere),
or, where there is no file, from `BELL_KEY_CHECKER`, the file's JSON array.
Armed with no key, or with a key holding no SOL, it refuses to start. It must
not be the attestor's key or the deploy key: the program refuses a checker that
is the symbol's attestor, and `open-checks.ts` refuses both. Armed, it pushes
every 45 seconds unless `BELL_CHECKER_INTERVAL_MS` says otherwise, and exits
to be restarted if no pass has finished for five minutes
(`BELL_CHECKER_WATCHDOG_MS`). A pass that pushes all fourteen symbols is two
transactions; a symbol whose reading it will not stand behind is skipped that
pass.

Hosted on devnet it is the Railway service "checker". It builds from
`Dockerfile.keeper`, whose image sets `BELL_CLUSTER` and `BELL_RPC_URL`, runs
`node scripts/checker.ts`, and restarts always. Its own variables are
`BELL_CHECKER_ARM=1`, `BELL_KEY_CHECKER` and `BELL_CHECKER_INTERVAL_MS=60000`:
one pass a minute, at most 10,000 lamports a pass, at most about 0.0144 SOL a
day. Its key,
`FWQdNaez3rAUn9t4VCf1EPs2pB821yPk7vgTFk68uJVR`, held 0.24874 SOL on the
evening of 24 Sep. It is on the same Railway account as the keeper, so it is
a separate key, process and data source, not a separate operator.

`node scripts/open-checks.ts <CHECKER_PUBKEY> [--plan]` opens each registered
symbol's check naming that key. It must be signed by the upgrade authority,
`BELL_AUTHORITY_KEYPAIR`, by default `~/.config/solana/id.json`, which pays
the rent: 1,473,200 lamports a check on devnet. It is idempotent: a symbol
that already has a check is left alone and reported. There is no instruction
to change a checker once named, so the key given here is the one the venue
lives with until an upgrade.

### Rolling out an upgrade that adds checks

From the moment the upgraded program lands, a 15-account fill fails with
Anchor's 3005 and a fill of a symbol with no check with 3012; from
`open_check` until the checker's first push, with `CheckStale` (6030). So the
order matters (`check.rs`, module doc):

1. Ship the clients with 17-account fills and the cross builder. They work
   against the old program too, so no 15-account crank is left running when
   the upgrade lands.
2. Check that the binary fits. `solana program show <PROGRAM_ID>` gives the
   program data account's length. If the new `.so` is bigger, extend first
   with `solana program extend <PROGRAM_ID> <ADDITIONAL_BYTES>`, so the size
   is your choice: `solana program deploy` would otherwise extend it by
   itself, unless given `--no-auto-extend`. The rent it adds is recoverable
   only by closing the program.
3. Upgrade.
4. `open-checks.ts` for every registered symbol, straight away, while the
   authority can still sign: the deploy key, or the multisig once the
   authority has moved there.
5. Start the armed checker. `node scripts/crank.ts` (dry) should then show no
   "no checker yet" and no `CheckStale` lines.
6. Only then move or burn the upgrade authority. A burn fixes the set of
   checkers for good.

On devnet on 24 Sep that was the extend by 50,648 bytes at 18:02:52 ET, the
upgrade at 18:04 ET (slot 503675389), and the fourteen checks at 18:05:49 and
18:05:52 ET (`AUDIT.md`, "Upgrade #2").

`register.ts` funds the attestor to 0.05 SOL. That is a starting balance: with
fourteen symbols the hosted keeper signed 100 transactions in 18 minutes on the
evening of 24 Sep (sessions, the token-risk refresh and marks, 5,000 lamports
each), about 0.04 SOL a day, so 0.05 SOL lasts about a day. `scripts/health.ts` fails below the same 0.05, so top it
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
- `app.ondo.finance/api/v2/assets` — Ondo's own word on its five tokens, from
  the list Ondo's web app loads. Public but undocumented, about 3 MB, so the
  keeper reads it every five minutes in the background and a reading older
  than ten minutes closes the Ondo names (`src/sensor/ondo.ts`).
- `lite-api.jup.ag` — depth and executable quotes. The keeper's marks are
  Jupiter quotes.
- `api.nasdaq.com/api/quote` — the last US sale of each underlying, read by the
  web server for `/api/reference` and shown beside the pool's price. That use
  is display only. The checker reads the same endpoint, and
  `api.nasdaq.com/api/market-info`, for its session verdict and its reference
  price, which every fill is held to.
- `query1.finance.yahoo.com/v8/finance/chart` — the checker's stand-in for a
  name Nasdaq gives no reading for. It answers a bare `Mozilla/5.0` user agent.
- `api.mainnet-beta.solana.com` — read-only, for `/overpay` and
  `scripts/overpay-census.ts` (`BELL_MAINNET_RPC` to use another).

Optional: `BELL_TELEGRAM_BOT_TOKEN` and `BELL_TELEGRAM_CHAT_ID`, on the keeper
and the crank, post halts, the open and close, rebase windows, breaker holds,
fills and crosses to one Telegram channel (`src/notify.ts`). Without both,
nothing is sent to it. `BELL_TELEGRAM_BOT_TOKEN` alone, on an armed keeper,
also runs the per-wallet messages (`src/alerts.ts`): it reads `/start <wallet>`
from the bot's chats and stores the follows in the keeper's database. Only one
process may poll a bot's updates, so a dry keeper never does. On the hosted
services both are set on the keeper and the crank: the channel is @bellfills
and the bot @Bell_solbot.
