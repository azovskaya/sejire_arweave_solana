# Проверочная версия: SOL → зашифрованный архив

01.10.2026. Это продолжение существующего SEJIRE, не новый продукт. Основной сайт,
ArNS, main и production-секреты не изменяются. Подключение включается только
`VITE_CHECKOUT_ENABLED=1`; прежний direct SOL/Turbo экран сохранён при выключенном флаге.

## Предлагаемое размещение (ожидает согласования)

Отдельный Cloudflare Worker `sejire-devnet-preview` со статическими assets и собственной
SQLite/Durable Object базой. Точный HTTPS URL определяется аккаунтом после развёртывания;
он пока не создан. Free-тариф без покупки: при превышении бесплатных квот запросы
останавливаются. Не подключать Worker к sejire.ar.io. Конфигурация:
`apps/sponsor/wrangler.preview.toml`; приложение и API закрыты для оплаты по умолчанию.
Проверки и сборки в CI ничего не публикуют.

Нужны подтверждение владельца, доступ к тестовому Cloudflare и два **публичных**
devnet-адреса (`CHECKOUT_SERVICE_RECIPIENT`, `CHECKOUT_FUND_RECIPIENT`). Используются native System transfers без SPL accounts и ATA. Публичные тестовые адреса:
- услуга: `ETWcxNPF3Qcwvo4NHYw6JhMiKnGwrvH1U9YEAQ3rZSWd`;
- фонд: `Gy3SSxP7spgDcserSfMckPd73LeSoxdrvXeNap7huLQN`;
- отдельный uploader: `Fp6ZxyVLfXhpxbcvmiL5hPsr2uqDozuLaQ1jA3avrVPF`.
Это disposable devnet wallets, не production-казна. Секреты вне Git, локально 600/700.
Ранее созданный USDC token account не закрывается и в этом checkout не используется.

Загрузчику нужен отдельный, не производственный **Solana test uploader signer**
`CHECKOUT_UPLOAD_SIGNER` через защищённую настройку Cloudflare. Не присылать его в чат;
не импортировать личный платёжный кошелёк. Это не Arweave JWK. Никакого пополнения
или перевода код загрузчика не выполняет. Для первого пилота используются только
бесплатные тестовые uploads, `winc=0`; исчерпание квоты блокирует готовность до платежа.
Ключ не даёт доступа к основной казне и расшифровке семейного архива.

Это ограничение тестового исполнения, а не окончательная экономика $3: в production
потребуется отдельный обеспеченный операционный бюджет. Существующий технический
`MAX_ENVELOPE_BYTES=524288` сохранён; меньшая граница бесплатной sandbox-загрузки
проверяется как условие готовности сервиса, не объявляется постоянным лимитом услуги.

Источники, проверены 01.10.2026:
[Cloudflare Free/DO](https://developers.cloudflare.com/durable-objects/platform/pricing/),
[Turbo sandbox: raw POST, free allowance, отсутствие mainnet settlement](https://docs.ar.io/build/testnet/uploading-and-credits/).
Свободные bytes wallet — advisory: лимит IP и окончательный ответ провайдера могут дать 402.
В этом случае оплаченная услуга остаётся незавершённой, без повторной оплаты клиента.

## Поток и защита

`POST /api/checkout/session` выдаёт 256-битный случайный Bearer-токен на 30 дней.
В SQLite хранится SHA-256 токена, без регистрации. При утрате/истечении токена доступ
к заказу требует отдельного будущего механизма; восстановление архива из файла/
квитанции и слов SEJIRE от токена не зависит. Токен не передаётся в URL, в блокчейн
или в логи. Browser journal хранит его и ciphertext в отдельной IndexedDB, без recovery words.

Маршруты: `POST /orders`, `GET /orders/:id`, `POST /orders/:id/prepare`,
`POST /orders/:id/reserve`, `POST /orders/:id/verify`, `POST /orders/:id/reconcile`, `POST /orders/:id/execute`
под `/api/checkout`. Условия — на сервере: devnet SOL, 0.03 SOL (30 000 000 lamports) за сохранение,
нулевая цена услуги для отдельной поддержки, точные разные получатели,
reference, 15 минут, версия политики. Нет продуктового потолка взноса;
u64 и decimal precision — технические пределы. Поддержка не требует архива.

Принадлежность заказа проверяется до pendingSignature и RPC; внешних commit/ledger/fault
маршрутов нет. Идемпотентность, владение, quotas и глобальный зачёт — в одном DO.
Лимиты за 60 секунд: сессии 10/IP и 100 глобально, создание 20/сессию и 60/IP,
проверка/исполнение 30/сессию, чтение 120/сессию, общий вход 600/IP и глобально.
CF-Connecting-IP доверяется только на Cloudflare ingress; X-Forwarded-For игнорируется.
Не выставлять этот ingress-адаптер за прокси, допускающим подмену CF-заголовка.
CORS — точный allowlist; он не заменяет Bearer-авторизацию.

До оплаты проверяются genesis, System recipient accounts, баланс суммы + комиссии,
загрузчик и архив. Транзакция: legacy, один signer, один/два System transfer,
reference и раздельные назначения; без ATA/CPI/priority fee. Суммы — integer lamports.
Комиссия SOL проверяется через getFeeForMessage и показывается отдельно.
Серверная цена фиксируется в заказе; смена политики не изменяет старые заказы.

После подписи точные bytes и signature сохраняются до broadcast; сервер резервирует
signature. Потеря ответа не запускает новый платёж. Возобновление сверяет прежний
signature и при необходимости повторно отправляет **те же** bytes. После оплаты
backend заново проверяет bytes/hash, сохраняет подписанный ANS-104 item до POST,
использует lease и прежний item ID при retry. Turbo acceptance и gateway hash verification
разделены. `completed` появляется только после получения bytes и совпадения хеша.
Ключи расшифровки не попадают на backend. Квитанция совместима с прежним RestoreSeed.

## Проверки и точка продолжения

Команды Ubuntu/Node 22: `npm ci --prefix apps/web`, `npm ci --prefix apps/sponsor`,
`npm test`, `npm run check --prefix apps/sponsor`, `npm run test:api`,
`npm run test:preservation`, `npm run checkout:build`,
`npm exec --prefix apps/web -- playwright install --with-deps chromium`,
`npm run test:checkout-browser`. Каждая команда — отдельный CI step.
Playwright использует существующий редактор и RestoreSeed, реальные HTTP handlers/SQLite;
кошелёк — software fixture, RPC/Turbo/gateway — синтетические ответы. Это не живой платёж.
Runtime тест отдельно открывает ту же SQLite в новом Node/workerd процессе.
Облачные failover и production scaling этими проверками не подтверждаются.

Локальные TypeScript web/sponsor PASS; native Chromium/workerd на Catalina BLOCKED.
Ubuntu CI подтвердил 5/5 браузерных сценариев, 24 HTTP/SQLite сценария (включая
перезапуск), 14 SQLite сценариев, 39 checkout и 49 RPC сценариев. Настоящий ANS-104
signer проверен также внутри workerd; CommonJS built-ins и Buffer явно подключены
через Node compatibility. Кошелёк и внешние ответы в этих тестах синтетические.
Последний SHA и его CI указываются в итоговом сообщении, без цепочки коммитов
для записи собственного SHA. Живое расширение, платёж, sandbox POST и независимое
получение файла пока NOT RUN. Preview разрешён владельцем, но BLOCKED: нет доступа Cloudflare, environment
devnet-preview и защищённой настройки загрузчика. Публичные получатели уже созданы.

Разрешённый начальный живой тест: обычное сохранение 0.03 devnet SOL;
сохранение + 0.005 SOL (итого 0.035); отдельный взнос 0.005 SOL.
Итого 0.07 SOL + три комиссии, фактический fee показывается до каждой подписи.
Никаких крупных переводов, mainnet или покупки токенов. Payer:
`Hn9ELgjKXrb7svZM9XtDYozGTirxo5e1tWRy1J1v4vwF`.
Публичное поступление 1 SOL и создание прежнего ATA finalized; новый SOL checkout
ещё не проверен живым платежом. Локальный signer не заменяет Phantom acceptance.

После публикации: открыть/создать дерево → «Сохранить» → «Сохранить через Solana» →
скачать backup → Phantom/Solflare → проверить цену/взнос/получателей/SOL fee →
подтвердить → дождаться hash verification → скачать квитанцию → в чистом браузере
«Открыть по 12 словам» → «Открыть из файла» (квитанция либо backup) → слова SEJIRE.

Открытые security findings не закрываются новым checkout. Совместимый override elliptic
6.6.1 (как в web) убирает critical malformed-input findings нового uploader dependency,
но оставшиеся high/low требуют отдельной оценки: см. прежнюю таблицу
`verification/2026-09-30-web-security-reachability.md` и результаты текущих audit steps.
HexSolana signer использует noble Ed25519, без ECDH/Ethereum. До живого запуска нужны
успешный browser/runtime CI и review фактически собранного Worker dependency graph.

Ручной workflow `SEJIRE isolated devnet preview` не запускается от push/PR. Перед
его запуском владелец подтверждает размещение и заполняет GitHub Environment
`devnet-preview`: секреты `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`,
`CHECKOUT_UPLOAD_SIGNER`, публичные variables `CHECKOUT_SERVICE_RECIPIENT`,
`CHECKOUT_FUND_RECIPIENT` необязательны: workflow по умолчанию использует перечисленные
выше отдельные disposable devnet адреса. Желательно require reviewer для environment.
Токен Cloudflare ограничить своим аккаунтом и правами тестового Workers deploy;
никаких production wallet keys. Workflow проверяет ветку/confirm, выполняет тесты,
упаковывает отдельный Worker, определяет существующий account workers subdomain
read-only и только затем создаёт согласованные preview Worker/SQLite. На push
запускаются исключительно проверки и сохранение build artifact, без публикации.
Покупка/смена тарифа, funding и создание платёжных счетов этим workflow не выполняются.

### Риски именно этого пути

| Пакет / finding | Путь и использование | Доказательство / действие |
|---|---|---|
| elliptic malformed-input signing (critical в исходном sponsor resolution) | arbundles → ethers signing-key; Solana uploader использует noble Ed25519 | Совместимый override 6.6.1, как в web; critical исчезает из audit. ANS-104 type 4 проверяется library selftest. Остальные elliptic low не объявлены закрытыми. |
| ws 7.5.10 DoS | arbundles → ethers providers → ws; preview не содержит WebSocket server/Ethereum provider | Override 7.5.11 снимает эти high findings. Не меняет архивную криптографию. |
| secp256k1 ECDH (high и parent arbundles high) | SDK содержит Ethereum helpers; наш sign/read использует только HexSolana/noble и собственный signed item type 4 | Наличие/bytes пакета фиксирует `worker-metafile.json`. ECDH не вызывается API, клиент не может выбрать signer или передать data item. Finding остаётся открытым; это анализ конкретного пути, не заявление о безопасности всего SDK. |
| прежние web findings | Turbo/web3 → SDK/browser dependencies; редактор и restoration не переписаны | Сохраняются audit FAIL и прежняя таблица; CI строит оба frontend режима. Реальный wallet/payment acceptance нельзя заменять тестами. |

Автоматический живой runner: `scripts/devnet-sol-checkout.mjs`. Сначала запуск без
`--execute` выводит payer, баланс, получателей, точные lamports и fee, не подписывая
транзакцию. Последующий `--execute` использует только локальный test-payer.json.
Журнал, synthetic recovery words и публичные доказательства — вне Git в каталоге 700,
файлы 600. Повтор использует тот же order/signature и проверяет неизменность зачёта.
После реального restart backend выполнить ту же команду и сравнить прежние receipt/state.
Сам runner и CI не доказывают живой restart до выполнения такого теста.

Для Catalina: `node --experimental-loader ./scripts/offline-ts-loader.mjs scripts/devnet-sol-checkout.mjs https://<actual-preview-origin> plain`.
Ubuntu Node 22: `npm exec --prefix apps/sponsor -- tsx scripts/devnet-sol-checkout.mjs https://<actual-preview-origin> plain`.
Никакие команды живого runner не входят в CI. Готовность Cloudflare и его signer
обязательна до предложения первого платежа; без неё статус живого сценария BLOCKED.
