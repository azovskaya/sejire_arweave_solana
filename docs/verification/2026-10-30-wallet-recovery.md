# Interrupted wallet confirmation recovery

Implemented and locally verified on 2026-10-30, based on feature source
`957afa998b49f1f4c89be06c5413bfbae89a390d`. Publication is accepted separately
through the existing exact-source CI artifact and Pages provenance checks.

## Problem and resulting behavior

The client persists `signingStarted` before asking a wallet to sign. Only an
explicit rejection previously cleared it. A different wallet error could leave
an unsigned operation displaying “checking the previous signature” forever.
Reloading preserved that operation correctly but provided no way to finish it.

Unsigned interruptions now show “Подтверждение в кошельке не завершено”.
“Восстановить подтверждение” requests recovery of the same order. A prepared
but unclicked request also has “Обновить подтверждение”. Neither action opens
the wallet. The fresh preparation clears consent, displays the current network
fee, and requires a separate owner action to confirm payment in the wallet.
Signed operations keep their existing reconciliation path.

## Durable boundary

The authenticated `POST /api/checkout/orders/:id/recover` accepts only the old
preparation ID. The order, reference, payer, recipients, amounts, ciphertext,
archive metadata and AR reservation remain unchanged. It first checks for a
genuine payment of the old preparation and preserves it when found.

Renewal requires a complete reference observation, finalized expiry of the old
blockhash, no durable payment reservation, no payment or archive execution, and
an exclusive runner lease. Incomplete or ambiguous evidence and RPC failures
refuse renewal. The additive SQLite history stores the predecessor and its
successor together with the finalized height. The preparation update and the
existing signature reservation share an atomic preparation check: a reservation
that committed first blocks recovery, including when its response was lost; a
late reservation of a superseded preparation is rejected before broadcast.

This safety claim relies on the supported client's `signTransaction` contract
and durable reserve-before-broadcast ordering. An RPC “not found” response alone
is not treated as proof that no payment ever existed.

Preparation v1 is unchanged. V2 adds the predecessor ID and a payment window
bounded to 15 minutes after preparation creation. The immutable order's original
expiry is preserved. Validation, reference lookup and broadcast use the validated
preparation's window. Repeating a recovery for the same predecessor returns the
persisted successor, including after a process restart.

The browser persists recovery intent before the POST and accepts a replacement
only if its predecessor exactly matches that intent and the immutable order.
GET-only polling recovers a lost response without taking a competing runner
lease. Ordinary preparation, polling and page load cannot start renewal. Journal
revision checks reject a stale wallet callback. Signature and payment evidence
take precedence over any recovery request.

## Local verification

- Full repository `npm test`: passed, including existing client, crypto, recovery,
  checkout, RPC, treasury and recipient regressions.
- Sponsor TypeScript check and native web production build: passed.
- Web lint: no errors; existing warnings are outside the changed files.
- Paid browser coverage: all 21 distinct cases passed (20 in the full run and
  the remaining standalone contribution case after updating its two old heading
  expectations). New cases preserve the same expired order/archive through an
  unknown wallet result, explicit renewal, fresh consent, one synthetic payment
  and completion; a lost renewal response also survives reload.
- Backend paid components: 23 primitives, 16 archive adapter cases, 28 SQLite
  cases, 9 recipient cases, 26 actual workerd API cases and 7 archive workerd
  cases passed: 109 synthetic scenarios total.
- New adversarial checks cover both reserve/recovery races, lost acknowledgements,
  restart, duplicate requests, active leases, rollback, old payment discovery,
  wrong owner, invalid fields, stale blockhashes, bounded windows, incomplete
  reference scans and RPC outages.
- Browser and workerd network transports used synthetic fixtures and denied
  unexpected external calls. The recovery screen was visually inspected.

No production order, wallet approval, SOL transfer or Arweave submission was
performed during these checks. Mainnet configuration, price, recipients, treasury
budgets and existing browser storage were not changed. Actual wallet approval and
archive completion still require the owner to continue the original attempt on
the original browser origin after the accepted build is published.

## Hosted browser startup follow-up

The first hosted run for `e5ab8662c8a82ef9786f67dfd64722d1d8a105fd`
passed its unit, runtime and build checks, then stopped during setup of the
existing wallet-history browser test: the page's execution context was destroyed
before that test's assertions. Vite diagnostics reproduced late discovery of
`vite-plugin-node-polyfills/shims/buffer` and the resulting development-page
reload. The existing checkout test config already prebundles this exact shim.

Cold-cache comparison with that test-only config showed one initial optimization
and no late dependency discovery/reload; its target case and all 21 native
browser scenarios passed. Other suites also import signer fixtures immediately,
so the final fix prebundles the exact same shim in the shared development
optimizer. This avoids relying on another suite's warm cache. No assertion,
retry policy, payment logic or production build input was changed. The optional
native browser executable setting permits the same real test config to run in
this Linux workspace.

The native production build was repeated with the same flags after the optimizer
change: all 33 output files remained byte-for-byte identical.

## Published acceptance

- Accepted source: `cf4f6fbefe26d0144fa10a122470d37dac942b60` on
  `feat/promo-funded-preservation`. Full [SEJIRE checks 41065339626](https://github.com/azovskaya/sejire_arweave_solana/actions/runs/41065339626)
  completed successfully, including all paid browser and cold-start regressions.
- Accepted `native-admin-build`: artifact `12982233511`, ZIP SHA-256
  `d80489f66422b16005105a5bdf18d8ab7e92c393fef7148b0285c72f5290e087`.
  Preview staging `41065339631` succeeded. The root overlay reused all 34 exact
  native blobs including provenance, preserved all 90 older assets (94 total),
  and preserved the other published paths without deletions.
- Static parent: `fee47d32d818a39d43845c6ff4bbb422c6c28526`; tree
  `510f35309285b762581f42e331d2284fa78f4973`. Release commit:
  `6fcb89ac70474f814f6d7f1d5d6640b0da615285` on `gh-pages`.
  [Publication 41067629885](https://github.com/azovskaya/sejire_arweave_solana/actions/runs/41067629885)
  passed every artifact-byte, provenance, parent/tree and current-head gate and
  deployed successfully with the existing Pages environment protections.
- Worker recovery code `e5ab8662c8a82ef9786f67dfd64722d1d8a105fd` was deployed by
  [Worker run 41063346828](https://github.com/azovskaya/sejire_arweave_solana/actions/runs/41063346828).
  After deployment, production `/rpc-health` and `/policy` both returned HTTP 200
  and `ready:true`; the ten read-only Solana RPC checks completed. The final
  source follow-up changed only the development optimizer, browser executable
  option and this verification record, so no second Worker deployment was needed.
- Public HTTPS `index.html`, `build-provenance.json` and
  `assets/index-1fklctgL.js` matched the accepted Git blob hashes. The live bundle
  contains the three new wallet recovery labels. Managed Chrome loaded that
  exact bundle; the public welcome screen and transition to the recovery form
  worked without a wallet or recovery words. No application-origin console error
  was observed. The standalone container-browser smoke could not complete due
  to its DNS/proxy certificate environment; its two-viewport result is not claimed.

The owner must now continue the original attempt in the original browser tab:
reload the site, open the pending save if needed, and explicitly choose
“Восстановить подтверждение”. The server either finds and continues the original
payment or returns a fresh preparation for separate review and wallet approval.
No real payment or archive completion has been verified by these release checks.

## Unresolved recovery result visibility

A later owner screen exposed a separate UI problem. A failed recovery POST keeps
the durable recovery marker, as required, but a successful background GET of the
unchanged preparation cleared the generic error. Because those polls deliberately
do not repeat recovery, the screen could continue saying recovery was in progress
without displaying the rejected request's result. The screen alone did not prove
an active server job or establish why that request failed.

The UI now keeps a separate recovery failure for the operation and preparation.
Successful checks of that same unresolved preparation preserve the message next
to the recovery action. An admitted explicit retry clears the prior failure;
an accepted successor, known payment/signature, terminal state or different
operation clears it as well. Connecting a wallet does not clear this failure.

A persisted marker without a current recovery action now shows
“Восстановление не завершено” and “Повторить восстановление”. Its text explains
that polling only checks the result and that another request requires the button.
Only the admitted recovery action displays “Проверяем возможность восстановления”.
Reload still preserves the original operation and marker; without a persisted
POST error, the screen honestly says the result is unknown. Successful recovery
requires fresh amount/fee consent and a separate wallet-confirmation action.

This follow-up changes the component and synthetic browser coverage only. The
client protocol, journal schema, server, recovery leases and payment boundaries
are unchanged. No owner order API, wallet, SOL transfer or archive submission was
used for this follow-up.

Local verification for this follow-up:

- The full paid browser suite passed **23/23** scenarios using the existing
  synthetic transport and Chromium executable. The two new regressions cover
  rejected recovery followed by unchanged successful automatic/manual checks,
  an admitted explicit retry with fresh consent and zero premature wallet calls,
  a neutral persisted-marker screen after reload, and removal of an in-memory
  failure only after GET adopts a committed successor whose POST reply was lost.
- Native production build passed with the same published Worker URL and existing
  build flags. Web lint passed with no errors and 17 unchanged warnings outside
  this component. `git diff --check` passed.
- Independent review found no new automatic recovery, signing, order creation,
  payment, cancellation or journal mutation. Backend code remains unchanged.

The browser suite command was `SEJIRE_BROWSER_EXECUTABLE=<existing Chromium>
SEJIRE_BROWSER_CHANNEL=chromium npm run test:paid-browser` from `apps/web`.
Source acceptance and public publication are recorded separately after the
mandatory exact-source hosted checks.
