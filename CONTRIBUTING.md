# Contributing to SEJIRE

Thank you for helping improve SEJIRE.

## Before opening a change

1. Search existing issues and pull requests.
2. Keep changes focused and reversible.
3. Do not include real family data, recovery words, wallet seed phrases, private keys, admin passwords, or API secrets.
4. Use synthetic fixtures for tests and screenshots.

## Local setup

```bash
npm ci --prefix apps/web
npm ci --prefix apps/sponsor
npm test
npm run lint --prefix apps/web
npm run native:build
```

## Pull requests

A pull request should explain:

- the user or protocol problem;
- the exact behavior changed;
- tests added or updated;
- security and privacy implications;
- whether the change affects payment, preservation, or recovery compatibility.

Changes to payment verification, encryption, archive schemas, recovery derivation, or signed metadata require explicit regression tests.

## Security-sensitive changes

Read [SECURITY.md](SECURITY.md). Never place secrets in issues, pull requests, test logs, screenshots, or fixtures.
