# Contributing

Changes should preserve API contracts, persistent identities and existing operator data. Use an issue or focused pull request to describe the observable problem, proposed behavior and affected deployment modes. Do not attach real user documents, voices, keys, private URLs or data-volume contents.

## Working locally

Storage requires Node.js 24 or newer; Docker Compose is the documented deployment path. Contracts, operator services and Filecoin packages have independent lockfiles. Keep dependency changes separate from unrelated work. GPU serving requires the Linux NVIDIA environment described in `tts/README.zh-Hant.md`.

Keep changes within this node repository. The ATS Apple client is separate and is not required to run storage or the gateway.

## Validation policy

Run builds, acceptance scripts and GPU benchmarks only when explicitly requested. GitHub Actions acceptance is available by manual workflow dispatch, with no automatic push/PR trigger. Static syntax, metadata, link and diff checks can support documentation changes without starting services.

When execution is requested, use synthetic documents, isolated Compose projects and disposable credentials. Report the source revision, commands, environment, results and omissions. Never present mocked responses as GPU performance evidence. Dated records under `docs/` and `tts/` illustrate scope reporting.

## Pull requests

Explain what changed, why it matters and how it was checked. Update relevant examples and deployment documentation together. For persistent-state changes, explain upgrade and recovery behavior. Include no secrets or generated dependencies, images, model weights, receipts, runtime data or benchmark audio.

Use conventional commit messages such as `fix(tts): ...` or `docs: ...`. Align package metadata with root entries in affected lockfiles; do not rewrite third-party license declarations.

## License

Contributions intentionally submitted for inclusion are provided under Apache-2.0 as described in `LICENSE`, unless explicitly agreed otherwise. Retain upstream attribution and license terms for third-party material. See `NOTICE` and `THIRD_PARTY_NOTICES.md`.
