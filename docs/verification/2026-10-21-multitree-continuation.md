# Working-project continuation — 21 October 2026

The owner requested a working project on GitHub first, followed by migration of the accepted release to `sejire.ar.io`. This change improves repeated promo preservation and recovery. It also repairs the existing devnet checkout transport; it does not launch mainnet SOL payments or move the ArNS record.

Source baseline: `bce6fb04c2ef05bfa9e3fe2bb04f6367630db7c7`, branch `feat/promo-funded-preservation`. The previously published Fund runtime correction is documented in [fund checks](2026-10-21-fund-checks.md).

## User flow

Going home and creating another tree now retain the archive already unlocked in the current tab. After the initial words and promo choice, each subsequent tree or edit can use one explicit **Сохранить бесплатно** click. A separate **Закрыть архив** action clears the mnemonic from memory, session metadata and that vault's remembered promo. It retains the draft, encrypted history and any unresolved request. Recovery words are not persisted to browser storage.

Preparing a new version uses the same metadata, exact byte-size, SHA-256, envelope, vault and AES-GCM verification as recovery. The native `/tx/<id>/data` fallback is available during preservation preparation, not only when opening an archive. A stale index cannot substitute an older, smaller vault for a known HEAD. A fallback must be the exact locally archived HEAD or have bytes matching that HEAD's verified size and digest; an unbound generic cache is not proof of the current version.

Index, metadata and peer-list reads now bound the complete HTTP response, including a stalled body. Their JSON limit is 2 MiB; the existing archive limit remains 10 MiB. Preservation preparation has a shared 45-second deadline. Cancellation prevents starting additional gateways. The old discovery list now uses the same mainnet Turbo gateway already used by recovery, instead of `ar-io.dev`.

## Parent links and rolling compatibility

The client sends `parentTxId` from its persisted attempt before the order POST. The server binds it immutably in the same SQLite transaction as the reservation and includes `Parent-Tx` in the prepared/signed Arweave tags. A changed parent is rejected before signing or resubmission. Client response checks prevent a mismatching parent from finalizing the editor or discarding the pending archive.

| Request or stored order | Binding and response |
| --- | --- |
| New client with an explicit TX ID | Bound parent, signed `Parent-Tx`, exact response echo |
| New client with explicit `null` | Bound genesis, response `parentTxId: null` |
| Still-open old client omitting the field | Legacy unbound request; response omits the field |
| Historical prepared or signed order | Original bytes and ID retained; no retrofitted parent |

The additive `fund_order_links` table preserves the old ten-column `fund_orders` layout. Distinguishing omission from explicit null is necessary: the old browser already stored a local parent but never sent it to the server. Declaring such an old request to be bound to null would prevent its recovery after an application update.

Historical immutable transactions without `Parent-Tx` are not rewritten. If discovery finds multiple independent historical tips, the existing verified-branch choice can still be appropriate. New parent links prevent future accidental breaks; they do not manufacture evidence of an old relationship.

## Checkout runtime correction

The existing devnet checkout had two failures hidden by tests that injected JavaScript transport functions:

1. Cloudflare workerd rejects `redirect: 'error'` before HTTP. RPC, uploader readiness, upload and retrieval now use `manual` and refuse 30x responses without following their location.
2. Assigning bare `fetch` to an instance property and invoking it as a method produced `Illegal invocation`. Default transports now call global `fetch` through an arrow wrapper.

The expected RPC response URL is canonicalized, including the root trailing slash. Network/genesis/finality, JSON-RPC identity, archive binding, exact signed-item persistence, receipt identity and the sandbox `winc=0` rule remain in force. No payment amount, recipient, network or enable flag changed.

The new workerd test goes through `application.fetch` and its default dependencies, with wire responses mocked outside the Worker. This exercises the genuine global-fetch boundary that the old injected transports skipped. Its mock bridge preserves one HTTP hop so Node does not follow a redirect before workerd can reject it. Unmatched external connections are disabled.

## Local evidence

All archives, words, payment evidence and signer fixtures used by these tests are synthetic. No new production order, live payment or Arweave submission was created.

| Check | Result / purpose |
| --- | --- |
| Root `npm test` | PASS: web, sponsor, RPC, Fund and encryption compatibility suites |
| Sponsor and web TypeScript | PASS |
| Fund SQLite tests | 24 scenarios PASS, including immutable parent, old-client omission and old-schema upgrade |
| Fund workerd tests | 18 checks PASS, including parent persistence after process restart |
| Checkout workerd tests | 32 scenarios PASS: 24 prior cases plus 8 default-adapter cases |
| RPC selftest | 57 cases PASS, including 30x rejection and canonical endpoint URL |
| Preservation and preparation selftests | PASS |
| Loader, gateways and recovery selftests | PASS: node-data fallback, body deadlines, cancellation and complete-vault preservation |
| Promo browser suite | 25/25 PASS in the final complete run, including three-tree continuation, explicit archive close and changed-parent recovery |
| Native build | PASS |
| Fund security scan and native dependency boundary | PASS |
| Lint | 0 errors; 16 pre-existing warnings |

The new browser journey creates three separate trees through the real editor, preserves them with one explicit click per subsequent tree and checks payloads containing 1 → 2 → 3 trees. The index remains stale at the first version while the exact latest local history exists. Each POST parent matches the journal and previous TX. A clean browser then opens the final complete archive by its words using raw-404/node-data-success fixtures, with no false fork picker. The close-archive journey verifies that draft and encrypted history remain. The changed-parent journey keeps the original pending archive until correct evidence arrives, then completes without another POST.

Independent review found and corrected the RPC trailing-slash issue, the old-client omitted-parent compatibility problem, and the unsafe generic-cache fallback. The default-adapter runtime test independently exposed the fetch receiver failure.

## Remaining release boundaries

- The production Fund ledger has not been read after the earlier runtime fix. Public Arweave confirmation and a successful Worker deployment do not establish internal COMPLETED, actual spend or released reservations. The known Cloudflare protection is not bypassed; no new save is requested to diagnose the old orders.
- General mainnet SOL preservation is not yet connected. The modern UI's older V2 paid path pins one devnet payer and archive and requires the treasury's Wander wallet. The separate general checkout is devnet-only and uses a sandbox uploader. A flag change is not a production payment implementation.
- A full paid path still needs its agreed mainnet payment policy, production archive executor, recovery tags/parent binding and modern-editor completion, followed by real-wallet acceptance with a reviewed amount. Tests with software signers or synthetic RPC evidence do not establish that acceptance.
- ArNS migration remains deferred. The approved GitHub artifact, release provenance and resulting published content must be verified first. The old permaweb deploy script rebuilds a different configuration and must not be used to publish this accepted artifact.

## Publication evidence

The exact accepted source, CI run, artifact digest, Worker version, Pages release and public byte checks are recorded here after the release completes. This section is not a claim of deployment or of production order completion.
