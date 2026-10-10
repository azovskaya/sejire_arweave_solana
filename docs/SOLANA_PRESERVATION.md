# Solana preservation implementation

> **01.10.2026 — активная цель: законченный devnet SOL-first checkout (0.03 SOL) и исполнение архива.** Начатый A2.2 сохранён и подключён к UI; старые ограничения отдельных этапов ниже исторические. Владелец разрешил код/CI/обычный push рабочей ветки. Preview/тестовый backend требуют отдельного согласования аккаунта, адресов и изолированного uploader signer; подписи выполняет владелец. См. [краткую точку продолжения](DEVNET_CHECKOUT_PREVIEW.md). Живой платёж и загрузка пока NOT RUN; sejire.ar.io/ArNS не изменялись.

> **30.09.2026 — A2.1:** владелец разрешил RPC decoder + постоянный SQLite Durable Object adapter и проверочный CI, без deploy/подписей/переводов. См. [границы и команды проверки](verification/2026-09-30-a2-1.md), [ADR 0008](adr/0008-solana-rpc-and-durable-ledger.md) и [таблицу web рисков](verification/2026-09-30-web-security-reachability.md). Штатный Ubuntu/Node 22 CI подтвердил 49 RPC и 14 реальных SQLite runtime сценариев, включая новый процесс и отсутствие повторного зачёта; на Catalina native runtime BLOCKED. Web audit остаётся FAIL; sponsor полный audit — 0 findings. Фактический окончательный SHA и CI-run сообщаются в заключении, не переносятся с прежнего SHA. Предыдущие запреты A2 ниже относятся к прежним этапам; текущий объём ограничен A2.1.

> **Фактический CI A0/A1:** commit `b04a0c5` отправлен; Ubuntu/Node 22 checks [36741938589](https://github.com/azovskaya/sejire_arweave_solana/actions/runs/36741938589) прошли. Полные тесты, TypeScript, lint, размеры и devnet build PASS; web audit FAIL (exit 1, 8 high/6 moderate/10 low), явно non-blocking. Подробности: [CI evidence](verification/2026-09-30-a0-a1-ci.md). Реальные платежи/расширение и persistent storage не проверены. Предыдущие статусы NOT RUN ниже относятся к историческому snapshot.

> **30.09.2026 — сохранение A0/A1 и штатный CI:** владелец разрешил commit/push только в `origin/feat/solana-preservation` и адресные исправления CI. Проверены совпадение историй после fetch, отсутствие repository webhooks, deploy только main/manual и Pages из gh-pages. Проверочный Ubuntu/Node 22 workflow включает отдельные install/test/typecheck/checkout/lint/measurement/devnet-build шаги; dependency audit явно non-blocking и сохраняет собственный неуспешный результат. На момент этой записи новый CI ещё NOT RUN; итоговый SHA/run нужно смотреть в GitHub Actions. Предыдущий отчёт ниже — исторический локальный snapshot. Реальные платежи и A2 не разрешены.

> **30.09.2026 — локальный A0/A1:** новая работа ещё не закоммичена и не отправлена; базовый HEAD `d76e2f5`, ветка `feat/solana-preservation`. См. [отчёт A0/A1](verification/2026-09-30-a0-a1-report.md). Владелец разрешил фундамент нового checkout; прежний direct Turbo-путь сохранён. Полное завершение A0 не заявлено: CI/настоящее расширение/оплаченный devnet требуют отдельной проверки.
>
> Этот Mac: Intel, Catalina 10.15.8, Node 18.20.7/npm 10.8.2. Node 22 и native esbuild здесь не поддерживаются штатно. Не менять ОС/глобальные инструменты/профиль Codex. Для доступных offline-проверок используется отдельный JS TypeScript loader; штатный Node 22 CI остаётся обязательным. Установка sponsor-зависимостей локальная; web-зависимости не устанавливались.

Updated: 2026-09-29. This is a testable prototype, not a completed production-payment certification.

## Decision and scope

Use SOL-funded Turbo uploads with a browser wallet. No Solana program, treasury private key, payment backend or SEJIRE token is required for this slice. Solana supplies payment/signing; Arweave supplies archival storage. This is not Solana Pay merchant checkout and does not charge an application fee.

Sources: [Turbo SDK](https://docs.ar.io/sdks/turbo-sdk), [testnet uploads](https://docs.ar.io/build/testnet/uploading-and-credits/), [testnet retrieval](https://docs.ar.io/build/testnet/accessing-data/), and installed `@ardrive/turbo-sdk` 2.1.0 source. The previous `OnDemandFunding` path was replaced: it can request funding before trying the free allowance.

## Implemented behavior

- `VITE_SOLANA_NETWORK` defaults to `devnet`. Explicit fixed RPC, payment-service and upload-service URLs prevent mixing the test/prod services.
- Phantom/Solflare connects only on a user click. A cloned adapter guards the public key before and after every signing request; the wallet extension object is not modified. It returns a real Solana `PublicKey`, including `toBuffer()` required by the SDK signer (missing in the earlier adapter).
- Existing `sejire/envelope/v1`, `sejire/v0.3`, AES-GCM and vault derivation remain compatible. Only validated ciphertext envelope fields reach the upload call; tags contain no family names, dates, notes or recovery words.
- Quote covers payload plus 4 KiB of signature/tag overhead. Turbo's decimal SOL quote is converted exactly to integer lamports, with 10% movement allowance and an absolute 0.01 SOL storage-top-up cap. This cap excludes Solana transaction fees. Existing credits/free allowance can make the payment zero. Unused credits remain associated with the wallet.
- Quote binds network, address, envelope SHA-256 and a 120-second expiry. Free allowance/existing credits are tried first. A separate unchecked-by-default consent permits one top-up only after HTTP 402. The entire displayed cap may be credited, not just the exact byte cost; unused credits stay with the wallet. No automatic second top-up is allowed for that signed archive.
- A successful response produces a network-labelled, downloadable receipt containing the service response and the ciphertext hash. Receipt is saved in browser storage immediately, where available; mainnet acceptance also records the encrypted local archive before the dialog is dismissed.
- Acceptance is shown as **accepted by Turbo**, not independently verified final settlement. Testnet receipt IDs never replace the mainnet vault head. An encrypted backup is available before and after upload.
- IndexedDB persists the exact signed data-item bytes/ID, network, ciphertext hash, encrypted envelope and optional parent ID. Retries replay those bytes, including after reload. The UI offers earlier attempts explicitly; resuming an earlier snapshot does not include later edits. No mnemonic/private signing key is stored in this journal.
- An in-process guard and Web Locks exclude concurrent uploads for the same network/wallet across tabs. Browsers without durable storage or Web Locks fail closed before funding.
- Before a SOL signature request, the transaction must be a single System Program transfer with the expected sender, fee payer, recipient and lamports. The returned signature and unchanged message are checked. The signed transaction signature is durably journalled **before** the SDK can broadcast. On retry, `submitFundTransaction` reconciles that transfer instead of creating another; an unresolved transfer also blocks funding another snapshot. SDK HTTP automatic retries are disabled for this flow.
- An interrupted request is not labelled unpaid. If acceptance is already known, later local-storage/verification failure does not turn it into a failed payment. The UI keeps receipt export and encrypted backup available.
- A receipt can be imported on the restore screen. Its network selects a hard-coded gateway (never a URL from the file), `/raw/<id>` supplies the exact ciphertext bytes, and SHA-256 plus vault ID are checked before AES-GCM decryption. Both buffered and streamed responses are limited to 10 MiB and requests time out after 20 seconds. Restoration does not require a wallet. Testnet heads never become mainnet parents.
- The accepted screen can verify a gateway download separately. Receipt hash matching is not independent verification of the service's RSA receipt signature or final Arweave settlement.
- A newly generated random SEJIRE key can create its first encrypted copy offline. An existing key with no local backup refuses to publish when gateways are unavailable. HTTP 429/5xx/malformed JSON are not interpreted as a missing archive. Restoring an archive caches the entire vault, including its other trees.

## Configuration

Use `npm run solana:dev` from the repository root for local development; `npm run solana:build` creates a production devnet build, and `npm run solana:check` runs offline tests, type checking, lint and that build. These macOS/Linux commands explicitly set the devnet environment without overwriting `.env.local`. `apps/web/.env.solana.example` remains a reference, not a file to copy over existing configuration blindly. Environment values are public build-time configuration; never place secrets in `VITE_*` variables. The committed Pages workflow selects devnet and hides QA cashier navigation. Mainnet activation is intentionally explicit and has not been done.

## Earlier verification (before the end-to-end changes below)

- Full repository `npm test`: web suites plus sponsor suite (46 sponsor assertions).
- TypeScript and Vite production build.
- New regression tests: envelope encryption roundtrip and plain-data rejection; invalid/oversized envelopes; decimal SOL to integer lamports; zero-price and maximum caps; expiry, wallet, digest and network binding; parent-tag validation; wallet-change signing refusal; HTTP gateway error classification; offline no-backup refusal and local preservation.
- Read-only calls to both live Turbo pricing environments returned valid quotes through the SDK. No wallet connected, transaction signed, payment sent or archive uploaded in that check. The quoted maximum for the small synthetic sample was about 3,400 lamports at that moment; this is not a guaranteed charge or a future price.
- Zero-budget devnet integration check with an ephemeral signing adapter: Turbo requested a top-up; SDK rejected it because the configured maximum was zero, before any transaction signature. No payment or successful upload occurred.
- Browser smoke check: international landing, tree creation, recovery-word confirmation, entry into the devnet Solana panel and the unavailable-wallet message; no browser console errors in that path. Russian and Kazakh landing layouts were also inspected at 390 px width.

Read-only pricing check can be repeated with `apps/web/node_modules/.bin/tsx scripts/solana-quote-smoke.mts`. It is deliberately outside CI because it depends on external services.

### September 29: portable encrypted recovery

The restore form now retains a selected encrypted archive while the user enters or corrects their recovery words. Submitting with an archive opens that file directly without gateway lookup. A recovery-words JSON can be selected after the encrypted archive without discarding it. Files over 10 MiB, malformed JSON and invalid envelope fields produce localized errors before decryption; an explicit action removes the file and returns to online lookup. RU/KK/EN instructions describe this flow.

Archive, recovery-word and receipt downloads now use a shared DOM-attached link with delayed Blob URL cleanup. The actual archive download was verified in Chrome 154 on macOS; this is not evidence of Safari/iOS compatibility.

Verification on September 29:

- Web selftests and the sponsor suite (46 assertions) pass; TypeScript/Vite production build passes. Lint reports the existing six warnings and no errors.
- The new crypto backup regression checks encrypted roundtrip of two trees, parent-child relationships and revision history, rejects malformed/oversized/tampered files, and verifies full-vault local caching on a fresh device simulation.
- The browser smoke downloads an actual encrypted archive through the Solana panel and imports it into an isolated Chrome profile. Both trees and the parent-child relationship survive; the historical commits remain intact. Wrong words can be corrected without reselecting the file. Malformed JSON produces a user-facing error. Recovery makes zero external service requests.
- Recovery-words file import after archive selection passes. RU/KK restore forms have no horizontal overflow at 390 px. No uncaught browser errors occur in the tested flows.
- All fixtures are synthetic; the browser smoke blocks external requests. It makes no wallet connection, payment, upload or settlement claim.

Reproduce the browser check with Vite running at `http://127.0.0.1:5173` and an independently installed Playwright plus Chrome:

```sh
NODE_PATH=/path/to/node_modules node scripts/recovery-browser-smoke.mjs
```

`SEJIRE_TEST_URL` overrides the dev-server address; `SEJIRE_BROWSER_CHANNEL` overrides the Chrome channel. The script uses app modules through Vite to construct fixtures and is not a production-preview test. Real network recovery remains a separate acceptance check below.

## September 29: live testnet roundtrip and retry safety

`npm run test:solana` now includes wallet-adapter contract tests against the actual SDK, 20 upload/failure scenarios with real Ed25519/data-item signatures and mocked service responses, IndexedDB reload tests, and receipt parsing/retrieval/decryption tests. Scenarios include denied signatures, changing accounts during a prompt, expiry, altered transactions, storage failure before a payment prompt, lost acceptance/payment responses, explicit funding authorization, concurrent attempts, and no second payment. These tests run in the existing CI via `npm test`; they use no funded wallets and make no external service calls.

Three live devnet runs succeeded on 2026-09-29. A disposable software signer signed a synthetic two-tree archive through the same application upload function and real SDK. Turbo accepted it for **0 winc**, the test gateway returned it, exact-byte SHA-256 matched, and AES-GCM recovery retained both trees, parent/child links and history. A fresh journal instance returned the same receipt without another signature. In the third run, deliberately withholding the saved receipt caused a second real POST of the same signed item; Turbo returned the same ID (`Hr2I-wT0ONvPbmPHZDs3EpoDIrkcBdSpUYuPxxu_p7w`), still with one message signature and zero SOL transfers. This proves the real service path and replay, **not** extension approval or the paid path.

The reproducible public-vector run produced data-item ID `_EbfgIBmLRveXVCFwNmsKj2ftw0bJKZoqQE82ahf8S0`. The testnet is ephemeral; later unavailability is expected and is not evidence of permanent storage. The public BIP39 test vector is used only for synthetic data, never for a wallet or a personal archive.

Browser verification imported the live receipt on a separate localhost origin with no cached vault or wallet, rejected a wrong phrase while retaining the selected file, and restored the parent/child tree with the correct public test words. The devnet panel at 390 px had no horizontal overflow and correctly reported both unavailable wallet providers. A transient pre-existing I18n Fast Refresh issue occurred during source edits; clean production-page checks are recorded separately, not described as a clean HMR run.

The production build was then served on a fresh port/origin. Importing the same live receipt and public test words restored the parent/child tree, with no captured browser errors/warnings and no horizontal overflow at a verified 390 px viewport. This check does not depend on Vite's development module imports or injected fixture state.

Reproduce locally (Node 22+, from `apps/web`):

```sh
npm run test:solana
# Opt-in public network test, synthetic data only; SOL transfers are forbidden by the test adapter:
SEJIRE_LIVE_DEVNET=1 npm run test:solana:live
# Optional known public recovery words for manually reproducing the UI restore:
SEJIRE_LIVE_DEVNET=1 SEJIRE_PUBLIC_FIXTURE=1 npm run test:solana:live
```

The live test is intentionally outside CI: free-tier exhaustion, gateway propagation, service failures and testnet expiration are external dependencies. It fails rather than authorizing a payment when the free allowance is unavailable. Output contains only public receipt/evidence fields (and the explicitly selected public test vector); random recovery words and the ephemeral wallet private key are not printed or saved.

### Remaining real-wallet acceptance runbook

Use a **test wallet**, synthetic family data and devnet. Never paste wallet recovery words into SEJIRE. Do not change this to mainnet as a troubleshooting step.

1. In a browser with Phantom, connect, inspect the displayed address/network and archive quote. Reject the data signature once and confirm the tree/backup remain available. Reconnect after changing accounts.
2. Save SEJIRE words separately. Leave top-up authorization off, sign the archive and download both the receipt and encrypted backup. Click Verify download. Repeat with Solflare. A free upload is not a paid transaction.
3. Import the receipt and SEJIRE words in a different clean browser; verify every tree/relationship/history. Do not import wallet seed words. Repeat with the encrypted backup offline.
4. Separately exercise the paid route with owner-approved test SOL after free allowance/credits are insufficient: inspect the single recipient/amount and network fee in the wallet. Reject once. Then approve, simulate a dropped service response, reload, explicitly resume the saved attempt and verify the **same** transaction signature is reconciled. Record the devnet explorer reference and Turbo credit change.
5. Keep the local journal until reconciliation is complete. Clearing browser storage, changing devices or manually transferring funds invalidates the local at-most-once safeguards; these actions require manual reconciliation, not a blind retry. A signed transaction that was never broadcast can remain conservatively unresolved; do not issue a replacement automatically.

## Outstanding acceptance before mainnet/submission claims

1. Connect real Phantom and Solflare in supported browsers; reject connection/signature, change account, and repeat with no balance.
2. With synthetic data and test SOL, sign an upload, download its receipt, inspect the actual transaction and Turbo credits, and verify the cap including any top-up minimum behavior. Free uploads must not be described as paid transactions.
3. Interrupt after top-up and before upload acceptance; retry without a duplicate unwanted payment. Confirm the network chosen by the SDK is clearly shown by each wallet.
4. Complete a controlled mainnet run only with an owner-approved spending amount. Retrieve ciphertext from a gateway, compare its hash, decrypt on a fresh browser/device, verify all family relationships and a second stored tree, and inspect actual settlement/indexing.
5. Complete backup download/reimport on Safari, iOS wallet browsers and Android. Chrome download and isolated-profile file recovery passed on September 29; the in-app browser and other platforms remain unverified.
6. Independently review dependencies and privacy/consent, profile slow mobile startup, and document measured storage/payment cost. Do not use real family data for a public demo.

## Dependency and architectural limitations

At this implementation checkpoint `npm audit` reports **0 critical, 8 high, 6 moderate and 15 low package-level findings**. These counts include parent packages affected by transitive advisories, not 29 independently exploitable application bugs. Compatible fixes removed the existing critical jsPDF finding; an elliptic 6.6.1 override removes older critical versions. Unresolved advisories include bigint-buffer, secp256k1, ws, stream-json, uuid and an elliptic implementation warning. Several involve native/server or unused token code paths, but browser reachability has not been comprehensively established. Do not present them as harmless or as resolved. Audit is reported in CI and is not a substitute for the mainnet release review.

The complete multichain Turbo SDK generates a roughly 1.35 MB minified lazy chunk (about 440 KB gzip), alongside the existing large Arweave wallet chunk. Its polyfills produce a vm-browserify eval warning. Optimize or replace this dependency surface after the supported wallet flow is proven; do not silently ship an obsolete SDK just to reduce the audit count.

Receipt persistence depends on browser storage availability. Browser data clearing can erase drafts, local encrypted archives and receipts. The local-copy warning system is inherited, and the encrypted file plus separately held recovery words remain necessary. A Turbo receipt does not itself contain the recovery key. Key rotation, family access control and encrypted local drafts are not implemented.

## Additional verification before the second-Mac handoff

September 29, unchanged application commit `4725b1e`: GitHub Actions run `36564863944` completed successfully, including real clean installs, tests and devnet build on Ubuntu/Node 22. Local full tests, sponsor type checking, production build and five additional Solana-suite repetitions passed. Lint still reports six warnings.

One fresh live free upload produced `PnLfyAI2gfLB_S8DYcHY8hslLJuTDMVVwLJUWQQP6X4`, with one disposable software message signature and zero SOL transactions. Receipt replay and a duplicate real POST kept the same item ID. Gateway hash and decryption retained both trees, relationships and history. Production UI restored this receipt on a new origin after rejecting incorrect words. A real 2994-byte encrypted-file download was checked for ciphertext-only contents and original history, then restored on a separate origin; imported words did not discard the selected archive. The restored draft survived reload. JSON export and a one-page A4 PDF export passed; the PDF was rendered and visually inspected.

Extra local diagnostics passed 10,000 integer money cases, 32 Unicode encryption/unique-IV roundtrips, ciphertext/wrong-key rejection, HTTP failure and abort cases, untrusted receipt URL isolation, 50 fake-IndexedDB concurrent writes with network isolation, and lock release after failure. These are not real-extension or real-browser multi-tab payment tests.

Observed UX limitation: at 390 px, Fit clamps to scale 0.55 for an 832 px world and leaves the root card at x=-11.8 px. Current fit tests intentionally preserve the minimum scale; whole-document no-overflow is insufficient to prove cards fit. Two smaller messages omit a supported receipt format or refer to Open when the action is Restore archive. No app-code fixes were made in this test-only pass.

UI JSON re-import was inconclusive: browser control timed out while setting the selected file and could not observe or close the test tab afterward. The import path calls window.confirm before replacing a populated draft; an automation/modal interaction is plausible but not established. Reproduce manually in Chrome. Export contents and JSON unit tests passed. The temporary mobile viewport override was reset.

The latest production-only npm audit scope differs from the earlier full report: web has 0 critical, 8 high, 6 moderate and 10 low package entries; sponsor has none. Browser reachability is not comprehensively reviewed. No dependency auto-fix, downgrade, mainnet action or deployment was performed. Real wallet extension and owner-approved paid-devnet acceptance remain outstanding.

The continuation package includes the [detailed test report](verification/2026-09-29-solana-report.md), [public devnet evidence without recovery words](verification/2026-09-29-devnet-evidence.json), [audit snapshot](verification/2026-09-29-web-production-audit.json), and [real-wallet acceptance checklist](SOLANA_WALLET_ACCEPTANCE.md). The portable `boundaries.selftest.ts` is now part of `npm test`/CI; it generates its own fixtures and never reads another Mac's files or contacts a gateway. This packaging adds tests, commands and documentation, not fixes for the observed UI limitations.
