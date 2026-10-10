# SEJIRE — Colosseum submission draft

Paste-ready English copy for Crypto World's Fair 2026. The owner will add the final public video URLs after upload.

## Product name

**SEJIRE**

## Tagline

**Pay with Solana. Preserve on Arweave. Recover with 12 words.**

## Brief description

SEJIRE is a decentralized protocol for creating, encrypting, preserving, and independently recovering family trees.

A family builds its tree without an account or wallet. When it chooses permanent preservation, SEJIRE encrypts the archive in the browser, verifies the preservation payment through Solana, stores the encrypted archive on Arweave, and allows recovery on a clean device using 12 words.

## Problem

Family history often depends on one device, one account, or one centralized platform.

A family may export a file, but it must still remember where that file is stored and how to open it years later. If the device, account, or platform is lost, the family may lose access to its own history.

The core problem is not drawing a family tree. It is making that tree independently recoverable.

## Solution

SEJIRE separates the family-tree interface from the preserved archive.

1. The family creates a tree without an account.
2. The archive is encrypted locally in the browser.
3. The user pays for preservation through Solana.
4. SEJIRE verifies the finalized payment and its exact recipient, payer, amount, and reference.
5. The encrypted archive is stored on Arweave.
6. SEJIRE retrieves the raw archive and verifies its integrity.
7. The family can recover the tree on a clean device using 12 words.

## Why Solana

Solana makes the preservation payment fast, practical, and verifiable.

SEJIRE uses Solana as the payment and coordination layer. It verifies the network, transaction finality, payer, recipient, exact service amount, and deterministic preservation reference.

Private family data is not written to Solana.

The current pilot uses Solana Devnet. Mainnet settlement is a future milestone, not a completed claim.

## Why Arweave

Arweave stores the encrypted family archive independently of the SEJIRE interface.

SEJIRE does not mark preservation complete after receiving a transaction ID. It retrieves the raw archive again and verifies its byte size, SHA-256 digest, and vault identity.

Only the encrypted archive and minimal technical metadata are public. Recovery words and plaintext family data are not uploaded.

## Blockchains and tools

- Solana Devnet
- `@solana/web3.js`
- Phantom-compatible browser-wallet flow
- deterministic payment reference
- finalized payment verification across public RPC endpoints
- Arweave Mainnet
- multi-gateway archive retrieval
- Web Crypto API
- AES-GCM encryption
- React
- TypeScript
- Playwright
- GitHub Actions and GitHub Pages

## Working proof

We completed one full owner-run technical pilot:

- created a family tree;
- encrypted it in the browser;
- verified a `0.03 SOL` payment on Solana Devnet;
- preserved the encrypted archive on Arweave Mainnet;
- opened SEJIRE in a clean browser;
- recovered the family tree using only the 12 recovery words.

The admin overview independently reads the Arweave save and verifies the finalized Solana payment through public read-only endpoints.

This proves the technical workflow. It does not yet prove product-market fit.

## Target user

The initial users are families that want to preserve genealogy and family stories independently of one device or platform.

The starting wedge is:

- Kazakh *shezhire* families;
- diaspora families;
- genealogy and family-history communities;
- families preserving an archive as a gift for future generations.

These customer segments still require external validation.

## Founder and insight

SEJIRE was created by Alexey Azovsky in Kazakhstan.

The project comes from a simple insight: families may last for generations, while the devices, accounts, and companies storing their history may not.

The protocol combines:

- a familiar family-tree experience;
- practical payment through Solana;
- encrypted archive storage through Arweave;
- family-controlled recovery through 12 words.

## Team

### Alexey Azovsky — official entrant and team lead

Alexey is the creator and developer of SEJIRE. He is an early-career software developer and a student at Tomorrow School. He graduated from the Faculty of Physics and Mathematics at Orenburg State Pedagogical University.

He leads SEJIRE's product design, protocol architecture, implementation, testing, and hackathon submission.

### Alisa Azovskaya — presentation and materials contributor

Alisa is Alexey's daughter. She helped prepare the Colosseum materials and record the English-language pitch and product-demo videos.

Alisa is credited for presentation and materials support and is not listed as an official Colosseum entrant.

### Location

Kazakhstan.

## Go-to-market

SEJIRE will begin with assisted onboarding, not broad paid advertising.

Initial distribution:

1. *Shezhire* and genealogy communities.
2. Diaspora and family-history groups.
3. Cultural organizations and archives.
4. Family-gift use cases, where one relative sponsors preservation for the wider family.

The first validation milestone is 10 external family sessions.

We will measure:

- completion of the first family tree;
- time to first preserved archive;
- successful recovery on another device;
- willingness to pay for preservation;
- referrals to another family.

## Demand validation

Current evidence:

- one complete owner-run technical pilot;
- a working public protocol;
- verified cross-network preservation and recovery.

Not yet established:

- external family usage;
- repeat usage;
- willingness to pay;
- customer acquisition cost;
- retention.

We will not present the technical pilot as customer traction.

## Business model

1. Free family-tree creation and local export.
2. One-time payment for encrypted permanent preservation.
3. Optional assisted family-archive preparation.
4. Future institutional plans for genealogy and cultural organizations.

The current `0.03 SOL` Devnet amount is a technical pilot policy, not validated production pricing.

## Differentiation

SEJIRE combines four behaviors in one user-controlled flow:

- create the family tree without an account;
- encrypt the archive before upload;
- verify the preservation payment through Solana;
- recover the archive from Arweave on a clean device using 12 words.

The strongest differentiator is not simply blockchain storage. It is **recoverability without depending on the original device or SEJIRE account**.

## Prior-work disclosure

SEJIRE existed before Crypto World's Fair.

Before the hackathon, the project included:

- family-tree editing;
- ancestor views;
- PDF and JSON export;
- client-side encryption;
- recovery concepts;
- earlier Arweave and AO experiments.

During the hackathon, the team built and hardened:

- Solana browser-wallet payment;
- exact finalized-payment verification;
- deterministic payment references;
- lost-response reconciliation;
- Preservation V2;
- real encrypted Arweave Mainnet preservation;
- raw archive integrity checks;
- clean-browser 12-word recovery;
- multi-provider and multi-gateway recovery;
- public deployment and browser-test coverage.

Exact source and import baselines are listed in `HACKATHON_WORKLOG.md`.

## Roadmap

### Next 30 days

- run 10 external family pilots;
- measure completion, recovery, and willingness to pay;
- improve onboarding based on observed failures;
- define production pricing from real storage and service costs.

### Next 90 days

- move the verified payment policy toward Solana mainnet;
- add safer family-sharing and recovery options;
- improve version history and multi-device workflows;
- publish the protocol under the permanent SEJIRE domain.

## Live links

- Product: https://azovskaya.github.io/sejire_arweave_solana/
- Recovery: https://azovskaya.github.io/sejire_arweave_solana/#/restore
- GitHub: https://github.com/azovskaya/sejire_arweave_solana
- Build provenance: https://azovskaya.github.io/sejire_arweave_solana/build-provenance.json
- Pitch video: pending owner upload
- Product demo: pending owner upload
- Logo: `docs/colosseum/assets/sejire-logo.svg`

## What we want from Colosseum

We want to turn a proven technical workflow into a validated company.

Colosseum can help us:

- reach external families and ecosystem partners;
- sharpen distribution and pricing;
- move from a Devnet pilot to production settlement;
- build a scalable protocol for family-controlled digital legacy.
