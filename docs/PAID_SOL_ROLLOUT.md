# Общее платное сохранение за SOL: реализация и включение

Дата среза: **21 октября 2026 года**.

**Общий paid SOL путь реализован в сервере и редакторе и проверен синтетическими тестами. Приём новых paid-заказов и отправка paid AR в текущей конфигурации выключены.** Результаты браузерной приёмки и состояние публикации приведены ниже. Синтетическая приёмка не означает настоящую оплату или готовность переноса на ArNS.

Общий путь принимает произвольный допустимый зашифрованный архив редактора. Он использует новый `sejire/order/v2`, оплату SOL по сохранённой политике и серверную прямую публикацию в Arweave Mainnet. Старые v1/ANS-104 заказы, фиксированный devnet-пилот и promo-сохранения сохраняют свои отдельные контракты. Код: [order](../packages/checkout/order.ts), [paid policy и preparation](../packages/checkout/paid.ts), [Checkout API](../apps/sponsor/src/checkout/api.ts), [Direct Arweave publisher](../apps/sponsor/src/checkout/directPreservation.ts).

## 1. Условия, которые уже определены

- Сохранение стоит **0.03 SOL — 30 000 000 lamports**. Дополнительный взнос — **0 по умолчанию**; комиссия Solana показывается отдельно. Эти величины не выбираются заново при включении.
- Сервер получает exact canonical `sejire/envelope/v1` ciphertext, SHA-256, размер, `vaultId` и явный `parentTxId: string | null`. Слова SEJIRE и незашифрованное дерево в заказ не входят.
- SOL network и genesis определяются серверной immutable policy. Для рабочего общего платного пути требуется явно назначенная `mainnet-beta`; выставление browser-флага или показ devnet-пилота не заменяют эту конфигурацию.
- Хранение у v2 всегда `arweave.N.1`. Trusted gateways: `https://arweave.net` и `https://g8way.io`. SOL network не переключает Arweave gateway.
- Один checkout оплачивает один неизменный архив. Повторный GET и reload продолжают исходную попытку. Явный повтор создания использует тот же key и exact payload и не создаёт второй order, второй SOL-платёж или новый signed AR TX для принятого заказа.

Источники: [контракт и фиксированная цена](../packages/checkout/order.ts), [immutable policy/message](../packages/checkout/paid.ts), [проверка ciphertext](../apps/sponsor/src/checkout/paidPolicy.ts), [browser client](../apps/web/src/lib/checkout/paidClient.ts), [publisher](../apps/sponsor/src/checkout/directPreservation.ts).

## 2. Что ещё необходимо назначить публично

До включения остаются **четыре назначения**:

1. Production SOL address получателя оплаты за сохранение.
2. Другой production SOL address получателя добровольного взноса.
3. Отдельный paid AR budget: публичный идентификатор allocation и его общий лимит в winston.
4. Максимальный AR reward одного paid-заказа в winston.

Адреса должны быть разными, соответствовать назначенным ролям и пройти проверку mainnet. Disposable devnet-адреса и System Program для этих ролей не подходят. Отдельный paid budget может использовать уже существующий AR treasury, но его allocation и расход не являются promo-лимитом. **13 AR promo quota нельзя автоматически присвоить paid-пути.** Общий лимит paid budget должен быть не меньше per-order cap; наличие достаточного физического AR-баланса проверяется отдельно.

AR signer уже хранится на сервере в `ARWEAVE_TREASURY_JWK`. Его значение не требуется повторно вводить, выводить, передавать браузеру или помещать в этот документ. Публичный `CHECKOUT_PAID_TREASURY_ADDRESS` должен совпадать с адресом, производным от существующего signer. Для использования существующего treasury Fund его именованный публичный адрес — `qgoIFw9WsusMRapWzcFg4jNW08HSWvQkpAKOz86BUuI`; выбор другого treasury требует отдельного решения и не выполняется скрытой заменой ключа.

Проверки назначения: [configuredPaidPolicy](../apps/sponsor/src/checkout/paidPolicy.ts), [validatePaidPolicy](../packages/checkout/paid.ts), [проверка signer/address](../apps/sponsor/src/checkout/directPreservation.ts), [публичный treasury Fund](../apps/sponsor/src/fund/ledger.ts).

## 3. Точная конфигурация

Текущее checked-in состояние приведено по [wrangler.toml](../apps/sponsor/wrangler.toml). Оно не является повторным чтением живого Worker. Effective deployed config и SHA должны быть зафиксированы отдельно при выпуске.

| Параметр | Текущее состояние | Назначение и условие включения |
|---|---|---|
| `CHECKOUT_PAID_ENABLED` | `"false"` | Приём новых v2-заказов. `true` только после заполнения политики и приёмки. `false` сохраняет существующие обязательства. |
| `CHECKOUT_PAID_EXECUTION_ENABLED` | `"false"` | Новые paid AR signatures и submit. При `false` разрешены чтение и проверка прежних подписанных TX; job и reserve сохраняются. |
| `CHECKOUT_PAID_NETWORK` | Не задан | Для production: явное `mainnet-beta`. Нет fallback на сеть старого пилота. |
| `CHECKOUT_PAID_POLICY_VERSION` | Не задан | Явный идентификатор принятой политики; от 1 до 64 символов `[a-zA-Z0-9._-]`. Новые условия получают новую версию; прежний order snapshot неизменен. |
| `CHECKOUT_SERVICE_RECIPIENT` | Production назначение отсутствует | Публичный mainnet SOL address получателя фиксированной оплаты. |
| `CHECKOUT_FUND_RECIPIENT` | Production назначение отсутствует | Другой публичный mainnet SOL address получателя добровольного взноса. При нулевом взносе перевод на него не включается. |
| `CHECKOUT_PAID_TREASURY_ADDRESS` | Не задан для paid policy | Явный публичный AR address, совпадающий с существующим server signer. Для общего физического баланса с Fund используется один и тот же адрес. |
| `CHECKOUT_PAID_AR_BUDGET_ID` | Не задан | Отдельный стабильный идентификатор paid allocation, не promo revision. Лимит относится к истории этого ID. |
| `CHECKOUT_PAID_AR_BUDGET_WINSTON` | Не задан | Положительное десятичное целое в winston: общий paid limit, учитывающий actual spend и активные paid holds. Не меньше per-order cap. |
| `CHECKOUT_PAID_MAX_REWARD_WINSTON` | Не задан | Положительное десятичное целое в winston: максимум reward одного заказа. **Весь cap резервируется до оплаты**, даже если первоначальная quote ниже. |
| `MAX_ENVELOPE_BYTES` | `"524288"` | Текущий production limit зашифрованного envelope — 512 KiB. Этот выпуск не увеличивает его. Размер HTTP body ограничен отдельно с учётом JSON escaping. |
| `ARWEAVE_TREASURY_JWK` | Существующий Worker secret | Повторный ввод не нужен. Только сервер; адрес должен совпадать с paid policy. Read-only reconciliation сохранённого signed TX не требует приватного ключа. |
| `CHECKOUT_LEDGER` | Binding `CheckoutLedger` | Существующий общий SQLite Durable Object. Имя объекта `sejire-checkout-ledger-v1`; не создавать per-order namespace или вторую независимую AR-кассу. |
| `CHECKOUT_ALLOWED_ORIGINS` | `https://azovskaya.github.io,https://sejire.ar.io` | Origin allowlist для API. Не ослаблять при публикации. Наличие `sejire.ar.io` в списке не означает публикацию ArNS. |
| `FUND_API_ENABLED` | `"true"` | Существующий promo-путь. Включение paid не меняет promo policy/лимит/историю. |
| `CHECKOUT_API_ENABLED`, `CHECKOUT_UPLOAD_ENABLED` | Не заданы в production config | Legacy v1/devnet/Turbo switches. Их включение не требуется для нового v2 и не заменяет paid policy. |
| `PAYMENT_PROVIDER` | `"mock"` | Старый cashier setting; не выбирает исполнителя v2. Modern route выбирается по `order.schema`, сохранённой policy и paid flags. |

`CHECKOUT_SERVICE_RECIPIENT` и `CHECKOUT_FUND_RECIPIENT` имеют общие с legacy checkout имена. При конфигурировании нужно проверить именно production `wrangler.toml`/effective Worker vars; переменные и адреса devnet-preview workflow нельзя переносить автоматически.

Клиентская сборка использует `VITE_PRESERVATION_V2_ENABLED=1` для общего выбора сохранения. API origin берётся из `VITE_CHECKOUT_API_URL`, затем `VITE_FUND_API_URL`, затем origin страницы. Origin должен быть точным HTTPS origin без path. Принятая CI-сборка должна указывать на нужный sponsor API. Старые `VITE_NATIVE_SOL_MAINNET=0` и `VITE_NATIVE_AR_BROADCAST=0` относятся к сохранённому legacy/native пути; переключать их ради общего v2 не требуется. Сеть и возможность новой оплаты клиент получает из `/api/checkout/policy`.

Источники: [runtime policy](../apps/sponsor/src/checkout/paidPolicy.ts), [route discriminator](../apps/sponsor/src/checkout/api.ts), [DO binding](../apps/sponsor/src/checkout/durableStore.ts), [build scripts](../package.json), [CI native build](../.github/workflows/checks.yml), [client endpoint/policy](../apps/web/src/lib/checkout/paidClient.ts), [выбор метода](../apps/web/src/components/PreservationV2.tsx).

## 4. Реализованные границы оплаты и хранения

### До открытия кошелька

Modern `POST /api/checkout/orders` проверяет exact serialized envelope, digest/bytes/vault/parent, snapshot политики, AR signer/address, balance/quote и готовность Solana payer/recipients/network. Order + ownership/idempotency + exact archive + prepared unsigned AR plan + paid hold записываются атомарно в общий SQLite. Quote выше cap, недостаточный physical balance, недостаточный paid budget и неверная политика не приводят к предложению оплаты.

`/prepare` сохраняет точные payment message bytes, их hash, blockhash, lastValidBlockHeight, fee, payer/reference/network/genesis и preparation ID. Browser сохраняет эту подготовку до обращения к кошельку. Подпись проверяется над теми же message bytes; серверный `/reserve` подтверждает public Ed25519 signature и связывает её с order/preparation **до broadcast**. Клиент использует `signTransaction`; `sendTransaction` происходит только после успешного reserve. Дополнительные инструкции, получатели, суммы или другая сеть не принимаются.

Явный отказ кошелька `4001` допускает продолжение того же подготовленного запроса либо его явную отмену. Неизвестный исход кошелька или потерянный ответ не разрешают новую подпись/новый заказ. `/cancel` сверяет точный preparation ID, включая `null`; атомарно выигрывает либо cancellation, либо signature reservation. Pending signature, paid credit и signed AR запрещают освобождение резерва этим способом. По обычному TTL истекает только untouched offer без preparation; неизвестный подготовленный платёж не объявляется неоплаченным по возрасту.

### Потерянный create response: прежний key, явный retry или отмена до admission

Автоматическое обновление читает `GET /api/checkout/orders/by-key/<key>` и не повторяет создание. Если order ID ещё неизвестен, пользователь может явно повторить **тот же** запрос: сначала выполняется scoped GET; лишь подтверждённый ответ «заказ не найден» разрешает снова отправить исходные ciphertext, archive binding, policy и idempotency key. Timeout, 401, произвольный 404/error, уже сохранённая preparation/signature и начатая отмена не разрешают такой retry. Новый key и новые bytes не генерируются; обычный TTL создания заказов остаётся обязательным.

Отдельное действие `POST /api/checkout/orders/by-key/<key>/cancel` атомарно выбирает один из двух результатов:

- Если admission уже создал v2-заказ, возвращается **его неизменённый snapshot**. Этот ответ не означает отмену. Preparation, pending payment, paid job и holds сохраняются; допустимость отдельной отмены по order ID проверяется прежними guards.
- Если заказа ещё нет, создаётся durable запись отмены `paid_cancelled_keys(owner,key)` и возвращается receipt `{schema:'sejire/paid-request-cancellation/v1', status:'cancelled', key}`. Проверка этой записи стоит внутри linked SQL transaction **до AR hold и owner/job links**. Поздний исходный POST отклоняется как `paid_request_cancelled`; вставка order откатывается. Повтор отмены и GET после потерянного ответа/restart возвращают тот же receipt.

Клиент разрешает завершить локальную попытку как отменённую только по exact cancellation receipt с прежним key. HTTP 200 или обычный snapshot для этого недостаточны. Запись отмены принадлежит паре owner/key: чужой одноимённый key не отменяет заказ владельца. Существующий v1 с таким key возвращает конфликт, а не получает новую семантику отмены.

Код: [API admission](../apps/sponsor/src/checkout/api.ts), [PaidLedger](../apps/sponsor/src/checkout/paidLedger.ts), [payment preparation](../apps/sponsor/src/checkout/paymentPreparation.ts), [точное сообщение и подпись](../packages/checkout/paid.ts), [frontend reserve/broadcast](../apps/web/src/lib/checkout/paidClient.ts).

### После подтверждения SOL

Проверяется finalized transaction в сохранённой SOL-сети: genesis, payer/signers, reference, exact message/blockhash/fee, инструкции, роли, суммы и включение в окно заказа. Поздняя проверка допустима для транзакции, включённой вовремя. Unique credit и durable storage job возникают в одной SQLite transaction; сбой записи job откатывает credit.

Runner продолжает задание из alarm после закрытия браузера и restart. Перед **первой** AR signature он может обновить anchor/quote для того же архива в пределах уже занятого cap; refreshed unsigned plan сначала сохраняется. Signed plan, ID, reward, exact ciphertext и recovery tags сохраняются до первого submit. После этого создаётся только повторная отправка того же подписанного объекта.

`submission_ack` означает возврат полного provider submit, включая chunks. Принятый header с потерянным chunk acknowledgement оставляет ack=false: следующий проход повторяет те же signed bytes/TX. При ack=true обычный pending TX проверяется чтением; not-found или неоконченная загрузка допускают повтор того же объекта. Retry не означает новый SOL-платёж или новый AR TX.

Код: [validator](../apps/sponsor/src/checkout/paymentValidator.ts), [RPC reader](../apps/sponsor/src/checkout/rpcReader.ts), [atomic credits](../apps/sponsor/src/checkout/sqliteStore.ts), [runner](../apps/sponsor/src/checkout/paidRunner.ts), [durable alarm](../apps/sponsor/src/checkout/durableStore.ts).

### Подтверждение расхода отдельно от завершения архива

| Состояние | Что доказано | Учёт / следующее действие |
|---|---|---|
| `queued` / `signed` / `submitted` | SOL credit сохранён; степень готовности AR определяется plan/ack | Paid hold остаётся; продолжить тот же job. HTTP acceptance не является completed. |
| `requires-reconciliation` | Результат пока нельзя полностью подтвердить | Сохранить точный job/signature/TX; выполнять bounded повторную проверку. |
| `confirming` | Проверена on-chain AR TX с точными owner/reward/header/tags, но archive proof ещё отсутствует | Paid actual spend учитывается однократно; отсутствие bytes не возвращает расход в резерв и не объявляет сохранение завершённым. |
| `completed` | Проверены on-chain TX и exact archive SHA-256/bytes/vault/parent | Выдать v2 receipt; завершить локальную историю с readback. Повторное чтение не создаёт расход. |

Последующая временная недоступность сети не отменяет уже доказанный on-chain расход. Receipt содержит order/policy, SOL payment signature/network, AR TX/network/treasury/reward и полный archive binding. Локальное завершение не должно откатывать более новый HEAD.

Publisher проверяет persisted prepared/signed bytes, canonical base64url, signature/owner, reward, zero quantity/empty target, data root, точные tags и ciphertext. В recovery tags присутствуют `App-Name`, `Type`, `Schema`, `Protocol-Version`, `Vault-Id`, `Archive-SHA256`, `Archive-Bytes`, `Preservation-Id`, а для продолжения — exact `Parent-Tx`. У paid нет `Promo-Funded: true`. Подмена raw signed payload или metadata не даёт подтверждения.

Чтение bounded: общий deadline, request timeout, ограничение полного body, отмена проигравших запросов, запрет произвольных redirect destinations. Raw/canonical недоступность допускает строгий base64url fallback `/tx/<id>/data`; он проходит ту же hash/size/envelope validation. Восстановление сохраняет проверки protocol и AES-decryption и не ослабляет их ради receipt.

Код: [direct publisher/proof](../apps/sponsor/src/checkout/directPreservation.ts), [общие mainnet readers](../apps/sponsor/src/fund/provider.ts), [paid ledger/proof](../apps/sponsor/src/checkout/paidLedger.ts), [receipt contract](../packages/checkout/paid.ts), [paid recovery](../apps/web/src/lib/checkout/paidReceipt.ts), [общий recovery reader](../apps/web/src/lib/recovery/retrieve.ts).

## 5. Общий physical AR guard и отдельный paid budget

`FundLedger` и `PaidLedger` работают в одном SQLite object. Приём paid и promo атомарно проверяет сумму активных holds одного treasury. Paid quota учитывает только paid `actual + reserved`; promo quota и history учитывают только Fund. Подтверждённый paid debit не расходует promo quota, но уменьшает общий доступный физический AR-баланс.

Revision, снятая **до** balance GET, обнаруживает debit, произошедший во время чтения. Persisted conservative balance ceiling защищает также от завышенного gateway snapshot уже **после** подтверждённого debit: новый usable balance не выше сохранённого остатка и наблюдаемого balance. Debit до первого наблюдения учитывается консервативно. Эти значения переживают restart.

**Пополнение treasury автоматически не повышает этот ceiling.** Это осознанная граница текущей реализации: высокая новая balance response не является достаточным доказательством того, что snapshot уже учитывает старые debits. В этой реализации нет отдельной принятой процедуры повышения ceiling после top-up. До такой процедуры дополнительные средства могут оставаться недоступными для новых holds. Не сбрасывать guard/историю, не менять budget ID и не удалять строки для обхода ограничения. Увеличение paid allocation само по себе также не увеличивает physical balance.

Код: [TreasuryGuard](../apps/sponsor/src/checkout/treasuryGuard.ts), [paid admission и proof](../apps/sponsor/src/checkout/paidLedger.ts), [Fund reserve/debit](../apps/sponsor/src/fund/ledger.ts), [проверки двух направлений и stale balance](../apps/sponsor/tests/paid.local.mjs).

## 6. Долговременное продолжение и доступ владельца

Обычная session действует **30 дней** для создания новых заказов. После её истечения исходный 256-bit bearer остаётся capability только для **точного уже принадлежащего ему v2-заказа**, найденного по order ID или owner-scoped idempotency key. Проверяются существующий session hash, ownership и связь с `paid_orders`. Срок сессии не продлевается; чужой order/key и v1 не получают такого исключения. Новый bearer не наследует прежние заказы. Значения токенов не выводятся в журнал проверки или URL.

Для отмены запроса до admission есть второе узкое исключение: **известная серверу session, в том числе expired, может отменить только свой exact key**. Это не продлевает session и не разрешает create. После отмены scoped GET по той же паре owner/key возвращает receipt. Такой POST/GET работает и при выключенных paid flags, даже если ни одного `paid_orders` ещё не было. Неизвестный bearer, чужой order и чужая запись отмены остаются недоступными.

Эти правила позволяют браузеру получить прежнюю receipt и закончить локальную запись после длительного отсутствия либо безопасно закрыть не принятый сервером запрос. Сам runner вообще не требует browser token. Неизвестный create response читается по сохранённому key; автоматическое обновление не повторяет `POST /orders`, а явный same-key retry ограничен правилами раздела 4. Durable browser journal сохраняет exact encrypted bytes, ID, policy, preparation и прежнюю signature; recovery words туда не входят. Общий promo/paid guard и межвкладочный operation lock исключают новую оплату поверх незавершённой попытки.

Источники: [ownerPaid / scoped resume](../apps/sponsor/src/checkout/apiLedger.ts), [HTTP auth scope](../apps/sponsor/src/checkout/api.ts), [v2 DO dispatch](../apps/sponsor/src/checkout/durableStore.ts), [browser journal](../apps/web/src/lib/checkout/paidJournal.ts), [общий guard](../apps/web/src/lib/checkout/vaultGuard.ts).

## 7. Уже полученные backend-доказательства

Следующие результаты относятся к текущему набору изменений и синтетическим fixtures. Они проверяют production code paths, но **не являются настоящей mainnet оплатой, подтверждением живого Fund ledger или доказательством уже выполненного production deploy**. Workerd suites запрещают unmatched external connections; ключи и подписи тестовые, без средств.

| Проверка | Подтверждённый результат | Основное доказательство |
|---|---:|---|
| Paid primitives | **18 PASS** | [paid.selftest.ts](../apps/sponsor/src/checkout/paid.selftest.ts): v2/policy/message/network/signature/validation. |
| Direct publisher | **16 PASS** | [directPreservation.selftest.ts](../apps/sponsor/src/checkout/directPreservation.selftest.ts): exact prepare/sign/submit/proof, tamper rejection, bounded reads/chunks. |
| Paid SQLite | **19 PASS** | [paid.local.mjs](../apps/sponsor/tests/paid.local.mjs): реальные SQLite transactions/reopen, CAS, atomic credit/job, shared holds, stale balance, ack retry, scoped expired capability и обе стороны гонки cancel-before-admission с durable cancellation receipt. |
| Direct publisher в workerd | **7 PASS** | [direct-preservation-runtime.mjs](../apps/sponsor/tests/direct-preservation-runtime.mjs): actual default fetch/RSA, lost ack, secretless restart. |
| Paid API/DO в workerd | **15 PASS** | [paid-api-runtime.mjs](../apps/sponsor/tests/paid-api-runtime.mjs): actual API/default adapters/SQLite/alarm, pause/restart, partial upload, exact old TX; отмена при paused/zero-orders/expired session, receipt после restart, late create без holds, unchanged existing preparation и чужой одноимённый key. |
| Legacy checkout | **53 PASS** | [checkout/selftest.ts](../apps/sponsor/src/checkout/selftest.ts). |
| Legacy RPC | **57 PASS** | [rpc.selftest.ts](../apps/sponsor/src/checkout/rpc.selftest.ts). |
| Legacy payment preparation | **10 PASS** | [preparation.selftest.ts](../apps/sponsor/src/checkout/preparation.selftest.ts). |
| Fund SQLite/API | **24 PASS** | [fund.local.mjs](../apps/sponsor/tests/fund.local.mjs). |
| Fund в workerd | **18 PASS** | [fund-runtime.mjs](../apps/sponsor/tests/fund-runtime.mjs). |
| Прежний checkout API в workerd | **32 PASS** | [api-runtime.mjs](../apps/sponsor/tests/api-runtime.mjs). |

Команды уже подключены в [root package scripts](../package.json), [sponsor scripts](../apps/sponsor/package.json) и проверках [Worker deploy workflow](../.github/workflows/deploy-promo-fund-worker.yml). Перед выпуском результаты должны относиться к **одному exact source SHA**; локальные PASS не заменяют успешный полный CI этого SHA.

### Frontend evidence

Локальная браузерная приёмка выполняется в Chromium с синтетическими семьями, тестовым кошельком без средств и подменёнными HTTP/RPC-ответами. Непредусмотренные внешние запросы запрещены. Приватное расширение Phantom/Solflare и живой production backend этими проверками не подменяются.

| Проверка | Результат | Что проверено |
|---|---|---|
| `npm run test:paid-browser` | **11 PASS** | Реальный редактор: два дерева → один SOL payment → verified AR receipt → вся локальная история → восстановление в чистом контексте по словам/receipt. |
| Сбои paid в той же browser suite | **PASS** | Потерянный create response после admission и отказ до admission; exact-key retry; потерянная отмена/reload; неизвестный wallet result; потерянный reserve; явный `4001`; две вкладки и общий promo/paid guard; неверная сеть/заказ; поздний ответ кошелька после смены контекста. |
| Локальное завершение в той же suite | **PASS** | Ошибка записи истории не снимает pending guard. Явный повтор локального завершения не повторяет оплату. Более новый HEAD сохраняется; успешный callback закрывает диалог. |
| `npm run test:paid-client --prefix apps/web` | **PASS** | Exact bytes/message/signature, различие точного `order_not_found` и произвольного 404, immutable журнал, создание выиграло гонку отмены, standalone local archive readback. |
| `npm run test:fund-browser --prefix apps/web` | **25 PASS** | Прежние promo-сценарии, три последовательных дерева и cold restore, lost response/reload, legacy exact-file migration, новый standalone-файл и exact ciphertext при смене метода. |
| `npm run test:v2-recovery-browser --prefix apps/web` | **29 PASS** | Прежние сценарии восстановления. Вместе с paid 11 и promo 25 проверены 65 различных browser-сценариев; два paid cancellation case дополнительно повторены после callback-правки. |
| `VITE_FUND_API_URL=… npm run native:build` | **PASS** | Финальные TypeScript и native build после исправлений импорта нового файла и возврата между способами сохранения. |
| `npm run security:fund` | **PASS** | 20 frontend source и built JS files; secret payload/treasury private key в сборке отсутствуют. |
| `node scripts/native-bundle-audit.mjs` | **PASS** | Старые Turbo/arbundles/ethers/secp256k1/SPL/Cloudflare пакеты не попадают в emitted native bundle, включая dynamic chunks. |

Прежние promo-сценарии дополнительно обнаружили и подтвердили исправления двух совместимостей: новый standalone-файл после прежнего COMPLETED проходит строгую проверку старого журнала; возврат из недоступного paid до создания попытки сохраняет уже выбранные ciphertext/parent. Editor и pending paid при этом продолжают исходную попытку.

Сценарии: [paid browser](../apps/web/tests/paid-solana.spec.mjs), [client selftest](../apps/web/src/lib/checkout/paidClient.selftest.ts), [promo browser](../apps/web/tests/promo-funded.spec.mjs). Независимый review проверил payment/context/ownership/cancellation boundaries; выявленные ошибки исправлены до фиксации кода.

### Публикация текущего изменения

Код отправлен в `feat/promo-funded-preservation`: **`a38cb0841bbe6ed24022e742d8abfbc8c9ede584`**, tree `2f174a15df2139141a0ac550db56c8ff0a8c4c17`. Он побайтно совпадает с сохранённым локальным коммитом `18e5b8cc8f626193ef5b40262ff7d8c6fec9d103`; резервная ветка `local/paid-sol-implementation-20261021` сохранена. При продолжении после обрыва проверены все 23 frontend SHA-256 из `.cache/paid-general/verification.json`: совпали с committed source. Сами тесты и сохранения не запускались заново для восстановления контекста.

**Worker опубликован:** [run 39605952653](https://github.com/azovskaya/sejire_arweave_solana/actions/runs/39605952653), [job 119242060644](https://github.com/azovskaya/sejire_arweave_solana/actions/runs/39605952653/job/119242060644), head gate и Deploy step — success, не skipped. Version **`f510c32e-7fce-404d-bfeb-f1710ca84967`**. Actual Wrangler log подтверждает оба paid flags `false`. Публичных Worker/Admin probes при этой проверке не было.

Первый полный [CI 39605952744](https://github.com/azovskaya/sejire_arweave_solana/actions/runs/39605952744) **не принят**: серверные gates и сборки прошли, но первый checkout browser fixture import прервала автоматическая перезагрузка Vite; 4 других checkout case прошли. Diagnostic trace показал HTTP 504 `Outdated Optimize Dep`; изолированное cold-cache воспроизведение установило late discovery `vite-plugin-node-polyfills/shims/buffer` и `optimized dependencies changed. reloading`. Это произошло до restore/payment. Узкое исправление относится к test-only dependency prebundle/cache и запрету непредусмотренной сети в checkout harness; product payment/storage не переписываются. Следующие browser gates первого CI были skipped, поэтому его нельзя использовать для выпуска Pages. После test-only исправления холодный checkout прошёл **5/5**, отдельный холодный protocol checkout — **5/5** (JSON: 0 unexpected/skipped/flaky, errors пуст); прежние assertions сохранены. Late shim discovery, optimizer reload и 504 отсутствуют. Все три изменённых тестовых файла прошли targeted lint. Независимый review diff и логов — PASS. Полный CI новой версии остаётся обязательным.

Новая Pages-сборка **ещё не опубликована**. До успешного полного CI принятой версии остаётся предыдущая сборка `d6a8a00d4b85ef5e0e5c614c7c7a98319a9511f9`, Pages release `ee8e96b66eab12b85e53aa443807b4cb2164b5a8`. Новый source/run/artifact/ZIP/provenance фиксируются после реальной публикации.

## 8. Последовательность выпуска и активации

1. **Закончить приёмку кода.** Заполнить frontend evidence; получить полный CI на exact source SHA. Проверки должны включать новые paid suites и прежние promo/legacy suites. Flags остаются false, пока отсутствуют назначения из раздела 2.
2. **Подготовить reviewable конфигурацию.** Внести только публичные назначенные recipients, paid allocation/cap, policy version, SOL network и именованный AR treasury. Сопоставить budget units и signer address, не раскрывая и не вводя заново существующий secret. Проверить readiness-условия по коду и fixtures до живого включения.
3. **Выпустить принятый код с закрытым paid admission/executor.** Записать точный source SHA Worker, убедиться, что head gate и deploy step действительно выполнены, а не skipped, и записать Version ID. Если после этого изменился только тестовый harness или документация, доказать побайтное совпадение backend/config с принятой сборкой; не приписывать старому deployment новый SHA. Это не доказывает готовность живых выплат. Текущий workflow имеет concurrency и последний head check; не обходить их и не ослаблять protections.
4. **Опубликовать ровно принятую native-сборку.** Для GitHub Pages использовать `native-admin-build` из успешного CI того же SHA, проверить artifact ID/ZIP digest/provenance и допустимые пути, не пересобирать из другого дерева. Пользовательский root URL и `/native-admin/` должны содержать ту же принятую сборку; сохранить посторонние root assets и существующий admin verifier. Проверить публичные build markers. Артефактный механизм: [pages-native-artifact.mjs](../scripts/pages-native-artifact.mjs).
5. **Выполнить отдельный шаг включения после готовой конфигурации и разрешённой проверки.** Перевести paid switches только в явно принятой deployment-конфигурации. Проверить policy/readiness, immutable terms, достаточный paid allocation/physical guard и действующие CORS/ownership rules. Текущая сессия не выполняет Worker/Admin probes и не обходит ранее наблюдавшуюся Cloudflare-защиту.
6. **Провести настоящую пользовательскую приёмку, когда она отдельно готова и разрешена.** Зафиксировать exact ciphertext hash/bytes/vault/parent, цену 0.03 SOL, дополнительный взнос по выбору владельца, отдельную network fee и утверждённый AR cap. Живую подпись кошелька выполняет владелец. При неизвестном исходе продолжать исходный ID; не просить повторно оплатить. Принять результат только после SOL credit, AR confirmation, archive verification, local completion и восстановления архива. Synthetic PASS не заменяют эту запись.
7. **ArNS — отдельный последующий выпуск.** Только после принятия обоих пользовательских методов переносить принятый artifact. Этот документ не выполняет upload, подпись, платёж или изменение `sejire.ar.io`.

Для каждой публикации сохраняются фактические source/run/artifact/Version/provenance и результат проверок. До их появления формулировка результата — «код реализован, paid выключен, live acceptance не проведена».

## 9. Пауза и границы rollback

| Ситуация | Допустимое действие | Что сохраняется |
|---|---|---|
| Нужно остановить новые предложения | `CHECKOUT_PAID_ENABLED=false`, executor оставлен в ранее принятом состоянии | Existing offers/payments/jobs остаются адресуемыми; runner продолжает принятые обязательства. |
| Нужно остановить новые AR signatures/submit | `CHECKOUT_PAID_EXECUTION_ENABLED=false` | Exact archive, paid hold/credit, prepared/signed bytes и TX ID; read-only reconciliation и уже доказанный результат. Новая signature/submit не выполняются. |
| Оба paid flags false после появления заказов | Оставить совместимый v2 Worker и binding | Scoped owned resume, alarm/job state и completed receipt; отсутствие текущей ready policy не стирает старую policy. |
| Ошибка новой UI-сборки | Вернуть проверенную совместимую UI-сборку | Browser journals и ciphertext не удаляются; server job продолжает существовать. Совместимость old UI с v2 должна быть проверена. |
| Нужен Worker rollback | Только binary, сохраняющий v2 dispatch, scoped auth, paid tables, guard и runner | Старый v1-only binary отвергает v2 и не является полноценным способом продолжить эти jobs. Не считать его безопасным operational rollback при наличии v2 обязательств. |
| Gateway timeout / archive unavailable | Проверять прежний TX; при нужном retry отправлять только прежний signed object | Unknown outcome не освобождает hold; confirmed spend не обнуляется; completed требует archive proof. |
| Balance ceiling не вырос после top-up | Оставить admission закрытым при нехватке usable balance; подготовить отдельную доказуемую процедуру обновления guard | История debits, quotas и pending не сбрасываются. |

Не удалять SQLite/Durable Object, `paid_holds`, `paid_payloads`, `paid_cancelled_keys`, payment preparations, browser attempts или signed TX для «повторной попытки». В частности, удаление cancellation receipt снова открыло бы путь позднему create с тем же key. Не менять старым заказам recipients, parent, policy, budget binding, reward или signed bytes. Не переводить paid расход в promo quota. Изменение admission или текущей policy применяется к новым предложениям и не переписывает принятые обязательства.

Кодовые границы rollback: [новый discriminator](../packages/checkout/order.ts), [additive tables и immutable payloads](../apps/sponsor/src/checkout/paidLedger.ts), [shared treasury guard](../apps/sponsor/src/checkout/treasuryGuard.ts), [runner pause/retry](../apps/sponsor/src/checkout/paidRunner.ts), [resume routes](../apps/sponsor/src/checkout/api.ts).
