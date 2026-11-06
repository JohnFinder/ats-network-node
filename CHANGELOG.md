# Change log

## Unreleased

- Include the authenticated translation gateway, optional NVIDIA translation backend, music API and workers, and isolated Voice Market service in the standalone checkout.
- Support sandbox credits and Base Sepolia test transactions for Voice Market. Purchases are disabled until a test mode is configured.
- Require review for public and unlisted books and for voice packages. Existing listings enter review on upgrade. Add signed reports, reviewer tools and approval checks for federated listings.
- Add AAC speech output and registered voice references to the speech gateway.
- Rewrite the node documentation in English. The project overview, quickstart and component guides link to the canonical English pages. Previous localized URLs still point readers to those guides.

## 0.3.0 — 2026-10-22

- Set speech deployment concurrency from 1 to 128, with a default of 8. A shared environment override sets gateway admission, engine sequences and unified decode graph capacity.
- Set an independent graph batch limit and gateway memory and CPU limits. The gateway reserves connection headroom for readiness probes and capacity responses.
- Validate concurrency settings before launching the pinned vLLM-Omni process. The entry point renders a private YAML copy and preserves the mounted source.
- Extend the operator benchmark to accept 128 concurrent requests and 1,024 total requests.
- Publish the original English and Traditional Chinese introductions alongside deployment, protocol, contribution and security guides.
- License project-owned sources and metadata under Apache-2.0 and retain third-party attribution.
- Limit GitHub acceptance to manual workflow dispatch.

The 0.3.0 publication received source, metadata and documentation checks. Builds, acceptance suites, public deployment and 128-way GPU inference were outside that validation. [Node validation record](docs/VALIDATION.md) · [GPU validation record](tts/VALIDATION.md)

## Earlier revisions

Earlier revisions introduced resumable storage, signed federation, wallet integration, funded service contracts, the Filecoin adapter and authenticated VoxCPM2 deployment. Consult the dated validation records for the environment and scope of each check.
