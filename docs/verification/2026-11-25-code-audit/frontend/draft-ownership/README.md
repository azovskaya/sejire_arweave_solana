# Draft ownership and immediate input persistence

Date: 2026-11-25. This evidence covers the ownership patch in the shared working tree; `manifest.json` records SHA-256 for each reviewed/modified file and the exact commands. No deployment, real wallet operation, payment or archive upload was performed.

## Runtime decisions

- One origin-wide Web Lock (`sejire.draft-writer.v1`) owns the draft and its guide. It uses `ifAvailable`; there is no lock stealing, expiry timer or localStorage lease pretending to provide mutual exclusion.
- The lock holder compares the exact current draft/guide bytes with its expected values before every write. An older application that ignores the lock cannot silently be overwritten by this writer after a detected change.
- The holder and each asynchronous operation have distinct scoped tokens. StrictMode provisional mounts, pagehide, unmount and a later holder cannot release or reuse each other's permission. A persisted pageshow reacquires permission before reloading actual saved data.
- Both App entry points wait for a writable, freshly loaded document before mounting editor/restore. New tree, import, restoration, vault version selection and guide writers use the same guard. Writer ownership does not change draft, ciphertext, receipt or payment journal schemas.
- The current document writes synchronously from explicit handlers. Workspace has no autosave effect. PersonPanel writes raw text during the input event, including partial dates, empty intermediate names and spaces; its old 350 ms debounce is removed. Explicit flush still normalizes the profile for actions such as export/save/navigation.
- Draft and guide replacement uses synchronous paired writes with conditional rollback, preserving the old tree until replacement starts. This is not a claim that two localStorage keys form a crash-atomic database transaction.
- Restore and preparation callbacks validate their original ownership token before cache/session/draft mutation. Workspace also fences delayed journal checks and JSON imports by their request/tree context. The independent modal checks ownership after encryption and before adopting prepared state.
- A second tab or a browser without usable Web Locks gets a read-only/export path. Handoff is explicit, and closing the owner releases its browser lock. Unsaved edits caused by storage refusal remain in memory, can be downloaded, carry an unload warning and need an explicit retry. They are not automatically applied after reacquiring a different ownership generation.

## Executed verification

Every command below returned exit code 0; complete output is beside this file.

| Check | Result |
| --- | --- |
| TypeScript app typecheck, no emit, no incremental cache | PASS |
| `draftOwnership.selftest.ts` | PASS: exclusive writers, blocked reader, scoped releases, stale callback token, byte conflicts, denied/missing APIs, cancelled provisional acquisition, quota, paired replacement rollback |
| Existing `storageQuota.selftest.ts` | PASS, including historical quota error shapes |
| Existing `vaultSession/selection.selftest.ts` | PASS, all 15 selection/preparation/full-vault/history/rollback checks |
| Existing `treeJson.selftest.ts` | PASS |
| Editor Playwright collection | 24 tests collected; no browser execution |
| Independent Playwright collection | 26 scenarios × 3 browsers = 78 tests collected; no browser execution |

## Browser regressions prepared for CI

Seven editor scenarios cover input plus reload in the same event task; two real pages sharing one browser context and transferring the actual browser lock; persisted pagehide/pageshow handling; unsupported Web Locks and export; quota retention/export/retry; a decrypt result arriving after another real tab takes ownership; and a storage event from an older uncooperative application. The editor runs in the existing React StrictMode entry point.

Two static independent-build scenarios cover immediate reload and real two-tab handoff. The existing complete-vault/cache-conflict regression now transfers the draft lock explicitly; its original full-vault/history, digest, journal, zero-payment and zero-external-request assertions remain intact.

The pagehide/pageshow scenario uses actual two tabs but dispatches synthetic persisted events. It does not claim that the browser actually admitted a document to its native BFCache. Browser execution is still pending root-managed GitHub CI because no usable local browser binary is available. Test collection is not reported as browser PASS.

## Boundaries

The coordinator protects cooperating application tabs on the same origin and detects changed draft bytes from older code. It does not provide cross-origin synchronization. Browser storage remains subject to the user's browser settings and storage limits; failure is surfaced and no automatic takeover is used. This patch does not change network payment finalization or the backend durability contract.
