# Критичные риски переноса GitHub Pages → sejire.ar.io

Дата: **3 ноября 2026** (Asia/Calcutta). База аудита: ветка `fix/paid-one-action`, HEAD `74abd62`. Код не менялся; только анализ. ArNS / mainnet spend / upload **не выполнялись**.

## Вердикт

Статический `sejire.ar.io` сам по себе **не заменяет** Cloudflare Worker. Текущий `deploy:permaweb` / `web:build:arns` собирает **другой** продукт, чем принятый Pages `native-admin-build`. В committed `wrangler.toml` уже включены paid/fund на **mainnet-beta**. Незавершённые journals с `github.io` на ArNS **не переносятся**.

## CRITICAL

### 1. `deploy:permaweb` пересобирает «не тот» SPA

`scripts/deploy-permaweb.sh` и `web:build:arns` ставят только `VITE_PUBLISH_MODE=self`, **без** `VITE_PRESERVATION_V2_ENABLED`, **без** `VITE_FUND_API_URL` / `VITE_CHECKOUT_API_URL`. Workflow `.github/workflows/permaweb.yml` вызывает именно этот путь.

Принятый CI artifact наоборот: `VITE_FUND_API_URL=https://sejire-sponsor.azovskaya-alissa.workers.dev npm run native:build` (см. `.github/workflows/checks.yml`).

**Риск:** залить на ArNS пакет без promo/paid Worker URL и без V2 UI. Уже предупреждено в `docs/verification/2026-10-21-dual-route-acceptance.md`.

### 2. Fallback API → `location.origin` на статическом Arweave

`apps/web/src/lib/fund/client.ts` и `apps/web/src/lib/checkout/paidClient.ts`: если env URL не запечён, endpoint = `location.origin + '/api/fund|checkout'`.

На `https://sejire.ar.io` этих маршрутов нет → promo/paid мертвы, если бандл собран без Worker URL.

### 3. ArNS ≠ backend

Fund/Checkout ledger живут в Worker `sejire-sponsor` (`apps/sponsor`). Перенос UI не переносит Durable Object, секреты treasury JWK, promo secret, RPC, admin token.

### 4. Worker в Git уже в режиме mainnet spend

`apps/sponsor/wrangler.toml`:

- `FUND_API_ENABLED=true`
- `CHECKOUT_PAID_ENABLED=true`, `CHECKOUT_PAID_EXECUTION_ENABLED=true`
- `CHECKOUT_PAID_NETWORK=mainnet-beta`
- AR budget / max reward заданы; treasury `qgoIFw9WsusMRapWzcFg4jNW08HSWvQkpAKOz86BUuI`

Часть docs всё ещё пишет, что production paid admission выключен. **Committed config — включён.** Публичный сайт + живой Worker без отдельной owner-приёмки recipients/budgets = реальные расходы.

### 5. Принятый `native:build` всё ещё DEVNET/pilot в клиенте

`package.json` `native:build` → `VITE_SOLANA_NETWORK=devnet`, `VITE_NATIVE_AR_PILOT=1`, `VITE_NATIVE_SOL_MAINNET=0`, broadcast off. Legacy Turbo указывает на `*.ar-io.dev`. Worker policy может быть mainnet — смешанный бандл опасен для «вечного» публичного сайта.

## HIGH

### 6. Origin isolation github.io → sejire.ar.io

IndexedDB / localStorage (`sejire-checkout-journal`, fund attempts, drafts) привязаны к origin. Незавершённая оплата на Pages **не видна** на ArNS → риск второго order / повторного платежа.

### 7. CORS allowlist узкий

`CHECKOUT_ALLOWED_ORIGINS` = только `https://azovskaya.github.io` и `https://sejire.ar.io`. Открытие через `*.arweave.net`, txid underlay или другой gateway → `origin_denied`.

### 8. Path underlay без trailing slash + `base: "./"`

Относительные `./assets/…` на URL вида `…/TXID` (без `/`) резолвятся мимо манифеста. Subdomain ArNS обычно ок.

### 9. Публичные `#/admin` и `#/fund-admin`

Hash-маршруты доступны без `VITE_QA_TOOLS`. Защита — `ADMIN_TOKEN` на Worker; поверхность всё равно на вечном origin.

## Уже подготовлено правильно

- `vite.config.ts` `base: "./"`; hash-роутинг `#/save`, `#/restore`
- Нет service worker registration в web src
- `siteMirror.ts` не показывает Pages-предупреждение на `*.ar.io`
- CI кладёт `permaweb-static-release` после native build + `permaweb:prepare`

## Минимальный безопасный cutover (без исполнения здесь)

1. Брать **принятый** `native-admin-build` / `permaweb-static-release` с запечённым Worker URL — **не** `npm run deploy:permaweb`.
2. Сверить bytes до смены ArNS Target.
3. Smoke с origin `https://sejire.ar.io`: Fund validate + checkout policy (CORS).
4. Незавершённые journals закрывать на старом origin; не ждать автомиграции.
5. Отдельная owner-приёмка Worker mainnet flags / recipients / budgets до объявления production.

## Граница отчёта

Аудит кода и конфигурации в Git. Живой deploy Worker, чтение секретов, ArNS Target, реальные платежи и upload **не выполнялись**.
