# Чеклист владельца: проверка перед вечной выкладкой на sejire.ar.io

Дата подготовки: **3 ноября 2026**. Агент **не** загружает сайт в Arweave и **не** меняет ArNS Target — это делаете вы после этой проверки.

## Что уже прогнано агентом (локально + read-only к Worker)

| Проверка | Ожидание |
|----------|----------|
| `npm run arns:build` / `arns:prepare` | relative `./assets/`, Fund URL запечён |
| `npm run arns:live` | CORS `https://sejire.ar.io` → Worker OK; чужой Origin не отражается |
| `npm run test:fund` + `test:fund-runtime` | PASS |
| `npm run test:fund-browser` | 25/25 |
| `npm run test:arns-browser` | static dist + mocked promo save → «Семейная история сохранена» |
| `npm run security:fund` | нет JWK/секретов в бандле |

## Ваша проверка на своём Mac (Chrome + Phantom не обязательны для promo)

```sh
git fetch origin
git checkout cursor/arns-promo-cutover-5150
git pull
npm ci --prefix apps/web
npm ci --prefix apps/sponsor
npm run arns:prepare
npm run arns:live
npm run test:arns-browser
npx vite preview --prefix apps/web --host 127.0.0.1 --port 5191 --strictPort
```

Откройте `http://127.0.0.1:5191/#/save` и пройдите **тестовый** сценарий только если готовы к **реальному** промо (это уже бьёт в production Worker). Для безопасной UI-проверки без расхода используйте `test:arns-browser` (мок).

Реальный smoke с промокодом — **только когда решите**, одним сохранением синтетического дерева, затем restore по словам.

## После вашего «ОК» — вечная выкладка (только вы)

1. `wallet.json` казны локально (не в чат, не в Git).
2. `npm run deploy:permaweb`
3. Скопировать manifest TX.
4. Удалить `wallet.json`.
5. Phantom → [arns.ar.io](https://arns.ar.io) → имя `sejire` → Target ID = manifest → Save.
6. Smoke: `https://sejire.ar.io/#/save` → промокод → одно тестовое сохранение → `#/restore`.

## Граница

Promo upload подписывает **казна через Cloudflare Worker**. Сайт и restore — на Arweave/ArNS. Незавершённые journals с `github.io` на `sejire.ar.io` не переезжают.
