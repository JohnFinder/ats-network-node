# Change log

## 0.3.0 — 2026-10-22

- Support speech deployment concurrency from 1 to 128, defaulting to 8. A shared environment override configures gateway admission, engine sequences and unified decode graph capacity.
- Allow a separate graph batch cap and configurable gateway RAM/CPU limits. Leave HTTP connection headroom for probes and busy responses.
- Validate engine concurrency settings before launching the pinned vLLM-Omni process, rendering a private YAML copy without changing the mounted source.
- Extend the explicitly invoked benchmark tool to 128 concurrency and 1024 requests. This release does not include a GPU benchmark result.
- Publish English and Traditional Chinese introductions, protocol, deployment/upgrade, contribution and security reporting documentation.
- Adopt Apache-2.0 for project-owned sources and metadata, retaining third-party license information.
- Make GitHub acceptance manual only; pushes and pull requests do not execute builds or tests.

Validation for this publication is limited to source, metadata and documentation checks. No builds, test suites, public deployment or 128-way GPU inference were executed for this release. Historical execution evidence remains in `docs/VALIDATION.md` and `tts/VALIDATION.md` with its original scope.

## Earlier node revisions

The repository history records resumable storage, signed federation, wallet integration, optional funded service contracts, the Filecoin adapter and the initial authenticated VoxCPM2 deployment. See the dated validation records for their environments and limitations.
