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
- A full paid path still needs its mainnet payment policy, production archive executor, recovery tags/parent binding and modern-editor completion, followed by real-wallet acceptance with a reviewed amount. The service price is already 30,000,000 lamports (0.03 SOL); the initial contribution is zero and the Solana fee is separate. Production SOL recipients and a separate paid AR allocation have not been designated. Tests with software signers or synthetic RPC evidence do not establish that acceptance. The concrete next implementation contract is recorded in [Paid SOL implementation plan](../PAID_SOL_IMPLEMENTATION_PLAN.md), explicitly marked not implemented or enabled.
- ArNS migration remains deferred. The approved GitHub artifact, release provenance and resulting published content must be verified first. The old permaweb deploy script rebuilds a different configuration and must not be used to publish this accepted artifact.

## Publication evidence

Published on **21 October 2026**. The accepted source and release evidence are:

| Evidence | Accepted identity / result |
| --- | --- |
| Source commit | [`d6a8a00d4b85ef5e0e5c614c7c7a98319a9511f9`](https://github.com/azovskaya/sejire_arweave_solana/commit/d6a8a00d4b85ef5e0e5c614c7c7a98319a9511f9) |
| Source tree | `72f155ca12cfe9421633bb6c0e1dc93cdb25cf4d`, identical to the tested local tree |
| Full SEJIRE checks | [39582617992](https://github.com/azovskaya/sejire_arweave_solana/actions/runs/39582617992), success; includes all 25 promo browser tests, recovery, editor journeys, actual checkout/Fund workerd, native build and security checks |
| Fund runtime workflow | [39582618188](https://github.com/azovskaya/sejire_arweave_solana/actions/runs/39582618188), success |
| Worker deploy | [39582618205](https://github.com/azovskaya/sejire_arweave_solana/actions/runs/39582618205), success; actual `Deploy sejire-sponsor` step completed |
| Worker version | `820d37f7-484c-4d83-9171-8ce8891ec792` |
| Accepted native artifact | `native-admin-build`, ID `12337686315` |
| ZIP SHA-256 | `70c7e9d49bbd3aff7e1c95ccecbf795979262e951397f57aa3a1a7dda1773089` |
| Preview staging | [39582618027](https://github.com/azovskaya/sejire_arweave_solana/actions/runs/39582618027), success; gh-pages `7f4762076aa840da3e404f5077909dbb6461c65b` |
| Root + native static parent | `9cd06ad45da7665b4d6f29a0a5627f9a2ae1d5a5`; tree `efe0ac48c01e5b3a0c54e3e9d9c74f13daf21710` |
| Pages release | `ee8e96b66eab12b85e53aa443807b4cb2164b5a8`; tree `31be0d12dcfca74f2fdb9afad4eb7143b492330f` |
| Actual Pages deploy | [39584311913](https://github.com/azovskaya/sejire_arweave_solana/actions/runs/39584311913), job `119169298154`, success, including the deploy step |
| One-time release workflow | `publish-multitree-continuation.yml`, blob `e2be9ef4ff1e4e7e22c0ff1d9d18484b8339713d`; independently reviewed pins, syntax, environment and both head guards |

The CI ZIP was downloaded and its digest verified independently. All **33 build files plus provenance** in staged `/native-admin/` matched their expected Git blob IDs and sizes. The root overlay copied those exact files, preserved every unrelated blob and retained the existing admin verifier. The one-time release workflow publishes that static parent without rebuilding and refuses a stale gh-pages head before upload and deployment.

At **10:25:08 UTC / 15:25:08 Almaty**, ten ordinary public GETs returned HTTP 200 and matched the accepted HTML, main JavaScript, CSS, provenance and admin verifier, at both the [root editor](https://azovskaya.github.io/sejire_arweave_solana/) and [`/native-admin/`](https://azovskaya.github.io/sejire_arweave_solana/native-admin/). [Public byte-check evidence](2026-10-21-multitree-pages-public.json).

| Public file at each editor path | Git blob / bytes |
| --- | --- |
| `index.html` | `6d75b750eab67ba1b364a9cff61528e18b2822a0` / 1,103 |
| `assets/index-Bki41Hv1.js` | `5d284e6abf46c55d252b58e7b160c1e08a3dfe69` / 923,902 |
| `assets/index-D_DSbhqU.css` | `50162636ac2bf3d5cf03f4de7f65f8f6ed51e2d7` / 39,610 |
| `admin-lock.json` | `9abb055bad188dfe754e07e1bcff15344824e322` / 235; unchanged |

No new production order, SOL payment, production Arweave signature or submission was created during this work. ArNS was not changed. Successful checks, deployment and public file verification do not establish production Fund ledger completion or mainnet SOL acceptance. Existing non-blocking dependency audit findings remain subject to the project's release review; this update changes no dependency manifest or lockfile.
