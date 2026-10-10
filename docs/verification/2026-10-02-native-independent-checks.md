# Native-path independent checks — 2026-10-02

This is a development/Pages check, not production payment acceptance. Mainnet payments, Arweave broadcast and configuration publication remain disabled. No Cloudflare deployment or ArNS change.

## Cold checkout failure

The failure was reproduced on a fresh Ubuntu runner at `5ad13d6`, run 36975358930. The retained Playwright trace shows two document requests (06:50:34.313 and 06:50:37.540 UTC), two Vite connections and a changed optimized-dependency hash. Opening the lazy checkout discovered dependencies and triggered Vite's full reload; the modal disappeared, rather than merely taking longer to render. No page exception was reported. Diagnostic ZIP SHA-256: `cd37dfa5386d94bdda03d4c41d577e4953e8679944f00352bd94ec614494c3f2`.

Build-time `@sejire/payment-panels` selection uses the actual native or legacy components. It removes the cold lazy-import reload and excludes legacy payment imports from native mode. Legacy sources and old receipt parsers remain. Assertions and the 5000 ms timeout are unchanged. A separate test-fixture correction distinguishes rejection of an order/message signature from rejection of a transaction signature; both scenarios remain tested.

## Dependency review

Installation, production audit and emitted native chunks are separate evidence. `native-security-boundary/bundle.json` records installed versions, parsed modules and rendered modules in every chunk, including dynamic chunks. Browser checks independently reject Turbo/cloud checkout requests and test signers are forbidden in product chunks.

Read-only production audit on 2026-10-02 after patch overrides: web **24 findings (5 high, 6 moderate, 13 low, 0 critical)**; sponsor **13 low, 0 high/critical**. Audit remains FAIL and existing CI audit policy was not changed.

| Package / finding | Dependency path and use | Reachability evidence | Action / remaining risk |
|---|---|---|---|
| secp256k1 GHSA-584q-6j8j-r5pm | legacy arbundles → secp256k1/Ethers; ECDH / secp signing | Native uses Ed25519 and Arweave RSA-PSS, not ECDH; emitted-module boundary checks exclusion | Compatible 5.0.0 → 5.0.1 patch in both locks; elliptic advisory below remains |
| ws high DoS advisories | legacy Ethers providers → ws 7 | Native browser transactions use fetch / WebCrypto; no WebSocket server | 7.5.11 override, retained newer compatible ws 8; no blanket dependency upgrade |
| bigint-buffer GHSA-3gc7-fjrx-p6mg | web3 / SPL → bigint-buffer 1.1.5 | The all-chunk report contains **zero bigint-buffer modules**. Local devnet runner explicitly loads web3 browser IIFE. No `.node` module is permitted in native browser output | No compatible published fix. Installed package remains high; Node addon/server paths are not certified by browser evidence |
| @solana/buffer-layout-utils, @solana/spl-token, @ardrive/turbo-sdk propagated high | legacy SPL/Turbo → bigint-buffer | SOL-first templates contain native System transfers; native graph rejects SPL/Turbo packages | Legacy dependencies preserved; not claimed globally safe or removed from monorepo |
| node-forge GHSA-86w9-cpqp-85rv | legacy deterministic Arweave key derivation → node-forge 1.4.0; bundled RSA utilities | Existing `arweave/wallet.ts` calls key generation, not PKCS#1 v1.5 verification. Native format-2 verify uses SDK browser `WebCryptoDriver`, RSA-PSS and fixed e=65537. Signature/tamper regressions remain | **No official patched release**. Vulnerable package/code remains; current path does not invoke the affected verifier. Audit not waived; revisit before wider crypto/SDK use |
| elliptic GHSA-848j-6mx2-7j84 (low), stream-json GHSA-528h-pc64-c93x (moderate) | legacy Ethers/arbundles and Turbo stream handling | stream-json has zero emitted modules. **elliptic has 16 emitted modules**, through crypto-browserify/polyfills; not excluded and not declared safe. Current SOL signatures use Noble Ed25519, native Arweave signatures use WebCrypto RSA-PSS | elliptic low finding remains in the native bundle; no current ECDH invocation is established, but wider use needs review. Legacy risks remain; no blind SDK replacement |
| uuid GHSA-w5hq-g745-h8pq (moderate) | web3 → jayson → uuid | Advisory concerns v3/v5/v6 with an output buffer, not all uuid calls | Not declared closed; retain as a dependency limitation |

Primary advisories: [secp256k1](https://github.com/advisories/GHSA-584q-6j8j-r5pm), [bigint-buffer](https://github.com/advisories/GHSA-3gc7-fjrx-p6mg), [node-forge](https://github.com/advisories/GHSA-86w9-cpqp-85rv).

## Direct Arweave preparation

Synthetic vault: two trees, parent/child links and version history. Existing AES-GCM envelope and portable backup; offline decryption/restore passed. Recovery words/private test data remain outside Git. Ciphertext: **5149 bytes**, SHA-256 `83e322b971c1163c6c038f49e09ad7239be396e24150f925a44aaa7916b49b1e`.

Only ciphertext and public tags would be published: Content-Type=application/json, App-Name=SEJIRE, Protocol=sejire/v0.3, Type=vault-envelope, Envelope-SHA256=digest. Compatible signer: Wander SIGN_TRANSACTION. No approved public AR reserve yet. Quote is size-based read-only Arweave mainnet `/price`, not Turbo. A fresh quote, approved AR address/budget and separate owner signature/spend approval are required before broadcast. No actual Arweave signature, upload, receipt or settlement in this check.

## Live Solana devnet probe and restart

Only the approved disposable payer and two approved recipients were used. `public-results.json`/operation files remain outside Git; the public-only evidence snapshot is [native-devnet-public.json](2026-10-02-native-devnet-public.json). Saved operation files contain exact signed bytes and signatures before broadcast, never the keypair. Rerunning the local process reuses signatures and reads finalized RPC results; it does not sign or broadcast a new payment.

Payer `Hn9ELgjKXrb7svZM9XtDYozGTirxo5e1tWRy1J1v4vwF`. Service `ETWcxNPF3Qcwvo4NHYw6JhMiKnGwrvH1U9YEAQ3rZSWd`. Fund `Gy3SSxP7spgDcserSfMckPd73LeSoxdrvXeNap7huLQN`. Initial finalized balance **998506560 lamports**, final **928491560**, total spent **70015000 = 0.070015 devnet SOL**, including three fees of 5000 lamports. Overall authorized run cap remains 200000000 lamports, not reset on interruption.

| Scenario | Service lamports | Fund lamports | Fee | Finalized transaction |
|---|---:|---:|---:|---|
| A | 30000000 | 0 | 5000 | [mkFCDSqaRrVB…](https://explorer.solana.com/tx/mkFCDSqaRrVBdhqiNqs7Wp8jY9T3RxppqB4LhQURCpiEkc9B3EL95T9kDrbbWagATTBdD4owQqccTekQu3Bvfqh?cluster=devnet) |
| B | 30000000 | 5000000 | 5000 | [B8jxxE1SNB4d…](https://explorer.solana.com/tx/B8jxxE1SNB4d7PpxLrTW1c7tzatAX8a7Qrev5wLEBFu5v3M2YunfgymumrymLDiNpGYWdcaAMuNfv9KkaHdnSGM?cluster=devnet) |
| C | 0 | 5000000 | 5000 | [4F1KFHF9Mypo…](https://explorer.solana.com/tx/4F1KFHF9MypoVn2XqVu4Hhy7CTnf9sBX5TefRXAhjFfXZJdiVGdBo5NchPbLkDBpkWVwMAbrkSK8oFXrVx4dZyL1?cluster=devnet) |

Actual network evidence was checked by existing `verifyPaymentRpc`/decoder/validator: devnet genesis, finalized status, matching signature, successful execution, fee payer/signer, reference, expected recipients and exact amounts. No extra transfers. Reconciliation returned credited once / already-credited on repeat. Local fresh-process replay uses saved evidence and MemoryAtomicOrderStore; **this alone does not prove durable SQLite storage**. The existing Ubuntu SQLite test adds offline replay of these public real-network records into the actual disk-backed adapter, concurrent confirmation and a separate Node/workerd process reopening the database. That CI evidence is distinct from real RPC observation and from cloud guarantees.

The probe intentionally tests transfers/validator separately: no AR reserve or live executor is approved, so it does not bypass native storage readiness or claim a paid service was fulfilled. **Storage NOT RUN**; no Arweave receipt/ID/settlement. Phantom/Wander extension acceptance NOT RUN. AO remains blocked; no live AO claim.

Read-only direct quote refreshed **2026-10-02T07:14:43.204Z**: **3295008643 winston = 0.003295008643 AR** for 5149 bytes, `https://arweave.net`. Price must be re-quoted before owner approval; it is not an exchange rate or automatic SOL→AR.
