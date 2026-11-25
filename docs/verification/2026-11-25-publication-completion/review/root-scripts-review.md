# Independent review: portable release and Linux backups

Reviewer: frontend/public-release agent. Date: 2026-11-25.

Full reads: `scripts/portable-funded-profile.mjs`, `scripts/build-arns-portable-funded.mjs`, `scripts/permaweb-release.mjs` including the profile diff, `scripts/verify-portable-service.mts`, `scripts/linux-backup.mjs`, `scripts/linux-backup-cli.mjs`. Targeted supporting reads traced the CI evidence validator, current workflow diff, service startup, fund readiness/availability and treasury accounting. The added `apps/sponsor/linux-writer.mjs` was read fully for the fix review.

## Findings and fixes

1. **Restore/startup interleaving could bypass the review marker.** Startup could observe a missing marker, wait for writer acquisition, then open an older snapshot which restore had published during that wait. The old restore path did not take startup's kernel guard. The corrected paths share `linux-writer.mjs`; startup repeats the marker check while holding the guard, before opening or initializing the ledger and before alarms. Restore and acknowledgement also hold this guard.

   Independent regression `scripts/linux-backup-startup-race.test.mjs` passes (1/1). It uses temporary real SQLite files and a narrowly scoped filesystem scheduling barrier: startup's first marker lookup has already returned ENOENT, restore finishes publishing the snapshot and marker, then startup resumes. Startup must reject with `linux_restore_review_required`. The entire restored database SHA, synthetic signed bytes and marker remain unchanged; no `fund_jobs` table is initialized. No order, signature, upload or external request is performed. The previous implementation was not executed; this is not claimed as a measured red/green run.

2. **Durability ordering did not synchronize directory entries.** Files were synchronized, but marker creation and database publication had no explicit parent-directory synchronization. The revised restore synchronizes the marker and parent before `link`, synchronizes the parent after publication and cleanup, and acknowledgement durably records its evidence before removing the blocking marker. Backup creation also synchronizes the snapshot directory and backup root. This ordering was reviewed in source; a power interruption was not simulated.

3. **The production preflight could report funded budget ready while all physical AR was already committed.** It previously compared the gross wallet balance and promo budget with a 6144-byte quote, ignoring the shared paid/promo holds and conservative treasury ceiling. The readiness endpoint now quotes the configured archive cap and returns `fundAvailable`, computed as the smaller of remaining promo budget and guarded physical balance minus all shared holds. Preflight requires the advertised 524288-byte quote, sufficient effective availability and consistency with gross balance, holds and budget. The new negative test cases cover exhausted effective funds, contradictory gross/held figures and the old small quote. These changes were reviewed; their execution belongs to the root/backend suites and is not claimed here.

## Gate and disclosure review

No new weakening was found in the exact branch, commit, CI attempt, workflow, job, artifact digest or release profile checks. The independent and portable-funded profiles keep separate branch/artifact contracts. Final bundle bytes are bound to the captured module graph; the portable build requires the funded UI modules, rejects bundled Worker/bundler code and includes standalone recovery files. The build prints that live service and owner acceptance are separate requirements.

The service preflight uses GET/OPTIONS, bounded responses and fixed diagnostic codes. It does not call order, prepare or signing routes, print the admin credential or claim a real payment/recovery acceptance. Backup restores use no-replace publication and preserve the review gate; acknowledgement is explicitly an operator statement, not an automatic reconciliation of external payments.

## Verification limits

This was a source review plus the one independent deterministic startup/restore regression. Root's production builds, broader Node/backend suites and later CI runs remain separate evidence. No real server deployment, database import, account access, production credential read, wallet signature, payment or archive upload occurred. Filesystem durability under actual power loss and an operator's reconciliation of a historical ledger remain operational acceptance requirements.

## Offline ledger migration addendum

Full reads of `apps/sponsor/ledger-snapshot.mjs`, `apps/sponsor/bin/import-ledger.mjs` and `apps/sponsor/src/checkout/migrationSnapshot.ts` found no additional blocker in their current code.

The importer requires a private regular snapshot file, validates the explicitly supplied source digest, table hashes and trusted destination column contract before touching the destination, and accepts only a new destination. It shares the kernel guard with startup/restore/review, durably publishes an incomplete blocking marker before creating the database, and leaves that marker on failure. Each original table's columns, rowids and values are read back inside the import transaction and compared exactly; foreign keys, schema version, singleton rows and integrity are checked. Sequence counters are retained. The two compatible additive columns and missing historical promo queue reconstruction are explicit rather than silent changes to source order bytes.

Completion checkpoints WAL, closes/synchronizes the database and records its digest in the replacement review marker. Import does not call the executor or service startup and does not clear the operator-review barrier. The source's stopped admissions/alarms and drained jobs are an explicit prerequisite; the exporter does not claim it can freeze a live source, and it additionally rejects active leases. These three files were reviewed, but this reviewer did not execute the migration suite or import a real ledger. Scope was closed after these files.
