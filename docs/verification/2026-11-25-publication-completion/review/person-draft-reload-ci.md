# Raw profile preservation after reload — 25 November 2026

## Observed failure

GitHub CI [45599285860](https://github.com/azovskaya/sejire_arweave_solana/actions/runs/45599285860), remote candidate `66512ee`, reported 23/24 editor safety tests passed. The first same-event input test failed after its second reload: the saved notes lost their final space. Its earlier assertion after the first reload passed, and the name written immediately before the second reload retained its final space. This was a runtime data-preservation defect, not a timing allowance to relax in the test.

Root downloaded and verified diagnostic artifact `15015870090`, SHA-256 `d1b971a9641de77e1cbf5172be78fd50081a8d2595897f9865e8e690b8bac59a`. Read the supplied `editor-safety-the-final-in-99950-ask-before-immediate-reload/error-context.md`; the editor is mounted with its writer ownership and the new name. The exact assertion result and CI counts were supplied by root from the job log. Independent 78/78 and portable 33/33 in that run do not establish success for this changed runtime.

## Cause and fix

`loadDraftTree → coerceTreeStore → normalizePerson` preserves raw string values. After the first reload, opening the profile calls `Workspace.openProfile → captureEditorStore → PersonPanel.flush`. The mounted panel is still pristine, but the former `buildPerson` trimmed every text field and normalized every date. Merely opening the card therefore changed an unrelated saved note before the second input. The same path could alter partial dates and spaces in names and facts.

The profile capture helper now copies editable values exactly. Both synchronous input persistence and imperative flush use the same `buildPersonDraft` helper. Identity, relationships, media and deletion state continue to come from the live tree. A pristine flush compares equal and does not call `onChange`. `DateTextInput` retains its existing field-specific `onBlur` conversion; it is not called by profile capture. No draft parser, tree engine, schema, historical archive, encryption, digest or journal implementation changed.

The browser regression retains every previous assertion and adds a check immediately after reopening the card. It also enters the partial date `" 19 "` with the native input setter, dispatches the input event and reloads in the same event task. After another profile open, the test requires that date, the name and the notes to remain exact, with both commits and version indices intact. It retains the existing no-external-request/no-write/no-console-error checks. No retry, sleep or timeout increase was added.

## Executed evidence

Before changing the behavior, the old `buildPerson` implementation was moved verbatim into the extracted helper. The new focused Node tests failed **2/2**. The first failed on the same notes string and lost final space as CI; the second exposed the untouched date/name/fact conversions. See [person-draft-red.stdout.txt](person-draft-red.stdout.txt).

After removing implicit normalization:

| Check | Actual result | Evidence |
| --- | --- | --- |
| Focused profile capture, real draft save/load, pristine reopen, other-field edit, structural fields and immutable history | 2/2 PASS | [person-draft-green.stdout.txt](person-draft-green.stdout.txt) |
| Existing tree JSON and history validation | PASS | [person-draft-tree-json.stdout.txt](person-draft-tree-json.stdout.txt) |
| Existing explicit date normalization | PASS | [person-draft-dates.stdout.txt](person-draft-dates.stdout.txt) |
| Web application TypeScript | PASS, exit 0 | [person-draft-typecheck.stdout.txt](person-draft-typecheck.stdout.txt) |
| Editor browser test collection | 24 collected, exit 0 | [person-draft-editor-collection.stdout.txt](person-draft-editor-collection.stdout.txt) |

Browser execution for this fix is pending a new GitHub CI run. Local browser installation remains unavailable; collection is not execution. Root added the new Node test to the existing `test:storage` command so normal web/CI testing includes it. No broader suites, browser install retries, production builds, live services, real user data, wallet signatures or uploads were used for this targeted correction.

## Source manifest

Local base observed before this correction is `88b1c30f8d87a0eba47d094e83c4ff0cb5e85dbc` on `feat/funded-portable-release-20261125`. Root owns the later commit/push and remote source identity. Reviewed local files at freeze:

| File | SHA-256 |
| --- | --- |
| `apps/web/src/components/PersonPanel.tsx` | `b907cca8457442746fa05f486dc8b86fe2073c17824e9ffac975191f8b0fe76e` |
| `apps/web/src/lib/personDraft.ts` | `16adc6c9dd36d320737d82b9a8e910290a8a2d58f0f396f2e2b28a3624ac48bb` |
| `apps/web/src/lib/personDraft.selftest.ts` | `1cc0a206fe429dfb39eb40c5d245a0ac1d89d980e3e791526de0209d6ae8e4e8` |
| `apps/web/tests/editor-safety.spec.mjs` | `715375f3b4e6745ae971ef0d9af750d5889a012845ccc3e19f6e69c005dd9b65` |

The helper author did not commit or push; runtime/tests are frozen for root review and CI.
