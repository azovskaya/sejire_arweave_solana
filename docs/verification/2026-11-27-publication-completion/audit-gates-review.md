# Production dependency audit gates — 27 November 2026

Scope: four-file process fix on `feat/funded-portable-release-20261125`, local base `b0f294fc6ecd4d0bc68526bea2cf9e4d6a8ca196` (remote equivalent `ba6777ac9c780627a6cdceafe947fed08ddaca63`, base tree `79e4286c3217bc5b59abcfd2a76905b221b932be`). No dependency version, lockfile, runtime or product behavior changed. No commit or push performed by the patch author.

## Change

- `.github/workflows/checks.yml`: web and sponsor production audits now block on `--audit-level=high`; explicit Bash/pipefail retains a nonzero npm exit through `tee`. All four audit steps and the JSON artifact upload use `if: always()`, so a failed production audit does not suppress the remaining reports. Both full dev/test audits retain `continue-on-error: true`.
- `.github/workflows/permaweb-portable.yml`: cache both lockfiles, install sponsor production dependencies with `--omit=dev --ignore-scripts`, and run fresh blocking production audits for both web and sponsor before owner/upload steps.
- `deployment/Dockerfile`: the production dependencies stage runs the blocking sponsor audit in the existing `&&` chain before cache cleanup and the final image.
- `deployment/README.md`: require the explicit fresh sponsor production audit and `docker build --pull --no-cache`; explain that cached audit layers must not replace the fresh deployment check. Audit retrieval errors and high/critical findings stop release.

## Release-gate compatibility

Before editing, read `scripts/worker-release-gate.mjs` and its audit-name references. The only allowed skipped-step name is `Preserve checkout failure diagnostics`; it remains unchanged. No code relies on the previous audit-step names. The source/attempt/artifact acceptance gate was not modified.

## Verification actually performed

- YAML parsing: both changed workflows PASS.
- `bash -n`: 73 workflow run blocks PASS.
- `sh -n`: all four Dockerfile RUN shell fragments PASS; this is not Docker execution or a full Dockerfile engine validation.
- `bash -n`: changed operator command block PASS.
- `git diff --check`: PASS.
- Independent source review by `/root/public_release_audit/remaining_gate_review`: PASS, no concrete issue found. Reviewer checked the exact four-file diff, failure propagation through `tee`/`&&`, continued report collection, full-audit nonblocking behavior, manual release installation/cache/audits, and cache-freshness documentation.

No mirrored string tests were added. No actual audit request, npm install, Docker build, browser test, production action or secret read was performed in this patch phase. Actual audit results and Docker/full CI verification are pending the new source commit. Run `45603078598` attempt 3 still belongs to the old `ba6777ac` source; its artifact cannot establish final acceptance for this changed source.

## Frozen hashes

SHA-256 of `git diff -- .github/workflows/checks.yml .github/workflows/permaweb-portable.yml deployment/Dockerfile deployment/README.md`:

`26001ce512ece77eca3ea910e42ed75e1aba0a4a4c2298e82f188321e4e2385c`

| File | SHA-256 |
| --- | --- |
| `.github/workflows/checks.yml` | `60ba4a00e99482e24e3be239387abc138d0321d5b53d15a04188c60f81922e37` |
| `.github/workflows/permaweb-portable.yml` | `fb8ed659fc4f0f8674aa3a24c06274c0afdf5713ee99443c38d2a467e120e2f7` |
| `deployment/Dockerfile` | `3c979b2986b3091507c0ab19a6642e201c216d9c800d9b7ec8f445ad10183696` |
| `deployment/README.md` | `7635d0b0bebfe35d631c417b89b025b7d5207599df43a58de0a7b896bc579d90` |
