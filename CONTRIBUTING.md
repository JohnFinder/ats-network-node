# Contributing to ATS Network Node

Open an issue or a focused pull request with the observed behavior, expected result and affected deployment modes. Preserve API contracts, node identities and existing operator data. Use synthetic examples and keep real user documents, recordings, private URLs and credentials out of reports.

## Work locally

Use Node.js 24 or newer for storage development and Docker Compose for deployment. Contracts, operator services and the Filecoin adapter have independent lockfiles. Keep changes to dependencies separate from unrelated work. Run GPU serving on a supported Linux NVIDIA host. [GPU requirements](tts/README.md)

The node and gateway run independently of the ATS Apple client. Keep standalone changes within this repository.

## Verify changes

Run builds, acceptance scripts and GPU benchmarks only when explicitly requested. The GitHub acceptance workflow uses manual dispatch. For documentation changes, check links, paths, command examples and the diff without starting services.

For an execution request, use an isolated Compose project, synthetic inputs and disposable credentials. Record the revision, commands, environment, results and omissions. Label mocked runs so readers can distinguish them from real GPU measurements. [Node validation record](docs/VALIDATION.md) · [GPU validation record](tts/VALIDATION.md)

## Submit changes

Explain what changed, which behavior it affects and how you verified it. Update the corresponding documentation and examples. For changes to persistent state, describe upgrades and recovery. Keep secrets, installed dependencies, images, model weights, receipts, data volumes and benchmark audio out of commits.

Use conventional commit messages, such as `fix(tts): validate concurrency` or `docs: update the quickstart`. Keep package metadata in sync with root entries in the affected lockfiles. Preserve third-party license declarations.

## License

Contributions intentionally submitted for inclusion use Apache-2.0 unless otherwise agreed. Preserve upstream licenses and attributions. [License](LICENSE) · [Notice](NOTICE) · [Third-party components](THIRD_PARTY_NOTICES.md)
