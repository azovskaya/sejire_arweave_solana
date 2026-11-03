# ArNS cutover: promo-funded SPA для sejire.ar.io

Дата: **3 ноября 2026** (Asia/Calcutta). Источник продукта: `sejire_arweave_solana` ветка cutover. Репозиторий `azovskaya/Sejire_arweave` проанализирован; **запись в него у этого агента запрещена (GitHub 403)** — готовый пакет живёт здесь.

## Что взято из Sejire_arweave

Оставить / уже есть в этом репо (не переписывать заново):

| Артефакт | Зачем |
|----------|--------|
| `base: "./"` + `404.html` SPA fallback | ArNS path manifest |
| `deploy-permaweb.sh` + workflow `pack-ready` | upload без авто-смены ArNS |
| `docs/BUY_SEJIRE.ru.md`, `LOCKED_DECISIONS.ru.md`, `LIVE.md` | имя `sejire`, Target ID вручную |
| Wallet gitignore / `PERMAWEB_JWK` | казна, не user 12 слов |
| Envelope `sejire/envelope/v1` + restore по словам | совместимость с уже записанными TX |

**Не переносить как продукт на ArNS:** Kaspi-кассир как основной UX, investor `presentation/` как payload сайта, старый `web:build:arns` = `VITE_PUBLISH_MODE=self` без Fund.

## Что переносится из sejire_arweave_solana

Проверенный **promo-funded** путь:

- UI: «По промокоду» / «Сохранить бесплатно» (`PromoFundedFlow`, Fund journal)
- Worker: `https://sejire-sponsor.azovskaya-alissa.workers.dev` (`/api/fund`)
- Сборка: `npm run arns:build` = native V2 + baked `VITE_FUND_API_URL`
- CORS Worker уже включает `https://sejire.ar.io`

## Децентрализация — честная граница

| Действие | Где выполняется |
|----------|-----------------|
| SPA на `sejire.ar.io` | Arweave / ArNS (статика) |
| Шифрование / 12 слов / restore с gateway | Только браузер + публичные gateway |
| Промокод → резерв → подпись казной → upload | Cloudflare Worker + treasury JWK (как на Pages) |

Полностью убрать Worker из promo **нельзя** без новой on-chain кассы; это не часть данного cutover. Цель: тот же проверенный promo на каноническом ArNS origin.

## Команды (без upload / без смены ArNS)

```sh
npm ci --prefix apps/web
npm ci --prefix apps/sponsor
npm run arns:build          # dist + verify baked Fund URL
npm run arns:prepare        # + .cache/permaweb-release + release-manifest.json
npm run test:fund
npm run test:fund-runtime
npm run test:fund-browser
npm run security:fund
```

Upload и Target ID — **только владелец** (`npm run deploy:permaweb` с локальным `wallet.json`).

## Защита от старого бага

1. `deploy:permaweb` / `web:build:arns` больше не собирают self-only пакет.
2. На `*.ar.io` / `*.arweave.net` клиент **не** падает на `location.origin/api/fund` — явная ошибка `fund_api_not_configured`, если URL не запечён.

## Зеркало в Sejire_arweave

Когда будет push-доступ к `azovskaya/Sejire_arweave`: скопировать этот tree (или указать ArNS Target на manifest TX, загруженный из этого репо). Доступ агента на 2026-11-03: только read.
