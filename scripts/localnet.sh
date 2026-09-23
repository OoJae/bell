#!/bin/sh
# Local validator seeded with the REAL mainnet mints.
#
# None of the xStocks or Backpack mints exist on devnet, so the hosted
# deployment runs against mirrors of them (scripts/mirror-mints.ts). This is the
# other way to run BELL: clone the real mainnet accounts, so every gate that
# reads Token-2022 extension state reads the real bytes, on a ledger that stays
# local, free and reproducible.
#
# The --account flags seed the filler's stock inventory. Backed holds the mint
# authority on these, so there is no way to mint some for a test: the mint stays
# byte-for-byte real and only the holding is fabricated. The addresses are
# derived from *your* .filler.json, so they are read from the file
# `node scripts/seed-accounts.ts` writes rather than hardcoded here.
set -e
[ -f localnet/accounts.flags ] || { echo "run: node scripts/seed-accounts.ts (needs .filler.json)"; exit 1; }
# The flags file uses backslash-newline continuations; drop the backslashes and
# let the shell split what remains.
SEED=$(tr -d '\\' < localnet/accounts.flags)
# shellcheck disable=SC2086
exec solana-test-validator -r \
  --url https://api.mainnet-beta.solana.com \
  --ledger test-ledger \
  --clone XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W --clone Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh --clone Xs8S1uUs1zvS2p7iwtsG3b6fkhpvmwz4GYU3gWAmWHZ --clone XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB --clone XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp --clone XsbELVbLGBkn7xfMfyYuUipKGt1iRUc2B7pYRvFTFu3 --clone XsCAXu7xTaZMG9b9KJhNWYapuvNjxPuE4SysZq8uvMq --clone PFER6ENqP8r8NF3CqVt4mFowxsin3V5MLidBNQFCC3x --clone LMT3i1BHgixFqPUgcyteJhnEz2dpy9i3cYy4pi9BoeV \
  $SEED \
  --bpf-program 56AUPR1c1Tq5AgMvAa3PASax61YYo1KTdocwW6pR7Pdx target/deploy/bell_session.so \
  --quiet
