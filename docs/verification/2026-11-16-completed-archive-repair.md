# Повторная проверка завершённого архива — 16 ноября 2026

## Основание и границы

Владелец поручил исправить необходимые проблемы Sejire и подготовить перенос на `sejire.ar.io`. Исходная опубликованная версия — `8b07f9f5a3dae939f7d519f4e3c65ac9d49dfa09`; рабочая ветка изменений — `fix/ario-ready-20261116`, от коммита с доказательствами предыдущего выпуска `035233ccbc4322aea55e5e78b6f4898d5ca3b171`.

Предыдущий выпуск и его доказательства: [pilot-release-result](2026-11-16-pilot-release-result.md). Этот документ описывает новые исправления и локальную проверку; успешный CI, фактический deployment и готовность реального архива должны подтверждаться отдельным результатом выпуска.

Новый платёж, замена архива, подпись владельца или чтение его слов/ключей в рамках этой работы не выполняются.

## Воспроизведённые дефекты

1. `PaidLedger.claim()` и `nudge()` исключали любой заказ со статусом `completed`. Даже явное продолжение после последующей недоступности байтов не вызывало ни сверку, ни досылку. Синтетический опыт дал `reconcile=0`, `replay=0`, `alarm=0` при одном прежнем платеже.
2. Constructor Durable Object безусловно вызывал `setAlarm()`. При холодном старте workerd отменял уже назначенное событие и переносил его примерно на секунду. Вечное зависание не подтверждено; исправление сохраняет уже назначенный alarm. [Рекомендация Cloudflare](https://developers.cloudflare.com/durable-objects/api/alarms/#setalarm).
3. Завершённый заказ нельзя было открыть из общей истории в интерфейсе, поэтому новую проверку было бы негде вызвать после закрытия экрана сохранения.
4. При смене origin локальные заказы и черновики остаются в прежнем браузерном хранилище. Автоматический перенос токенов через URL не допускается; прежний сайт должен оставаться доступным.
5. Один manifest fallback не обеспечивает запуск приложения на глубоком адресе: относительные `./assets/` разрешались относительно неизвестного пути. HTML теперь задаёт базу только для известных permaweb hosts: корень ArNS/subdomain или исходный `/{manifestId}/` на gateway; GitHub Pages и локальные подпапки сохраняют прежнее поведение.

## Новое поведение

Владелец выбирает **«Сохранения на этом устройстве» → прежний заказ → «Проверить и восстановить доступность архива»**. Это отдельное явное действие, без обращения к Phantom/Solflare.

`POST /api/checkout/orders/{id}/repair` принимает только `{}` и прежний Bearer владельца этого заказа. Чужой доступ, неоплаченный запрос, взнос без архива и незавершённый заказ не допускаются. Прежняя истёкшая capability остаётся допустима только в существующей границе возобновления принадлежащего ей заказа.

Отдельная таблица `paid_archive_repairs` хранит `queued`, `checking`, `waiting` или `verified`. В `execution.repair` передаются только безопасные статус, времена и код причины. Исторические завершение, receipt, payment, TX и proof сохраняются. Браузерный журнал остаётся версии 2 с прежними stores; `done` не превращается обратно в `pending`.

Repair runner выполняет свежую проверку. Только при подтверждённом прежнем заголовке и отсутствующих байтах он досылает исходные чанки того же signed transaction и снова проверяет данные. Он не готовит и не подписывает транзакцию, не отправляет новый заголовок, не запускает Solana-платёж и не повторяет учёт расхода treasury.

Потеря ответа POST восстанавливается клиентом через GET. Повторные явные запросы не создают параллельную операцию; lease, backoff и ограждение старого runner сохраняются. Alarm продолжает работу без браузера. При выключенном execution допускается только проверка чтением.

На permaweb-хостах есть ссылка на прежний сайт с объяснением, где завершить начатую оплату. Ссылка не содержит токена, заказа, слов или ciphertext. Завершённый архив можно открыть на новом домене обычным восстановлением или из зашифрованной копии.

## Локальные проверки

| Проверка | Фактический результат до CI |
|---|---|
| Sponsor TypeScript | PASS |
| Paid SQLite | 42/42, внешних запросов 0 |
| Actual API / Durable Object / workerd | 28/28; выполнено до последнего узкого expired-lease fence, который отдельно включён в повтор SQLite |
| Холодный alarm после полного restart | PASS, до replay не было GET/inspect/nudge из браузера |
| Web TypeScript | PASS |
| `paidClient.selftest` | PASS, включая потерю repair reply, прежний receipt, done journal и неизменные счётчики платежей |
| `permawebHost.selftest` | PASS |
| Web lint | PASS, 0 ошибок; существующие предупреждения не скрывались |
| Независимый review | Открытых blockers в backend/frontend repair не найдено |

Добавлены два браузерных сценария history → repair → reload → verified, в том числе потеря ответа POST, и три новых сценария готовой ArNS-сборки: граница browser origin, глубокий ArNS path и gateway manifest path. В этой среде локальный Chromium ранее блокировался sandbox (`EPERM`); эти сценарии должны пройти в Linux CI, прежде чем их считать проверенными.

## Реальный архив: что установлено, а что ещё нет

Публичный TX: `AtwLYx509C9jWIFKUNg7dy1GSgiaDbXVK1YEQbBWfHY`.

Публичный `Preservation-Id`: `3288d114053260a8168cd36cdf2e85bf`.

Размер 25 269 байт и опубликованный `Archive-SHA256` независимо дают тот же одночанковый Merkle root, что записан в TX: `oIW8IQbrmRcT4gT2M13TuMySiQCnu61vZKSqNiDPYHg`. Ошибка подготовки root не подтверждена. При наличии исходного ciphertext его можно дослать без новой подписи и без повторного SOL-платежа.

Последняя подтверждённая публичная проверка предыдущего выпуска — **16 ноября, 16:40:18 Алматы (UTC+5)**: header/status и offset отвечали 200, raw и основной data path — 404. Это не доказывает необратимую потерю. Статус production order и наличие ciphertext в Durable Object не прочитаны; считать именно completed trap причиной этого архива пока нельзя.

Для безопасной проверки production metadata: Cloudflare → `sejire-sponsor` → `CHECKOUT_LEDGER` / `CheckoutLedger` → Data Studio → unique name `sejire-checkout-ledger-v1`.

```sql
SELECT p.order_id, p.status, p.paid, p.released, p.attempts,
       p.last_error, p.next_at, p.lease_until,
       CASE WHEN p.receipt_json IS NULL THEN 0 ELSE 1 END AS has_receipt,
       CASE WHEN p.proof_json IS NULL THEN NULL ELSE json_extract(p.proof_json, '$.onchainConfirmed') END AS chain_confirmed,
       CASE WHEN p.proof_json IS NULL THEN NULL ELSE json_extract(p.proof_json, '$.archiveVerified') END AS archive_verified,
       CASE WHEN p.proof_json IS NULL THEN NULL ELSE json_extract(p.proof_json, '$.reason') END AS proof_reason,
       EXISTS(SELECT 1 FROM paid_payloads x WHERE x.order_id=p.order_id AND x.kind='archive') AS has_archive,
       COALESCE((SELECT length(x.payload) FROM paid_payloads x WHERE x.order_id=p.order_id AND x.kind='archive'),0) AS archive_chars,
       EXISTS(SELECT 1 FROM paid_payloads x WHERE x.order_id=p.order_id AND x.kind='prepared') AS has_prepared,
       EXISTS(SELECT 1 FROM paid_payloads x WHERE x.order_id=p.order_id AND x.kind='signed') AS has_signed
FROM paid_orders p
WHERE p.order_id='3288d114053260a8168cd36cdf2e85bf';
```

Запрос read-only, не выбирает ключи, capability-токены, ciphertext или целые JSON payload. Если повреждённый `proof_json` мешает выполнению, можно убрать только три proof-поля. Нельзя исправлять финансовые/lease-таблицы прямыми SQL UPDATE в обход протокола.

Полная Mainnet-приёмка остаётся незавершённой до получения реальных байтов, проверки SHA-256 и открытия архива владельцем. Синтетические тесты и сам deploy не заменяют этот результат.
