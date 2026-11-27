# SEJIRE — чекпоинт продолжения работы

> **Исторический checkpoint.** Текущая цель изменена 27 ноября 2026 на
> Arweave-only без обязательного сервера. Начать с [актуального handoff](CONTINUE_ON_ANOTHER_MAC.md)
> и [независимого выпуска](INDEPENDENT_RELEASE.md). Команды Turbo/Actions upload
> и прежние утверждения о готовности ниже не применяются к новому кандидату.

> **С этого места продолжать доработку.**  
> Дата: **2026-08-20**  
> Ветка: `cursor/ao-protocol-v03-82e4`  
> Протокол: **`sejire/v0.3`**  
> Предыдущий продукт-чекпоинт: v0.4 (`sejire-v0.4-checkpoint`, permaweb upload)

Старые решения владельца не переспрашивать: [`LOCKED_DECISIONS.ru.md`](./LOCKED_DECISIONS.ru.md).  
План Arweave/Kaspi: [`PERMAWEB_ROLLOUT.ru.md`](./PERMAWEB_ROLLOUT.ru.md).  
Норматив протокола: [`PROTOCOL.md`](./PROTOCOL.md).

---

## 1. Где смотреть живое

| Что | URL |
|-----|-----|
| Приложение (зеркало Pages) | https://azovskaya.github.io/Sejire_arweave/ |
| Investor deck (HTML RU) | https://azovskaya.github.io/Sejire_arweave/presentation/ |
| Investor deck (HTML EN) | https://azovskaya.github.io/Sejire_arweave/presentation/en.html |
| Investor deck PPTX/PDF | RU + EN: см. [`LIVE.md`](./LIVE.md) |
| Канон (цель) | `https://sejire.ar.io` — **имя куплено (Phantom/ARIO)**; Target ID после `npm run deploy:permaweb` |

Тестовое зеркало: **https://azovskaya.github.io/Sejire_arweave/** (обновляется через `npm run deploy:pages`).  
**https://sejire.ar.io/** пока **старый манифест** — в Arweave не выкладываем, пока зеркало не ок.

Известные баги живого манифеста (уже закрыты в коде):

- пустая схема после «Начать» (карточка за краем 7 поколений)
- `Failed to fetch dynamically imported module: …/wallet-*.js` (цикл ленивого чанка)
- нет `404.html` / `favicon.ico` на ArNS
- Google Fonts с CDN (для вечности шрифты должны ехать в том же бандле)

---

## 2. Что уже работает (не ломать без нужды)

Всё из v0.4: редактор до 7 поколений, PDF, JSON backup, 12 слов → envelope, Pages-зеркало, кассир mock.

### Протокол v0.3 (этот чекпоинт)

- Tree Process: `GetAncestors`, `GetJetiAta`, `Relate` (публичное чтение HEAD или `Commit-Id`)
- Коды родства: `packages/schema/kinship-codes.json` (не локализованные строки в процессе)
- Тестовый двойник Lua: `apps/web/src/lib/ao/treeProcess.ts` + `SejireAoClient`
- Selftest: `cd apps/web && npm run test:protocol`
- Live aos: `.load ao/processes/tree.lua` — те же Action; process id в `VITE_SEJIRE_FACTORY_ID` когда задеплоен

---

## 3. Ключевые файлы

| Зона | Путь |
|------|------|
| Lua Tree (норматив on-chain) | `ao/processes/tree.lua` |
| AO client / simulator | `apps/web/src/lib/ao/*` |
| Kinship codes | `apps/web/src/lib/kinship.ts` |
| Schemas | `packages/schema/{ancestors,jeti-ata,relate}-v1.schema.json` |
| UI workspace | `apps/web/src/components/Workspace.tsx` |
| Permaweb upload | `scripts/deploy-permaweb.sh` |

Тесты: `cd apps/web && npm test`

---

## 4. Что делать дальше

1. **Сейчас:** тестировать и править на GitHub Pages. **Не выкладывать ArNS**, пока зеркало не ок.
2. **Пак на Arweave:** когда зеркало ок — GitHub Actions → workflow «Upload SEJIRE SPA to Arweave» → confirm `pack-ready` (secret `PERMAWEB_JWK`) **или** локально `npm run deploy:permaweb` с `wallet.json`. Затем Phantom → Target ID. Ключ в чат не слать.
3. **aos:** Factory + Tree process IDs — отдельно, не блокер сейфа.
4. **Kaspi live:** протокол в коде готов. Включить — ИП/ТОО + `KASPI_MERCHANT_TOKEN` + KV + `PAYMENT_PROVIDER=kaspi` + `TURBO_JWK`.
5. Позже: медиа Turbo, GEDCOM, UI родства из AO.

**Не начинать** с переписывания редактора на Lua.

---

## 5. Открытые хвосты у владельца

1. Казна (Wander/ArConnect) готова к деплою сайта? (да/нет — **не** присылать ключ)
2. Есть / будет ИП или ТОО под Kaspi?
3. Live Factory process id — когда появится после aos.

Всё остальное из LOCKED_DECISIONS — закрыто.

---

## 6. Как поднять работу

```bash
git fetch origin
git checkout cursor/ao-protocol-v03-82e4
cd apps/web && npm ci && npm test && npm run dev
```

Читать сначала:
1. этот файл
2. `PROTOCOL.md` (v0.3)
3. `LOCKED_DECISIONS.ru.md`
4. `PERMAWEB_ROLLOUT.ru.md`

---

## 7. Инварианты безопасности (не нарушать)

- 12 слов не уходят с устройства
- Кассир видит только ciphertext + факт оплаты
- Казна ≠ личный seed пользователя
- Restore по словам не зависит от кассира
- Kinship queries на AO читают snapshot процесса; приватный род остаётся в encrypted envelope
