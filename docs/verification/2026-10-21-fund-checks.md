# Fund verification correction — 21 October 2026

## Observed user result

The owner's 20 October screenshots still show the existing funded attempt at
Arweave confirmation, with a fresh check timestamp and an unfinished archive
check. The canonical data link also returns a gateway 404. The 19 October
deployment therefore did not establish completion of this user's order.

Do not create a replacement order, ask for another free-save click, clear browser
storage, request recovery words, or request the owner's Admin token.

## Fresh public evidence

On 21 October at 06:43:39 UTC / 11:43:39 Asia/Almaty, ordinary public GETs returned:

- TX: `BRw9ARMTCfRgaABRSIumqiR5VBUtOvRu4wrQ88TtSPs`.
- `arweave.net/tx/<id>/status`: HTTP 200, block 2023994, 1748 confirmations.
- `arweave.net/tx/<id>`: HTTP 200, 2282 bytes. ID matches, public owner derives to
  `qgoIFw9WsusMRapWzcFg4jNW08HSWvQkpAKOz86BUuI`, reward is 3408198040 winston,
  and data size is 39305 bytes.
- `arweave.net/tx/<id>/data`: HTTP 200, 52407 encoded bytes, 39305 decoded bytes;
  SHA-256 is `08921aedb2c30bbbb1f2b24f48d232df1575a956076e70fc9fa16556dc350f32`,
  matching the original archive.
- The corresponding g8way responses were HTTP 200 with 195-byte bodies. Status
  and metadata did not parse as JSON; the data response did not match the archive.

The first executor attempt failed before HTTP with URLError. The successful run
used the platform's approved network permission for these same public reads. It
did not access Worker/Admin, change user agents, bypass a site challenge, decrypt
data, create an order, sign, submit, or spend funds. The public RSA modulus used
by the regression tests comes only from transaction metadata; it contains no
private key material.

Public chain confirmation and ciphertext integrity do not prove the current
Fund ledger status, Actual confirmed spend, or cleared reservations. Worker/Admin
access from this environment remains unavailable after the previously observed
Cloudflare 1010 denial. Do not route around that protection.

## Worker incompatibility reproduced before network access

Adding a real DirectArweaveFundProvider read to the workerd runtime harness
failed with `transaction_unavailable`, even though its mocked gateway responses
contained valid confirmation, metadata and ciphertext. The previous runtime
suite used MockFundedArweaveProvider and never exercised these fetch options.

An isolated Request-construction check in the same workerd compatibility date
(`2026-07-01`, `nodejs_compat`) established that `redirect: 'error'` throws before
any outbound request, while `manual` and `follow` are accepted. The deployed
provider used `error` for status, metadata and node-data GETs. Its catch blocks
converted the exception into the network-unavailable state shown by the UI.

The [Cloudflare Request documentation](https://developers.cloudflare.com/workers/runtime-apis/request/)
also specifies this runtime limitation. The correction uses `manual` for the
three exact-endpoint reads and rejects redirect responses without following
them. Exact URL, HTTP status, owner/reward and archive checks remain required.
Browser-only recovery requests retain their supported redirect behavior.

This is a reproduced runtime incompatibility in the production code path, not
just a gateway-latency hypothesis. Production ledger completion must still be
distinguished from the successful runtime test and deployment.

## Additional defects in the previous provider

Three isolated, offline reproductions demonstrated:

1. A first-gateway HTTP 202 immediately returned pending without consulting a
   second gateway that could have confirmed the transaction.
2. A valid status on one gateway and valid metadata on the other could not be
   combined. A failed same-gateway metadata response caused an unavailable result.
3. Four serial raw/canonical reads could exhaust the shared 22-second deadline
   before the working `/tx/<id>/data` candidate was even attempted.

The integration regression additionally reproduces an existing order remaining
VERIFYING despite available confirmation, valid metadata and exact archive data.
It uses the actual DirectArweaveFundProvider, mocked public fetch responses and a
real local SQLite ledger. No production order is used by the tests.

These are demonstrated algorithm defects. The precise failing response inside
the production Worker is not observable here; do not claim the reproductions
identify that response with certainty.

## Correction and acceptance

The three Worker-only exact-endpoint reads now use `redirect: 'manual'`.
Redirect HTTP responses are rejected without following their Location, and the
exact response URL is still checked. Fifteen negative tests cover the three
endpoints and HTTP 301/302/303/307/308 with valid-looking response bodies.

Status and metadata reads run concurrently across the two configured mainnet
gateways. A stale pending response cannot hide valid confirmed evidence from the
other gateway, and valid same-TX treasury metadata may come from either gateway.
HTTP 200 with zero confirmations still requires valid metadata. Missing,
contradictory or incorrect metadata cannot complete an order. Four bounded
archive-read chains start together, including node-data, so slow raw/canonical
reads do not prevent a working data response. The common 22-second deadline,
exact size/hash/envelope/vault checks, and cancellation of losing requests remain.

The UI now says that a check could not be completed when the provider is
unavailable, instead of describing that state as normal slow confirmation. It
continues polling the same durable order, shows the time of the latest check,
and keeps transaction metadata in the technical details. It does not offer a
replacement save or treat unavailable status as a failed transaction.

Local acceptance:

- Root `npm test`: PASS, including the real SQLite existing-order regression.
- Provider tests: PASS, including stale 202, split gateway evidence, HTTP 200/0
  validation, request/body deadlines, cancellation, and rejected redirects.
- Sponsor TypeScript: PASS.
- `npm run test:fund-runtime`: all 17 checks PASS, including the actual Direct
  provider inside workerd; all external network connections are disabled by the
  harness. This new check failed before the redirect correction and passed after.
- Promo browser scenarios: 22/22 PASS, with external HTTP/WebSocket/wallet calls
  blocked. The resumed order polls without POST or a second save, survives
  unavailable/confirmed/pending transitions, completes, and stops polling.
- Native production build and fund browser security scan: PASS.
- Web lint: zero errors, 16 existing warnings. `git diff --check`: PASS.
- Independent final review: PASS, including redirect rejection, public-only
  owner fixture, test-only runtime entry, and exactly-once ledger behavior.

The integration test first gives the confirmed transaction an incorrect positive
reward: the order stays in reconciliation, reserve stays held, and actual spend
does not increase. A later GET of the same order with correct metadata and the
verified archive completes it once. Repeated GETs make no new gateway request,
signature, submission or ledger charge. Production ledger code is unchanged.

Publication evidence will be appended after the accepted CI artifact, actual
Worker deploy, actual Pages deploy, and public site bytes have been verified.
