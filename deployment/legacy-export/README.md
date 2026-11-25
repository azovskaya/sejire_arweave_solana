# Закрытый экспорт старого SEJIRE ledger и совместимость прежнего API

Этот комплект подготовлен отдельно от принятого приложения. Он **не развёрнут**, не обращался к производственным данным, не содержит кошельков или секретов и не меняет исходники принятого выпуска. В комплекте нет команды автоматического deploy. `source-evidence.template.json` намеренно не проходит проверку до заполнения действительными данными владельца.

Назначение — заменить исходный Worker на закрытый экспортёр **в том же аккаунте, под тем же именем Worker и с тем же классом `CheckoutLedger` / namespace `CHECKOUT_LEDGER`**. После проверенного переноса можно подготовить отдельную версию совместимости, чтобы прежний адрес API обслуживал старые клиентские журналы через Linux.

## Что именно подготовлено

| Файл | Действие |
|---|---|
| `src/export-only.ts` | Прекращает исполнение в заменённом объекте, сохраняет наблюдение alarm, закрывает публичные API, выполняет только авторизованный экспорт. |
| `bin/prepare.mjs` | Офлайн проверяет согласованность метаданных владельца и создаёт новый приватный каталог с готовым модулем и upload metadata. |
| `bin/collect.mjs` | По явной команде получает снимок и приватный sidecar, проверяет идентичность и хеши, сохраняет новые файлы `0600` в каталоге `0700`. |
| `src/compatibility-proxy.ts` | Опциональный переходный API: один запрос к фиксированному HTTPS Linux origin; старый DO остаётся заморожен. |
| `bin/prepare-proxy.mjs` | Офлайн связывает подготовку прокси с экспортированным снимком, freeze и подтверждением завершённого переноса. |
| `vendor/` | Две неизменённые копии проверенного snapshot codec и canonical JSON. |

Исполнитель, treasury signer, платёжные провайдеры и старые обработчики сохранения не входят в модуль экспорта. Подготовка не создаёт `wrangler.toml`, `exports` lifecycle или новые классы. В metadata используется существующий `namespace_id`; существующие типы bindings сохраняются через `keep_bindings`, включая `secret_text` и KV. Legacy migration tag остаётся прежним: `old_tag == new_tag`, `steps: []`. Это проверка совпадения тега, а не миграция данных.

## До установки: необходимые данные и условия

Владелец получает следующие сведения через свои средства управления Cloudflare. Передавать нам значения секретов или содержимое кошельков не требуется.

1. Точный аккаунт, полный script name фактически работающего Worker, его active version UUID и commit **старого исполнителя**. Commit экспортёра и commit нового сайта — другие величины. Если связь source commit с развёрнутым Worker не установлена, подготовку нужно остановить.
2. Существующий namespace ID, class `CheckoutLedger`, `use_sqlite: true`, точный 64-символьный ID объекта с именем `sejire-checkout-ledger-v1` и признак сохранённых данных. Проверьте полный список объектов namespace и namespace этого Worker: дополнительный объект с данными, иной класс, remote binding или неизвестная схема требуют отдельного разбора. Пустой новый namespace нельзя выдавать за прежний ledger.
3. Существующий migration tag и compatibility settings. Этот первый комплект поддерживает проверенный legacy-migrations случай. Он откажет при `exports` lifecycle и не переводит инфраструктуру на другую схему управления.
4. Полный перечень имён и типов существующих bindings. В evidence не должно быть значений `ADMIN_TOKEN`, `PROMO_CODE_SECRET`, JWK, plaintext vars или `ops:secrets`. Сохранность этих bindings нужно сверить после установки; их прежние значения для Linux передаются только через существующий секретный канал владельца.
5. Отдельный случайный export bearer: 32 случайных байта в виде 64 lowercase hex-символов, в секрете Worker `SEJIRE_EXPORT_TOKEN`. Он не является admin-токеном, promo-secret или ключом кошелька. Локальный файл для сборщика должен иметь права `0600` и содержать только этот bearer. Его нельзя помещать в URL, Git или командную строку.
6. Возможность провести окно обслуживания: остановить новые запросы на старом входе, убрать старый трафик и триггеры, дождаться завершения текущего исполнения и сверить неопределённые внешние отправки. Само истечение lease **не доказывает**, что внешняя транзакция не была отправлена.

Метаданные в `source-evidence.template.json` — **нормализованная запись оператора**, а не автоматическая онлайн-проверка аккаунта. До подготовки сопоставьте их с read-only сведениями Workers settings/deployments, списком Durable Object namespaces и объектов. Отдельно сохраните исходные приватные evidence. Подготовка принимает запись, наблюдённую не более часа назад, но такой срок сам по себе не доказывает её достоверность.

Неизвестные заранее условия — фактический Worker/env/account, полный перечень версий и старых клиентов, source commit, схема/объём старого ledger, отдельное KV и реальные незавершённые внешние операции. Эти данные невозможно установить из одного репозитория.

## Фаза 1. Офлайн подготовка и явная установка режима обслуживания

Скопируйте шаблон в приватный файл, заполните точные значения, перечислите **все** существующие bindings без их содержимого. `maintenance.requestedAt` и `observedAt` — Unix milliseconds. `MAINTENANCE_EXPORT_ONLY` означает намерение установить режим обслуживания; оно **не утверждает**, что старый исполнитель уже остановлен.

```sh
node --import tsx bin/prepare.mjs \
  --source-evidence /private/sejire/source-evidence.json \
  --output-new-directory /private/sejire/export-prepared
```

Результат: `export-only.mjs`, `upload-metadata.json`, `export-config.json`, `export-acknowledgement.json` и `operator-review.json`. Каталог должен быть новым. Проверяются точные binding/class/namespace/object, отсутствие смешанного исходного deployment и запрещённых lifecycle steps. Сравните module SHA и metadata SHA с журналом подготовки.

Установка — отдельное действие владельца после просмотра этих файлов и целевого адреса `operator-review.uploadTarget`. Для multipart Upload Worker API части называются `metadata` (JSON upload-metadata) и `export-only.mjs` (JavaScript module). Используется **точный существующий** `/accounts/{account}/workers/scripts/{script}`; новый Worker здесь не подходит. Комплект сам не вызывает API, не принимает Cloudflare API token и не выбирает аккаунт.

При обычном изменении кода Cloudflare может некоторое время оставлять активный DO на прежней версии. Владелец должен применить экспортёр на **100%**, установить/проверить подходящую стратегию обновления и убедиться, что именно нужный объект уже отвечает закрытым статусом. `immediate` заменяет код сразу, но не доказывает завершение уже отправленной внешней операции. Смешанный deployment, старые версии с трафиком, rollback на старого исполнителя или другой активный источник недопустимы во время переноса.

## Фаза 2. Freeze, остановка и приватный снимок

Доступны только следующие operator endpoints. Все требуют `Authorization: Bearer <SEJIRE_EXPORT_TOKEN>`, ответы `no-store`; браузерный `Origin` отвергается. В URL не передаются токены или параметры. Используйте приватный HTTP-клиент либо `curl --config` с защищённым файлом заголовка, не токен в аргументах shell.

| Метод и путь | Требование |
|---|---|
| `GET /__sejire_legacy_export/status` | Статус конкретного объекта; первый запуск класса выполняет freeze. |
| `POST /__sejire_legacy_export/freeze` | Тело из `export-acknowledgement.json`; повтор сохраняет тот же freeze. |
| `POST /__sejire_legacy_export/seal-quiescence` | Отдельное явное подтверждение **после** применения версии и сверки текущих операций. |
| `POST /__sejire_legacy_export/alarm-reconciliation` | Только при неизвестном первоначальном alarm и только после отдельной проверки владельцем. |
| `POST /__sejire_legacy_export/snapshot` | Тело из `export-acknowledgement.json`; до seal, при активных leases, неизвестном alarm или неподдержанной схеме — отказ. |

Freeze сохраняется в служебном DO KV, отдельно от таблиц приложения. Исходное наблюдение alarm и его удаление выполняются одной storage transaction. Конструктор не создаёт SQL-таблицы и не запускает старые jobs. Повторная инициализация проверяет тот же config SHA. Любой оставшийся вызов `alarm()` ничего не подписывает, не отправляет и не планирует заново.

После проверки 100% adoption, закрытого старого входа, отсутствия старого исполнителя и сверки неопределённых операций владелец формирует приватное подтверждение:

```json
{
  "target": {"namespaceId":"EXACT_ID","objectId":"EXACT_ID","sourceCommit":"OLD_SOURCE_COMMIT","attestation":"MAINTENANCE_EXPORT_ONLY"},
  "quiescedAt": 0,
  "evidenceSha256":"SHA256_OF_THE_PRIVATE_QUIESCENCE_REVIEW",
  "attestation":"SOURCE_EXECUTION_STOPPED"
}
```

Это тело для `/seal-quiescence`; placeholders и нулевое время не принимаются. `quiescedAt` не раньше `frozenAt`. Первый seal долговечен; повтор с теми же данными допустим, изменение времени/evidence — конфликт. Автоматического подтверждения нет. Само подтверждение остаётся заявлением владельца с отдельными доказательствами, а не доказательством состояния блокчейна.

### Alarm: `null` не означает доказанное отсутствие

Cloudflare может возвращать `null` из `getAlarm()` во время уже исполняемого alarm. Поэтому экспортёр хранит `alarmObservation: "null-unconfirmed"`, отдельно отмечает наблюдение самого вызова alarm и блокирует snapshot. Он не заменяет неизвестный момент вымышленным timestamp и не выдаёт его за подтверждённое отсутствие.

Если timestamp наблюдался, он сохраняется без изменения. Если не наблюдался, владелец сверяет прежний таймер, durable jobs и внешние операции, сохраняет приватное evidence и один раз отправляет `/alarm-reconciliation`:

```json
{
  "target": {"namespaceId":"EXACT_ID","objectId":"EXACT_ID","sourceCommit":"OLD_SOURCE_COMMIT","attestation":"MAINTENANCE_EXPORT_ONLY"},
  "restoredAlarmAt": null,
  "evidenceSha256":"SHA256_OF_THE_PRIVATE_ALARM_REVIEW",
  "attestation":"ALARM_STATE_RECONCILED"
}
```

`restoredAlarmAt` — обоснованный Unix timestamp либо `null`, если владелец подтвердил отсутствие нужного таймера. Исходное `null-unconfirmed` и отметка вызова alarm остаются в sidecar; новое значение обозначено как решение после reconciliation. Изменить уже записанное решение нельзя. При наблюдавшемся timestamp override запрещён.

### Получение артефактов

После seal и, если нужно, alarm reconciliation:

```sh
node --import tsx bin/collect.mjs \
  --origin https://VERIFIED-EXISTING-WORKER-ORIGIN \
  --config /private/sejire/export-prepared/export-config.json \
  --token-file /private/sejire/export-token \
  --output-new-directory /private/sejire/ledger-export
```

HTTPS origin нужно независимо проверить до передачи bearer. Сборщик не делает redirects, retries, seal или reconciliation. Он проверяет status → snapshot → status, связывает снимок с `X-Sejire-Freeze-Sha256` и сохраняет `ledger-snapshot.json`, `private-freeze-sidecar.json`, затем `complete.json`. В sidecar сохраняются первоначальный alarm/неопределённость/вызов, решения владельца, evidence digests, исходная версия и адрес. `snapshotSha256` — хеш manifest codec, `snapshotFileSha256` — хеш конкретного файла: это разные значения.

Снимок содержит ciphertext, capability hashes, подготовленные и подписанные bytes, payment/order histories, idempotency keys, promo hash, holds, spend, ceiling/revision и audit. Это **приватный операторский артефакт**. Не прикладывайте его к публичному PR или отчёту. Сохраните его и sidecar в долговечном защищённом хранилище владельца.

## Импорт Linux и единственный исполнитель

Дальше используется уже проверенный importer из принятого backend, только в новый отсутствующий DB path:

```sh
node --experimental-sqlite --import tsx bin/import-ledger.mjs \
  --snapshot /private/sejire/ledger-export/ledger-snapshot.json \
  --output /data/NEW-sejire.sqlite \
  --expected-sha256 SNAPSHOT_MANIFEST_SHA256
```

Это команда из `apps/sponsor`, не из каталога этого комплекта. Importer проверяет схему, строки, rowids, хеши, FK и integrity; сохраняет review barrier. Он не запускает исполнителя и не перезаписывает живую БД. После ручной сверки snapshot/sidecar, старых обязательств, секретов, budgets и uncertain sends владелец использует штатный guarded acknowledge с **database file SHA**, затем допускает ровно один Linux writer. Нельзя одновременно включать старый Worker и новый исполнитель.

Ограничения первого формата: 29 известных SQL-таблиц; старые отсутствующие обязательные таблицы требуют отдельно проверенного additive upgrade; неизвестные таблицы вызывают отказ; source table data более 64 MiB требует отдельно проверенного chunked export. Ничего не обрезается. Активные leases paid/promo/legacy upload блокируют экспорт.

## Необязательный совместимый вход для старых клиентов

Старые неизменяемые клиенты продолжают обращаться к прежнему Worker URL. Один перенос SQLite на Linux это не исправляет. После проверенного импорта и handoff на один исполнитель владелец выполняет приёмку с прежним browser Origin, старой capability и idempotency key: читает прежний заказ, восстанавливает тот же журнал, подтверждает отсутствие нового платежа и корректный CORS.

Для этого в комплекте есть отдельный compatibility proxy. Он использует тот же замороженный класс и передаёт только `/api/checkout` и `/api/fund` с подпутями на один точный HTTPS Linux origin. Сохраняются тело, bearer, idempotency и `Origin`. Старый `Host`, hop-by-hop и произвольные forwarding-IP заголовки удаляются. Linux самостоятельно проверяет bearer и CORS. Публичный ingress/rate limiting нужно настроить и проверить отдельно: прокси не доверяет подставленным клиентским IP и по умолчанию не обещает отдельную IP-квоту каждому старому посетителю.

Владелец сохраняет приватный cutover JSON по `ProxyConfig` в `src/compatibility-proxy.ts`: точный Linux origin, source namespace/object/commit, `sourceSnapshotSha256`, `sourceFreezeSha256`, `cutoverEvidenceSha256`, время `acceptedAt` и явное `LINUX_IMPORT_AND_LEGACY_ORIGINS_VERIFIED`. Это подтверждение завершённой приёмки; поле с хешем не является автоматическим доказательством Linux import.

```sh
node --import tsx bin/prepare-proxy.mjs \
  --prepared-export-directory /private/sejire/export-prepared \
  --private-sidecar /private/sejire/ledger-export/private-freeze-sidecar.json \
  --cutover-evidence /private/sejire/verified-cutover.json \
  --output-new-directory /private/sejire/proxy-prepared
```

После просмотра новая proxy-версия устанавливается владельцем на тот же старый Worker. Это отдельный необходимый шаг для сохранения прежнего API URL. Прокси проверяет замороженный/sealed source и совпадение freeze, но не выполняет SQL импорт и не снимает Linux review barrier. Размер тела запроса ограничен 2 MiB, ответа — 4 MiB; общий срок — 55 секунд. Redirect и автоматический повтор запрещены. Если ответ после POST потерян, возвращается `compatibility_upstream_outcome_unknown`; новый платёж или заказ не создаётся самим прокси.

`/v1/*`, protocol routes и иные пути получают явный отказ `legacy_route_requires_separate_migration`. До cutover нужно инвентаризировать старые сценарии внутри `/api/checkout` тоже: сам prefix не гарантирует наличие нужного старого provider или сохранённой KV-сессии. Новый funded сайт может обращаться непосредственно к Linux; существование старого Worker остаётся зависимостью только для клиентов с неизменённым старым API URL.

## Отдельные старые данные: stop-gates

Этот SQL-снимок не экспортирует внешний `IDEMPOTENCY` KV (`sej_*`, Kaspi indices, `ops:state`, `ops:secrets`) и protocol journals/checkpoints. Экспортёр не читает секреты из KV. Если там существуют незавершённые обязательства, нужны отдельная приватная инвентаризация и перенос/сверка до отключения соответствующего старого пути. Не обещайте их восстановление по одному SQL-снимку или прокси. Известные неопределённые платежи сохраняются с прежними bytes и proof; новая оплата не заменяет старую автоматически.

## Проверки и происхождение

### Воспроизводимая установка внутри репозитория

Планируемое место комплекта — `deployment/legacy-export` в checkout принятого репозитория SEJIRE. Команды ниже запускаются **из корня этого checkout**, с Node 24. Зависимости устанавливаются по существующему `apps/sponsor/package-lock.json`; отдельного lockfile у комплекта нет, поэтому `npm ci` из его каталога не является способом воспроизводимой установки.

```sh
set -eu
node -e 'if (Number(process.versions.node.split(".")[0]) !== 24) throw new Error("Node 24 required")'
test -f apps/sponsor/package-lock.json
npm ci --prefix apps/sponsor
cd deployment/legacy-export
node --input-type=module <<'NODE'
import {realpath, stat, symlink, readlink} from 'node:fs/promises';
const target = '../../apps/sponsor/node_modules';
const expected = await realpath(target);
if (!(await stat(expected)).isDirectory()) throw new Error('Sponsor dependencies are missing');
// Atomic creation fails with EEXIST for any existing file, directory or link.
await symlink(target, 'node_modules', 'dir');
if (await readlink('node_modules') !== target || await realpath('node_modules') !== expected) {
  throw new Error('Unexpected dependency link');
}
NODE
```

Ссылка создаётся заново с точным относительным target `../../apps/sponsor/node_modules`. Если `node_modules` уже существует, блок останавливается: сначала проверьте существующий объект; команда не удаляет и не заменяет его автоматически. Локальную scratch-ссылку нельзя копировать в репозиторий. Этот установочный блок приведён для будущего checkout; в текущем проверочном проходе зависимости не переустанавливались и не обновлялись.

### Запуск проверок

Из `deployment/legacy-export`:

```sh
node --import tsx test/run.mjs
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json
```

Используются Node 24, локальный workerd/Miniflare и синтетическая реальная SQLite. Внешняя сеть в workerd отключена. Отдельный процесс повторно читает тот же snapshot. Случай первого `alarm()` с возвращаемым `null` проверяется отдельной unit-моделью документированной семантики, а не выдаётся за точное воспроизведение всех планировщиков Cloudflare. API upload/deploy и реальный аккаунт не тестировались. Итоговые counts, версии зависимостей и SHA файлов — в `evidence/summary.json`; stdout — рядом.

Зависимости в этом проходе не устанавливались и не обновлялись: использована существующая проверенная установка `apps/sponsor/node_modules`. `package.json` перечисляет фактически проверенные версии. Для воспроизводимого запуска используйте зависимость от принятого sponsor lockfile; локальная ссылка `node_modules` не входит в переносимый комплект. Сгенерированные Worker-модули уже bundled и не загружают npm-пакеты при работе. Предельные 64 MiB относятся к формату снимка; допустимый размер конкретного боевого ledger дополнительно ограничен реальными CPU/memory-квотами Worker.

Codec скопирован без изменений из local commit `0151154adfeecbd05b267ba791ad7841e93d607c`, tree `ce00da8cfe9c13e04d68c1a3f465a52b704f9d17`; root сопоставил этот tree с remote `23037bd`. Это происхождение инструмента, **не доказательство commit старого production Worker**.

Официальные источники, проверенные 25.11.2026:

- [Upload Worker API](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/methods/update/) — existing binding namespace ID, сохранение типов bindings и проверка legacy migration tag.
- [Durable Object class exports](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/) — отдельный механизм lifecycle; этот комплект его не включает.
- [Durable Object code updates](https://developers.cloudflare.com/durable-objects/deployments/durable-objects-code-updates/) — отложенное обновление активного объекта и стратегия immediate; установка версии не равна сверке внешних операций.
- [Alarms API](https://developers.cloudflare.com/durable-objects/api/alarms/) — at-least-once invocation и значение `getAlarm()` во время обработчика.
- [List namespaces](https://developers.cloudflare.com/api/resources/durable_objects/subresources/namespaces/methods/list/) — идентичность namespace, owning script/class и SQLite backend.
- [Workers Request API](https://developers.cloudflare.com/workers/runtime-apis/request/) — режимы `follow`/`manual`; прокси использует `manual` и отклоняет 3xx. Режим `error` в workerd не поддерживается, что дополнительно воспроизведено локальным runtime.

Нет production export, deployment, mainnet подписи, платежа или live reconciliation. Реальные unknown-schema/KV/old-client/host/кошелёк gates остаются операционными условиями владельца.
