# Preservation V2 pilot

Branch: `feat/preservation-v2-simple`. The V2 user path is enabled in the native build by `VITE_PRESERVATION_V2_ENABLED=1`; local route: `http://127.0.0.1:5173/#/save`. Old NativeJob, orders, config, successor and recovery records remain historical and are never read by V2.

## Path and binding

1. Import the original encrypted backup file (or supply the matching encrypted envelope from the editor). V2 checks raw file size/SHA, serialized envelope size/SHA and vault ID before creating a session.
2. `saveId = SHA-256(policy version, vault ID, archive SHA, payer)`; reference is derived from `saveId`. Both remain stable across retries. The ciphertext and state live in the separate `sejire-preservation-v2` IndexedDB database. The one cross-tab lock is `sejire-preservation-v2-{saveId}`.
3. `READY → SOLANA_PREPARED → SOLANA_PENDING → SOLANA_PAID`: persist blockhash and reference before one Phantom `signAndSendTransaction` prompt. Verify a finalized devnet transaction with the expected payer, signer, reference and exactly one 30,000,000 lamport transfer to the service treasury. ComputeBudget limit/price instructions are permitted within fixed bounds; all other instructions and inner effects are rejected.
4. A lost Phantom response stays pending. On reload V2 scans the reference. A replacement blockhash is allowed only when two independent devnet readers report complete history, no transaction and finalized height beyond the old expiry. Any RPC outage or pruned history blocks a new prompt. The service charge is 0.03 devnet SOL; network fee is separate. The pilot fund transfer is zero.
5. `AR_READY → AR_SIGNED → AR_UPLOADING → AR_PENDING_CONFIRMATION → COMPLETE`: after finalized SOL, quote Arweave Mainnet and check the exact reserve, 28,365 byte archive, SHA and 4,000,000,000 winston ceiling. Show exact current reward before Wander. Persist exact signed transaction and ID before upload. On timeout/reload only those signed bytes are resumed; a lost signing response without persisted bytes blocks re-signing.
6. After upload, require confirmed inclusion, retrieve the encrypted payload from a public gateway, compare size and SHA-256 and parse the envelope with the expected vault ID. Only then show Complete. Recovery words are entered locally on the separate restore screen after completion.

The UI shows only Payment, Preservation and Complete. `#/admin` in the V2 build is read-only public metadata, with no legacy operator actions or archive bytes. It never requests wallet seed phrases, wallet private keys or SEJIRE words during payment/upload. This pilot is bound to the one archive, payer and reserve approved by the owner. No real SOL/AR action is part of automated tests or CI.

## Verification and limitations

`npm run test:v2 --prefix apps/web` runs synthetic policy, Solana verifier, reference recovery, state-machine and upload-resume scenarios. `npm run test:v2-browser --prefix apps/web` tests the V2 browser route with no wallet call. Full release gate is the `SEJIRE checks` GitHub workflow on this feature branch: tests, TypeScript, lint, browser, native build, dependency boundary and retained `native-admin-build` artifact. Pages publication is a separate owner decision.

The IndexedDB journal is local to the browser profile. Starting the same save on another device without carrying a verified V2 record is unsafe and is not an authorized pilot recovery method. The owner must manually perform the real Phantom and Wander acceptance; the synthetic tests do not prove extension behavior or real settlement.
