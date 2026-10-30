# SEJIRE resilience continuation

Updated 2026-10-30. This records evidence separately from intentions. Mainnet recipients, 0.03 SOL price, paid AR budget (1 AR / 0.01 AR per order), promo budget (13 AR), signer, and existing browser attempt were not changed.

## 1. Solana payment access — released

- Public Pages build is source `2bd3ad4880e920d176c19925e743847050244514`, full checks `41020132835` SUCCESS, accepted artifact `12961536896`, release `41051026567` SUCCESS. Public `build-provenance.json` and the loaded JS were checked over HTTPS. The production Worker deployment `41020132824` succeeded. The RPC code had already been deployed and checked at `550ae6d3da886726b3502df4d3df509992e85638`; the later release preserves its payment configuration.
- The original public Solana RPC returned HTTP 403 from Cloudflare. Pocket's keyless endpoint passed read-only checks from the deployed SEJIRE Worker. From a browser on the public Pages origin, production Worker `/api/checkout/rpc-health` returned HTTP 200, `ready:true`, and all ten method calls: `getGenesisHash`, both recipient `getAccountInfo` calls, `getLatestBlockhash`, `getFeeForMessage` on an unsigned synthetic message, `getBalance`, `getBlockHeight`, `getSignaturesForAddress`, `getSignatureStatuses`, and `getTransaction`. `/policy` returned HTTP 200 and `ready:true` in the same browser run `41051095582` (SUCCESS). No production order or payment was made for these checks. Command-line requests from this Mac received Cloudflare error 1010 before Worker response; the browser-origin result is the relevant acceptance evidence.
- Configured server RPC URLs can be replaced; failed endpoints pause and retries are bounded. Browser uses public RPC URLs only and preserves signed bytes. Only one operator (Pocket) is proven accessible from Cloudflare and the public browser currently. Multiple URL results are provider evidence, not a cryptographic proof of transaction inclusion. A self-hosted Solana RPC or PATH remains an option, subject to operation and access policy.
- Existing local paid attempt is untouched. The owner has reported an order screen with 0.03 SOL and a still-checking fee; that screen alone does not prove a successful payment. No wallet signature was requested by our diagnostics.

## 2. Recovery — checked and released on Pages

- `feat/recovery-independent` adds portable network recovery from 12 words plus optional known archive IDs, using the current derivation/encryption code and interchangeable Arweave gateways. It writes locally readable, owner-only output. Existing local encrypted backup recovery remains offline and needs neither Worker nor wallet.
- A missing index page, unavailable index, unverifiable version, or missing parent now marks history as incomplete. The UI retains verified trees and versions and warns instead of presenting a partial set as complete. Synthetic tests exercise known-ID recovery without the SEJIRE server and offline local backup. Full SEJIRE checks `41020132835` passed, including recovery browser and portable continuation tests. The published Pages source is the same checked commit.
- Public archive format and recovery instructions remain in `docs/PROTOCOL_CONTINUATION.md`. The twelve words, bearer token, and plaintext family data are never sent to Solana RPC or Arweave gateways by the CLI.

## 3. Static Arweave release — prepared, not uploaded

- `scripts/prepare-permaweb.mjs` copies the static build with relative assets, a fallback route, source SHA and SHA-256 manifest into `.cache/permaweb-release`. CI checked this and preserved artifact `12961715818` from run `41020132835`. No Arweave transaction or ArNS update has occurred.
- A preliminary read-only 4,080,953-byte single-blob quote from `arweave.net/price` was 60,101,978,646 winston (about 0.0601 AR). The final release price must be quoted for its actual bytes and packaging before owner approval. Moving the UI does not move the Worker or its order ledger; active payments remain on the original browser origin.

## 4. Replaceable server — synthetic candidate only

- A Node 22 Linux/SQLite adapter reuses the existing checkout, fund, recipient admin, and Durable Object ledger classes. It requires a single writer lock and a dedicated database. Synthetic HTTP tests cover idempotent creation with the same token/key, restart, and writer exclusion; full checks `41020132835` passed. This is not a production migration or a second live executor.
- Fund signing, paid obligations, execution, and admin control remain centralized. Never run a second independent ledger or executor with the same live treasury key. No live database is migrated automatically.

## Next gate

The single next owner action, when ready to test a real payment, is to continue the existing browser attempt through its own status/fee preparation screen and review the exact wallet transaction before approving it. Do not cancel or replace it merely for diagnostics. First real Phantom/Solflare approval and payment have not been performed or verified. Arweave publication needs a separate owner approval of a specific release and its final quote. Independent operation still needs another permitted RPC operator or self-hosted node; only Pocket has production/browser evidence here.
