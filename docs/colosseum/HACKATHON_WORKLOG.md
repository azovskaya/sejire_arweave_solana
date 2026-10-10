# SEJIRE — Hackathon work log and prior-work disclosure

This document separates pre-existing SEJIRE work from work completed during Colosseum Crypto World's Fair 2026.

## Official contest period

September 14, 2026, 6:00 AM PT — October 12, 2026, 11:59 PM PT.

Only work completed during that period should be judged as hackathon work.

## Pre-existing project baseline

SEJIRE existed before the hackathon.

Original project:

- Repository: `https://github.com/azovskaya/Sejire_arweave`
- Source commit: `22084ac99b69bf3971c3ed75626074ba9a04d078`

Imported into this repository:

- Import commit: `37a1a230934e0bbd9cecb2beb4531c542ab1b5a4`
- Exact imported tree: `f2d8a4b42e0e628360a72fcb6180e3f98d70e19b`

Pre-existing capabilities included:

- family-tree editor;
- ancestor views;
- PDF and JSON export;
- browser-side encryption;
- recovery concepts;
- earlier Arweave and AO code;
- earlier mock/Kaspi/Turbo service experiments.

The team does not claim that these capabilities were built during Crypto World's Fair.

## Hackathon contribution

### Solana payment and verification

Built or hardened during the contest:

- Phantom-compatible payment flow;
- exact `0.03 SOL` Devnet preservation policy;
- deterministic preservation reference;
- finalized transaction verification;
- exact payer, recipient, amount, and reference checks;
- unexpected-transfer rejection;
- multi-RPC discovery;
- lost-wallet-response reconciliation;
- duplicate-payment prevention.

Evidence:

- `apps/web/src/lib/preserveV2/solana.ts`
- `apps/web/src/lib/preserveV2/verify.ts`
- `apps/web/src/lib/preserveV2/machine.ts`
- `apps/web/src/lib/preserveV2/v2.selftest.ts`

### Arweave preservation

Built or hardened during the contest:

- Arweave Mainnet quote and reserve checks;
- exact encrypted archive binding;
- Wander signing boundary;
- signed transaction persistence;
- interrupted-upload resume;
- confirmation checks;
- raw archive retrieval;
- byte-size, SHA-256, and vault-ID verification.

Evidence:

- `apps/web/src/lib/preserveV2/arweave.ts`
- `apps/web/src/lib/preserveV2/machine.ts`
- `docs/PRESERVATION_V2.md`

### Independent recovery

Built or hardened during the contest:

- clean-browser recovery using only 12 words;
- multiple discovery providers;
- dynamic and fallback Arweave gateways;
- raw metadata and data verification;
- authenticated local decryption;
- tree validation;
- version-head resolution;
- fork preservation;
- no-wallet and no-write recovery path.

Evidence:

- `apps/web/src/lib/recovery/`
- `apps/web/tests/preservation-v2-recovery.spec.mjs`
- `docs/adr/0009-resilient-vault-recovery.md`

### Admin and release verification

Built or hardened during the contest:

- portable static admin-password verifier;
- admin diagnostics;
- read-only Arweave and Solana network overview;
- exact build provenance;
- verified-artifact deployment;
- public browser smoke tests.

Evidence:

- `apps/web/src/lib/opsDesk/`
- `apps/web/src/components/AdminDesk.tsx`
- `.github/workflows/checks.yml`
- `.github/workflows/pages.yml`
- `scripts/pages-native-artifact.mjs`
- `scripts/verify-public-root.mjs`

## Current public proof

Public protocol:

`https://azovskaya.github.io/sejire_arweave_solana/`

Published build provenance:

`https://azovskaya.github.io/sejire_arweave_solana/build-provenance.json`

Current verified release at the time of this document:

- source commit: `26f8a803d80c4474499f6fbe2f28374784408efb`
- successful CI run: `37923843733`
- verified build artifact: `11612853055`
- successful Pages run: `37931319575`

Observed public network state:

- one Arweave family-vault save;
- one verified finalized Solana Devnet preservation payment;
- service amount: `0.03 SOL`.

## Test evidence

The release gate includes:

- TypeScript;
- lint;
- unit and protocol tests;
- Preservation V2 browser suite;
- admin browser suite;
- 22 recovery browser scenarios;
- no-wallet and no-write recovery tests;
- public Arweave read checks;
- public Solana read diagnostics;
- root Pages browser smoke;
- source-to-published SHA provenance.

## Honest limitations

- The full pilot was run by the owner, not by external customers.
- Product-market fit and willingness to pay are not established.
- The current service payment is on Solana Devnet.
- The archive is encrypted, but wallet activity and technical metadata are public.
- Losing the recovery words may make the archive impossible to decrypt.
- Shared family access and inheritance recovery remain future work.
- The admin password is a static client-side gate, not server authentication.
