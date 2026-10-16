# Established Filecoin storage adapter

Optional operator CLI using official `@filoz/synapse-sdk@2.0.2`, `@filoz/synapse-core@0.10.1` and `viem@2.57.7`. This delegates storage datasets/PieceCID commitments to Filecoin's established PDP network. It does not create free capacity or automatically pay ATS rewards from a self-submitted proof report.

Default is **Calibration chain 314159**, read-only plan. Mainnet 314 requires `--allow-mainnet`; an explicit RPC must be HTTPS and its actual chain ID must match. The CLI never requests RPC signing, sends a transaction, deposits tokens or grants an allowance. Paid provider operations require external prior funding/authorization and narrowly scoped EIP-712 storage signatures using an isolated account key supplied through a mode-0600 secret file. Never use an account holding unrelated assets or balances.

## Plan and execute

```sh
npm ci --ignore-scripts
npm run cli -- plan --file /input/book.atsbook --address 0xYOUR_ISOLATED_ACCOUNT --copies 2 --output /output/plan.json
```

Review the exact file SHA-256 and PieceCID, provider identities, existing/new dataset IDs, recurring costs and the `planHash`. Plans expire after 15 minutes. Prepare and authorize the isolated account externally using the official Filecoin tooling after reviewing its service terms. This adapter refuses insufficient funding, new funding needs or missing FWSS authorization; it does not silently grant unlimited approval.

```sh
npm run cli -- upload --file /input/book.atsbook --plan /output/plan.json --plan-hash EXACT_64_HEX \
  --execute --key-file /run/secrets/filecoin-key \
  --max-cost-units YOUR_INTEGER_BOUND --max-monthly-units YOUR_INTEGER_RATE_BOUND \
  --output /output/receipt.json
```

Amounts are integer base units of the SDK's configured service token. Bounds check the fresh quote and total existing escrow exposure. **They are not a smart-contract enforced absolute future price ceiling.** Recurring service must be monitored and terminated externally; there is no automatic renewal/termination. No fiat exchange rate is assumed. Private archive content keys are never received by the adapter; an already encrypted archive can be stored as ciphertext.

Exactly the reviewed providers/datasets are selected again and rechecked before upload. A bounded private snapshot preserves bytes against concurrent edits. The SDK uploads/commits, and the receipt preserves actual provider/dataset/piece IDs and submitted transaction hashes. Partial failures retain a reconciliation receipt. A transaction hash or `complete` SDK result is not ongoing storage proof.

```sh
npm run cli -- download --receipt /output/receipt.json --output /output/retrieved.atsbook
npm run cli -- proof-status --receipt /output/receipt.json --confirmations 10
```

Download rejects redirects/private network destinations, limits bytes, checks both full SHA-256 and official PieceCID and atomically publishes without overwriting existing files. Proof status checks a confirmed block snapshot for active dataset, exact piece membership, provider/payer, last proven epoch and next challenge, and rejects a block reorganization. It reports `rpc-observed-pdp-current`, with `proofVerified:false` and `rewardAdapterEnabled:false`: the RPC/contract state is trusted, and this CLI does not independently verify Filecoin consensus or bridge that consensus to ATS reward contracts.

## Docker and verification

```sh
docker build -t ats-filecoin-adapter ./storage
docker run --rm --read-only --cap-drop ALL --security-opt no-new-privileges:true \
  --tmpfs /tmp:size=2g --mount type=bind,src=/absolute/input,dst=/input,readonly \
  --mount type=bind,src=/absolute/output,dst=/output \
  ats-filecoin-adapter plan --file /input/book.atsbook --address 0xYOUR_ACCOUNT --output /output/plan.json
npm run check
npm run verify
```

Bind mounts must be readable/writable by container uid 1000. Mount the key separately read-only only for explicitly executed upload. The immutable snapshot requires temporary space up to the 1 GiB archive limit. Preserve receipts and backup keys separately. Never put a key, plan containing private operational metadata, or receipt into Git by accident.

The local verifier imports the actual SDK and checks guarded execution, context/cost commitments, snapshot integrity, secret permissions, permitted signatures, partial-submission reconciliation, exact download integrity, address restrictions and reorg rejection with synthetic/mocked services. **No live paid Calibration/mainnet upload, funded account or PDP proof cycle has been exercised.** That operational acceptance needs external funded intent and provider access; local mock success must not be called live network proof.

Primary documentation: [Synapse SDK](https://docs.filecoin.cloud/developer-guides/synapse/), [storage operations](https://docs.filecoin.cloud/developer-guides/storage/storage-operations/), [SDK source](https://github.com/FilOzone/synapse-sdk).
