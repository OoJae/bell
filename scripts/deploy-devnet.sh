#!/bin/sh
# Deploy BELL to devnet.
#
# Devnet rather than mainnet because the rent is the same either way and devnet
# SOL is free. The program is byte-identical; a judge can verify a devnet address
# exactly as well as a mainnet one.
#
# Prerequisites:
#   1. ~3.3 devnet SOL at the deploy address. The CLI faucet is usually rate
#      limited; https://faucet.solana.com gives 5 SOL/day with a GitHub login.
#   2. A localnet running with the real mints cloned AND registered, because the
#      devnet mirror mints are DERIVED from them rather than hand-written:
#         ./scripts/localnet.sh &
#         ./scripts/demo-setup.sh localnet
#         node scripts/register.ts
#      Do NOT restart localnet until this finishes — `localnet.sh` runs the
#      validator with `-r`, wiping the only source the mirrors derive from.
#
# NOT idempotent. The program deploy, mirror-mints and register.ts all write
# state that cannot be undone: the program has no close instruction for
# SymbolState, TokenRisk or SymbolMark. Every check that can be made before the
# first lamport is spent, is.
set -e

# The Solana toolchain is added to PATH by ~/.profile, which zsh does not read
# and `#!/bin/sh` does not inherit. Without this the script dies on its first
# `solana` call, after the operator has already committed to a deploy.
PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
export PATH
for t in solana spl-token cargo-build-sbf node; do
  command -v "$t" >/dev/null || { echo "$t not on PATH"; exit 1; }
done

RPC=https://api.devnet.solana.com
LOCALNET=http://127.0.0.1:8899
# Deploy rent (see --max-len) + mirrors + PDAs + ATAs + attestor + filler. The
# program account for 420,000 bytes measured 2.1345 SOL on devnet and mainnet
# alike; this floor was set at the textbook 6,960 lamports/byte (2.92 SOL) and
# is kept as headroom. The old 2.4 predated --max-len and would pass a wallet
# that then failed mid-deploy.
NEEDED=3300000000

# Pin the payer. `solana address`, spl-token's implicit fee payer and
# register.ts's BELL_PAYER_KEYPAIR must provably be one key, or the balance check
# validates one wallet while another spends — and the mirror mint authorities end
# up on a key the rest of the deploy cannot reach.
PAYER_KP=${BELL_PAYER_KEYPAIR:-$HOME/.config/solana/id.json}
export BELL_PAYER_KEYPAIR="$PAYER_KP"
DEPLOYER=$(solana address -k "$PAYER_KP")

echo "deployer  $DEPLOYER"
BAL=$(solana balance "$DEPLOYER" --url "$RPC" --lamports 2>/dev/null | awk '{print $1}')
echo "balance   $(echo "${BAL:-0}" | awk '{printf "%.4f", $1/1000000000}') SOL"
if [ "${BAL:-0}" -lt "$NEEDED" ]; then
  echo; echo "Not enough devnet SOL. Need ~3.3."
  echo "CLI faucet is rate limited; use https://faucet.solana.com with:"
  echo "  $DEPLOYER"
  exit 1
fi

# ---------------------------------------------------------------- pre-flight
# Read-only. All of it must pass before anything is spent.

# An orphan buffer from a failed deploy holds ~1.59 SOL (for the 312KB binary). Re-running deploy
# without --buffer creates a second and fails for funds — one dropped write
# turning into a dead wallet.
# Match an actual base58 buffer address, not the table header the command
# prints even when there are none — a false positive here blocks the deploy.
if solana program show --buffers --url "$RPC" 2>/dev/null \
     | grep -qE '^[1-9A-HJ-NP-Za-km-z]{32,44} '; then
  echo "orphan deploy buffer exists. Resume with --buffer <ADDR>, or reclaim:"
  echo "  solana program close --buffers --url $RPC"
  exit 1
fi

solana cluster-version --url "$LOCALNET" >/dev/null 2>&1 \
  || { echo "localnet is not running — mirror-mints would have no source"; exit 1; }

node -e '
const {Connection,PublicKey}=await import("@solana/web3.js")
const {readTokenRisk}=await import("./src/chain/client.ts")
const {MAINNET_LISTINGS}=await import("./src/listings.ts")
const c=new Connection(process.argv[1],"confirmed")
const missing=[]
for (const l of MAINNET_LISTINGS)
  if (!(await readTokenRisk(c,new PublicKey(l.mainnetMint)))) missing.push(l.symbol)
if (missing.length) {
  console.error("localnet has no TokenRisk for: "+missing.join(", ")+" — run scripts/register.ts there first")
  process.exit(1)
}
console.log("localnet  "+MAINNET_LISTINGS.length+"/"+MAINNET_LISTINGS.length+" TokenRisk records — mirrors can be derived")
' "$LOCALNET"

# Deploy the artefact the tests ran against. `anchor build` silently replaces it
# with sbpf v3 and `cargo build-sbf` no-ops unless the source is newer, so it is
# rebuilt and then checked rather than trusted.
echo
echo "building..."
touch programs/bell-session/src/lib.rs
cargo build-sbf --manifest-path programs/bell-session/Cargo.toml \
  --arch v1 --tools-version v1.57 >/dev/null
file target/deploy/bell_session.so | grep -q "unknown arch 0x107" \
  || { echo "refusing to deploy: not an sbpf v1 binary"; exit 1; }

# ------------------------------------------------------------------- deploy
# --max-len buys ~108KB of growth room. Sized exactly, any later fix that adds a
# byte needs a NEW program address, invalidating every signature and link in the
# submission. Judging runs to Oct 2, so in-place upgrade must stay possible.
echo "deploying (~2.13 SOL rent, recoverable via program close)..."
solana program deploy target/deploy/bell_session.so \
  --url "$RPC" \
  --program-id target/deploy/bell_session-keypair.json \
  --max-len 420000

export BELL_CLUSTER=devnet
export BELL_RPC_URL="$RPC"

# --------------------------------------------------------- the quote asset
# Before register.ts, always: open_mark binds this mint permanently.
echo
echo "creating the devnet quote asset..."
./scripts/demo-setup.sh devnet

# ----------------------------------------------------------------- mirrors
echo
echo "creating mirror mints (derived from real mainnet extension state)..."
BELL_MIRROR_SOURCE="$LOCALNET" BELL_MIRROR_TARGET="$RPC" node scripts/mirror-mints.ts

# ------------------------------------------------------------- freeze gate
# The last point at which anything is recoverable. After register.ts the mirror
# map is effectively immutable: re-running mirror-mints mints nine new
# addresses, register.ts skips the already-registered symbols, and every order
# then fails MintMismatch with nothing in the logs naming the cause.
echo
node -e '
const m=(await import("./src/mirrors.json",{with:{type:"json"}})).default
const {MAINNET_LISTINGS}=await import("./src/listings.ts")
const {Connection,PublicKey}=await import("@solana/web3.js")
const missing=MAINNET_LISTINGS.filter(l=>!m[l.symbol]).map(l=>l.symbol)
if (missing.length) { console.error("mirrors.json incomplete: "+missing.join(", ")); process.exit(1) }
const c=new Connection(process.argv[1],"confirmed")
for (const l of MAINNET_LISTINGS) {
  if (!(await c.getAccountInfo(new PublicKey(m[l.symbol])))) {
    console.error("mirror for "+l.symbol+" is not on devnet: "+m[l.symbol]); process.exit(1)
  }
}
console.log("freeze gate  "+Object.keys(m).length+"/9 mirrors verified on devnet")
' "$RPC"
echo "These addresses are permanent for this deployment. Commit src/mirrors.json."

# ------------------------------------------------------ point of no return
echo
echo "registering symbols (creates permanent accounts)..."
set -a; . ./.demo.devnet.env; set +a
node scripts/register.ts

# --------------------------------------------------------------- inventory
# We hold the mirror mint authorities, so inventory is minted directly. The
# `--account` genesis seeding localnet uses cannot work here: that address is a
# PDA of a program that does not exist and cannot be created off-genesis.
echo
echo "minting filler inventory..."
FILLER=$(solana address -k .filler.json)
node -e '
const m=(await import("./src/mirrors.json",{with:{type:"json"}})).default
console.log(Object.values(m).join("\n"))
' | while read -r MINT; do
  spl-token create-account "$MINT" --owner "$FILLER" --url "$RPC" >/dev/null 2>&1 || true
  ATA=$(spl-token address --token "$MINT" --owner "$FILLER" --url "$RPC" --verbose --output json \
        | python3 -c 'import json,sys; print(json.load(sys.stdin)["associatedTokenAddress"])')
  spl-token mint "$MINT" 1000 --url "$RPC" -- "$ATA" >/dev/null
done
echo "  1000 units of each mirror minted to the filler"

PROGRAM=$(solana address -k target/deploy/bell_session-keypair.json)
echo
echo "done."
echo "  program   $PROGRAM"
echo "  explorer  https://explorer.solana.com/address/$PROGRAM?cluster=devnet"
echo
echo "Front end needs THREE variables. The cluster one is the easy miss — without"
echo "it the UI resolves mainnet mints and shows nine unregistered symbols:"
echo "  NEXT_PUBLIC_BELL_CLUSTER=devnet"
echo "  NEXT_PUBLIC_BELL_RPC=$RPC"
echo "  NEXT_PUBLIC_BELL_QUOTE_MINT=$(grep BELL_QUOTE_MINT .demo.devnet.env | cut -d= -f2)"
echo
echo "Keeper needs BELL_KEY_ATTESTOR set to the contents of .attestor.json."
