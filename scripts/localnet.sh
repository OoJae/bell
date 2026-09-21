#!/bin/sh
# Local validator seeded with the REAL mainnet mints.
#
# Devnet is not an option for this project: none of the xStocks or Backpack
# mints exist there, so every gate that reads Token-2022 extension state would
# have nothing to read. Cloning mainnet accounts keeps the bytes real while the
# ledger stays local, free and reproducible.
set -e
exec solana-test-validator -r \
  --url https://api.mainnet-beta.solana.com \
  --ledger test-ledger \
  --clone XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W --clone Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh --clone Xs8S1uUs1zvS2p7iwtsG3b6fkhpvmwz4GYU3gWAmWHZ --clone XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB --clone XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp --clone XsbELVbLGBkn7xfMfyYuUipKGt1iRUc2B7pYRvFTFu3 --clone XsCAXu7xTaZMG9b9KJhNWYapuvNjxPuE4SysZq8uvMq --clone PFER6ENqP8r8NF3CqVt4mFowxsin3V5MLidBNQFCC3x --clone LMT3i1BHgixFqPUgcyteJhnEz2dpy9i3cYy4pi9BoeV \
  --bpf-program 56AUPR1c1Tq5AgMvAa3PASax61YYo1KTdocwW6pR7Pdx target/deploy/bell_session.so \
  --quiet
