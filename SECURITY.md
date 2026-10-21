# Security reporting

Report vulnerabilities through this repository's **Security → Report a vulnerability** entry when private reporting is available. If unavailable, open an issue requesting a private channel without including exploit details, credentials or affected user content. Do not post signing keys, API keys, private download tickets, wallet seeds, real documents or voice recordings publicly.

Include the affected commit, component, expected trust boundary and a minimal synthetic reproduction. Distinguish local development from public deployment configurations. No response-time or hosted support guarantee is implied.

## Scope

Relevant components include publisher authentication, persisted nonces, visibility checks, transfer integrity, signed catalogues, peer-origin checks, speech authentication/resource admission and contract/service verification. See `docs/THREAT-MODEL.md` for known assumptions.

Use the latest published source when reporting an issue, identifying the exact revision where it occurred. There is no separately maintained long-term support branch.

## Operator references

The [operations manual](docs/OPERATIONS.md) covers draining, encrypted backup/restore and compromised identity handling. The [deployment guide](docs/DEPLOYMENT.md) covers preserving keys and volumes during updates. GPU inference stays on a private container network; expose the authenticated gateway through HTTPS for remote clients.
