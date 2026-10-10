# A1 order/payment foundation

Pure TypeScript money/order/state modules. No checkout, RPC client, signing, UI, payment collection or mainnet action. Existing direct Turbo/Solana integration is unchanged.

- `amounts.ts`: decimal → integer exact parsing, native u64 limits, no contribution business cap. Large-amount confirmation is a predicate, not a rejection.
- `order.ts`: immutable trusted server order; explicit service/contribution recipients, asset policy, payer/reference/time/policy version. Preservation binds SHA-256 of exact serialized envelope and its byte size. Contribution-only has zero service payment, positive contribution and no archive requirement. No default 512 KiB policy.
- `states.ts`: payment, contribution and fulfillment remain distinct. `ready` means eligible to start preservation, not uploaded/settled.
- Sponsor `paymentValidator.ts`: normalizes nothing; validates trusted decoded evidence against an order. A1 accepts the simple template, rejects extra transfers and duplicate instruction locators. Fake asset/mint/program/decimals, wrong recipient/sender/reference/amount and non-finalized evidence fail closed. Fee in lamports is separate, never attributed as a contribution.
- `reconciliation.ts`: records signature before invoking injected reader; absent/failed/pending/invalid evidence stays unresolved. No path constructs, signs or replaces a transaction. Service expiry is checked at on-chain inclusion, not later reconciliation time; late payments require manual resolution, not disappearing money.
- `store.ts`: atomic contract and TEST-ONLY memory adapter, detached snapshots and at-most-once credit in one isolate. Allocation is per instruction; the conservative A1 template also forbids reuse of a transaction across orders. No persistent/production claim.

## Trust boundary

Order creation receives server-selected price/recipient/mint/expiry, not untrusted checkout input. Id and reference must be securely generated in the next server layer (shape validation does not prove entropy). The future RPC decoder must obtain configured cluster/genesis, resolve versioned loaded addresses, decode exact transfer and inner instruction paths, verify signer/authority and SPL source/destination mint/program/owners, distinguish token owner from token-account address, and obtain finalized metadata/time/fee. No raw RPC decoder is installed. Never feed HTTP client JSON into TransactionEvidence. No public route exists in A1.

Normalized synthetic fixtures are not blockchain proofs, and validation of digest shape is not proof of upload: the next upload executor must independently recompute digest/bytes from received envelope and use stored order binding. Backend, fund and donor must never receive decryption keys/recovery words. A1 stores no archive contents or wallet key material.

## Verification

CI Node 22: `npm run test:checkout`, `npm run check --prefix apps/sponsor`.
Local Catalina after sponsor install: `npm run test:checkout:local` uses a pure-JS TypeScript loader (no native esbuild). It transpiles only; `npm run check --prefix apps/sponsor` is the separate type check. Existing sponsor tests: `npm run sponsor:test:local`.

Required next proof: raw RPC adapter fixtures then approved real extension/devnet acceptance; restart/crash/multi-process persistence, duplicate callbacks and lost commit responses on real durable storage. The memory implementation has no restart durability, and memory guarantees do not transfer automatically to a database.
