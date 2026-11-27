# Живые ссылки SEJIRE

> **Историческая заметка.** Ссылки, статусы и команды ниже описывают прежние
> этапы и не подтверждают текущую публикацию. С 27 ноября 2026 активный выпуск —
> Arweave-only; см. [порядок публикации](INDEPENDENT_RELEASE.md) и exact-source
> CI. Обычный `deploy:permaweb` теперь запускает native publisher с явным журналом.

**Чекпоинт продолжения:** [`CHECKPOINT.ru.md`](./CHECKPOINT.ru.md) (ветка `cursor/ao-protocol-v03-82e4`, протокол `sejire/v0.3`).

## Канон (цель)

**https://sejire.ar.io** — сайт на Arweave (имя куплено; Target ID после `npm run deploy:permaweb`).  
Решения: [`LOCKED_DECISIONS.ru.md`](./LOCKED_DECISIONS.ru.md).

## Зеркало сейчас (GitHub Pages) — сюда тестируем

**https://azovskaya.github.io/Sejire_arweave/**

Сборка с рабочей ветки, режим публикации **self** (12 слов → адрес AR → «Отправить»).  
**Arweave / `sejire.ar.io` пока не трогаем** — один `npm run deploy:permaweb`, когда зеркало ок.

Презентация RU (HTML): https://azovskaya.github.io/Sejire_arweave/presentation/  
PPTX RU: https://azovskaya.github.io/Sejire_arweave/presentation/SEJIRE-investor-deck.pptx  
PDF RU: https://azovskaya.github.io/Sejire_arweave/presentation/SEJIRE-investor-deck.pdf  

Презентация EN (HTML): https://azovskaya.github.io/Sejire_arweave/presentation/en.html  
PPTX EN: https://azovskaya.github.io/Sejire_arweave/presentation/SEJIRE-investor-deck-en.pptx  
PDF EN: https://azovskaya.github.io/Sejire_arweave/presentation/SEJIRE-investor-deck-en.pdf

Источник деплоя: ветка [`gh-pages`](https://github.com/azovskaya/Sejire_arweave/tree/gh-pages).

## Репозиторий

- Код: https://github.com/azovskaya/Sejire_arweave  
- Рабочая ветка продукта: `cursor/ao-protocol-v03-82e4`  
- Документация: [`docs/`](./)

## Как обновляется зеркало Pages

```bash
npm run deploy:pages   # из корня; сохраняет presentation/
```

## Как выгрузить SPA в Arweave

```bash
npm run deploy:permaweb   # нужен wallet.json на машине владельца; см. scripts/deploy-permaweb.sh
```

## Открыть уже сохранённый сейф

Только 12 слов + приложение. Банк и кассир **не нужны**. См. flow 07 и LOCKED_DECISIONS §4.
