# SEJIRE resilience continuation

Updated 2026-10-30. This records evidence separately from intentions. Mainnet recipients, 0.03 SOL price, paid AR budget (1 AR / 0.01 AR per order), promo budget (13 AR), signer, and existing browser attempt were not changed.

## 1. Solana payment access — released

- Feature branch `feat/promo-funded-preservation` at `550ae6d3da886726b3502df4d3df509992e85638`. Public Pages build is source `e5f56e315f3e0c61f5fb53d39082316918f38da1`, checks `41014786417`, artifact `12959297067`, release `41015828066`. Worker deployment run `41016312496` succeeded; version `15e1df33-3af0-4518-bda9-38e6edb14c90`.
- The original public Solana RPC returned HTTP 403 from Cloudflare. Pocket's keyless endpoint passed read-only checks from the deployed SEJIRE Worker: `/api/checkout/rpc-health` returned `ready:true` for `getGenesisHash`, both recipient `getAccountInfo` calls, `getLatestBlockhash`, `getFeeForMessage` on an unsigned synthetic message, `getBalance`, `getBlockHeight`, `getSignaturesForAddress`, `getSignatureStatuses`, and `getTransaction`. Browser-origin read-only requests to Pocket also succeeded. No production order or payment was made for these checks.
- Configured server RPC URLs can be replaced; failed endpoints pause and retries are bounded. Browser uses public RPC URLs only and preserves signed bytes. Only one operator (Pocket) is proven accessible from Cloudflare and the public browser currently. Multiple URL results are provider evidence, not a cryptographic proof of transaction inclusion. A self-hosted Solana RPC or PATH remains an option, subject to operation and access policy.
- Existing local paid attempt is untouched. The owner has reported an order screen with 0.03 SOL and a still-checking fee; that screen alone does not prove a successful payment. No wallet signature was requested by our diagnostics.

## 2. Recovery — candidate branch, awaiting checks/publication

- `feat/recovery-independent` adds portable network recovery from 12 words plus optional known archive IDs, using the current derivation/encryption code and interchangeable Arweave gateways. It writes locally readable, owner-only output. Existing local encrypted backup recovery remains offline and needs neither Worker nor wallet.
- A missing index page, unavailable index, unverifiable version, or missing parent now marks history as incomplete. The UI retains verified trees and versions and warns instead of presenting a partial set as complete. Synthetic tests exercise known-ID recovery without the SEJIRE server and offline local backup.
- Public archive format and recovery instructions remain in `docs/PROTOCOL_CONTINUATION.md`. The twelve words, bearer token, and plaintext family data are never sent to Solana RPC or Arweave gateways by the CLI.

## 3. Static Arweave release — prepared, not uploaded

- `scripts/prepare-permaweb.mjs` copies the static build with relative assets, a fallback route, source SHA and SHA-256 manifest into `.cache/permaweb-release`. CI checks this and preserves an artifact. No Arweave transaction or ArNS update has occurred.
- A preliminary read-only 4,080,953-byte single-blob quote from `arweave.net/price` was 60,101,978,646 winston (about 0.0601 AR). The final release price must be quoted for its actual bytes and packaging before owner approval. Moving the UI does not move the Worker or its order ledger; active payments remain on the original browser origin.

## 4. Replaceable server — synthetic candidate only

- A Node 22 Linux/SQLite adapter reuses the existing checkout, fund, and Durable Object ledger classes. It requires a single writer lock and a dedicated database. Synthetic HTTP tests cover idempotent creation with the same token/key, restart, and writer exclusion. This is not a production migration or a second live executor.
- Fund signing, paid obligations, execution, and admin control remain centralized. Never run a second independent ledger or executor with the same live treasury key. No live database is migrated automatically.

## Next gate

Run the complete checks for the candidate branch, fix any failures, then publish only accepted frontend/backend components through the existing release flow. After publication, recheck the public build and Worker independently. The first real Phantom/Solflare approval and payment belong to the owner; do not trigger them through automated verification.
