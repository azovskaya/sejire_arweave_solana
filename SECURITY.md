# Security Policy

SEJIRE handles encrypted family archives, recovery words, and wallet-connected operations.

## Never disclose publicly

Do not place any of the following in an issue, pull request, discussion, screenshot, test fixture, or log:

- real SEJIRE recovery words;
- decrypted family data;
- Phantom, Solflare, Wander, or other wallet seed phrases;
- Arweave JWK files;
- private keys;
- admin passwords;
- API tokens or session cookies.

## Reporting a vulnerability

Use GitHub's private **Report a vulnerability** flow when it is available for this repository. If it is unavailable, contact the repository owner through GitHub before publishing technical details.

Include:

- affected route, commit, or component;
- reproducible steps using synthetic data;
- expected and observed behavior;
- impact;
- a suggested fix, if known.

## Scope

High-priority reports include:

- recovery-word leakage;
- plaintext family-data leakage;
- accepting the wrong archive or vault;
- payment verification bypass;
- duplicate-payment risk;
- unauthorized wallet signing or upload;
- integrity-check bypass;
- secret exposure in builds or logs.

Do not test against real family archives or attempt transactions without explicit authorization.
