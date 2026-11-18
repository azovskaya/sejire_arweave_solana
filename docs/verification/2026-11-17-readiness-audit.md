# SEJIRE — повторная проверка перед публикацией в sejire.ar.io

Дата проверки: 17 ноября 2026, время в отчёте — Алматы (UTC+5).

> **Итог: код и точный пакет готовы к контролируемой публикации.** Полный CI
> `44040950008` и подготовка `44042817147` завершились успешно.
> Для объявления полноценного пилота остаются реальная приёмка кошелька, публичных
> байтов и восстановления, управление именем и прежнее оплаченное обязательство.
> Публикация, реальные подписи, расходы и изменение ArNS не выполнялись.

## Исходная и новая версии

Исходный выпуск: `4d22e9ecf27bb0b439c7279d63d222f93479042a`, полный CI
[43874287720](https://github.com/azovskaya/sejire_arweave_solana/actions/runs/43874287720).
Вчерашний отложенный prepare
[43876797864](https://github.com/azovskaya/sejire_arweave_solana/actions/runs/43876797864)
фактически завершился успешно 16 ноября в 19:15:46 Алматы. Upload был пропущен.
Его официальный artifact `14233961654` побайтно совпал по всем 41 файлам с ранее
выданным локальным ZIP. Разные ZIP SHA связаны с упаковкой.

Повторный аудит нашёл дополнительные реальные дефекты, поэтому прежний пакет
сохранён как историческая версия и не является текущим кандидатом для публикации.

Итоговый кандидат: `3ed64d14738a2c7080de2007bb34f2df13dd7e1f`,
tree `9112a5720a9e951921067605a8035767f9b54152`, рабочая ветка
`feat/decentralized-arweave-20261116`.
Полный CI: [44040950008](https://github.com/azovskaya/sejire_arweave_solana/actions/runs/44040950008), attempt 1.
По сравнению с исходным выпуском изменено 37 файлов. Каждый отправленный набор
сравнен с GitHub побайтно и по режимам; локальный HEAD совпадает с отправленным.

Предшествующие прогоны сохранены как evidence, а не приняты как успешные:

- `44036834470` / `3f8ceb7`: 8/13 browser cases. Исправлены локатор кнопки меню
  и ограничение искусственного download через Playwright route.fulfill.
- `44040313555` / `12991d4`: 13/15 browser cases, реальные API 2/2 PASS. Исправлен
  устаревший список разрешённых mock-узлов после обновления defaults.

Во всех этих исправлениях assertions сохранены. Скачивание decoder с реального
статического сервера и правильные URL/байты на виртуальном gateway проверяются
отдельно; отменённая загрузка не считается успехом.

## Метод проверки

Сверены фактические branch/HEAD/рабочее дерево, исходные проектные инструкции,
последние доказательства, CI run/attempt/jobs и готовые ZIP. Три параллельных кодовых
обзора проверили протокол и сохранность vault, выпуск и зависимости, восстановление
и пользовательские переходы. Найденные случаи воспроизведены на синтетических
данных, исправлены и включены в регрессии. Выполнено взаимное чтение изменений.

Для React проверены явный порядок записи состояния, подтверждение пользователя,
ошибки browser storage, асинхронные ответы после закрытия, cleanup и зависимости
effects. Тесты не используют личное дерево или настоящий wallet signer.

Отдельно проверены текущие публичные адреса и API. Проверка заголовка транзакции,
готовности API или принятия upload не подменяет получение фактических байтов и
восстановление. Ограничения локального окружения указаны отдельно от CI.

## Найденное и исправленное

| Область | До исправления | Исправление и доказательство |
| --- | --- | --- |
| Отмена старой версии | Session/HEAD менялся до подтверждения замены draft; после отказа следующий архив мог взять старый vault A вместо A+B+C | Подтверждение предшествует записи; принятие полного vault/draft/session с проверкой и rollback; unit и браузерные регрессии |
| Сетевые версии | Versions и подготовка сохранения использовали старый metadata-only путь | Общий native reader проверяет подпись, transaction ID, Merkle root, метаданные, ciphertext, AES и весь vault |
| Локальные версии | `local_…`/`demo_…` могли назначаться сетевым HEAD | Локальные копии остаются локальными; сетевой parent не выдумывается |
| Новая локальная подготовка | При устаревшей session другой вкладки или отказе её записи можно было выбрать старый completed snapshot | Точный immutable prepared/cancelled journal защищает полный cache; несовпадающий parent останавливает сохранение |
| Устаревший parent из UI | Старый prop мог переопределить уже выбранный HEAD | Явный конфликт останавливает операцию до изменений и сетевых запросов |
| Ошибки browser storage | Publish/Restore могли продолжить при неудачной записи session | Проверяемое сохранение; отсутствие ложного успеха; encrypted journal остаётся |
| Отказ Wander | Реальная строка отказа отличалась от code4001 в прежнем synthetic тесте | Узкий классификатор окончательного отказа только на wallet promise; неизвестный результат и timeout по-прежнему блокируют новую подпись |
| Cloudflare в PDF | Неиспользуемая ветка jsPDF содержала внешний Cloudflare CDN loader | В независимой сборке удалена вся ветка внешнего viewer; обычные PDF проверяются; guard проверяет все JS chunks на жёстко заданные адреса Cloudflare/Worker |
| Адрес манифеста | Sandbox subdomain терял /manifestID/ и искал assets в корне | Исправлен base URL для обычного/sandbox/другого шлюза, сохранено поведение ArNS и локальных подкаталогов |
| Рабочие резервные адреса | ar-io.net и g8way.io не подтвердили готовность в CI | Defaults заменены на документированные native API arweave.net и turbo-gateway.com; блокирующая проверка требует 2/2 |
| Свой узел | Настройка терялась между экранами и после reload, поиск версий шёл к фиксированным сервисам | Проверяемая session preference; все independent native операции и custom /graphql следуют выбору; defaults не добавляются; 9 unit и сквозной browser case |
| Инструменты разработки | Две high-находки в Vite и source-map-js | Минимальные совместимые patches Vite8.1.6 и source-map-js1.2.2; остальные версии lockfile сохранены |

## Выполненные локальные проверки

Node 22.23.4. Общая независимая сборка и TypeScript прошли. Boundary: 10 JS chunks,
339 включённых модулей, 8 recovery files, обязательного сервиса SEJIRE нет.

| Проверка | Результат |
| --- | --- |
| Настройка собственного узла, сброс, ошибки записи и изоляция поиска | 9 PASS |
| Direct Arweave, включая повтор на другом узле с теми же ID/подписью | 21 PASS |
| Общий native reader / независимая подготовка полного vault | 10 PASS |
| Backup/finalization | 12 PASS |
| Historical native | 14 PASS |
| Принятие версии и rollback | 8 PASS |
| Упаковка, provenance, PDF transform, host/base URL | 32 PASS и deterministic manifest selftest |
| Offline decoder/CLI | 12 PASS и production crypto interop |
| Lint | exit 0; 22 предупреждения остаются, ошибок нет |

Локальный полный `npm test` остановился на запрете IPC pipe у `tsx` (EPERM).
Этот сбой не выдаётся за тест приложения. Общий `npm test` в окончательном CI `44040950008` прошёл
после чистой установки зависимостей. Локальный Chromium здесь не запускался
повторно после известного ограничения среды; итоговые browser-результаты берутся
из завершённого нового CI.

## Полный окончательный CI

[SEJIRE checks 44040950008, attempt 1](https://github.com/azovskaya/sejire_arweave_solana/actions/runs/44040950008)
завершён **17 ноября в 12:57:31 Алматы**, conclusion `success`.
**74 выполненных шага успешны**. Единственный skipped — предусмотренная выгрузка
диагностики только при неудаче. Это число шагов workflow, не число тестов.
Job `133895132554`; source и актуальный branch ref совпали с `3ed64d1`.
Prepare также содержит предупреждение GitHub о переводе actions v4 с Node20
на Node24; это замечание к инфраструктуре CI. Сам проект проверен под Node22;
предупреждение не было скрыто и не является сбоем выполненного workflow.
[Raw run/ref/jobs/artifacts](2026-11-17-exact-ci-evidence.json).

| Группа | Успешно |
| --- | ---: |
| Независимый браузерный профиль | 15/15 |
| Настройка собственного native node | 9 |
| Historical native recovery | 14 |
| Independent backup/finalization | 12 |
| Independent native vault | 10 |
| Vault version selection | 8 |
| Offline decoder | 12 + production crypto interop |
| Автономный HTML decoder в браузере | 1 |
| Release/PDF/base URL | 32 + deterministic manifest selftest |
| Worker release gate | 53 |
| Editor browser | 7/7 |
| Checkout browser | 5/5 |
| Protocol browser | 5/5 |
| ArNS hosting/base URL | 9/9 |
| Native browser | 21/21 |
| Native pilot browser | 3/3 |
| V2 browser | 15/15 |
| Admin browser | 14/14 |
| V2 recovery browser | 35/35 |
| Funded save/reload browser | 25/25 |
| Paid SOL browser | 48/48 |
| Native journey | 48/48 |

Также прошли полный `npm test`, Linux/SQLite/runtime, TypeScript, lint, обе legacy
сборки и wallet-history timeout regression. Legacy browser suites используют
управляемые тестовые адаптеры; они не доказывают настоящую подпись расширением или
реальную оплату. Chromium viewport 390 px не заменяет физический iPhone/Android.

В 15 сценариях независимого профиля подтверждены отказ от открытия старого vault,
полная локальная версия, ошибки persistence, защита от unsigned network binding,
оба PDF-экспорта, точное скачивание автономного decoder, sandbox URL, повтор той же
подписанной транзакции после reload/import и собственный узел при заблокированных
defaults. Снимки синтетического дерева: [desktop](screens/2026-11-17-independent-1280.png),
[390 px](screens/2026-11-17-independent-390.png).

## Принятый пакет и подготовка публикации

Пакет принят **из готового CI artifact без пересборки**. Валидатор проверил успешный
точный run/attempt, текущий branch ref, SHA ZIP, состав профиля и все пути, размеры
и SHA файлов release manifest, затем добавил проверяемый provenance.
[Полный результат приёмки](2026-11-17-accepted-release.json).

| Поле | Значение |
| --- | --- |
| Source commit | `3ed64d14738a2c7080de2007bb34f2df13dd7e1f` |
| Исходный CI artifact | `permaweb-static-release`, ID `14309427569` |
| SHA-256 исходного ZIP | `d613cbb11412843772f0f17b0ba4ea9ab0a1168b3634d51c55044fe2281a94b1` |
| SHA-256 release manifest | `b51e46a891c41ab8cb7d23a7b6ecaef50e4a5829528ffbcbb19fee9eeacbf613` |
| Содержимое с provenance | 41 файл, 2 900 136 байт |
| Профиль | `decentralized-direct-arweave` |
| Состав JS | 10 chunks, 339 включённых модулей |
| Восстановление | 8 recovery files, включая автономный HTML и CLI |
| ZIP для владельца | `sejire-independent-3ed64d1.zip`, 1 256 285 байт |
| SHA-256 ZIP для владельца | `29204dda9130c30baeade6dca07fdadfe4c643d67acf5a6c7f034626beab2d96` |

[Скачать ZIP](releases/sejire-independent-3ed64d1.zip) ·
[Контрольная сумма](releases/sejire-independent-3ed64d1.zip.sha256).
ZIP содержит файлы сайта в корне. **Для публикации сайта загружают содержимое ZIP
с path manifest, а не сам ZIP как единственный объект.** `release-manifest.json`
является ведомостью контрольных сумм; сетевой path manifest ещё не создан.

[Подготовка 44042817147](https://github.com/azovskaya/sejire_arweave_solana/actions/runs/44042817147)
успешна: `mode=prepare`, `max_quote_winc=0`, exact CI `44040950008/1`.
Шаг `Recheck exact CI, upload with existing credits, verify public bytes` **SKIPPED**.
Официальный accepted pack `14310087297` совпал побайтно со всеми 41 файлами
локально принятой папки, включая provenance. Его ZIP SHA-256:
`9460ce3d23c01d55c8e71ecc23bd6cd458c5f0b116a9a39db31e40bb7409f5f1`.
Разные SHA трёх ZIP отражают упаковку и добавленный provenance; одинаковость
принятого содержимого проверена отдельно, а не предположена по именам.

Свежая оценка от **17 ноября, 12:59:00.014 Алматы**: **39 042 965 855 winc**
за 41 файл и path manifest (42 позиции с консервативной надбавкой на подпись).
`withinBudget=false`, поскольку заданный разрешённый лимит равен нулю;
`autoTopUp=false`, `providerHardCap=false`, `limitKind=preflight-quote-only`.
Это снимок цены в единицах Turbo credits, не сумма в SOL/AR/долларах и не разрешение
на расход. Код перед upload требует свежую цену (не старше 60 секунд) и
собственный достаточный баланс. Ограничение является проверкой предварительной
цены, а не гарантированным жёстким лимитом провайдера.
[Исходная оценка](2026-11-17-publication-quote.json),
[raw prepare metadata](2026-11-17-prepare-github-evidence.json),
[сравнение официального пакета](2026-11-17-prepare-comparison.json).

Turbo здесь — выбранный транспорт разовой публикации статических файлов;
приложение и семейные native-архивы от его SDK, счёта или bundler API не зависят.
Пакет переносим и может быть опубликован другим совместимым способом.
Ни наличие ключа для публикации, ни баланс владельца этой проверкой не проверялись.
[Экран завершённой подготовки](screens/2026-11-17-prepare-result.jpg).

Рабочая папка `sejire-pilot-release` безопасно fast-forward обновлена до source
`3ed64d1`; `.cache/permaweb-accepted` содержит новый пакет. Прежний пакет перенесён
в `.cache/permaweb-accepted-4d22e9e`, старый delivery ZIP сохранён.
Документы и копия нового ZIP сохраняются отдельно в ветке
`docs/readiness-evidence-20261117`; ветка приложения не продвигается ради отчёта.

## Зависимости

Аудит относится к `apps/web`, а не ко всему monorepo. После точечных patches:

| Scope | Low | Moderate | High | Critical |
| --- | ---: | ---: | ---: | ---: |
| Production npm dependencies | 13 | 10 | 0 | 0 |
| Полный web audit, включая dev tools | 18 | 11 | 0 | 0 |

Оба web high gate возвращают exit 0. Это не нулевое количество находок.
В отдельном legacy sponsor scope окончательный CI сообщает production: 13 low,
1 moderate, 0 high/critical; с test/dev tools: 13 low, 1 moderate, **3 high**,
0 critical. Эти три high остаются открытыми в старом серверном инструментарии;
его код не включён в независимый статический профиль. Package entries: `sharp`,
`undici`, `miniflare` (последний наследует transitive findings); это не три
независимых CVE. Поэтому утверждение
«во всём monorepo нет high» было бы неверным. Старый backend не развёртывался.
[Sponsor audit excerpt](2026-11-17-legacy-sponsor-audit.txt),
[структурированное резюме из лога](2026-11-17-legacy-sponsor-audit-summary.json).
CI audit-report steps могут быть non-blocking: зелёный шаг сам по себе не
означает отсутствие findings; приёмка нового пакета дополнительно выполнила
блокирующий production audit.
Lockfile SHA-256: `daab8369e0c4323765a6641ed99c6b547050596085e2b684942e98d8fd6cc88d`.
В version diff ровно два patch-обновления: Vite8.1.5→8.1.6 и source-map-js1.2.1→1.2.2.
Предыдущий optional TypeScript dependency и production versions сохранены.

Все 23 package-level production findings сопоставлены с module map
**точного принятого CI артефакта**: соответствующие package paths отсутствуют
среди его 339 включённых модулей. Этот анализ состава не является обещанием отсутствия
любых уязвимостей или внешним независимым security audit.

Официальные исправления: [Vite advisory](https://github.com/vitejs/launch-editor/security/advisories/GHSA-587h-7wmj-h5pm),
[source-map-js release](https://github.com/7rulnik/source-map-js/releases/tag/v1.2.2).

## Фактическое публичное состояние

17 ноября, 12:14:39 Алматы, `https://sejire.ar.io/` отвечает HTTP200 и через шлюз
разрешается в `UVtbBWxU9HK5gD21Pq0qc3I4adRREFbOQpU4F0NXik8`, root record `@`,
TTL900. Его HTML — прежняя сборка; `build-provenance.json` и `release-profile.json`
нового профиля там отсутствуют (404). Заголовок шлюза не заменяет проверку записи
владельца в реестре. GitHub Pages по-прежнему сообщает source `8b07f9f…`.

Новый сайт в Arweave не загружался, manifest ID не получен, ArNS Target не менялся.
Проверка owner/controller, типа регистрации и срока имени остаётся до cutover.
TTL900 описывает кэширование routing record. Тип регистрации и срок владения
именем требуют отдельной проверки реестра. Документированный [resolver API](https://docs.ar.io/apis/ar-io-node/arns/)
описывает target/ANT/TTL, но не registration expiry и полномочия. Одна попытка
публичного resolver-запроса была недоступна через веб-инструмент; это ограничение
проверки, а не доказательство неисправности имени.

Согласно текущей [архитектуре ar.io](https://docs.ar.io/learn/protocol-architecture/),
регистрация и срок хранятся в ArnsRecord, контроллеры — в AntControllers, а ANT
представляет владение именем на Solana. Отсутствие обязательного SOL checkout для
семейного архива не означает отсутствия отдельного управления именем в протоколе
ArNS. Адрес кошелька владельца и право менять этот конкретный ANT не подтверждены.

Read-only probe принятого CI `44040950008` от **12:46:28.252 Алматы**
подтвердил `arweave.net` и `turbo-gateway.com`: info/anchor/price HTTP200,
preflight tx/chunk HTTP204 и разрешённый Origin. Результат **2/2**,
requiredReadyNodes=2. Отдельный recovery gate в том же CI подтвердил
metadata/raw/CORS на обоих endpoints для публичной контрольной записи.
[Исходный API report](2026-11-17-direct-api-readiness.json).

Это два доступных endpoint, а не доказательство независимости их операторов,
реальной передачи архива или финального settlement. Ни один probe не делает
POST, не использует адрес кошелька и не оплачивает хранение. Официальная
поддержка native API Turbo подтверждена [transactions](https://docs.ar.io/apis/ar-io-node/transactions/)
и [chunks](https://docs.ar.io/apis/ar-io-node/chunks/); bundler API и credits в
runtime не добавлялись.

### Прежний оплаченный архив

Публичный ID `AtwLYx509C9jWIFKUNg7dy1GSgiaDbXVK1YEQbBWfHY` проверен 17 ноября
в 11:56:51 Алматы: status200, block2035774, 8229 confirmations; offset200 и размер
25269 в метаданных; raw404. В этой проверке фактические байты получить не удалось;
успешное восстановление владельцем не подтверждено.
Это не доказательство утраты на всех узлах, но и не завершённое сохранение.

Существующие ciphertext, signed transaction, receipt и прежние browser/Worker
journals нужно сохранить и не удалять до сверки обязательства. Наличие полного
исходного комплекта в этой проверке не подтверждалось. Новый платёж/архив это обязательство не закрывает. В этой проверке
архивные слова, личное дерево и приватные ключи не читались. Ограничение старого
сервиса не обходилось.

## Оставшаяся реальная приёмка

1. Использовать принятый пакет `3ed64d1`; перед реальной публикацией получить
   новую цену и явное решение владельца по сумме и способу оплаты. Подготовка
   с лимитом 0 не разрешает расходы и не подтверждает баланс или доступ к ключу.
2. Загрузить содержимое папки с index.html и 404.html, сохранить path
   manifest ID и receipts, проверить каждый публичный файл и fallback.
3. После этой проверки владелец имени меняет только Target корневой записи @;
   отдельно сверяются owner/controller, прежний Target, стоимость и результат.
4. На маленькой синтетической семье проверить настоящее Arweave-расширение:
   адрес, отказ, цена, явная подпись, reload/resume того же ID, подтверждение и
   фактические bytes/hash. Проверить резервный endpoint из реального браузера.
5. В чистом контексте и отдельно без сети восстановить весь vault, все деревья
   и историю. Сохранить decoder, encrypted kit и слова отдельно.
6. Закрыть прежнее оплаченное обязательство Atw… без нового автоматического платежа.

Физические iOS/Android/Safari и настоящее расширение не объявляются проверенными
по Chromium viewport или software signer. Старые ANS104 items не становятся
native-транзакциями: если формат не поддержан reader, требуется точный encrypted
file. Медиа-ссылки сами по себе не включают media bytes в архив.

## Долговечность

Убрана обязательная зависимость нового runtime от Cloudflare и частного сервера
SEJIRE; decoder и формат позволяют восстановление из сохранённого файла без сайта,
ArNS, кошелька и сети. Это повышает устойчивость к исчезновению оператора.
Использование Cloudflare внутри инфраструктуры стороннего шлюза этой проверкой
не исключается; шлюз остаётся заменяемым.
Обещание «точно будет работать через 200 лет» не следует ни из тестов, ни из модели
хранения: сохраняются условия существования сети, копий, ключей и читаемого формата.

Первичные документы: [Arweave HTTP API](https://docs.arweave.org/developers/arweave-node-server/http-api),
[ar.io gateways](https://docs.ar.io/learn/gateways),
[ArNS Console](https://docs.ar.io/build/guides/working-with-arns/buy-manage-arns-console),
[sandboxing](https://docs.ar.io/build/advanced/sandboxing),
[Wander sign API](https://github.com/wanderwallet/wander-docs/blob/main/api/sign.md).

## Доказательства и ограничения хранения

В этой ветке хранятся принятый delivery ZIP, SHA-256, исходные run/artifact metadata,
публичные API-результаты, отчёты npm audit, свежая цена и снимки проверки.
GitHub Actions artifacts имеют ограниченный срок хранения; поэтому копия ZIP
сохранена в Git отдельно от временного artifact. Личных архивов и секретов в
этих доказательствах нет. Полный список выпускных идентификаторов —
[release summary](2026-11-17-release-summary.json).

Это внутренняя техническая приёмка с несколькими параллельными обзорами,
а не сертификация и не внешний независимый аудит безопасности.
