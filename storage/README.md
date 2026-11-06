# Filecoin storage adapter

This optional operator CLI uses `@filoz/synapse-sdk@2.0.2`, `@filoz/synapse-core@0.10.1` and `viem@2.57.7` to store `.atsbook` archives on Filecoin's PDP network. A receipt records provider and PieceCID commitments. Operators fund recurring storage separately from ATS reward budgets.

The default chain is Filecoin Calibration (314159), and the default operation is read-only planning. Mainnet (314) requires `--allow-mainnet`. An explicit RPC URL must use HTTPS and report the expected chain ID. Prepare funding and allowances externally. For paid provider requests, use an isolated account and a mode-0600 key file for scoped EIP-712 signatures. The adapter requests neither RPC signing nor direct transactions, deposits, or approvals.

## Plan and execute

From `storage/`, install the pinned dependencies and plan the upload:

```sh
npm ci --ignore-scripts
npm run cli -- plan --file /input/book.atsbook --address 0xYOUR_ISOLATED_ACCOUNT --copies 2 --output /output/plan.json
```

Check the file SHA-256 and PieceCID, selected providers and datasets, recurring cost and `planHash`. The plan expires in 15 minutes. Use the official Filecoin tooling to fund and authorize the account after reviewing the provider's terms. The adapter rejects insufficient funds and missing FWSS authorization, including requests that would require new funding.

To execute the reviewed plan, pass its exact hash and separate bounds for total and monthly cost:

```sh
npm run cli -- upload --file /input/book.atsbook --plan /output/plan.json --plan-hash EXACT_64_HEX \
  --execute --key-file /run/secrets/filecoin-key \
  --max-cost-units YOUR_INTEGER_BOUND --max-monthly-units YOUR_INTEGER_RATE_BOUND \
  --output /output/receipt.json
```

Enter amounts in integer base units of the SDK's service token. The bounds cover the fresh quote and existing escrow exposure at execution time. Recurring charges can change later, so monitor the service and arrange termination externally. The CLI uses token units and makes no fiat conversion.

The CLI selects and rechecks the reviewed providers and datasets, then creates a private snapshot to keep the upload stable if the source changes. The SDK uploads and commits those bytes. The receipt saves provider, dataset and piece IDs and any submitted transaction hashes, including on partial failure so the operator can reconcile the result. Use a later proof-status check to observe continued storage. The adapter accepts an already encrypted archive as ciphertext and needs no decryption key.

## Retrieve and inspect a receipt

```sh
npm run cli -- download --receipt /output/receipt.json --output /output/retrieved.atsbook
npm run cli -- proof-status --receipt /output/receipt.json --confirmations 10
```

Downloads reject redirects and private network destinations. The CLI caps bytes, verifies both SHA-256 and PieceCID, and writes the result atomically without replacing an existing file.

Proof status checks the active dataset, exact piece membership, provider and payer, last proven epoch and next challenge at a confirmed block. It rejects a reorganization of that block. A current RPC observation returns `rpc-observed-pdp-current` with `proofVerified:false` and `rewardAdapterEnabled:false`. This check trusts the selected RPC and contract state. Independent consensus verification and bridging to ATS rewards are outside this adapter.

## Docker and verification

From the node repository root, build the image and run a read-only planning container:

```sh
docker build -t ats-filecoin-adapter ./storage
docker run --rm --read-only --cap-drop ALL --security-opt no-new-privileges:true \
  --tmpfs /tmp:size=2g --mount type=bind,src=/absolute/input,dst=/input,readonly \
  --mount type=bind,src=/absolute/output,dst=/output \
  ats-filecoin-adapter plan --file /input/book.atsbook --address 0xYOUR_ACCOUNT --output /output/plan.json
```

Make input readable and output writable by UID 1000. Mount the key separately, read-only, for an explicitly executed upload. Allow temporary space for a snapshot up to the 1 GiB archive limit. Keep receipts, private plan metadata, and backup keys out of Git.

From `storage/`, run local checks when requested:

```sh
npm run check
npm run verify
```

The verifier loads the pinned SDK and uses synthetic files and mocked services. It exercises execution guards, committed context and costs, snapshot integrity, key permissions, signature scope, partial submission receipts, exact retrieval, destination restrictions, and reorg rejection. Live acceptance still needs a funded account, provider access, a paid Calibration or mainnet upload, and a complete PDP proof cycle.

See the [Synapse SDK guide](https://docs.filecoin.cloud/developer-guides/synapse/), [storage operations guide](https://docs.filecoin.cloud/developer-guides/storage/storage-operations/), and [SDK source](https://github.com/FilOzone/synapse-sdk).
