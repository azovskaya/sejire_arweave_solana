# SEJIRE: проверяемый перенос на sejire.ar.io

> **Исторический funded-профиль.** После перехода на независимый runtime текущая ветка, workflow, состав пакета и приёмка описаны в [независимом выпуске](2026-11-16-independent-release-result.md). Для нового выпуска не применять приведённые ниже `feat/promo-funded-preservation`, требование `admin-lock.json` и Worker readiness. Исторические доказательства и ограничения uploader сохранены; новый пакет принимается только по точному успешному CI независимой ветки.

Дата: 16 ноября 2026. Ниже сохранена процедура, подготовленная до изменения архитектуры. Локальный build и зелёный тест сами по себе не означают, что новая версия уже доступна на ArNS.

## Состояние и границы

До этого изменения production Pages и Worker были выпущены из `8b07f9f5a3dae939f7d519f4e3c65ac9d49dfa09`. Следующую публикацию нужно связать с **новым точным SHA и его полным успешным SEJIRE checks**. Номер прежнего CI не подходит к изменённому коду.

При подготовке 16 ноября в GitHub Actions не был настроен `PERMAWEB_JWK`. Режим `prepare` работает без этого секрета. Подготовка кода не загружает сайт, не меняет ArNS Target и не подтверждает расход. Реальная загрузка требует конкретного рассмотренного пакета, цены и действия владельца с кошельком.

Прежний архив `AtwLYx509C9jWIFKUNg7dy1GSgiaDbXVK1YEQbBWfHY` на последней проверке имел доступные status/offset, но raw bytes возвращали 404. Перевод сайта на другой домен этот архив не восстанавливает. Отдельная процедура: [досылка уже оплаченного архива](2026-11-16-completed-archive-repair.md).

## Что исправлено в пути публикации

| Область | Требование новой процедуры |
| --- | --- |
| Источник файлов | Только `permaweb-static-release` из принятого CI, без повторной локальной сборки при upload |
| CI | Текущий head `feat/promo-funded-preservation`, точные SHA/run/attempt, успешные обязательные jobs/steps |
| Artifact | Один непросроченный artifact из текущей CI attempt, проверка GitHub ZIP SHA-256 и внутреннего manifest всех файлов |
| Распаковка | Ограничения размера/числа файлов, запрет symlink, traversal, дубликатов и посторонних файлов |
| Provenance | Публичный `build-provenance.json` связывает SHA, CI run/attempt, artifact ID, digest ZIP и release manifest |
| Инструмент | Уже закреплённый `@ardrive/turbo-sdk@2.1.0`; старый `permaweb-deploy@5.0.0` удалён |
| SPA | `index.html`, равный ему `404.html`, явные index/fallback в path manifest v0.2.0 |
| Платёж | Только собственный существующий Turbo balance; без top-up, shared-credit approvals или ArNS-команд |
| Ошибки | Одна попытка подписи/передачи item; общий abort останавливает очередь после первой ошибки |
| Повтор Actions | `upload` запрещён при `GITHUB_RUN_ATTEMPT > 1`; `prepare` можно повторять |
| Проверка доставки | Каждый публичный файл и fallback сверяются по длине и SHA-256 до изменения Target |

У старого CLI из lockfile фактический backend был LegacyBundler (`up.arweave.net`), а код генерации manifest не добавлял fallback. Новый runner использует официальные Turbo endpoints `upload.ardrive.io` и `payment.ardrive.io`, проверенный API закреплённого SDK и явный fallback.

## 1. Подготовить точный пакет без кошелька

Сначала зарегистрировать новую версию `.github/workflows/permaweb.yml` на default branch обычным PR. Старый main workflow имеет только `confirm` и не содержит новых защит. Не запускать его. После полного CI нового feature SHA открыть Actions → **Upload accepted SEJIRE site to Arweave (manual)**. Выбрать ветку `feat/promo-funded-preservation` и задать:

| Input | Значение |
| --- | --- |
| `mode` | `prepare` (по умолчанию) |
| `confirm` | `pack-ready` |
| `ci_run_id` | Успешный SEJIRE checks именно текущего feature SHA |
| `ci_attempt` | Номер успешной attempt этого CI |
| `max_quote_winc` | `0` допустим для подготовки и получения цены |

Workflow проверяет CI, восстанавливает artifact, устанавливает web lockfile, выполняет блокирующий production dependency audit и получает публичную цену. Он не читает upload key, не создаёт signer и не проверяет приватный кошелёк в `prepare`.

Результаты Actions:

- `permaweb-accepted-pack`: точная папка сайта, `release-manifest.json`, `build-provenance.json`.
- `permaweb-upload-evidence`: принятие CI и `upload-quote.json`; при подготовке здесь ещё нет upload receipt.

Сверить `sourceCommit`, run/attempt, число файлов, суммарные байты и quote. Если `withinBudget: false`, режим подготовки всё равно сохраняет конкретную цену и пакет. Это **не** разрешение загрузки сверх лимита.

`max_quote_winc` — максимальная принимаемая **предварительная котировка в Winston Credits**, не жёсткий лимит провайдера. Сумма включает отдельную оценку каждого файла, manifest и консервативные 4096 байт на подписанный item. Перед upload цена получается заново; она должна быть не старше 60 секунд, укладываться в выбранный предел и собственный баланс. Цена может измениться на стороне сервиса. Runner проверит итоговую сумму из receipts после успешного upload, но эта последняя проверка не может отменить уже принятые item.

## 2. Выбрать один способ загрузки после рассмотрения цены

### Вариант A: официальный браузерный Console, без экспорта приватного ключа

Для текущего состояния без `PERMAWEB_JWK` можно использовать [официальный ar.io Console / Deploy](https://console.ar.io/deploy). По проверенному исходному коду Console поддерживает выбор **папки сайта**, а не ZIP напрямую.

1. Скачать `permaweb-accepted-pack` из конкретного prepare run и распаковать ZIP. Выбрать папку, в корне которой находятся `index.html`, `404.html`, `assets/`, оба manifest/provenance JSON и публичный admin verifier. Не выбирать весь checkout репозитория.
2. Подключить поддерживаемый кошелёк владельца в самом Console. Приватный ключ/JWK не передавать в чат, не добавлять в сайт или Git.
3. Проверить в summary **Index: `index.html`**, **Fallback: `404.html`**. Не включать автоматическую привязку/обновление ArNS.
4. Рассмотреть отображённую стоимость и оплату существующими **Credits**. Crypto/JIT-top-up — отдельное расходное действие; оно не следует из подготовки пакета.
5. После собственного подтверждения загрузки сохранить manifest ID. Перед изменением Target выполнить проверку всех публичных байтов ниже.

Console — отдельное приложение с собственными текущими настройками и поведением ошибок. Защиты retries/abort из repository runner не следует приписывать Console. При неясном результате не повторять upload вслепую: сначала сохранить показанные IDs/ошибки и выяснить, что принято. Сам интерфейс с реальным кошельком в рамках этой подготовки не запускался.

### Вариант B: manual workflow с уже настроенным upload key

Этот вариант доступен владельцу, который отдельно настроил GitHub Actions secret `PERMAWEB_JWK` для выбранного Arweave-кошелька. Скрипт не ищет `wallet.json`, не пишет JWK во временный файл и не печатает SDK request configuration. Настройка ключа не выполняется в режиме подготовки.

Запустить **новый** dispatch с `mode=upload`, тем же принятым текущим SHA/CI и рассмотренным `max_quote_winc`. Workflow заново получает quote и проверяет CI непосредственно перед созданием signer. Используется собственный баланс этого кошелька; автоматического пополнения нет. Если source branch успела измениться, gate отклонит старую сборку.

Успешный результат содержит `upload-result.json` с manifest ID, file/manifest receipts и `actualWinc`, затем `public-result.json` с проверенными публичными байтами. ArNS Target остаётся прежним.

**Если upload завершился ошибкой:** сохранить artifacts этого run. `folder-index.jsonl` и `completed-files.jsonl` сохраняют известные успешные IDs/пути. Полные receipts и `actualWinc` доступны только после успешного результата folder upload; при частичной ошибке или потерянном ACK окончательная сумма/приём item могут быть неизвестны. Этот путь не реализует автоматическое возобновление и не даёт обещания нулевого расхода при ошибке. Не запускать новую загрузку как способ проверить доставку.

GitHub **Re-run jobs** в upload режиме намеренно блокируется: новый runner не имеет локальной истории старого upload. Для уже полученного manifest использовать только read-only verification. Внутри одной попытки SDK также не подписывает второй item после потери ACK, и очередь прекращается после первой ошибки.

## 3. Проверить manifest и публичные байты

Для локальной read-only проверки распаковать именно `permaweb-accepted-pack` в `.cache/permaweb-accepted/` этого checkout. При workflow upload можно дополнительно восстановить evidence artifact в `.cache/permaweb-upload-evidence/`.

Для ID из Console либо сохранённого manifest:

```sh
npm run permaweb:verify -- --manifest MANIFEST_ID
```

Команда читает публичный raw manifest с `turbo-gateway.com`, проверяет полный набор path IDs и `fallback`, затем длину и SHA-256 каждого опубликованного файла и ответ на неизвестный путь. Она не создаёт подписи и не загружает файлы. При восстановленном `upload-result.json` допустимо просто `npm run permaweb:verify`.

404/пустой body/неверный hash — отказ проверки доставки. Повторить позже можно **verification**, не upload. Статус `PASS` означает доступность именно этих байтов на проверенном gateway в момент проверки. Это не доказательство расчёта/финальности в L1 и не восстановление пользовательского архива.

## 4. Только после проверки — сменить ArNS Target

Владелец имени `sejire` вручную выбирает проверенный manifest ID в официальном интерфейсе управления ArNS и подтверждает действие своим кошельком. Repository workflow эту операцию не выполняет. Сохранить прежний Target ID для возможного возврата.

После распространения записи:

```sh
npm run permaweb:verify-target -- --manifest MANIFEST_ID
```

Затем проверить `https://sejire.ar.io/` на desktop и mobile: загрузку UI, `#/save`, `#/restore`, закрытый admin, глубокий неизвестный путь, отсутствие JS/CSS MIME ошибок. В коде CI есть compiled-browser проверки ArNS root и глубокого fallback; реальные проверки нового публичного Target остаются отдельным шагом после переноса.

Read-only `arns:live` теперь требует не только CORS, но и HTTP 200 / `ready: true` от checkout policy, а также успешный OPTIONS с `Authorization`, `Content-Type`, `Idempotency-Key`. Возврат policy 503 или `ready: false` больше не считается готовностью. В текущем окружении прежняя попытка Sponsor была остановлена ответом Cloudflare Error 1010; повторных попыток или обхода этого ограничения в подготовке не было. Поэтому живую готовность Worker для ArNS здесь заново не подтверждали.

## Старые сохранения и смена origin

IndexedDB pending-order journal, bearer token/idempotency/signature и локальная история backup привязаны браузером к origin. Они не переносятся автоматически с `azovskaya.github.io` на `sejire.ar.io`. Экспорт архива с recovery words переносит само дерево, но не полномочия продолжить незавершённый оплаченный заказ.

Старый Pages URL нужно оставить доступным. Для существующего оплаченного или ожидающего заказа использовать прежний URL в том же браузере; новый сайт показывает миграционное объяснение и ссылку. Не очищать локальное хранилище до завершения/экспорта. Не передавать токены через URL, редирект, localStorage bridge или обычный архив: такой экспорт требует отдельного протокола и анализа.

## Проверки реализации

- Node 22.23.4: 16 release regression tests, включая exact CI/artifact, hostile ZIP, digest/provenance, собственный баланс/quote, запрет upload rerun, реальные SDK manifest/fallback, потерянный ACK с синтетическим RSA и прекращение очереди после первой ошибки. Сеть и реальные ключи/расходы в этих тестах отсутствуют.
- Отдельные чистые тесты готовности отклоняют policy 503/false и неполный authorization preflight.
- Корневой lockfile создан npm 10.9.9; холодный `npm ci` с той же версией успешен. Удалён старый deploy CLI с ненужными зависимостями, версии оставшихся пакетов не изменены.
- Полный CI нового итогового SHA, успешный prepare quote и реальный публичный cutover должны быть записаны в handoff после выполнения; данный документ не подменяет эти доказательства.

## Первичные источники

- [Arweave path manifests: index и fallback](https://docs.ar.io/build/upload/manifests).
- [SPA hosting и fallback](https://docs.ar.io/sdks/ario-deploy/single-page-apps/).
- [Turbo advanced upload](https://docs.ar.io/build/upload/advanced-uploading-with-turbo) и [authenticated client API](https://docs.ar.io/sdks/turbo-sdk/turboauthenticatedclient).
- [Официальный ar.io Console](https://github.com/ar-io/ar-io-console): `src/components/panels/DeploySitePanel.tsx` (папка, index/fallback, независимое включение ArNS) и `src/hooks/useFolderUpload.ts` (wallet signing, существующие credits/crypto choice, manifest). Проверка исходного кода, не реального кошелька в live UI.
- Фактические SDK semantics проверены на установленном пакете `@ardrive/turbo-sdk@2.1.0`, а не только по названиям опций в документации.
