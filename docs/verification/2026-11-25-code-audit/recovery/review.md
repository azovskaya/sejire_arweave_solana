# Recovery and PDF/export code audit — 25 November 2026

Base commit: `a2b738b`. This review owns `tools/recovery/` and
`apps/web/scripts/`; it does not modify application frontend, backend, release
scripts, or the accepted ZIP. No new defect requiring a code change was found
in this scope. Evidence and per-file hashes are in `summary.json` and
`coverage.json`.

## Fresh checks

- Standalone Node decoder tests: **12/12 PASS**, no skips.
- Production crypto interoperability: **PASS**, including fresh AES-GCM nonces
  and matching BIP39/PBKDF2/HKDF/vault-locator derivation.
- The adversarial interoperability suite passed **7 groups**: 16 complete
  synthetic vaults, 54 malformed envelopes, 51 ciphertext/nonce/truncation
  mutations, 16 wrong phrases, 41 invalid kits/receipts, 22 truncated or
  malformed files, four copied single-file CLI round trips, and two overwrite
  protections. External fetch count: **0**.
- `recovery.html` remains reproducibly generated from the same decoder core.
  The exact inline script/style hashes match its CSP; no external scripts,
  fonts, images, frames, or network loader are needed.

All test inputs are synthetic. Test logs were checked against the public vector
phrases, derived key values, and full payloads; those values are not in the logs.

## Reviewed boundaries

`recover.mjs` validates the fixed envelope fields and BIP39 checksum, enforces
the existing 10,485,760-character ciphertext bound and a 64 MiB outer-file
bound, and validates kit byte counts/digests before decrypting. The optional
receipt must match the same envelope, size and digest. Authenticated plaintext
is returned as its original bytes: no tree selection, coercion, history rewrite,
merging, or dropping of unknown fields occurs.

The CLI reads words from bounded stdin rather than command arguments. It creates
the plaintext output with exclusive creation and POSIX mode 0600, refuses an
existing output or symlink, leaves the ciphertext untouched, and prints fixed
status/error text instead of words, plaintext, or raw exceptions. A failed write
may leave a partial newly created output, as already documented; the input
remains available.

The browser interface never inserts archive text, metadata, or plaintext into
HTML. Status and errors use fixed `textContent`; plaintext is provided only as
an `application/json` Blob download with a fixed filename. A new input/phrase,
clear action, or page exit revokes the preceding download URL. The UI prevents
parallel submissions, clears words after successful decryption, and makes no
storage writes. Browser CSP specifies `connect-src 'none'` and
`form-action 'none'`.

The decoder intentionally recovers authenticated generic JSON, including old
formats. It does not establish application-level tree validity, find a newer
archive, or prove the completeness of every network version. Receipt validation
does not prove payment, transaction signing, inclusion, final settlement, or
future availability.

## Documented UTF-8 compatibility limit

A narrow synthetic probe authenticated plaintext containing an invalid UTF-8
byte inside a JSON string. The existing non-fatal `TextDecoder` parsing accepts
it using replacement decoding, while the standalone output retains the exact
authenticated bytes. Production `decryptJson` uses the same decoding behavior;
`FORMAT.md` explicitly describes compatibility with that reader.

This is **not an AES authentication bypass or loss of authenticated data**.
No current writer-generated invalid UTF-8 was found. Acceptance was deliberately
left unchanged, as directed by the parent audit, to avoid silently changing the
compatibility contract. The successful status is not a separate guarantee that
arbitrary authenticated byte payloads satisfy a strict UTF-8 validator.

## Reused browser and PDF evidence

The decoder, HTML generator, generated HTML and browser harness are unchanged
from the accepted source. The previous exact-SHA CI
[`45122610001`, attempt 1](https://github.com/azovskaya/sejire_arweave_solana/actions/runs/45122610001)
passed the OS-isolated local-file recovery gate in Chromium, Firefox and WebKit,
plus the isolation-parser test. This audit **did not repeat** that browser gate
and does not call its results fresh tests from 25 November. Linux WebKit is not
physical Safari/iOS acceptance.

Both PDF exporter source hashes, the stress generator and geometric checker
match the earlier validated versions. The previous 20-fixture matrix produced
**89/89 passing PDF files, 779 pages, zero findings**, with a maximum 8,191-person
tree and a 103-generation line. A separate 24 November inspection also reopened
those saved PDFs. No PDF generation or mass geometry validation was repeated
today.

The four export/QA/check scripts were reviewed as developer tools using fixed
synthetic fixtures and trusted manifests. They are absent from the accepted
emitted browser module graph. Their arbitrary developer-selected output paths
are not a public upload interface. The geometry checker measures saved PDF
glyph/card/connector positions and verifies expected names and paternal order;
it is not an exhaustive proof for every conceivable future tree or media asset.

## Accepted ZIP structure

The existing `17a254e` ZIP still has SHA-256
`f897aa1172986b595e39b76a7a8535da94b4a5be1886d21a7362cd099bcc5b60`.
The 41-entry namespace, all 39 manifest-file hashes, case-insensitive path
uniqueness, absence of traversal/symlink entries, and all eight recovery-file
hashes were checked. No `.env`, `.git`, key-file, or source-map entries occur in
that namespace. This is a structural artifact check, not a proof that all Git
history or all possible encoded secrets have been scanned. Public synthetic
crypto vectors are intentionally included and are not private wallet keys.

That accepted ZIP is the independent release. It does not contain SOL checkout,
promo saving or the payment/fund admin UI, and it does not represent new changes
in the current audit working tree. No upload, payment, real wallet signature,
deployment, or ArNS change was performed.
