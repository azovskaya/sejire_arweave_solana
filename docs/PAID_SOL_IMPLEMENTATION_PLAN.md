# Общее платное сохранение за SOL — план реализации

Дата: 21 октября 2026 года. **Статус: общий платный путь реализован; production paid admission и executor выключены.** Этот документ сохраняет исходный контракт разработки. Фактическая реализация, результаты проверок, конфигурация и порядок выпуска описаны в [Paid SOL rollout](PAID_SOL_ROLLOUT.md); формулировки «добавить» ниже относятся к исходному плану. Живая SOL-оплата и перенос `sejire.ar.io` ещё не приняты. Для включения отсутствуют два назначенных публичных SOL recipient, отдельный paid AR budget и допустимый AR reward на заказ. Цена **0.03 SOL** уже закреплена и не требует повторного выбора.

## Заданные условия

- Сохранение стоит **0.03 SOL / 30 000 000 lamports**. Дополнительный взнос — **0 по умолчанию**, комиссия Solana показывается отдельно. Цену повторно не выбирать: она уже закреплена в [checkout/api.ts](../apps/sponsor/src/checkout/api.ts) и [PROTOCOL_CONTINUATION.md](PROTOCOL_CONTINUATION.md).
- Сервер получает только зашифрованный архив `sejire/envelope/v1`, без слов SEJIRE и plaintext. Произвольные пользовательские архивы заменяют фиксированные payer/archive старого V2-пилота.
- В репозитории не закреплены production SOL recipients и отдельное выделение AR для общего платного исполнения. Не подставлять disposable devnet-адреса, promo-лимит или лимит одноразового пилота. Подготовка конфигурации и проверок входит в реализацию; mainnet-включение — отдельный финальный шаг после готового кода и подтверждённых назначений/расхода.
- Новые paid orders и подпись/отправка paid AR по умолчанию отключены. Этот план не разрешает реальные платежи, перенос ArNS или изменение существующих production-флагов.

## Контракт заказа и политики

Расширять существующие checkout API и общий `CheckoutLedger`, не создавать параллельный платёжный продукт. Новый вариант — **`schema: 'sejire/order/v2'`**, legacy v1 остаётся отдельной веткой. Старый бинарник должен отвергнуть v2 при rollback: добавление незнакомых полей только к v1 опасно выбором прежнего Turbo-исполнителя для нового direct-заказа.

V2 сохраняет общие платёжные поля заказа и обязательно содержит:

```ts
policyHash: string;
archive: {
  digest: string;
  bytes: number;
  vaultId: string;
  parentTxId: string | null;
};
storage: {
  kind: 'arweave-direct';
  network: 'arweave.N.1';
  treasuryAddress: string;
};
```

Modern `POST /api/checkout/orders` передаёт payer, contribution, policyHash, archive binding и точный `serialized` ciphertext **до предложения оплаты**. Сервер проверяет UTF-8 bytes, SHA-256, размер, envelope и vault; parent — явный null либо TXID. При повторе idempotency key неизменны архив, parent и policy. Конфликт отклоняется до оплаты/подписи; восстановление не выполняет reseal.

Серверная immutable policy закрепляет Solana network/genesis, цену, публичные роли, storage target, paid budget ID, допустимые bytes и AR reward. Снимок сохраняется по hash. Текущая политика не меняет старые заказы. Клиенту не разрешено выбирать цену, recipients, signer, budget, RPC или gateway URL. Публичное чтение policy сообщает условия и readiness без секретов.

## SQLite, резервы и исполнение

Добавить связанные с заказом записи для policy snapshot, exact encrypted bytes, paid AR reservation, платёжной подготовки/attempt и storage job. Размер хранения ciphertext должен быть ограничен и проверен на реальном SQLite; при необходимости хранить точные bytes частями. Старые JSON заказов, prepared/signed bytes, ANS-104 plans и receipts не преобразовывать. Adapter выбирается по сохранённому discriminator, не по текущему флагу.

Три атомарные границы в существующем global SQLite:

1. **Предложение оплаты:** order + owner/idempotency + exact archive + policy binding + AR hold.
2. **Зачёт SOL:** unique transaction/credits + verified payment + durable pending storage job. Потеря ответа или остановка браузера не оставляет подтверждённую оплату без задания.
3. **Учёт подтверждённого AR-расхода:** проверенная on-chain TX с правильными owner/reward + однократный переход paid reserve → paid actual spend. Получение и проверка архива отмечаются отдельно: уже потраченные AR не должны оставаться только в резерве из-за недоступного gateway; completed требует обеих проверок.

Promo и paid имеют **раздельные quotas, spend и историю**. Для одного treasury address физический guard общий: новый hold плюс активные promo и paid holds не превышают проверенный доступный баланс. Проверка выполняется атомарно **в обоих reserve entrypoints**. Устаревшее наблюдение баланса при конкурентном завершении нужно обнаруживать версией/CAS либо учитывать последующие дебеты консервативно. При неизвестном балансе новые предложения оплаты не выдаются; paid расходы не списываются с promo quota.

Внутренний job runner/alarm продолжает задания после закрытия браузера и перезапуска. Истечение пользовательской сессии не удаляет оплаченный job; публичный доступ сохраняет проверку владельца. Lease защищает исполнение, а подписанные bytes и TXID сохраняются **до submit**. Retry использует тот же подписанный объект. Новый direct plan/receipt не маскируется под `maxWinc: 0` или Turbo acceptance.

Direct publisher сохраняет полный recovery-контракт: `App-Name`, `Type`, `Schema`, `Protocol-Version`, `Vault-Id`, `Archive-SHA256`, `Archive-Bytes`, `Preservation-Id` и `Parent-Tx` для следующей версии. Тега `Promo-Funded: true` у paid-заказа нет. Подготовленные и подписанные bytes повторно проверяются против exact binding; произвольные unsigned/signed transaction из браузера не принимаются.

Приём новых заказов и аварийная остановка executor — разные настройки. Обычная пауза приёма не отменяет действующие предложения и оплаченные обязательства. Чтение, проверка прежней подписи/TX и завершение уже подтверждённого хранения остаются доступны; аварийная остановка новой подписи/отправки сохраняет job и hold.

## Сроки, retry и доказательство результата

- Подготовку платежа, blockhash/lastValidBlockHeight и message binding хранить на сервере. Подпись связывается с подготовкой и hold до broadcast. Нельзя поздно зарегистрировать первую подпись для уже освобождённого v2 hold; legacy semantics отдельно сохраняются.
- Оплата требует правильных genesis/network, payer, reference, recipients, amounts, успешной finalized TX и времени включения внутри окна заказа. Проверка после expiresAt допустима для TX, включённой вовремя.
- Истечь может только незапущенное неоплаченное предложение. Pending signature, неизвестный результат, paid job или signed AR не освобождают резерв по обычному TTL. Timeout, null RPC и возраст операции не доказывают отсутствия оплаты. Нерешённая попытка не заменяется новым платежом; повторяются только прежние подписанные bytes.
- Изменение AR quote после оплаты не вызывает второй SOL-платёж и не использует promo-бюджет. До новой AR подписи возможны только действия в пределах сохранённой политики/резерва; после подписи bytes и TXID неизменны.
- Completed требует подтверждённой AR TX, корректных owner/reward и совпадения archive digest/bytes/vault и подписанной parent binding. HTTP acceptance недостаточно. Квитанция отдельно указывает payment network и Arweave network, order/policy/archive/parent/TX/reward. Старые квитанции продолжают читаться.

## Frontend и проверяемая приёмка

До reseal и выбора метода искать pending попытку по tree/vault. Нужен общий promo/paid и межвкладочный guard: переключение способа, повторный клик, StrictMode, reload и потеря ответа не создают вторую оплату/заказ. Parent берётся из durable attempt, не из изменившегося HEAD. Перед подписью проверяются order/policy/network/payer/сумма; смена кошелька или контекста требует остановки текущего действия.

После потерянного create response нужен scoped GET по сохранённому idempotency key, поскольку order ID мог не дойти до браузера. Неизвестный результат кошелька без signature требует проверяемого поиска по прежнему reference; новая подпись не предлагается. API token и exact ciphertext сохраняются до сетевого действия, слова и приватные ключи в журнал не входят. Серверное completed с незавершённой локальной записью остаётся активной попыткой после reload.

Локальное завершение принимает только доказанный результат для exact archive/parent/order. Сначала запись и readback архива и session head, затем удаление pending. Более новый HEAD не откатывается. Ошибка локального хранения повторяет только завершение; поздний async callback после закрытия/смены контекста не финализирует другой архив. Solana wallet не должен запрашивать слова SEJIRE, а пользователь — подключать казначейский Wander.

Восстановление v2 использует общий bounded metadata/SHA/size/envelope/AES reader, включая `/tx/<id>/data`; SOL-сеть не выбирает Arweave gateway. После успешного восстановления сохраняется точный проверенный envelope, а не только повторно зашифрованный generic cache. Шифрованная копия доступна до оплаты и во всех незавершённых состояниях.

Обязательные meaningful tests следующей реализации:

- Legacy v1/ANS-104/receipts и restart остаются совместимыми; старый reader отвергает v2; default-disabled не создаёт paid order.
- Изменённые network/roles/policy/digest/size/vault/parent отклоняются; тот же idempotency key восстанавливает исходный exact archive.
- Конкурентные promo+paid holds соблюдают общий физический баланс и отдельные quotas; fault между payment credit и job откатывает оба изменения.
- Browser close, DO restart, потерянные ответы и session expiry сохраняют обязательство и тот же signed TX; поздняя проверка своевременной finalized оплаты работает; неопределённость не разрешает второй платёж.
- Pause не изменяет старые обязательства; повторное completion учитывает spend один раз; неверные owner/reward/archive не дают completed.
- Две вкладки, смена метода/кошелька, StrictMode и reload не дублируют оплату; local quota failure повторяет только local completion; newer HEAD и все деревья сохраняются.
- Actual workerd default adapters с сетевыми fixtures проверяют redirects, body deadlines, abort и receiver; browser tests проверяют редактор → оплату → storage proof → локальное завершение → восстановление в чистом контексте.

Синтетические проверки не заменяют реальную wallet acceptance. Контрольную операцию с точной ценой, отдельной комиссией и разрешённым максимумом AR подготовить после реализации; живую подпись выполняет владелец при финальном разрешённом включении. Миграция принятого сайта на ArNS остаётся отдельным этапом.
