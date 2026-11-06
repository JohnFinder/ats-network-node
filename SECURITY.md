# Security reporting

Use **Security → Report a vulnerability** on GitHub if private vulnerability reporting is available. Otherwise, open an issue asking for a private contact channel. Keep exploit details, signing keys, API keys, download tickets, wallet seeds, documents and voice recordings out of public issues.

Identify the affected component and exact revision. Include a minimal synthetic reproduction, the expected trust boundary and whether the failure occurred in a local or public deployment. If possible, check whether the issue affects the latest published source. This repository has no dedicated long-term support branch or guaranteed response time.

## Scope

Reports can cover publisher authentication, persisted nonce checks, resource visibility, transfer integrity, signed catalogs, peer-origin checks, speech authentication and admission, or verification by contracts and operator services. [Threat model](docs/THREAT-MODEL.md)

## Operator guidance

The operations guide covers draining, encrypted backups, recovery and compromised identities. The deployment guide explains how to preserve keys and volumes during upgrades. Keep GPU inference on the private container network and expose the authenticated gateway through HTTPS for remote clients. [Operations](docs/OPERATIONS.md) · [Deployment](docs/DEPLOYMENT.md)
