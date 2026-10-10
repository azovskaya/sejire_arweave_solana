<p align="center">
  <img src="docs/colosseum/assets/sejire-cover.svg" alt="SEJIRE — Pay with Solana. Preserve on Arweave. Recover with 12 words." width="100%">
</p>

<p align="center">
  <a href="https://azovskaya.github.io/sejire_arweave_solana/"><strong>Live Protocol</strong></a>
  ·
  <a href="https://azovskaya.github.io/sejire_arweave_solana/#/restore"><strong>Recovery</strong></a>
  ·
  <a href="docs/colosseum/README.md"><strong>Colosseum Materials</strong></a>
  ·
  <a href="https://azovskaya.github.io/sejire_arweave_solana/build-provenance.json"><strong>Build Provenance</strong></a>
</p>

<p align="center">
  <a href="https://github.com/azovskaya/sejire_arweave_solana/actions/workflows/checks.yml">
    <img alt="SEJIRE checks" src="https://github.com/azovskaya/sejire_arweave_solana/actions/workflows/checks.yml/badge.svg?branch=feat%2Fpreservation-v2-simple">
  </a>
  <img alt="Solana Devnet" src="https://img.shields.io/badge/Solana-Devnet-7B61FF">
  <img alt="Arweave Mainnet" src="https://img.shields.io/badge/Arweave-Mainnet-222222">
  <img alt="License MIT" src="https://img.shields.io/badge/license-MIT-C57A45">
</p>

# SEJIRE

**Pay with Solana. Preserve on Arweave. Recover with 12 words.**

SEJIRE is a decentralized protocol and web client for creating, encrypting, preserving, and independently recovering family trees.

A family can build a tree without an account or wallet. When it chooses permanent preservation, SEJIRE encrypts the archive in the browser, verifies the preservation payment through Solana, stores the encrypted archive on Arweave, and allows recovery on a clean device using 12 words.

Rooted in the Kazakh tradition of *shezhire*. Built for families everywhere.

## Working end-to-end proof

The current pilot has completed this full path:

1. Create a family tree in the browser.
2. Encrypt the family vault locally with AES-GCM.
3. Verify an exact `0.03 SOL` payment on Solana Devnet.
4. Publish the encrypted archive to Arweave Mainnet.
5. Retrieve the raw archive and verify its byte size, SHA-256 digest, and vault identity.
6. Open SEJIRE in a clean browser.
7. Recover the family tree using only the 12 recovery words.

The public admin overview also reads Arweave saves and independently verifies the finalized Solana payment through public RPC endpoints.

> This proves the technical workflow. It does not yet prove product-market fit or production pricing.

## Why Solana + Arweave

### Solana: practical payment and verification

Solana is used as the payment and coordination layer.

SEJIRE verifies:

- the network;
- transaction finality;
- the payer;
- the recipient;
- the exact service amount;
- the deterministic preservation reference;
- the absence of unexpected transfers.

Family names, dates, relationships, and recovery words are not written to Solana.

### Arweave: encrypted archive storage

Arweave is used to preserve the encrypted family archive independently of the SEJIRE interface.

SEJIRE does not mark preservation complete after receiving a transaction ID. It retrieves the raw archive again and verifies its integrity before showing completion.

### Browser cryptography: family-controlled recovery

The archive is encrypted before upload. The 12 recovery words stay with the family and are used locally to derive the decryption key and vault identifier.

## Architecture

```mermaid
flowchart LR
    A[Family tree in browser] --> B[AES-GCM encryption]
    B --> C[Encrypted vault]
    C --> D[Solana Devnet payment]
    D --> E[Strict payment verification]
    E --> F[Arweave Mainnet upload]
    F --> G[Raw retrieval + integrity checks]
    G --> H[Permanent encrypted archive]
    R[12 recovery words] --> I[Local key derivation]
    H --> J[Multi-provider discovery]
    I --> K[Local decryption]
    J --> K
    K --> L[Recovered family tree]
```

More detail: [Architecture and trust boundaries](docs/colosseum/ARCHITECTURE.md).

## Product links

- Live protocol: https://azovskaya.github.io/sejire_arweave_solana/
- Recovery: https://azovskaya.github.io/sejire_arweave_solana/#/restore
- Published build provenance: https://azovskaya.github.io/sejire_arweave_solana/build-provenance.json
- Colosseum submission draft: [docs/colosseum/COLOSSEUM_SUBMISSION.md](docs/colosseum/COLOSSEUM_SUBMISSION.md)
- Judge demo guide: [docs/colosseum/DEMO_GUIDE.md](docs/colosseum/DEMO_GUIDE.md)
- Hackathon work log: [docs/colosseum/HACKATHON_WORKLOG.md](docs/colosseum/HACKATHON_WORKLOG.md)

## What existed before the hackathon

SEJIRE was an existing genealogy project before Crypto World's Fair.

The pre-hackathon product already included:

- the family-tree editor;
- ancestor views;
- PDF and JSON export;
- client-side encryption;
- recovery concepts;
- earlier Arweave and AO experiments.

The original source and import baseline are disclosed in [HACKATHON_WORKLOG.md](docs/colosseum/HACKATHON_WORKLOG.md).

## What was built during the hackathon

The hackathon work added and hardened:

- Solana browser-wallet payment;
- deterministic payment references;
- strict finalized-payment verification;
- lost-response reconciliation and duplicate-payment prevention;
- the Preservation V2 state machine;
- real encrypted Arweave Mainnet preservation;
- post-upload raw-data verification;
- clean-browser recovery from 12 words;
- multi-provider and multi-gateway recovery;
- version-head and fork handling;
- password-protected admin diagnostics;
- network-based Arweave and Solana admin overview;
- public deployment, provenance, and extensive browser tests.

Only work completed during the contest period is presented as hackathon work.

## Team

**Alexey Azovsky** — co-creator and adult team leader.

**Alisa Azovskaya** — co-creator and English-language presenter, age 15.

SEJIRE is a father-and-daughter project from Kazakhstan, created from a shared goal: family history should not depend on one device, account, or company.

> Colosseum participation by a minor requires case-by-case approval. The team must obtain written confirmation from Colosseum before listing Alisa as an official entrant.

## Run locally

Requirements:

- Node.js `22.12+`
- npm
- Git

```bash
git clone https://github.com/azovskaya/sejire_arweave_solana.git
cd sejire_arweave_solana
git checkout feat/preservation-v2-simple

npm ci --prefix apps/web
npm ci --prefix apps/sponsor

npm test
npm run lint --prefix apps/web
npm run native:build
```

Run the web client:

```bash
npm run dev --prefix apps/web
```

The automated test suite uses synthetic data and mocked wallets. It does not spend SOL, sign with the owner's wallets, or publish a new family archive.

## Verification

The release gate includes:

- TypeScript and lint;
- unit and protocol tests;
- Solana payment validation;
- Preservation V2 browser tests;
- admin-login browser tests;
- 22 clean-browser recovery scenarios;
- multi-gateway fallback;
- no-wallet/no-write recovery checks;
- public deployment smoke tests;
- build-to-published-SHA provenance.

Key technical documentation:

- [Preservation V2](docs/PRESERVATION_V2.md)
- [Resilient recovery ADR](docs/adr/0009-resilient-vault-recovery.md)
- [Solana preservation](docs/SOLANA_PRESERVATION.md)
- [Security policy](SECURITY.md)

## Privacy and limitations

- Draft family data is stored locally in the browser and is not encrypted until the user creates the protected archive.
- The encrypted payload and limited technical metadata are public on Arweave.
- Solana wallet activity is public; SEJIRE does not claim payment anonymity.
- Losing the 12 recovery words can make the archive impossible to decrypt.
- The current payment uses Solana Devnet and is not production revenue.
- One owner-run pilot proves the technical path, not external demand.
- Shared family access, inheritance recovery, and mainnet settlement remain future work.
- The static admin password gate protects the interface only; wallet signatures remain required for critical wallet operations.

## Repository map

| Path | Purpose |
|---|---|
| `apps/web` | React/TypeScript family-tree client, encryption, payments, preservation, and recovery |
| `apps/sponsor` | Earlier service and checkout components retained for protocol development |
| `packages/checkout` | Payment amounts, orders, and state models |
| `packages/schema` | Family-tree and archive schemas |
| `ao` | Earlier AO protocol experiments |
| `docs/colosseum` | Submission, demo, work-log, and review materials |
| `docs/verification` | Reproducible technical evidence |
| `presentation` | Earlier presentation assets |

## License

MIT. See [LICENSE](LICENSE).

---

**SEJIRE — Pay with Solana. Preserve on Arweave. Recover with 12 words.**
