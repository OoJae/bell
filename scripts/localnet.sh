#!/bin/sh
# Local validator seeded with the REAL mainnet mints.
#
# Devnet is not an option for this project: none of the xStocks or Backpack
# mints exist there, so every gate that reads Token-2022 extension state would
# have nothing to read. Cloning mainnet accounts keeps the bytes real while the
# ledger stays local, free and reproducible.
#
# The --account flags seed the filler's stock inventory. Backed holds the mint
# authority on these, so there is no way to mint some for a test: the mint stays
# byte-for-byte real and only the holding is fabricated. Regenerate with
# `node scripts/seed-accounts.ts`.
set -e
exec solana-test-validator -r \
  --url https://api.mainnet-beta.solana.com \
  --ledger test-ledger \
  --clone XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W --clone Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh --clone Xs8S1uUs1zvS2p7iwtsG3b6fkhpvmwz4GYU3gWAmWHZ --clone XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB --clone XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp --clone XsbELVbLGBkn7xfMfyYuUipKGt1iRUc2B7pYRvFTFu3 --clone XsCAXu7xTaZMG9b9KJhNWYapuvNjxPuE4SysZq8uvMq --clone PFER6ENqP8r8NF3CqVt4mFowxsin3V5MLidBNQFCC3x --clone LMT3i1BHgixFqPUgcyteJhnEz2dpy9i3cYy4pi9BoeV \
  --account A3DwPxvFyUjJq7CXGvhxrHwMrWCi31qZcyU9dGpKt9Tc localnet/inv-SPYx.json    --account DCP7RabVeWLCb89D59ExPMqQ6tc4d3crr1Y99LFzMaCG localnet/inv-NVDAx.json    --account Evgwr7w8zysoMhAwMrPn5cxikjcHvsdJLK8u2SmhmnLG localnet/inv-QQQx.json    --account BJ3aRYxRWGY5Uh4vjJ1GNYouu2UHq9zZd8ciy2KriynS localnet/inv-TSLAx.json    --account 3ikxVyKq6PDYfJjgfaN1Lv99pWtCTaCNAMvDaKxChy5P localnet/inv-AAPLx.json    --account DcsBkmbmGMttt5s4rMUcATaMGbKZAXRYhHjRQ6APYv5j localnet/inv-IWMx.json    --account FwB8Y5bgS68tdqCUqR4CqHbnrXgfzLNssKVsxve1ddhH localnet/inv-JPSTx.json    --account KBtFU1msWcM9HjGStVP19gJwVwFTcp7Mbc9WJwEbgYw localnet/inv-PFE.json    --account 8FhNeHdjVYHY2v4HTHAeWYM8a1EEajcDNmL2goEfALmg localnet/inv-LMT.json  \
  --bpf-program 56AUPR1c1Tq5AgMvAa3PASax61YYo1KTdocwW6pR7Pdx target/deploy/bell_session.so \
  --quiet
