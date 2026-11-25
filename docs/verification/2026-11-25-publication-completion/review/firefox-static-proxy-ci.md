# Firefox virtual-gateway fixture — CI 45597559533

## Evidence

Root reported CI source `413b06b`: independent acceptance passed 78/78, including the previous WebKit lock handoff fix. Portable acceptance failed 7/33, all Firefox: the previous-origin notice plus six deep manifest fallbacks. The portable localhost promo/landing checks and admin/Mainnet policy checks passed; Chromium and WebKit passed the portable cases.

Run: `45597559533`; job: `139147558076`; artifact: `15013908824`. Root verified artifact SHA-256 `5c980d87c2bd7f2dde718903d01e8e5b03e04953304304296ec50456af405ad9`. This reviewer read all seven extracted `error-context.md` files under `.cache/publication-completion/ci45597559533/diagnostics/`.

Every failure snapshot contains Vite's plain-text rejection: `Blocked request. This host (...) is not allowed`, naming the virtual ArNS/gateway host for that scenario. The browser did not receive the application document. This evidence does not indicate a hash-routing, draft ownership or legacy-state failure in the application.

## Root cause and correction

Two test proxy handlers used `route.fetch({ url: localhostPreviewUrl })`. In the failing Firefox requests, the relayed request retained the original virtual host, so the local Vite preview correctly rejected it. The independent manifest fixture already used a separate `context.request.get` to read the preview with its own Host header and passed Firefox in the same CI run.

Only `apps/web/tests/arns-hosted.spec.mjs` changed:

- Both proxy handlers now read the local preview using `context.request.get(localUrl, { maxRedirects: 0 })` and fulfill the original virtual-origin browser request with those static bytes.
- Both require an OK preview response before fulfilling. A fixture transport failure is now reported at that boundary.
- The deep-path proxy retains the request query string.

The original virtual host, deep path, browser URL, manifest base-path, script/CSS loading, previous-origin notice/link and forbidden-external-request assertions remain unchanged. No application runtime, `allowedHosts` setting, allowlist, timeout, expected text or test selection was changed. The fix does not allow the preview to accept arbitrary Host headers.

## Verification

Portable Playwright collection returned exit code 0 with all 33 entries. `git diff --check` passed. No local browser execution is claimed; the next exact-source CI run must establish the corrected portable browser result. No production service, wallet or public site was contacted by this fixture correction.
