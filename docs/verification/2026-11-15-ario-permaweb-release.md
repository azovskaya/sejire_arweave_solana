# Подготовка к sejire.ar.io — 15.11.2026

Ветка `cursor/ario-permaweb-release-5150`. Агент **не** загружал сайт в Arweave, **не** менял ArNS Target, **не** разворачивал Worker, **не** создавал заказы и **не** тратил средства.

## Состав ветки

- Основа: `fix/ario-20261110-editor-safety` `91d2acc` (редактор + ручной Worker release gate).
- Влито: `fix/restore-direct-data` — отдельный `/chunk` для всех размеров оплаченных архивов, запасной `/{id}` при чтении, видимость прежнего оплаченного заказа.
- Cherry-pick: ArNS promo cutover (запечённый Worker URL, `base: "./"`, `404.html`, verify/live/browser, `deploy:permaweb` через `build-arns-promo.sh`).
- Сохранён ручной Worker deploy только с `feat/promo-funded-preservation` + `DEPLOY` + точный успешный CI (не авто-push).

## Локальные проверки (Linux, Node 22.23.4)

| Проверка | Результат |
|----------|-----------|
| `npm test` | PASS |
| `npm run arns:build` / `arns:prepare` | PASS; Fund URL запечён; 33 файла; ~4.0 MiB |
| `npm run arns:live` | PASS; CORS `https://sejire.ar.io` → Worker; чужой Origin не отражается |
| `npm run test:fund` | PASS |
| `npm run test:fund-runtime` | PASS (disabled/write/restart/direct) |
| `npm run test:fund-browser` | 25/25 |
| `npm run test:arns-browser` | 2/2 |
| `npm run test:paid-browser` | 46/46 |
| editor Playwright (`playwright.editor.config.ts`) | 7/7 |
| `npm run security:fund` | PASS |
| `node --test scripts/worker-release-gate.test.mjs` | 53/53 |

Свежий smoke: `docs/verification/2026-11-03-arns-live-smoke.json` (`checkedAt` 15.11.2026 ~21:21 Екатеринбург / 16:21 UTC). Treasury `qgoIFw9WsusMRapWzcFg4jNW08HSWvQkpAKOz86BUuI`.

GitHub CI для `593dfbf`: [SEJIRE checks `43735513189`](https://github.com/azovskaya/sejire_arweave_solana/actions/runs/43735513189) success; [SOL recipient admin checks `43735513269`](https://github.com/azovskaya/sejire_arweave_solana/actions/runs/43735513269) success.

## Что это даёт для переезда

1. Статический пакет для `sejire.ar.io` собирается с тем же Fund/Checkout Worker, что на Pages.
2. На permaweb-хосте без `VITE_FUND_API_URL` клиент падает с `fund_api_not_configured` / `checkout_api_not_configured`, а не бьёт в `location.origin`.
3. Новые оплаченные архивы любого размера уходят через подписанный `/tx` без тела + детерминированные `/chunk` (исправление из `fix/restore-direct-data`).
4. Worker **ещё на `02983df`**: это исправление доставки **не** в production, пока владелец вручную не выпустит Worker после CI этой линии и fast-forward в `feat/promo-funded-preservation`.

## Блокер, который переезд сам не снимает

Оплаченный архив `AtwLYx509C9jWIFKUNg7dy1GSgiaDbXVK1YEQbBWfHY`: заголовок подтверждён, фрагмент данных в сети отсутствует (проверено 15.11). Нужен выпуск Worker с `replayData`/исправленным submit и проверка досылки того же подписанного чанка. Новый SOL-платёж не нужен. Клиентский fallback `/{id}` без данных на узлах не поможет.

## Следующие шаги владельца

1. Принять эту ветку (после зелёного CI) в `feat/promo-funded-preservation`.
2. Отдельно разрешить **ручной** Worker deploy из feature-ветки с точным CI run/attempt.
3. Проверить чтение/досылку `Atw…` (хеш из тегов, без новых платежей).
4. Локально: `npm run arns:prepare` → preview → при желании одно синтетическое promo-сохранение.
5. Только после «ОК»: `npm run deploy:permaweb` → Phantom → Target ID для `sejire` → smoke на `https://sejire.ar.io`.

Чеклист: [2026-11-03-arns-owner-checklist.ru.md](2026-11-03-arns-owner-checklist.ru.md) (обновлён под эту ветку).
