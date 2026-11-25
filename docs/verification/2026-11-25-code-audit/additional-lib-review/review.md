# Дополнительный ручной аудит frontend libraries — 2026-11-25

## Вывод и границы

Ручное чтение области `apps/web/src/lib` завершено. В объединении этого отчёта и ранее сохранённого `frontend/coverage.json` **134 из 134 runtime TypeScript/TSX файлов прочитаны полностью**. Текущие SHA-256 всех 134 файлов совпали с соответствующими записями ручного review. Отдельно прочитан runtime JSON с единственным публичным историческим locator.

Дополнительных доказанных блокирующих дефектов текущего SOL + promo пользовательского пути при этом проходе не обнаружено. Это вывод о прочитанном коде, а не разрешение на публикацию и не утверждение о выполнении каждого возможного пути. Проверка работающего API, Mainnet policy, принимающих адресов, баланса, DNS/ArNS, полного CI и окончательного публикуемого архива остаётся в родительском release audit.

Runtime и tests этим reviewer не изменялись. Повторные сборки, браузерные тесты, PDF matrix, кошельки, подписи, платежи, uploads и deploy не запускались. Выполнялись только чтение, локальная AST-инвентаризация импортов, вычисление SHA и сверка evidence. Содержимое `.env`, локальных хранилищ реального браузера или приватных ключей не открывалось.

## Фактический охват

| Область | Результат |
| --- | --- |
| Runtime `.ts/.tsx` в `apps/web/src/lib` | 134 файла, 15 078 строк; полный ручной охват в объединённых evidence |
| Не отмеченные ранее файлы lib | 96 файлов прочитаны полностью в этом проходе |
| Дополнительное расширение прежнего чтения | 5 файлов: `treeEngine`, `localArchive`, `native/receipt`, `independentVault`, `independentBackup` |
| Этот проход lib | 101 TypeScript/TSX + 1 runtime JSON; 11 818 строк, включая JSON |
| Оставшиеся только targeted записи lib | 0 после расширения трёх прежних targeted reviews и двух dependency re-reads |
| Текущий SHA против SHA ручного review | 134/134 совпали; 0 неизвестных или изменившихся источников |
| Дополнительные собственные shared packages | Полностью прочитаны `amounts`, `order`, `recipients`, `rpcJson`, `protocol/wire` — 5 файлов, 277 строк |

`full` означает, что весь файл прочитан; это не процент покрытия тестами и не доказательство отсутствия всех ошибок. UI-каталоги на RU/KK/EN также прочитаны целиком; профессиональная лингвистическая сертификация или проверка каждой строки на каждом экране не заявляется. Tests, fixtures, declarations и зависимости `node_modules` не входят в указанные 134 файла.

Пофайловые SHA, число строк, степень чтения, область и точный источник предыдущего review сохранены в `coverage.json`. Повторно прочитанные файлы не добавлены второй раз к объединённому числу 134.

## Что реально попало в funded сборку

Независимая локальная сборка `App.independent.tsx` не использовалась как доказательство состава funded сайта. Использованы два различных источника:

1. `source-import-reachability.json`: AST-граф исходников от `main.tsx` с funded alias из Vite (`App.tsx`, обычный Publish modal, legacy preservation context, native payment panels). Найдены 115 из 134 lib TypeScript/TSX файлов по консервативной цепочке импортов; 0 неразрешённых относительных импортов. Граф не сворачивает ветки environment и не доказывает сохранение неиспользуемого export в JS.
2. Предоставленный родителем свежий `release/funded-bundle-boundary.json`: Vite `generateBundle`, только модули с `renderedLength > 0`, включая lazy chunks. В нём 13 JS chunks, 725 модулей вместе с зависимостями, 141 модуль приложения. **Все 113 lib модулей из этого списка (112 TypeScript/TSX + locator JSON) имеют полный ручной review; 0 пропусков.** Сверка и текущие SHA сохранены в `funded-boundary-coverage.json`.

SHA-256 использованного funded boundary: `1d9070e63d24f93cfb150412befc732fca5bf66657e1968c6214eab0319c9d41`.

Producer boundary помечает сборку `sha: local`, без встроенных per-source digests. Поэтому точное происхождение сборки подтверждается родительским журналом запуска и состоянием worktree; данный crosscheck связывает текущие прочитанные файлы с перечисленными module paths. Наличие модуля в chunk не означает, что все его exports и legacy branches доступны пользователю.

Граф также содержит 10 собственных исходников вне `apps/web/src`. Четыре sponsor RPC/payment helper уже отмечены `active_path_full_review` в backend coverage, их SHA совпали. Пять небольших package modules дочитаны здесь. Для `packages/checkout/paid.ts` родитель прямо сообщил полное личное чтение и включение в root coverage; этот reviewer не присваивает себе дополнительное независимое чтение данного файла. Разделение сохранено в `shared-dependency-coverage.json`.

## Проверенные свойства

### Деревья, история, локальные данные

Прочитаны core types, engine, JSON-related callers, pedigree/kinship helpers, guide, date helpers, download и localisation. Копирование snapshot при commit, tombstones и отдельные versions/commits сохраняют историю в соответствующих операциях. Ранее проверенные crypto/vault и tree JSON validators сверены по текущему SHA и не были заново объявлены динамически протестированными.

Расширено чтение `independentVault` и portable backup: явно выбранный file/local ciphertext привязан к `cacheDigest`; journaled подготовка проверяется по hash, operation ID и parent; известный native parent проходит signature/Merkle binding. Recovery kit хранит точный ciphertext и checksum, отдельно от слов. Legacy receipts используются как locator, не импортируют состояние оплаты или завершения.

`localArchive` ограничен 40 browser-history rows и сам по себе использует best-effort запись. Это не atomic acceptance API и не долговременное хранилище всех версий. В новых funded selection/finalization путях критические cache/session/draft writes проверяет ранее рассмотренный `selection.ts`; наличие legacy helper не следует принимать за гарантию успеха при quota.

### Восстановление и сети

Прочитаны discovery, gateway pool, bounded readers, metadata/raw validation, native historical reader и version selection. JSON gateway reads ограничены 2 MiB и таймером на headers + body. Raw readers ограничивают bytes, проверяют ожидаемые digest/size и допустимый base64url. Candidate identity, vault binding, уникальные relevant tags, envelope schema и AES остаются отдельными проверками. В native reader дополнительно проверяются подпись, transaction ID и заново вычисленный Merkle root; публичный индекс служит источником ID.

Peer URLs фильтруются перед использованием. Явно выбранный собственный direct node допускает credential-free HTTPS origin. При выбранном node поиск не переключается незаметно на другой оператор. Discovery остаётся ограниченным и может быть неполным; выбор head не является доказательством наличия всех исторических версий.

### Direct Arweave, сохранённые попытки и legacy paths

Полностью прочитаны прямой journal, формат operation/package, wallet signature flow, quote, upload, receipt и network transport. Журнал сохраняет ciphertext и signing intent до вызова кошелька, точные signed bytes до upload, не создаёт новую подпись при неопределённом результате и проверяет revision/immutable fields. Проверки подписи заново связывают data bytes, root, tags, payer/owner, reward и parent. Импорт package не переносит недоказанное утверждение о network completion.

Дополнительно прочитаны старые sponsor/Turbo/native/preserveV2 модули. Они остаются отдельными протоколами с разными ограничениями; их наличие не означает, что обычный funded save использует legacy cashier или Turbo. В текущем funded route обычный `#/save` отделён от явно выбранного `#/save/legacy-pilot`; guards и соответствующие компоненты рассмотрены в независимом reviewer report и свежем addendum ниже.

### PDF

Полностью прочитаны classic tree, shezhire, lineage, text layout, fonts, ornaments, poster, filenames и PDF locale. Сетевой источник шрифтов — упакованные asset URL; внешнего font CDN в этом коде нет. Пользовательские имена и заметки передаются как текст, а не как HTML/script/PDF-команды. Для переполнения карточек предусмотрены продолжения/списки подробностей; обходы ancestry используют visited sets. Экспорт не мутирует vault/tree store.

Предыдущее доказательство 89 PDF / 779 страниц остаётся историческим результатом сохранённой матрицы. В этом проходе оно не пересоздавалось и не представлено как новый запуск. Никакого дополнительного визуального прогона только из-за расширенного чтения не было.

### AO и автоматические локальные запросы

Прослежены оба автоматических UI вызова. `queryPersonFromDraft` создаёт `LocalTreeProcess` и вызывает локальный `handle`. `mirrorStoreToProtocol` явно создаёт `SejireAoClient({ mode: "local" })`, без `send`; это остаётся локальным даже при другом `VITE_AO_MODE`. Полный snapshot не отправляется внешнему сервису по этим цепочкам. Отдельный `probeHyperBeam` — GET по process ID при его явном вызове; он не принимает snapshot.

### Денежные значения и shared packages

В дополнительно прочитанных shared modules суммы преобразуются через bounded decimal strings и BigInt, без дробного округления; допустимый максимум задаёт u64. Recipient roles, reference, network, fixed service amount и paid archive fields проверяются отдельно. RPC JSON сохраняет точные небезопасные для Number integer tokens до последующей u64 validation. Canonical signing representation не принимает произвольные prototypes и нецелые numbers. Наличие корректного public recipient address само по себе не доказывает владение адресом.

## Ограничения legacy кода, не новые блокеры funded UI

В `opsDesk/store.ts` legacy local-secret helpers используют best-effort localStorage и не имеют generation fence вокруг await PBKDF2/decrypt. При самостоятельном использовании этих helpers поздний результат после logout может снова заполнить memory state. Для текущего funded profile `App` открывает `AdminDesk` с `v2Diagnostics`: keys/password controls скрыты, `refreshDesk` не вызывает `loadOpsSecrets`, а `treasuryOn` выключен Preservation V2. Секретные хранилища реального пользователя не исследовались; действующий SOL/promo путь не объявляется уязвимым только на основании этих legacy exports. При возвращении старого local-treasury UI его quota/logout semantics требуют отдельного исправления и regression.

`treeEngine.listHistory`, `kinship.layoutTree` и `guide.applyGuidePerson` имеют ограниченную защищённость от специально изготовленных входов или старые предположения о структуре. По поиску production source у всех трёх найдены только определения, без call sites. Они не представлены как воспроизведённая ошибка текущего пользовательского пути. Полный security audit внешних библиотек или математическое доказательство завершения на всех допустимых размерах данных не заявляется.

## Независимый addendum по двум последним UI fixes

Прочитан production diff `ErrorBoundary.tsx` / `Workspace.tsx` и обе новые regression в `editor-safety.spec.mjs`:

- Crash recovery удаляет старый fragment перед reload только когда существует валидный draft. Это позволяет remembered editor screen получить приоритет над упавшим deep link.
- `openPublish` сверяет revision сразу после awaited shared-journal guard, до capture/commit/mirror. Home инвалидирует запрос немедленно, cleanup — при unmount или смене tree ID. Новый browser test удерживает настоящий Web Lock, уходит на Home, создаёт новое дерево, затем отпускает lock и проверяет неизменность нового draft.

Для этих доказанных сценариев новых блокеров в патче не найдено. Этот addendum — targeted independent diff review. Динамический PASS двух новых browser assertions этим reviewer не заявляется; их фактическое выполнение относится к новому parent CI. SHA рассмотренных файлов и граница review сохранены в `ui-patch-addendum.json`.

## Evidence

- `coverage.json` — полный фактический список ручного чтения и объединённый lib coverage с SHA.
- `source-import-audit.mjs` — воспроизводимая read-only AST-инвентаризация; не тест и не build.
- `source-import-reachability.json` — source graph, aliases, edges, current SHA.
- `funded-boundary-coverage.json` — 113/113 rendered lib modules из отдельной funded сборки.
- `shared-dependency-coverage.json` — явное разделение backend, root и этого reviewer для shared own code.
- `ui-patch-addendum.json` — hashes и targeted independent review последних двух UI fixes.
- `summary.json` — итоговые counts, ограничения и evidence hashes.


## Финальное дополнение: два independent компонента

После закрытия lib scope полностью дочитаны `PublishSeedModal.independent.tsx` (126 строк) и `RestoreSeed.independent.tsx` (219 строк). Это расширяет прежний targeted охват до full для обоих файлов. Точные SHA и границы чтения — в `independent-components-full-read.json` и `coverage.json.independentComponentFullReads`.

В Publish просмотрены все режимы UI, legacy/pending guards, создание и подтверждение слов, подготовка полного vault, запись direct journal до cache, digest-bound session, закрытие и completion callback. В Restore просмотрены все file/receipt/known-ID/discovery ветки, native verification перед принятием network HEAD, повторное чтение и расшифровка одного и того же local ciphertext, явный выбор версии, guards после await, quota/error paths и все rendered controls. Новых доказанных блокеров не обнаружено.

При этом не заявляется отсутствие любых поздних локальных записей: если independent modal размонтируется во время encryption, `createDirectOperation` может ещё сохранить зашифрованную подготовку. Следующая lifetime-проверка останавливает cache/session update и UI callback; этот шаг не вызывает кошелёк и upload. Журнал перед cache/session обеспечивает сохранность точных байтов попытки, но не является общей атомарной транзакцией этих хранилищ.

В этом дополнении runtime/tests не изменялись, tests/build не запускались. Динамические проверки относятся к parent CI, а не к данному full-file чтению. Scope больше не расширялся.
