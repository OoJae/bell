# Toolchain

Installed 2026-09-20.

| | |
|---|---|
| Rust | 1.96.0 (was pinned to 1.81.0 — revert with `rustup default 1.81.0`) |
| Solana CLI | Agave 4.1.2 — **pinned by Anchor 1.2.0**, which repoints `active_release` on first run. Do not force a newer Agave. |
| Anchor | 1.2.0 via avm (`~/.avm/bin`) |
| platform-tools | v1.57 (required by Anchor 1.2.0) |
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
node scripts/measure.ts   # liquidity census -> data/snapshots/
node --test test/*.test.ts

# Build the program. --arch v1 is required: anchor build emits sbpf v3, which
# litesvm cannot load, and v1 is the more conservative deployment format.
# --tools-version is required too, or cargo-build-sbf tries to fetch v1.54.
anchor build                                         # IDL
cargo build-sbf --arch v1 --tools-version v1.57      # the .so we test and ship
cargo test -p bell-session
```

## External dependencies

All read-only and unauthenticated today:

- `api.xstocks.fi/api/v2/public` — the universe, per-asset session and halt state,
  and the rebase multiplier. **Rejects non-browser user agents with 403.**
- `api.backpack.exchange/api/v1` — sessions, holidays, securities, assets.
  BELL calls no private endpoint, so there is no API-key or KYC dependency.
- `lite-api.jup.ag` — depth and executable quotes.

Still outstanding: a **Pyth API key**. Hermes price reads have returned 401 since
2026-08-26; only feed metadata is public. This is the critical path.
