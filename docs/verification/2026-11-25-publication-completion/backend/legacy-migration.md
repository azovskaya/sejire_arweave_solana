# Прежний Worker ledger → новая Linux SQLite

## Текущий статус и конкретный инструмент

Добавлены `apps/sponsor/src/checkout/migrationSnapshot.ts` (read-only encoder/validator полного private snapshot), `apps/sponsor/ledger-snapshot.mjs` (offline importer) и `apps/sponsor/bin/import-ledger.mjs` (CLI). Синтетическая приёмка — `apps/sponsor/tests/ledger-import.mjs`, входит в `test:linux`. Проверены неизменность всех исходных строк, raw strings и rowids, старые optional columns, foreign keys, hash/count manifest, исключение существующего/live destination и блокировка запуска до operator review.

**Реальный Cloudflare export, freeze и переключение не выполнялись.** У прежнего public Worker нет безопасного полного export/import endpoint. Owner должен подготовить и развернуть временный защищённый export-only entry в ТОМ ЖЕ production Worker/namespace/object, остановить старые исполнения и получить private snapshot. Этот offline importer не замораживает живой Worker, не удостоверяет его остановку и не превращает admin summary в полную базу. Свежая пустая Linux DB не заменяет прежний ledger.

## Что переносится

Авторитетный объект: `CHECKOUT_LEDGER.idFromName('sejire-checkout-ledger-v1')`. Все указанные таблицы находятся в одном объекте; другой namespace с тем же именем объекта — другая база и не является допустимым источником по умолчанию.

| Данные | Таблицы | Сохраняемые инварианты |
|---|---|---|
| Базовый журнал | `schema_version`, `orders`, `used_transactions`, `credits` | IDs, immutable order JSON, network/reference, pending signature, payment evidence, states, уникальность network/signature/instruction и все суммы как decimal strings |
| Владение и idempotency | `api_sessions`, `api_orders`, `paid_cancelled_keys` | SHA capability tokens, expires_at (в том числе уже истёкшие capability старых v2 orders), owner/key/intent, отменённые ещё не созданные requests; tokens не перевыпускаются |
| Legacy execution | `api_execution` | Исходные signed upload plan/raw/envelope, accepted receipt, retrieved flag и lease; не преобразовывать в новый платёж |
| Paid v2 | `paid_orders`, `paid_payloads`, `paid_archive_repairs`, `paid_payment_recoveries` | Policy snapshots, preparation/signature/receipt/proof, status/retry/leases, archive/prepared/signed/signed-payment rows byte-for-byte, прежние recoveries и fences |
| Общая физическая казна | `treasury_revision`, `treasury_balance_ceiling`, `paid_holds` | Revision, ceiling, unobserved_debit, budget IDs, reservations/actual/released. Нельзя вычислить заново из текущего gross balance или обнулить spent |
| Promo | `fund_settings`, `fund_orders`, `fund_order_links`, `fund_events`, `fund_audit`, `fund_meta` | HMAC текущего кода/hint/revision/enabled, лимит, parent-bound/unbound semantics, prepared/signed JSON, TX IDs, actual/reserved, sequence и audit без переписывания истории |
| Autonomous promo | `fund_jobs` | Persisted lease/next_at/attempts/error. Если старая schema ещё не имеет этой derived таблицы, новый runtime создаёт задания для старых активных orders без смены signatures |
| Адреса SOL | `solana_recipient_settings`, `solana_recipient_audit` | Публичные адреса, revision/history; уже принятые orders сохраняют свои snapshots |
| Новое пополнение | `treasury_topups`, `treasury_topup_audit`, `treasury_topup_transfers` | Nonce, исходный baseline, credited proof/revision/TX uniqueness; unsigned/signing claim и единственная signed попытка. Старые nonce-less prepared intents требуют review |
| Ограничения частоты | `api_rates`, `fund_rates` | Временные buckets сохраняются, чтобы restart/import не обходил действующие лимиты |
| Метаданные SQLite/alarm | `sqlite_sequence`, `storage.getAlarm()` | Прежние rowids и счётчики AUTOINCREMENT; alarm timestamp отдельно от таблиц платформы. В Linux он хранится в `sejire_alarm` |

Snapshot codec содержит явный allowlist29 app tables и обязательный baseline schema. Unknown app table, пропущенная обязательная таблица, активный paid/promo/legacy `api_execution` lease или несовместимые columns вызывают отказ. Cloudflare internal `_cf_*` не копируются как app tables. Если реальный источник имеет более старую schema, сначала нужен отдельный проверенный additive schema upgrade/export entry; нельзя просто отметить отсутствующие финансовые таблицы пустыми.

## Вне SQLite: обязательная отдельная инвентаризация

Legacy `/v1/*` использует `IDEMPOTENCY` KV: payment sessions (`sej_*`), `kaspi:<orderId>` indexes, `ops:state` и `ops:secrets`. Старые сохранённые данные, оплаченные/неисполненные сессии и privacy-preserving indexes не заменяются новым SQL ledger. Linux adapter не монтирует прежний Kaspi/Turbo admin runtime. Их нужно сохранить в защищённом архиве/обслуживаемом read-only legacy path до закрытия обязательств, либо отдельно реализовать согласованную миграцию.

`ops:secrets`, private JWK, passwords/tokens и signer material не входят в JSON ledger snapshot и не выводятся в чат/логи. Владелец устанавливает signer в новом защищённом runtime отдельно, сохраняя нужные публичные treasury addresses. Новый admin authorization на `ADMIN_TOKEN` не переносится из browser localStorage. Смена `PROMO_CODE_SECRET` без обновления HMAC settings сделает текущий код невалидным; секрет устанавливает владелец, а история revisions/orders остаётся неизменной.

Экспериментальные `src/protocol` signed journals/checkpoints, если они когда-либо обслуживали реальные обязательства, являются отдельным источником: сохранить genesis, checkpoint/head, ordered entries, ciphertext и signed upload bytes. Нельзя объявлять, что они автоматически вошли в SQLite. Конкретный старый `AtwLYx509C9jWIFKUNg7dy1GSgiaDbXVK1YEQbBWfHY` должен быть сопоставлен со своим исходным журналом/receipt и восстановлен, а не заменён новым платежом.

## Процедура owner-controlled extraction

1. Через подтверждённый доступ владельца определить действительный production Worker, namespace ID, fixed object ID и source commit. Сверить публичные orders/старое обязательство с этим источником. Не выбирать test namespace или новый пустой DO по совпадению имени.
2. Подготовить временный **export-only** Worker entry с теми же binding/class identity и server-side admin authorization. Он не монтирует checkout/fund admissions, sign/replay/execute или legacy payment upload routes. `alarm()` этого временного entry не запускает исполнителей. Оригинальный alarm timestamp фиксируется ДО его отключения. Source остаётся отключённым после extraction, пока не принято решение о единственном исполнителе.
3. Переключение source entry и durable freeze — отдельные owner-authorized production actions. Admission flags=false недостаточны: прежние подписанные jobs продолжаются намеренно. Нужно остановить/дождаться всех старых in-flight исполнений и исключить старую версию в traffic split. Истёкший lease сам по себе не доказывает остановку старого процесса. Не запускать одновременно новый Linux executor.
4. Только после quiescence вызвать из фиксированного DO `readOnlyLedgerSnapshot(ctx.storage, source)`. В `source` передать точные поля: `platform: 'cloudflare-durable-object'`, `namespaceId`, `objectId` (64hex), `objectName: 'sejire-checkout-ledger-v1'`, `sourceCommit` (40hex), `quiescedAt`, `exportedAt` (UTC epoch ms), `attestation: 'SOURCE_EXECUTION_STOPPED'`. Attestation — утверждение оператора, не автоматически доказанный факт. Если alarm был отключён export-only entry, adapter `getAlarm()` для encoder должен вернуть заранее сохранённый original timestamp.
5. Encoder читает app tables в одной synchronous SQLite transaction, берёт exact rowids/columns/rows и counters, проверяет allowlist и отсутствие active leases, вычисляет per-table SHA256/count и manifest SHA256. Он НЕ меняет источник. Первая версия отказывает для serialized table data больше64MiB; крупный источник требует отдельно проверенного chunked export, без усечения.
6. Защищённый owner-only endpoint отдаёт результат как приватный файл. Сохранить его с mode0600 и отдельно записать manifest SHA256 непосредственно из trusted source response/log. Snapshot содержит ciphertext, signatures, capability hashes и metadata; не помещать его в Git, public bucket или чат. Public `/admin/dashboard`, `/paid-orders`, `/v1/admin/overview` редактированы и для extraction не подходят.
7. Сверить source table counts/hashes, totals по networks/budgets, активные holds, unresolved signatures/TXs, legacy inventories и old receipt. Подписать операционный акт cutover с точными namespace/object/source/SHA и временем quiescence. До этого импорт проверяет формат/целостность, но не владение источником и не полноту реальных обязательств.

Source export-only deployment остаётся отдельной необходимой owner operation; безопасный endpoint не добавлен в обычный public runtime и production источник этим инструментом не запрашивается.

## Offline import в новую базу

Из `apps/sponsor`, с установленными штатными dependencies:

```sh
node --experimental-sqlite --import tsx bin/import-ledger.mjs \
  --snapshot /private/sejire-ledger.json \
  --output /private/new-ledger/sejire.sqlite \
  --expected-sha256 SOURCE_MANIFEST_SHA256
```

`SOURCE_MANIFEST_SHA256` — отдельно проверенный digest из source, не автоматически прочитанный из произвольного входного файла. В собранном operator image используется скомпилированный entry с теми же arguments, если он включён в build.

Importer сначала проверяет private regular file/size/manifest/table hashes/counts и columns по текущей trusted schema в памяти. Затем canonicalizes путь, берёт ТУ ЖЕ kernel SQLite guard, что startup/restore, повторно проверяет отсутствие destination/WAL/SHM/review marker и создаёт/fsync review marker ДО создания DB. Он никогда не перезаписывает существующий файл, не исполняет SQL из snapshot, не читает ключи и не выполняет network calls.

Все исходные rows вставляются в одной transaction с exact readback; проверяются foreign keys, singleton/schema version и integrity_check. Optional historical columns получают только известные совместимые defaults. Затем восстанавливается лишь derived promo queue, сохраняется alarm, выполняются WAL checkpoint/fsync. Final marker содержит исходный snapshot digest и финальный **database file SHA256**. При ошибке частичный destination остаётся закрыт marker; автоматического удаления/перезапуска нет.

## Приёмка перед снятием барьера

Пока marker существует, новый Linux откажет ДО DB initialization и alarm. Владелец сверяет исходные/новые counts и hashes, token-hash owner/key mappings, signed payload hashes, credits, policy snapshots, treasury ceiling/holds/spent, recipients, promo revisions и unreconciled obligations. Проверяется, что старый executor действительно остаётся остановлен и прежние client journals смогут дойти до нового authoritative API (base-URL/compatibility routing, CORS, retained capabilities).

Далее выполняется read-only chain reconciliation сохранённых signatures/TX IDs и проверка соответствующих ciphertext/receipts. Не отправлять повторный платёж и не генерировать новые signed archives вместо неразрешённых старых. Владелец явно подтверждает `RECONCILIATION_REVIEWED` с **database SHA256** через root `linux-backup.mjs acknowledge` workflow; точный синтаксис — в deployment README. Только после этого допускаются один Linux executor, проверка возобновления прежних jobs и отдельная новая Mainnet/promo end-to-end приёмка. Снятие marker — operator acknowledgement, а не автоматическое доказательство blockchain completeness.
