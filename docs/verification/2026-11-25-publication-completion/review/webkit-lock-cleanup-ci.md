# WebKit close/handoff synchronization — CI 45595831074

## Observed failure

Root reported independent-browser CI results of 77/78 passing for source `23037bd`. The failing WebKit scenario was `independent editor ownership transfers between two real tabs without replacing the latest draft`, after `other.close()` and one click on «Продолжить здесь». The expected enabled Save control was absent after the normal 5-second assertion timeout.

Evidence: run `45595831074`, job `139141507015`, artifact `15013122813` (`checkout-failure-diagnostics`, 312195 bytes). Root verified its SHA-256 as `7b8270d5557dabea3419f888963ec96a7627767a94860b7e4e8044b94b6aca67`. This reviewer read the extracted `independent-independent-ed-19a52--replacing-the-latest-draft-webkit/error-context.md`.

The snapshot contains only the draft-access notice, its “open in another tab” alert, Continue here, Download saved copy and Home controls. It shows safe refusal to acquire the writer, not an editor crash or evidence of overwritten data. There is no recorded trace for exact engine event timing.

## Cause and correction

The test assumed page-close completion also acknowledged completion of lock-manager cleanup, then made exactly one `ifAvailable` attempt. `DraftOwnership` enters `blocked` only when the Web Locks callback receives null. The [Web Locks specification, Termination of Locks](https://www.w3.org/TR/web-locks/) queues lock termination/release on the lock task queue. Page close and release observation are distinct synchronization points. The observed WebKit result is consistent with that race; the artifact does not establish its precise IPC timing.

The correction is test-only:

- After closing the owner, poll the actual `navigator.locks.query().held` snapshot until there are zero `sejire.draft-writer.v1` locks.
- Make the same single explicit Continue here click and retain the enabled-editor assertion.
- Require exactly one held draft lock, with mode `exclusive`, after the editor opens.
- Retain every existing final-input, draft/history, zero-signature, zero-network-write and error assertion.

The same page-close assumption occurred in two editor scenarios and received the same observed-state wait and exact-lock assertion. Explicit release-button handoffs remain immediate and unchanged. No runtime code, lock stealing, queued automatic takeover, fixed sleep, increased timeout, skipped test or reduced assertion was introduced. A lock that does not actually disappear will still fail at the release check.

## Verification

`git diff --check` passed. Both affected Playwright suites were collected successfully: 78 independent browser entries and 24 editor tests, exit code 0. Runtime/unit/build checks were not repeated for this test-only correction. Local browsers remain unavailable; the corrected scenarios have not been executed locally. A fresh CI run is required to establish browser PASS for the corrected source.
