# Security Policy

## Supported versions

Checkin Pod is preparing its first open-source release. Security fixes are applied to the latest commit on the default branch. Tagged support ranges will be listed here after the first stable release.

## Report a vulnerability

Please use [GitHub Private Vulnerability Reporting](https://github.com/hlb/checkin-pod/security/advisories/new). Include:

- A clear description of the issue.
- The affected route, component, or commit.
- Reproduction steps or a proof of concept.
- The expected impact.
- Any suggested remediation.

Do not include attendee names, Email addresses, phone numbers, QR Codes, event exports, passwords, session cookies, or workstation tokens. Use synthetic test data.

Please do not open a public issue for an unpatched vulnerability.

## Response targets

- Initial acknowledgement: 3 business days.
- Triage and severity assessment: 7 business days.
- Remediation plan: 14 business days for confirmed High or Critical issues.
- Coordinated disclosure: after a fix is available to supported deployments.

These targets describe the intended response and may change with maintainer availability.

## Disclosure process

1. The maintainer confirms receipt and assigns an owner.
2. The maintainer reproduces the issue with synthetic data.
3. A private fix and regression test are prepared.
4. A GitHub Security Advisory and CVE are requested when appropriate.
5. Supported deployments receive the fix.
6. The advisory is published with credit agreed with the reporter.

## Deployment security

Deployers are responsible for secrets, Cloudflare account controls, rate limiting, logs, backups, retention settings, and privacy notices. Review [docs/security-review.md](docs/security-review.md) before production use.
