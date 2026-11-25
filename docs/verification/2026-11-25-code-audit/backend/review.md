# Backend review — 25 ноября 2026

## Вывод и область проверки

Проверена серверная часть целевого продукта **SOL Mainnet + промокод + администрирование, без обязательного Cloudflare**. Исходная точка — `a2b738b`, рабочая ветка `fix/release-code-audit-20261125`. Изменения этого прохода локальны; этот отчет не является свидетельством deployment или готовности production-конфигурации.

Новый сквозной тест подтвердил реальный Linux HTTP → SQLite → paid runner → сохраненные подписанные байты → восстановление после повторного открытия базы. Обнаружены и исправлены два существенных дефекта продолжения promo-загрузки и один дефект классификации HTTP-ошибки. Привязка кода к реальному production API, реальным кошелькам и казне этим не подтверждена. **Публичный прием реальных денег пока не разрешен результатами данного backend-прохода.**

Исходники и их SHA-256 перечислены в [coverage.json](coverage.json). Там разделены глубокое чтение активного пути, чтение границ старых подсистем и выборочный просмотр. Это перечень ручного review, а не процент автоматического statement/branch coverage. Общий аудит frontend, shared packages, сборки и публикации ведется отдельно.

## Воспроизведенные дефекты и исправления

### B1. У promo не восстанавливались данные уже подтвержденной транзакции

До исправления `fund/api.ts::settle` повторял сохраненную транзакцию только при `state === 'not_found'`. Если заголовок уже подтвержден, а архивные данные не доступны, явный POST прежнего заказа или admin reconciliation лишь повторяли чтение. Сохраненные подписанные байты были в ledger, но данные не отправлялись повторно.

Воспроизведение прошло через настоящий Linux HTTP adapter и реальную SQLite: после потери ответа на загрузку и повторного открытия базы имитировались подтвержденный заголовок и отсутствующие данные. Повтор прежнего заказа оставался `VERIFYING` вместо `COMPLETED`. См. [promo-missing-data-before.log](promo-missing-data-before.log).

Исправление в [fund/api.ts](../../../../apps/sponsor/src/fund/api.ts) и [fund/provider.ts](../../../../apps/sponsor/src/fund/provider.ts): при явном повторе и подтвержденном заголовке исполняется `replayData` только прежней подписанной транзакции; новый заголовок, новая подпись и новая оплата не создаются. После отправки требуется повторная проверка доступных байтов. Обычный GET заказа остается читающей операцией. Исторические `COMPLETED` записи этим проходом не переписываются и автоматически не превращаются в новые repair jobs.

Оставшийся общий deadline проверки не увеличен: первый поиск данных получает треть оставшегося времени, replay — две трети времени после этого поиска, финальная проверка — оставшийся бюджет. Новый Linux-тест удерживает первоначальное чтение до его deadline и проверяет, что на replay осталось реальное время. Это исключает вариант, когда все 22 секунды были израсходованы на поиск недоступных данных, а repair не мог даже начаться.

### B2. Promo submit наследовал долгий внутренний цикл SDK

`DirectArweaveFundProvider.submit` использовал `ar.transactions.post`. В установленном Arweave SDK эта операция повторяет нефатальные ошибки chunk upload с длительными паузами и допускает до 100 ошибок. Общий deadline fund API не ограничивал этот цикл. Подписанные байты оставались безопасно сохранены, но HTTP-запрос и завершение процесса могли ждать значительно дольше срока запроса.

Regression с временной RSA-парой, настоящей native Arweave-подписью и полностью перехваченным gateway воспроизвел незавершенный вызов после ошибки chunk: [promo-submit-before.log](promo-submit-before.log). Это проверка именно отправки валидных сохраненных байтов; соответствие временного ключа фиксированной production-казне не заявляется.

Новый `writeFundTransaction` в [provider.ts](../../../../apps/sponsor/src/fund/provider.ts) делает один ограниченный проход: отдельно подписанный заголовок без встроенных данных, затем его Merkle chunks. Неопределенный ответ возвращается в существующее состояние reconciliation. Последующий повтор использует прежний ID. Общий предел — не более 22 секунд; отдельные запросы также ограничены временем. Тест моделирует как ответ 503, так и fetch, который вообще не завершает Promise и игнорирует abort.

До любого POST проверяются format 2, разрешенные поля raw JSON, подпись, data size, точное base64url-представление и заново вычисленный Merkle root. SDK не должен доверять внедренным `raw.chunks`: эти поля запрещены, а локальный кэш chunks очищается перед вычислением. Для repair дополнительно сверяются digest, размер и vault ID из ledger. Regression подменяет данные и пытается передать старые chunks; ни один POST не допускается. Это защита внутренней границы сохраненных байтов; публичный API не принимает произвольную signed Arweave-транзакцию клиента.

### B3. Неверные подписанные SOL-байты маскировались как backend uncertainty

В новом Linux-тесте измененный `signedMessage` корректно отклонялся до reserve, однако его `payment_preparation_mismatch` отсутствовал в безопасном списке ошибок durable adapter и превращался в `503 checkout_requires_reconciliation`. Аналогично терялся `invalid_signed_payment`.

Исправлены только списки передачи и классификации ошибок в [durableStore.ts](../../../../apps/sponsor/src/checkout/durableStore.ts) и [api.ts](../../../../apps/sponsor/src/checkout/api.ts). Неверная подпись, измененное сообщение и измененная signed transaction теперь дают `400` с фиксированным кодом. Regression проверяет отсутствие сохраненного signed-payment и отсутствие relay. Правила проверки подписи и запрета повторной оплаты не ослаблены. Для действительно неопределенного commit/transport сохраняется reconciliation.

## Что проверено в активном пути

- **HTTP и полномочия.** Разрешенные origins, формат/размер запроса, отдельный bearer владельца paid-заказа, невозможность другого bearer читать заказ или получить его по idempotency key. Административные promo/лимит/получатели требуют серверный admin credential. Secret, prepared и signed transaction не возвращаются в публичном FundOrder.
- **Idempotency и ротация.** Повтор accepted owner/key сохраняет прежние order, reference, policy и данные. Изменение SOL-получателей меняет новые предложения; существующий заказ продолжает прежние реквизиты. Повтор admin-save с уже записанными адресами не создает дополнительную revision. Старый policy для нового заказа отклоняется.
- **Оплата.** Проверяются сеть/genesis, finalized evidence, конкретные compiled instructions, payer, сумма, reference, fee и сохраненная подготовка. Подпись проверяется до reserve. Signed SOL transaction записывается в SQLite до `sendTransaction`. Потерянный ответ не порождает новый перевод; неопределенное состояние нельзя отменить как неоплаченное.
- **Учет.** `orders`, `used_transactions`, `credits`, paid job и AR hold связываются SQLite-транзакциями. Суммы хранятся десятичными строками, расчеты используют BigInt. Повторные подтверждения не увеличивают расход. Shared treasury guard учитывает paid/promo резервы, но бюджеты остаются раздельными; соответствующие старые SQLite regressions существуют в `tests/paid.local.mjs` и запускаются в общем проходе root.
- **Подпись и отправка Arweave.** Paid signer привязан к сохраненной policy. До первого submit подписанные bytes и ID сохраняются в ledger. Подтверждение заголовка не считается подтверждением доступности архива. Completion требует проверки прочитанных байтов; последующий paid repair сохраняет receipt и accounting.
- **Restart.** Новый Linux-тест повторно открывает ту же SQLite после потери ответов. Сохраняются owner/key, исходный SOL payment, AR ID, signed bytes, recipient revision и promo revision. Реальный Linux alarm продолжает зарезервированную оплату без дополнительного вызова execute/verify от браузера. Уже существующий процессный regression дополнительно проверяет SIGKILL и исключение двух writers.
- **Promo.** Ротация/отключение кода влияет на новые сохранения. Уже принятый заказ продолжается по прежней записи даже после изменения кода. Лимит кумулятивен; уменьшение доступного бюджета не создает новую подпись при отказе. Секрет промокода хранится как HMAC и display hint, не как полный исходный код.

## Выполненные проверки

Node: `v24.22.3`. Все перечисленные процессы завершились с exit code 0. Внешние blockchain HTTP-запросы в fixtures перехвачены, неизвестные внешние URL отвергаются. Реальные подписи/транзакции кошельков владельца, production mutations и загрузки не выполнялись.

| Команда из apps/sponsor | Результат | Свидетельство |
|---|---|---|
| `npm run check` | TypeScript PASS | [typecheck.log](typecheck.log) |
| `npm run test:linux` | 5 прежних групп + 10 новых Linux paid/promo групп | [test-linux.log](test-linux.log) |
| `npm run test:fund` | прежний provider suite + 6 новых submit/replay групп + 24 SQLite Fund API группы | [test-fund.log](test-fund.log) |
| `npm run test:fund-runtime` | 18 workerd acceptance checks: 3 disabled, 11 write, 2 restart-read, 2 direct-read | [test-fund-runtime.log](test-fund-runtime.log) |

Отдельный JSON результатов Linux lifecycle: [linux-paid-promo-summary.json](linux-paid-promo-summary.json). В нем зафиксированы одна синтетическая SOL relay, один AR header, четыре отправки chunks (первичная дозагрузка и последующий repair), один paid order/hold/credit и два promo-заказа. У paid использован настоящий `DirectArweavePreservation` с временными Ed25519/RSA ключами. У promo полный Linux HTTP/admin/ledger цикл использует `MockFundedArweaveProvider`; настоящий submit/replay и криптографическая привязка данных проверены отдельным тестом `fund-submit-recovery.mjs`.

Новые regressions включены в штатные npm-команды в [package.json](../../../../apps/sponsor/package.json), а не оставлены ручными скриптами. Опциональный in-process `fundProvider` в Linux adapter использует уже существующий test port `fundApi`. CLI [bin/linux-checkout.mjs](../../../../apps/sponsor/bin/linux-checkout.mjs) и HTTP input его не предоставляют; production default не изменен.

Общий root-проход отдельно проверяет остальные sponsor suites и frontend. Их результаты нельзя приписывать этому отчету, пока они не добавлены в общий отчет.

## Эксплуатационные stop-gates, которые тесты не закрывают

1. **Production API и сервер.** Публикация HTML в Arweave не запускает Linux процесс. Нужны действующий HTTPS API, проверенные CORS, реальные server-only bindings, persistent local disk, безопасная резервная копия ledger и проверенный restart на выбранном сервере. Writer guard рассчитан на один хост и один согласованный путь SQLite; он не является распределенной блокировкой двух серверов или двух копий базы. Переход со старого sentinel описан в [LINUX_WRITER_RECOVERY.md](../../../LINUX_WRITER_RECOVERY.md).
2. **Admin вход.** Linux монтирует Fund/recipient admin API, использующие `ADMIN_TOKEN`. Старые `/v1/admin/setup`, `/v1/admin/password`, генерация/ввод JWK и старый Worker HTML admin в Linux не монтируются. Их наличие в [index.ts](../../../../apps/sponsor/src/index.ts) не доказывает такой login на Linux. Нужен согласованный и проверенный пользовательский вход к реальному API. Обычный GET заказа не подписывает/не отправляет данные; отдельный старый admin `GET /api/fund/admin/sign-readiness` по своей явной семантике выполняет локальную подпись probe, поэтому его нельзя выдавать за чистое чтение баланса.
3. **Promo не имеет автономного alarm.** В [CheckoutLedger.alarm](../../../../apps/sponsor/src/checkout/durableStore.ts) запускаются только `paid.due()` / `runPaidOrder`. Продолжение promo вызывается из явного повторного POST заказа или `POST /api/fund/admin/reconcile` в [fund/api.ts](../../../../apps/sponsor/src/fund/api.ts). После аварии до сохранения подписи запись `RESERVED` не подписывается автоматически: admin reconciliation может освободить такую запись без txId только после 10 минут. Нужна эксплуатационная процедура для этих состояний; «загрузится само навсегда после закрытия браузера» для promo не подтверждено.
4. **Пополнение AR не повышает сохраненный ceiling автоматически.** [TreasuryGuard.effectiveBalance/assertBalance/debit](../../../../apps/sponsor/src/checkout/treasuryGuard.ts) используют консервативный минимум прежнего ceiling и нового наблюдаемого баланса. Это предотвращает перерасход из-за stale high balance. `FundLedger.reconciled` в [fund/ledger.ts](../../../../apps/sponsor/src/fund/ledger.ts) сверяет записи и фиксирует audit, но не устанавливает новый ceiling. Изменение promo limit также его не меняет. Проверенного административного процесса подтверждения нового пополнения/повышения ceiling в текущем коде нет. Нельзя обещать неограниченное продление работы простым переводом AR или сменой лимита; этот финансовый guard в данном проходе не ослаблялся.
5. **Фиксированная promo казна и разные бюджеты.** Адрес promo казны задан в [fund/ledger.ts](../../../../apps/sponsor/src/fund/ledger.ts); `DirectArweaveFundProvider.assertSigner/sign` проверяют его. Временный тестовый RSA не соответствует этому адресу, поэтому реальные production signer/balance никогда не заявляются проверенными. SOL поступает на настроенные SOL-получатели, а Arweave оплачивается отдельным запасом AR; автоматического обмена SOL→AR здесь нет.
6. **Размер и сохранность старых обязательств.** Paid/promo ограничены архивом 512 KiB; этот предел проверяется в HTTP handlers независимо от размера PDF. В данном Linux fixture использован синтетический envelope около 360 KiB и отдельно проверен отказ для oversized envelope. Сохраненные старые ciphertext, signed bytes, receipts, parents и unresolved payments нельзя заменять новой оплатой. Этот аудит не проверял и не восстанавливал конкретный исторический production-архив.
7. **Реальные кошельки и чистое восстановление.** Временная software-подпись не является Phantom/Solflare extension test. Доступность mocked gateway и совпадение ciphertext digest не являются реальной сетевой финальностью или расшифровкой реального родословного архива на чистом устройстве. Эти acceptance gates должны выполняться отдельно с согласованным тестовым сценарием.
8. **Proxy и эксплуатационная нагрузка.** Linux использует адрес TCP peer для rate limits; за reverse proxy без согласованного trusted ingress все посетители могут разделить один bucket. Зависимости, резервные копии, мониторинг, емкость диска и нагрузка выбранного production-сервера этим локальным функциональным тестом не проверены. Это не утверждение об уже наблюдавшемся сбое production.

## Измененные backend-файлы

- `apps/sponsor/src/fund/provider.ts` — ограниченный submit, data-only replay, проверка исходных подписанных данных.
- `apps/sponsor/src/fund/api.ts` — продолжение подтвержденного promo header с недоступными данными и общий временной бюджет.
- `apps/sponsor/src/checkout/durableStore.ts`, `apps/sponsor/src/checkout/api.ts` — передача фиксированных validation errors как HTTP 400.
- `apps/sponsor/linux-server.mjs` — только in-process injection существующего Fund provider port для acceptance fixture.
- `apps/sponsor/tests/linux-paid-promo.mjs`, `apps/sponsor/tests/fund-submit-recovery.mjs` — новые обязательные regressions.
- `apps/sponsor/package.json` — включение regressions в стандартные test:linux и test:fund.

Production keys/configuration, сети, денежные политики, адреса и budgets не изменялись. Commit/push/deploy этим агентом не выполнялись. Финальное независимое review и интеграцию ведет root.
