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
