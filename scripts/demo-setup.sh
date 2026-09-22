#!/bin/sh
# Create the quote asset and demo holdings for a cluster, and record them.
#
#   ./scripts/demo-setup.sh            # localnet (default)
#   ./scripts/demo-setup.sh devnet
#
# Why a mint of our own rather than a cloned USDC: cloning mainnet USDC gives a
# mint whose authority we do not hold, so nothing can be minted from it and no
# demo wallet can be funded. The securities stay real — only the money is local,
# which is the right way round.
#
# Everything lands at the *associated* token address, because that is what the
# browser derives. A demo whose accounts the front end cannot find would only
# prove the CLI works.
#
# This must run BEFORE `register.ts` on any cluster. `open_mark` binds its quote
# mint permanently and there is no instruction to change it, so a mark opened
# before the quote asset exists bricks that symbol for good.
set -e

CLUSTER=${1:-localnet}
case "$CLUSTER" in
  localnet)
    RPC=http://127.0.0.1:8899
    ENVFILE=.demo.env
    ;;
  devnet)
    RPC=https://api.devnet.solana.com
    # Deliberately NOT .demo.env: the localnet stack is still running and the
    # mirror mints are derived from it, so clobbering its addresses mid-deploy
    # would break the very source this cluster is built from.
    ENVFILE=.demo.devnet.env
    ;;
  *)
    echo "unknown cluster '$CLUSTER' (want: localnet | devnet)"; exit 1 ;;
esac

# The Solana toolchain lives outside the default PATH and is added by ~/.profile,
# which zsh does not read and `#!/bin/sh` does not inherit. Without this the
# script dies on its first `solana` call — after the operator has already
# committed to a deploy.
PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
export PATH
for t in solana spl-token; do
  command -v "$t" >/dev/null || { echo "$t not on PATH"; exit 1; }
done
# Refuse to run twice. Each run mints a NEW quote asset, and `open_mark` welds
# whichever one is in the environment at `register.ts` time into all nine marks,
# permanently. A second run after registering therefore produces a quote mint
# nothing on chain will accept, with no error until the first order is refused
# for QuoteMintMismatch. Deleting the file is a deliberate act; overwriting it
# by accident is not.
if [ -f "$ENVFILE" ] && [ "${BELL_FORCE:-0}" != 1 ]; then
  echo "$ENVFILE already exists — this cluster is already set up."
  echo "Re-running would mint a SECOND quote asset and orphan the marks bound to the first."
  echo "If that is genuinely what you want: BELL_FORCE=1 $0 $CLUSTER"
  exit 1
fi

DECIMALS=6
# Pin the payer rather than relying on CLI config resolution. `solana address`
# reads the configured keypair but `solana transfer` does not resolve it as a
# signer, so an unpinned script reports one wallet and then refuses to spend
# from it — and any later `solana config set --keypair` would silently split the
# mint authority from the wallet the rest of the deploy uses.
PAYER_KP=${BELL_PAYER_KEYPAIR:-$HOME/.config/solana/id.json}
USER=$(solana address -k "$PAYER_KP")
FILLER_KP=.filler.json

[ -f "$FILLER_KP" ] || solana-keygen new --no-bip39-passphrase -s -o "$FILLER_KP" >/dev/null
FILLER=$(solana address -k "$FILLER_KP")

echo "cluster $CLUSTER  ($RPC)"

# Localnet mints SOL freely. Devnet's faucet is rate limited to the point of
# being unusable, so the filler is funded by transfer from the payer instead.
if [ "$CLUSTER" = localnet ]; then
  solana airdrop 100 "$USER"   --url "$RPC" >/dev/null 2>&1 || true
  solana airdrop 100 "$FILLER" --url "$RPC" >/dev/null 2>&1 || true
else
  FB=$(solana balance "$FILLER" --url "$RPC" --lamports 2>/dev/null | awk '{print $1}')
  if [ "${FB:-0}" -lt 50000000 ]; then
    echo "  funding filler from payer (devnet faucet is rate limited)"
    solana transfer "$FILLER" 0.15 --url "$RPC" --keypair "$PAYER_KP" --allow-unfunded-recipient >/dev/null
  fi
fi

# Six decimals, like USDC: the rate arithmetic is raw-per-raw, and the decimals
# skew against an 8-decimal security is exactly what the Q64.64 rate carries.
#
# Plain SPL Token, deliberately NOT --program-2022. `crank.ts` passes
# quoteTokenProgram: TOKEN_PROGRAM and the browser approves under the same, so a
# Token-2022 quote asset would break both — and because the mark binds it
# permanently, it would break them irreversibly.
QUOTE=$(spl-token create-token --url "$RPC" --fee-payer "$PAYER_KP" --owner "$PAYER_KP" --decimals $DECIMALS --output json | \
        python3 -c 'import json,sys; print(json.load(sys.stdin)["commandOutput"]["address"])')

spl-token create-account "$QUOTE" --url "$RPC" --fee-payer "$PAYER_KP" --owner "$PAYER_KP" >/dev/null
USER_QUOTE=$(spl-token address --token "$QUOTE" --url "$RPC" --verbose --output json | \
             python3 -c 'import json,sys; print(json.load(sys.stdin)["associatedTokenAddress"])')
spl-token mint "$QUOTE" 100000 --url "$RPC" --fee-payer "$PAYER_KP" >/dev/null

# No --fee-payer: the payer covers the rent so the filler's balance stays
# reserved for fill_order fees, which is the only thing it must never run out of.
spl-token create-account "$QUOTE" --owner "$FILLER" --url "$RPC" --fee-payer "$PAYER_KP" >/dev/null
FILLER_QUOTE=$(spl-token address --token "$QUOTE" --owner "$FILLER" --url "$RPC" --verbose --output json | \
               python3 -c 'import json,sys; print(json.load(sys.stdin)["associatedTokenAddress"])')

cat > "$ENVFILE" <<EOF
# Generated by scripts/demo-setup.sh for $CLUSTER. Never mainnet.
BELL_QUOTE_MINT=$QUOTE
BELL_USER_QUOTE=$USER_QUOTE
BELL_FILLER_QUOTE=$FILLER_QUOTE
EOF

if [ "$CLUSTER" = localnet ]; then
  cat > web/.env.local <<EOF
# Localnet.
NEXT_PUBLIC_BELL_CLUSTER=localnet
NEXT_PUBLIC_BELL_RPC=$RPC
NEXT_PUBLIC_BELL_QUOTE_MINT=$QUOTE
EOF
  echo "wrote $ENVFILE and web/.env.local"
else
  echo "wrote $ENVFILE"
  echo
  echo "Front-end variables for the hosted service:"
  echo "  NEXT_PUBLIC_BELL_CLUSTER=devnet"
  echo "  NEXT_PUBLIC_BELL_RPC=$RPC"
  echo "  NEXT_PUBLIC_BELL_QUOTE_MINT=$QUOTE"
fi

echo "quote mint   $QUOTE"
echo "user quote   $USER_QUOTE  (100,000 minted)"
echo "filler quote $FILLER_QUOTE"
