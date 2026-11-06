# Deploy and verify an ATS Network Node

The node provides shared audiobook storage and discovery. You can also deploy VoxCPM2 speech synthesis on an NVIDIA host. Operators or sponsors provide disk, bandwidth, GPU capacity and retention funding. [Project overview](../README.md)

## Start locally

Install Docker Desktop or Docker Engine with Compose V2. For a new standalone installation, run the following commands.

```sh
git clone https://github.com/JohnFinder/ats-network-node.git
cd ats-network-node
cp .env.example .env
docker compose up -d --build
```

The storage API listens at `http://127.0.0.1:8787` by default. For same-host development, enter that address in ATS and enable local HTTP explicitly. A physical phone has its own loopback address. To connect it, use a node address reachable from the device.

Docker stores node identity, publications and metadata in a named volume. Recreating containers preserves the data. Keep production volumes when stopping Compose and avoid `docker compose down -v` on them. Existing deployments should preserve their credentials, project name, data and model cache volumes, and local engine settings. [Upgrade and rollback](DEPLOYMENT.md)

## Add NVIDIA speech

On a Linux x86_64 host, configure the NVIDIA driver and Container Toolkit. From the repository root, run the helper to start storage, the authenticated speech gateway and the private VoxCPM2 engine.

```sh
sh scripts/start-gpu-node.sh
```

Set `TTS_MAX_CONCURRENT` in `.env` to configure admission, engine sequences and decode graph capacity. The supported range is 1–128 and the default is 8. Measure memory and performance on the target GPU before raising the limit. KV cache capacity is configured separately. [Deployment concurrency](../tts/README.md#deployment-concurrency)

## Add optional services

- Set a compatible upstream for the translation gateway or include its optional private NVIDIA backend. The startup helper supports loopback, LAN discovery and HTTPS. [Translation guide](../translation/README.md)
- Run the Node.js music API and the Python worker for the model you enable. Use a separate HTTPS origin for remote clients. [Music guide](../music/README.md)
- Start the isolated Voice Market Compose service with reviewer configuration and choose sandbox credits or Base Sepolia test transactions. [Voice Market guide](../voice-market/README.md)

## Publish over HTTPS

Point a domain at the host and make ports 80 and 443 reachable. Set `NODE_DOMAIN` in `.env`. Set storage quotas and define intake, moderation, administrator and backup procedures before accepting uploads.

```sh
docker compose -f compose.yaml -f compose.public.yaml up -d --build
```

Caddy requests a TLS certificate. Confirm DNS, network reachability and certificate issuance from outside the deployment. For public storage and speech together, use `sh scripts/start-gpu-node.sh --public` to apply the speech routes as well.

An ATS app build can set `ATSCommunityNodeURL` to the deployed HTTPS origin so users can find the node without entering its address. Builds without that setting let users enter a node address.

## Upload and find an audiobook

In ATS, export an archive and choose the option to upload it to a node. Select public, unlisted or private visibility. Existing archive encryption is preserved by default. The user manages and shares the decryption key separately.

ATS uploads an immutable snapshot in 8 MiB parts. Uploads can pause and resume after an app restart. After validation, public and unlisted uploads enter the review queue. Public uploads appear in search after approval. A public deployment needs administrator key fingerprints and a monitored HTTPS contact page. [Content moderation](OPERATIONS.md#content-moderation)

Download counts and ranking reflect the observations of that node. They do not represent global totals or trigger token issuance.

## Verify an isolated deployment

Run acceptance only on explicit request. GitHub Actions uses manual workflow dispatch. On a host with Node.js 24 or newer, the following script starts an isolated Compose project, creates synthetic fixtures, checks upload recovery after restart and verifies settlement on a local chain.

```sh
sh scripts/verify-docker.sh
```

For a direct run of `scripts/verify-node.mjs`, configure the isolated node with `NODE_ADMIN_PUBLIC_KEYS` and `NODE_MODERATION_CONTACT_URL`. Point `ATS_MODERATION_PRIVATE_KEY_FILE` at the matching disposable review key. Use `NODE_URL` to select the test node. The default target is `http://127.0.0.1:18787`. Keep the verification state in the test environment because it contains a disposable identity. A direct run uses `/tmp/ats-network-verification-state.json` unless overridden with `VERIFY_STATE`.

Set `KEEP_VERIFY_CONTAINERS=1` when running the script if you need to inspect or reuse its isolated deployment. The script prints the project name and state directory. Read `publicResourceID` and `providerID` from its `state.json` and export them as `NODE_RESOURCE_ID` and `EXPECTED_NODE_ID`. Set `VERIFY_PROJECT` to the printed project name and use the same running containers and volumes.

```sh
docker compose -p "$VERIFY_PROJECT" -f compose.yaml -f compose.chain.yaml run --rm --no-deps verify-chain
```

The local chain ID is 1337 and its RPC binds to `127.0.0.1:18545` by default. Verification deploys a fixed-supply test token to exercise staking, prepaid service, sponsored tasks, delays and duplicate reward protection. These tokens have no value. Keep real assets out of this environment.

## Set up peers, wallets and funded services

Start each peer and verify its fingerprint before adding it to `NODE_PEERS`. Use HTTPS in public deployments. The V2 mesh exchanges signed public catalogs and supports replication, repair and origin failover. `compose.full.yaml` is a three-node development example. Adapt and review its configuration before operating a public network.

Configure operator processes with `compose.services.yaml` and supply a reviewed deployment manifest, RPC, pinned node identity, separate keys and data volumes. In ATS, the wallet and earnings area can create a dual-proof binding and open registration and transaction pages in an external wallet. Users confirm each transaction in that wallet. Operators can sign a binding intent in the node with `src/bind-wallet.mjs` without copying the node private key.

Prepaid storage settles for the funded period using observed results. Failed service portions are refunded. Disputes pause settlement until resolution. Publishers can fund milestones separately. A preservation reward can require 30 accumulated days of successful preservation before unlocking. Download counts do not drive rewards.

When explicitly requested, run the relevant acceptance scenarios in this order.

```sh
./scripts/verify-docker.sh
./scripts/verify-mesh-docker.sh
./scripts/verify-backup-docker.sh
npm ci --ignore-scripts --prefix services
./scripts/verify-services-docker.sh
npm ci --ignore-scripts --prefix storage
npm --prefix storage run verify
```

Use synthetic files, disposable identities and the local chain. Live Filecoin uploads and proof cycles need separate funding and acceptance. Public operation also needs validation across independent failure domains, external review and a process to check content rights. [Operations](OPERATIONS.md) · [Delivery status](PLAN.md) · [Contracts](../contracts/README.md) · [Operator services](../services/README.md) · [Filecoin adapter](../storage/README.md)
