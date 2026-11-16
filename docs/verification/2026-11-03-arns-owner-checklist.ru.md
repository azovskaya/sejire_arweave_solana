# Чеклист владельца: проверка перед вечной выкладкой на sejire.ar.io

> Историческая проверка. Для текущей публикации использовать [процедуру от 16 ноября](2026-11-16-ario-cutover.md): принятый CI artifact, default `prepare`, рассмотренная цена, отдельный upload и ArNS Target. Старый путь с локальным `wallet.json` ниже больше не используется.

Дата подготовки: **15 ноября 2026**. Ветка: `cursor/ario-permaweb-release-5150`. Агент **не** загружает сайт в Arweave и **не** меняет ArNS Target — это делаете вы после этой проверки.

## Что уже прогнано агентом (локально + read-only к Worker)

| Проверка | Ожидание |
|----------|----------|
| `npm run arns:build` / `arns:prepare` | relative `./assets/`, Fund URL запечён |
| `npm run arns:live` | CORS `https://sejire.ar.io` → Worker OK; чужой Origin не отражается |
| `npm test` | PASS |
| `npm run test:fund` + `test:fund-runtime` | PASS |
| `npm run test:fund-browser` | 25/25 |
| `npm run test:arns-browser` | 2/2 static dist + mocked promo |
| `npm run test:paid-browser` | 46/46 |
| editor Playwright | 7/7 |
| `npm run security:fund` | нет JWK/секретов в бандле |
| Worker release gate | 53/53 |

Подробности: [2026-11-15-ario-permaweb-release.md](2026-11-15-ario-permaweb-release.md).

## Ваша проверка на своём Mac (Chrome + Phantom не обязательны для promo)

```sh
git fetch origin
git checkout cursor/ario-permaweb-release-5150
git pull
npm ci --prefix apps/web
npm ci --prefix apps/sponsor
npm run arns:prepare
npm run arns:live
npm run test:arns-browser
npx vite preview --host 127.0.0.1 --port 5191 --strictPort --prefix apps/web
```

Откройте `http://127.0.0.1:5191/#/save`. Для безопасной UI-проверки без расхода используйте `test:arns-browser` (мок). Реальный smoke с промокодом — **только когда решите**, одним сохранением синтетического дерева, затем restore по словам.

## Перед вечной выкладкой (рекомендуемый порядок)

1. Дождаться зелёного CI этой ветки.
2. Влить в `feat/promo-funded-preservation`.
3. Отдельным разрешением выпустить Worker вручную (gate: `DEPLOY` + точный CI run/attempt) — иначе исправление доставки маленьких оплаченных архивов останется только в коде, не в production.
4. По возможности проверить досылку прежнего оплаченного `AtwLYx509C…` без нового SOL-платежа.

## После вашего «ОК» — вечная выкладка (только вы)

1. `wallet.json` казны локально (не в чат, не в Git).
2. `npm run deploy:permaweb`
3. Скопировать manifest TX.
4. Удалить `wallet.json`.
5. Phantom → [arns.ar.io](https://arns.ar.io) → имя `sejire` → Target ID = manifest → Save.
6. Smoke: `https://sejire.ar.io/#/save` → промокод → одно тестовое сохранение → `#/restore`.

## Граница

Promo upload подписывает **казна через Cloudflare Worker**. Сайт и restore — на Arweave/ArNS. Незавершённые journals с `github.io` на `sejire.ar.io` не переезжают.
