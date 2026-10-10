# Web dependency risks — A2.1

Checked 2026-09-30. Baseline production audit: 0 critical, 8 high, 6 moderate, 10 low. Findings count includes parent propagation, not 24 distinct exploits. No web dependency versions, crypto or SDK changed in this stage; no audit fix --force. CI continues to expose audit's own exit 1. Do not infer safety from a transitive dependency or Node/browser label.

Evidence: apps/web/package-lock.json; docs/verification/2026-09-30-web-production-audit.json; apps/web/src/lib/solana/client.ts (Turbo/web, PublicKey), upload.ts (Turbo SDK), apps/web/vite.config.ts (browser alias/polyfills). scripts/dependency-reachability.mjs builds the actual devnet browser target and records module inclusion/rendered code in `.cache/a2-1/browser-dependency-reachability.json`, uploaded as CI artifact. Bundle presence is evidence of shipping, not of an exploit call; a renderedLength=0 module may be removed. Stock CI completed this module graph check on source SHA dad4fd7; its JSON is preserved as 2026-09-30-browser-dependency-reachability.json. Function-level dynamic exploit/taint verification remains NOT RUN.

| Package / advisory | Dependency path | Application use | Reachability in target scenario | Evidence | Action |
|---|---|---|---|---|---|
| bigint-buffer 1.1.5, GHSA-3gc7-fjrx-p6mg, native toBigIntLE overflow | Turbo → SPL Token → buffer-layout-utils → bigint-buffer | SDK token/account amount utility; new RPC decoder does NOT import it | Exact build renders only dist/browser.js; inspected lines 10–20 return JS BigInt after Buffer copy/reverse, before unreachable converter call. Native advisory path is not observed here; other environments and resource exhaustion are not cleared | Lock node, advisory, bundle module/sourceMatches (CI) | Trace source inputs/length guards and native consumers before live use; no patched release in advisory. SDK replacement needs approval |
| secp256k1 5.0.0, GHSA-584q-6j8j-r5pm, ECDH key extraction | arbundles → secp256k1; Turbo also pulls arbundles | Multichain signer code; SEJIRE Solana flow uses wallet Ed25519 | Three secp256k1 elliptic modules rendered, including ECDH entry at lib/elliptic.js:370 and lib/index.js:312. ECDH use from the Solana path not proved absent | Lock; advisory; client/upload signer choice; bundle matches ecdh | Audit ECDH consumers/private-key inputs; do not downgrade signer library or claim wallet safety without proof |
| ws 7.4.6, GHSA-3h5v-q93c-6h6q / GHSA-96hv-2xvq-fx4p, headers/fragments DoS | arbundles → ethers/providers → ws | Multichain provider, not SEJIRE HTTP server; native browser WebSocket may be used | Exact browser graph contains zero ws modules and zero ethers/providers modules. No ws receiver/server path observed in this bundle; native/Node consumers remain separate scope | Lock, advisories, included/rendered ws modules | Consider compatible scoped ws 7.x patch only after native/browser regression tests; no blind global major override |
| stream-json 1.9.1, GHSA-528h-pc64-c93x, nested filter CPU DoS | web3.js → jayson → stream-json | web3.js RPC support; A2.1 reader uses bounded fetch + JSON.parse, no jayson | Zero stream-json modules in exact browser graph; jayson/lib/client/browser/index.js and generateRequest.js do render. No stream parser/filter path observed here; other Node consumers remain unresolved | Lock/advisory, module graph; A2.1 imports | Confirm browser exclusion and check Node consumers; no forced web3.js downgrade suggested by audit |
| uuid 8.3.2, GHSA-w5hq-g745-h8pq, v3/v5/v6 output buffer bounds | web3.js → jayson → uuid | RPC request id generation in dependency | 15 uuid browser modules render, including v3/v5/v35. Locked jayson 4.3.0 generateRequest.js:3,49 calls v4 without a caller output buffer; other SDK consumers of vulnerable v3/v5 remain unproven | Lock/advisory; installed sources and rendered uuid modules | Trace actual variant and buffer arguments; replace only compatible consumer path with regressions |
| elliptic 6.6.1, GHSA-848j-6mx2-7j84, implementation warning | ethers/signing-key and secp256k1 → elliptic; existing override 6.6.1 | Multichain EC crypto, distinct from AES-GCM/recovery | 16 elliptic modules render; source ec/key.js:101 includes ECDH. Crypto API/input reachability still not comprehensively established | Existing override, advisory, bundle graph, signer source | Independent crypto review/upstream plan; do not rewrite crypto within this substage |
| @ardrive/turbo-sdk; @solana/spl-token; @solana/buffer-layout-utils | Direct Turbo → SPL → utilities | Current direct upload/top-up path | Parent high findings propagate underlying risks above; SDK import is definitely used | client.ts/upload.ts, lock, module graph | Keep direct path and cap; upstream compatible mitigation and separately approved live acceptance |
| @solana/web3.js; @solana/spl-token-group; @solana/spl-token-metadata; jayson | Direct web3.js / Turbo → web3.js → jayson | PublicKey and transaction checks; SDK token helpers | Parent moderate findings; exact tree-shaken paths need module evidence | client.ts; lock; module graph | Separate browser/Node RPC consumers; no broad SDK replacement |
| @dha-team/arbundles; @ethersproject/providers | Direct arbundles/Turbo → providers/secp256k1 | Data-item construction and multichain code | Parent high risks; module presence does not authorize ECDH/server use | lock, upload.ts, bundle graph | Review signer surface and provider selection; preserve format compatibility |
| @ethersproject/abstract-provider, abstract-signer, hash, hdnode, json-wallets, signing-key, transactions, wallet, wordlists | arbundles → ethers family → elliptic/providers | SDK Ethereum machinery, not requested family archive secrets | Parent low findings. Must not treat apparently unused machinery as safe merely because product selects Solana | Audit via chains; per-package module graph | Trace exported/called methods and secrets path; remove only via reviewed upstream/build change |

Advisories checked from authoritative GitHub reviewed database:
- https://github.com/advisories/GHSA-3gc7-fjrx-p6mg
- https://github.com/advisories/GHSA-584q-6j8j-r5pm
- https://github.com/advisories/GHSA-3h5v-q93c-6h6q
- https://github.com/advisories/GHSA-96hv-2xvq-fx4p
- https://github.com/advisories/GHSA-528h-pc64-c93x
- https://github.com/advisories/GHSA-w5hq-g745-h8pq
- https://github.com/advisories/GHSA-848j-6mx2-7j84

New test-tool dependencies separately: pinned Miniflare v4 has vulnerable sharp/undici dependencies at its original pins. Scoped patch overrides sharp 0.35.4 / undici 7.29.1 remove npm findings in lock resolution; Ubuntu clean install/runtime verifies compatibility. They are dev-only, not sponsor production code or browser SDK. Sponsor full audit after resolution: 0 findings locally; CI must reconfirm. No force-fix performed. Native runtime not run on Catalina.

Release gate remains OPEN: static bundling evidence narrows scope but does not constitute a full security review. No real payment or publication is authorized by a green functional CI.


Measured static evidence (source SHA dad4fd7, browser SDK/config unchanged):

| Package | Included modules | Modules with rendered code |
|---|---:|---:|
| bigint-buffer | 1 | 1 |
| secp256k1 | 3 | 3 |
| elliptic | 16 | 16 |
| uuid | 15 | 15 |
| jayson | 2 | 2 |
| ws | 0 | 0 |
| stream-json | 0 | 0 |
| ethers/providers | 0 | 0 |
| Turbo SDK | 36 | 34 |
| arbundles | 45 | 39 |
| SPL Token | 130 | 7 |

All 24 baseline audit entries have per-package paths in the preserved JSON. Sources of exactly locked bigint-buffer 1.1.5, secp256k1 5.0.0, uuid 8.3.2 and jayson 4.3.0 were read from npm tarballs without executing their scripts; this corroborates the module paths/API calls above. ECDH and uuid v3/v5 callers still require function-level review. No web finding was suppressed or represented as fixed. The new RPC/SQLite backend code imports none of these packages. New sponsor test-tool patches passed clean CI install, SQLite tests and full audit (0 findings).
