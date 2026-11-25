# Frontend code audit — 25 November 2026

The later [supplemental UI review](additional-ui-review.md) adds 24 fully read files, expands Workspace to a full review, and records two further authorized fixes with new browser regressions. Its [coverage and SHA manifest](additional-ui-coverage.json) supersedes the earlier Workspace hash and distinguishes remaining targeted reviews from full-file coverage. The findings and local test results below describe the earlier six-fix phase.

The [final UI reading](full-ui-review.md) subsequently upgrades AdminDesk, PublishSeedModal, SolanaRecipientsAdmin and VaultVersionsModal to full-file reviews, with unchanged source hashes and no additional source-confirmed defect. See its [exact coverage manifest](full-ui-coverage.json); unique-file counts are not inflated by the repeated reading.

## Result and exact scope

Six concrete defects were fixed in the funded frontend working tree. Two were reproduced by executable Node regressions before the production fix: loss of trees from an explicitly selected full vault, and replacement of that selection by an older paid completion. The other defects were traced through the actual runtime code and have focused browser regressions. Local browser execution was blocked before any assertion by missing Chromium executables; browser collection and JavaScript syntax checks are recorded separately from test execution.

The requested target is **SOL Mainnet + promo + admin with a configurable backend, without mandatory Cloudflare**. The preserved independent release is a different product profile. Its runtime and assertions were not changed to make the funded profile pass.

This report covers manual reading of 51 frontend source files, either in full or in specifically named functions/boundaries. `coverage.json` records each reviewed file, SHA-256, extent and purpose, together with an explicitly separate automated inventory. A file listed by an automated scan is **not** claimed as manually reviewed. The remaining source files, third-party dependencies, backend, release exporter and exact publication artifact require the parent audit's separate evidence.

## Findings and fixes

| ID | Defect in the starting code | Resulting change | Evidence |
| --- | --- | --- | --- |
| FE-01 — high | `loadVaultForPublish` ignored an explicit `file`/`local` selection and its `cacheDigest`. With selected full vault A+B and an older remote parent containing A, the next funded preparation selected remote A and silently lost B from the next archive. `sealVault` also changed the shared cache before the session was updated. | An explicit local/file selection wins over remote discovery, requires its exact cached digest, and decrypts those captured bytes. A stale parent, missing digest or cache replacement fails closed. Preparation now encrypts without writing, checks its live context, and synchronously persists full ciphertext plus local session/digest with readback and rollback. It rejects changes made while loading/encrypting. | **Actual RED then GREEN** in `load-vault-red.log` / `load-vault-green.log`; 15 selection checks in `selection-green.log`; browser regressions for two preparations and late encryption pending execution. |
| FE-02 — high | Funded `RestoreSeed` ignored failed draft/session persistence, stored local/file sessions without a digest, and could finish a decrypt/fetch after leaving the screen. This could replace newer edits or show a successful restore without durable state. The generic local picker resealed ciphertext; local/demo labels could become HEAD IDs. | Restore uses the existing checked full-vault selection transaction: cache, active draft, session and phrase are accepted together, with rollback on write failure. It keeps original ciphertext, records a digest for local choices, and keeps non-network version labels out of HEAD. A request identity and AbortController are invalidated on Back, picker cancellation and unmount; late results cannot prompt or commit. | Source trace in `RestoreSeed.tsx`; shared selection quota/decline/rollback checks **GREEN**. Browser tests for denied session storage and delayed decrypt+Back are collected but not locally executed. |
| FE-03 — high | Paid standalone and editor paid/promo finalizers advanced HEAD for any same-vault local/file session with the old parent. A previously completed archive A could overwrite the user's later explicit A+B selection, causing the following load to use A again. | `canAdvanceVaultHead` requires matching complete ciphertext digest **and actual shared cache** for an explicit local choice. Older completion is retained in immutable local history without replacing the later selection. New HEAD writes use checked session persistence. Promo finalization also binds its callback to the active publish context. | **Actual RED then GREEN** in `paid-finalization-red.log` / `paid-client-green.log`; completion guard cases **GREEN** in `selection-green.log`. |
| FE-04 — medium | Leaving `#/restore` through App's Back path retained the fragment, so reload returned to restore. Clearing the fragment while on restore did not leave it. A fragment change before the first listener subscription was missed. | Funded App updates or clears fragments consistently and reconciles a real initial fragment change after subscribing, while preserving an unchanged empty-URL editor resume. | Source trace in `App.tsx`; browser regressions for Back+reload and navigation before subscription collected. Independent App's existing assertions were retained. |
| FE-05 — release profile mismatch | Ordinary funded `#/save` without an editor envelope entered the fixed historical pilot: literal 0.03 SOL, Devnet, one permitted archive and the pilot machine. The ordinary editor path already used policy-bound general checkout. | Ordinary `#/save` now accepts a general encrypted archive up to 512 KiB and then offers the existing promo/SOL policy-bound methods, or returns to the editor. Only explicit `#/save/legacy-pilot` enables the unchanged old pilot machine/journal/polling; its screen is labelled as the previous test pilot. File reads are invalidated on a newer import, Back or unmount. | 14 legacy pilot browser cases retain their assertions and move through three URL substitutions; the admin case is unchanged. New default-route and late-file-read regressions are collected. |
| FE-06 — high | Promo POST and status polling put `COMPLETED` into visible state before checking its archive binding. A response with the wrong digest/size/vault could show “integrity checked” success and stop polling; only the later finish callback rejected it. | Both POST and GET validate a completed response against the exact journaled envelope and parent before updating UI state. Mismatch retains the original order/journal, leaves success unavailable and continues GET reconciliation; it never creates a replacement POST. | New mocked POST and GET wrong-digest browser cases require no success/Done, one retained exact journal, then same-order recovery after a valid GET, with one POST/validation. These tests were collected and syntax-checked, not locally executed. |

## Preservation invariants examined

### Complete vault, draft and history

The selected encrypted vault carries every tree, while the editor displays only its active tree. The next save loads that complete vault and replaces only the current tree through `putTree`. Regression fixtures contain multiple trees and immutable commits; assertions compare the inactive trees and existing history, not only the visible person's name. Cancelling version selection leaves the old cache, draft, session and in-memory phrase intact.

Local storage is shared across tabs; session storage is per tab. A file/local session therefore needs a digest identifying its particular cache bytes. A different tab replacing that cache causes a controlled “selection changed” failure rather than a fallback to an older remote archive. Preparation captures both the raw current cache and session before asynchronous work and checks them again before accepting the new full ciphertext. These are synchronous coordinated writes with readback and rollback, not a claim that browser storage provides a cross-tab multi-key database transaction.

The checked restoration path does not report success when `saveDraftTree` or session persistence fails. The original network ciphertext is retained; resealing a downloaded HEAD would change its size/hash identity. Network history is read back before a completed attempt is cleared. `local_` and `demo_` labels remain local history labels and do not become Arweave parents.

### Cancellation and reload

Restore checks the exact live request after asynchronous fetch/decrypt and before confirmation or any accepted selection. Back and unmount invalidate it. The default save import similarly ignores a late `file.text()` after leaving or starting another import. Encryption is side-effect free until the publish screen and storage snapshot are still current.

Paid and promo attempts are persisted before their order POST. Reload resumes the same immutable operation. Unknown replies do not create a successor operation. A verified old completion can be added to history without changing a newly selected archive. The new browser tests explicitly gate decrypt, encryption or file reading to make cancellation deterministic; they do not rely on network timing.

### Payment and promo boundaries

Manual review followed `PaidSolanaFlow`, `paidClient`, `paidJournal`, `vaultGuard` and `paidFinalize`: policy/order identity, payer and network binding, amount parsing, wallet account changes, storing signed bytes before relay, pending signature recovery, reservation, cancellation, exact receipts and local completion. The executed paid-client suite includes synthetic lost replies, cross-tab serialization, journal conflicts, wallet mutation/unknown response and whole-vault receipt checks. It did not connect a real wallet or transfer funds.

The shared attempt lock prevents a new paid request and a promo request from independently claiming the same vault/tree. Promo has its own exact-byte durable record and only clears it after a verified completion or an explicitly classified pre-reservation refusal. The added success guards check the completion binding before the UI can call it verified.

The frontend uses a configured HTTPS checkout/fund origin. It does not require a Cloudflare hostname in its client contract, and it refuses to invent `/api` on an unconfigured static ArNS host. That observation is about source behavior; it is not evidence that the desired production backend is deployed, funded or configured.

## Routes and admin boundaries

| Route/profile | Runtime after this patch |
| --- | --- |
| Funded editor save | Current full encrypted vault, then general policy-bound promo/SOL checkout. |
| Funded `#/save` | General ciphertext import / return to editor; no fixed pilot or automatic wallet request. |
| Funded `#/save/legacy-pilot` | Explicit historical fixed Devnet pilot, unchanged durable machine and history. This compatibility route should be documented in the handoff; it is not advertised to new users. |
| Funded `#/restore` | Checked full-vault restore with lifecycle cancellation and exact original ciphertext. |
| Funded `#/admin` | Local public-verifier gate for the admin UI, then separate server credential in FundAdmin for authorized fund/recipient operations. |
| Funded `#/fund-admin` | FundAdmin still requires the server credential for server administration. The local public verifier is not the server authentication boundary. |
| Independent entrypoint | Existing direct Arweave release, no paid/promo runtime. Its contract is not a substitute for funded Mainnet acceptance. |

`SolanaRecipientsAdmin` validates public addresses, uses expected revision, fences late credential-generation replies and confirms saved addresses by reading them back. No real credential or owner key was read or used during this audit.

**Existing limitation:** the V2 AdminDesk “overview” is explicitly labelled Solana Devnet and calls `fetchPilotPayments`, which uses the historical pilot reference and Devnet genesis. It is historical pilot analytics, not a Mainnet paid-order ledger. FundAdmin and server recipient settings are separate. This audit does not present the old overview as evidence of complete Mainnet administration/analytics.

## Executed checks and exact limits

| Check | Observed result |
| --- | --- |
| `node --import tsx src/lib/arweave/loadVault.selftest.ts` before fix | Exit 1 at new A+B preservation assertion. |
| Same loader suite after fix | Exit 0, `load-vault-green.log`. |
| `node --import tsx src/lib/checkout/paidClient.selftest.ts` before finalizer fix | Exit 1: actual session changed to older published HEAD instead of later file selection. |
| Same paid-client suite after fix | Exit 0, `paid-client-green.log`. |
| `node --import tsx src/lib/vaultSession/selection.selftest.ts` | Exit 0, 15 synthetic checks in `selection-green.log`. |
| `node --check` changed editor and promo browser tests | Exit 0; syntax only. |
| Playwright `--list`: editor / promo / old V2 pilot / recovery | Exit 0; 15 / 27 / 15 / 35 collected cases. Collection is not execution. |
| Local browser test attempt | Failed before the tests ran: Playwright shell absent; `/usr/bin/chromium` wrapper targets missing `/usr/lib/chromium/chromium`. `restore-browser-red.log` is an environment failure, **not** product RED evidence. |
| Browser installation | Parent reported official Playwright install blocked by HTTP 403 `SiteUnavailable`. No bypass attempted. |

Production build, typecheck, exporter verification, exact ZIP identity, backend tests and GitHub CI are handled in the parent audit. Their current results must be taken from that evidence, not inferred from the frontend unit logs. The browser regressions must run in the CI environment with a valid installed browser before calling those UI paths verified.

No real payment, archive upload, deployment, push or access to `.env`, owner seeds or actual admin credentials was performed by this frontend audit. Fixtures contain only synthetic data; recovery words were kept out of evidence output.

