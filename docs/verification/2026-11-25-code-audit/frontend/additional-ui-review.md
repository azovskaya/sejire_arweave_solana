# Supplemental UI source audit — 25 November 2026

## Scope and result

This pass manually read **24 additional files in full**: the 21 component files absent from the original frontend coverage, `main.tsx`, the environment type declarations and the complete stylesheet. It also expanded `Workspace.tsx` from targeted review to a full-file review. The original coverage and this addendum together contain **73 unique runtime source files** under the original inventory definition, plus the stylesheet and declaration file. All 34 files in `src/components` now have a full or explicitly targeted manual review entry. Six of those components remain targeted, not full-file reviews; their names are listed in `additional-ui-coverage.json`.

That six-targeted count describes this pass's snapshot. The subsequent [final UI reading](full-ui-review.md) completes four of those files in full with unchanged hashes. The parent assigned the remaining two independent components to a separate reviewer.

The SHA-256 and exact review extent of each file are recorded in [additional-ui-coverage.json](additional-ui-coverage.json). A command that listed filenames was used only to find gaps; it is not counted as manual review. Missing ranges in truncated tool output were read again before marking a file full. Source review does not establish visual correctness or execution of every branch.

Two further concrete defects were found and fixed after the parent authorized a small combined patch. Their source traces and the patch were independently reviewed by the parent and a separate reviewer. The new browser regressions have **not been run locally**. No browser, Vite instance, payment, upload or deployment was started in this supplemental pass.

## Additional defects and exact corrections

### FE-07 — draft recovery reopened the failed deep link

Before the fix, `AppErrorBoundary` showed an **Open draft** button whenever a valid draft existed. The button remembered `work` and reloaded, but retained the current fragment. Both app entrypoints prioritize recognized `#/save`, `#/restore` or administrative fragments over the remembered editor screen. A render failure on such a route therefore sent the user back to the same failed route, despite the button promising to open the stored draft.

The fix clears the fragment while preserving pathname and query before reloading a valid draft. The ordinary Reload action without a draft remains unchanged. The boundary's JSON export continues to read the stored draft and does not delete or replace it.

The added regression injects a deliberately failing save-screen module, uses the real application boundary, clicks **Open draft**, and requires the real reload/boot path to show the editor with the identical stored draft and an empty fragment. Only the deliberate synthetic render-error message is allowed by that test; unexpected errors, external requests and writes still fail. Existing editor tests continue to allow no page errors.

- Pre-patch `ErrorBoundary.tsx` SHA-256: `5c8a7dccf9ebb695a331857ce78b846ae853d5ec6e9207d064c914c6642b430c`.
- Evidence before change: source trace, not an executed browser RED result.
- Regression: `opening the saved draft after a render failure leaves the failed deep link`.

### FE-08 — a late Save lookup could restore the unmounted old tree

`Workspace.openPublish` awaits `hasPendingPreservation`, which can wait for the shared preservation Web Lock and IndexedDB. During this wait the user can still go Home and create another tree. The old component previously continued after that asynchronous boundary without an unmount or navigation check. Its `latestStore` ref still referred to the old tree, so its existing same-tree-ID check passed. For a dirty old tree, `persist(commitDraft(old))` invoked the still-live parent `App.setStore` and could replace the newly created tree with the old snapshot.

This failure is different from the already-fixed late encryption or late restore paths: it happens before the publish modal opens, at the editor's pending-attempt lookup.

The fix gives each lookup a request revision. Home invalidates it immediately; tree-context changes and unmount invalidate it through cleanup. Immediately after the awaited lookup, and before any profile flush, commit, local protocol mirror or modal state change, a stale request returns. The existing tree-ID check remains as a second check. No old payment attempt is discarded, and the guard does not create any new payment or encrypted archive.

The new browser regression holds the **actual** `sejire.preservation-attempts.v1` Web Lock after initial editor hydration. It makes the old tree dirty, starts Save, confirms the lookup is waiting, goes Home and creates a new tree, then releases the lock. It requires the new draft and empty editor to remain unchanged, with no publish dialog, external request or write. It does not replace the pending-attempt runtime module with a stub.

- Pre-patch `Workspace.tsx` SHA-256: `04c044a0e30e8108f46bc2f9835616e01ef5ab642aa9b39ef8ed04e063c7005b`.
- Evidence before change: source trace, not an executed browser RED result.
- Regression: `a delayed save lookup cannot replace a new tree after leaving the old editor`.

### Test-only correction reported by parent CI

The existing default `#/save` no-wallet test installed its wallet trap with `addInitScript` after the setup document had already loaded. Navigating from `/` to `/#/save` is a same-document fragment change, so that new init script had not executed and the observed counter was `undefined`. The assertion requiring exactly zero wallet calls is retained. An explicit reload after navigation now installs the trap before React starts. This is a test lifecycle correction, not a new runtime defect or a relaxation of the no-wallet requirement. The parent owns the exact CI run and logs.

## Reviewed user-data boundaries

| Area | What was actually read and traced | Result and limits |
| --- | --- | --- |
| Profile editing | All of `PersonPanel`, `DateTextInput`, `AddPersonModal` and `Workspace`; profile construction, debounce, explicit flush, parent/self additions and deletion/undo. | Editable fields are merged while retaining structural IDs, parent/media fields and tombstone state. Explicit Save/Home/export/card/focus actions flush the current profile. Undo applies to the latest tree rather than replacing it with an old whole-tree snapshot. This does not certify simultaneous editing in two tabs. |
| Tree display | Entire `PedigreeView` and stylesheet: focus, fitting, zoom/pan, pinch listeners, pointer exclusions, cards, links and mobile layout rules. | The display delegates tree mutation to parent callbacks. Names and notes are rendered as text, not injected HTML. No browser or visual rendering was performed here. |
| JSON and version replacement | Entire Workspace UI control flow, together with the earlier full `treeJson` and selection-helper review. | A JSON read checks its request revision before confirmation and replacement. Version opening uses the checked full-vault selection transaction. The UI replaces the current editor tree with explicit confirmation; no unreviewed automatic merge behavior is claimed. Tree-engine algorithms have separate library review. |
| PDF export | Workspace's capture/selection/async-export boundary and template picker. | The exporter receives the captured current snapshot and chosen root/template. PDF generation and layout algorithms have separate evidence from the PDF/library audit; this pass did not rerun PDF export. |
| Archive selection and history | Newly read `PaidSaveHistory`, `DirectSaveHistory`, `DirectArweaveFlow`, both Welcome variants and legacy notices; earlier paid/promo/restore review remains in the main report. | Listing an operation does not itself sign or send a new transaction. Signed direct operations have explicit resume/check actions and portable recovery downloads. Historical and independent profiles remain distinct from the new funded product. |
| Locale | Entire language switch and UI call sites; all stylesheet rules. | Radio-keyboard navigation and locale propagation were read. Several funded/legacy strings remain literal Russian; complete multilingual content coverage was not certified. |
| Administrative paths | Entire historical `NativeAdminDesk`, safe V2 diagnostics, and earlier targeted current AdminDesk/FundAdmin review. | Native configuration/settings/payments are historical branches when V2 is disabled. Current V2 mounts the separate fund administration UI; browser storage and public local UI verification are not presented as server authorization. |

The separate library reviewer checked the automatic AO-related calls used by Workspace. `queryPersonFromDraft` creates a local tree process, and `mirrorStoreToProtocol` explicitly selects local mode. These automatic calls do not transmit the plaintext tree. Their transport implementation and hashes are recorded by the library reviewer, not added to this agent's newly-read file count.

## Actual profile reachability

The funded build script sets `VITE_PRESERVATION_V2_ENABLED=1`. The reviewed App and Welcome branches therefore select general `PreservationV2`, `PaidSolanaFlow`, `PromoFundedFlow`, `PaidSaveHistory` and the current admin UI. The new paid client obtains its network/amount policy from the configured backend. Old Devnet/native compile flags and old panels are not evidence that the new paid client uses those old amounts or network rules.

The historical `NativeCheckoutPanel`, `NativeAdminDesk`, legacy Checkout panel and Turbo Solana panel were still read in full to understand their retained behavior. Their existence in the source tree does not mean those legacy payment screens are the default reachable funded route. The exact release-bundle reachability verification remains parent-owned.

The explicit `#/save/legacy-pilot` compatibility route remains available for the previous fixed pilot. Ordinary `#/save` imports general full ciphertext and does not silently select the pilot. The independent entrypoint instead reaches DirectArweaveFlow and independent history. Its accepted archive is a different release profile and does not demonstrate SOL/promo readiness.

## Unresolved limits, without overstating the patch

1. **Two editors in separate tabs can overwrite one shared draft.** Each tab holds its own TreeStore snapshot; `saveDraftTree` writes the whole value to one localStorage key without a revision/CAS check or editor ownership lock. Tab A can save a name, then tab B can save a note from an older snapshot and remove A's name change on the next reload. This source-traced architectural limitation remains open. Payment/promo locks and the new async lookup guard do not solve it.
2. **The final profile debounce window is not independently flushed on browser reload/pagehide.** The 350 ms profile timer is flushed by explicit app navigation/export/save actions. A separate browser-lifecycle flush was not found. Immediate reload can lose only the most recent still-pending profile input; the stored tree is not claimed to include that input. This was not changed in the small authorized patch.
3. **Accessibility and visual layout need actual browser verification.** Source includes keyboard locale handling, labels, modal roles, small-screen sheets and bounded/wrapping content, but no complete focus-trapping or assistive-technology audit was performed. Source CSS review is not a mobile screenshot or visual acceptance test.
4. **V2 admin overview remains historical Devnet analytics.** It must not be described as a complete Mainnet order ledger. FundAdmin/server recipient settings are separate.

## Verification and delivery state

For the final small patch, `node --check apps/web/tests/editor-safety.spec.mjs` and `git diff --check` returned exit 0. These checks establish syntax/patch hygiene only. The editor suite now contains the earlier 15 cases plus two new cases; this count is not a browser execution result. No local browser collection or execution was repeated in this supplemental pass, and the existing missing-Chromium limitation was not bypassed.

The independent reviewer read both runtime diffs and both new regressions and reported no further blocker in those changes. Parent-owned production build and exact-SHA CI are still required for final acceptance. At handoff, the two source changes and test change are in the shared working tree; the parent handles commit/push and records their final SHA. This agent did not deploy, upload an archive, connect a wallet, use owner credentials or perform a transfer.
