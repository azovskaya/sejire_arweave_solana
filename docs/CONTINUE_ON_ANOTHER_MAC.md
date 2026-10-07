> **07.10.2026 — V2 automatic flow:** Payment reconciliation, Arweave signed-transaction resume, confirmation, retrieval and SHA verification now advance on the same `#/save` screen without status buttons. Synthetic browser tests cover one Phantom call, one Wander signature, five reload points and a corrupt gateway payload. The final feature-branch CI SHA, conclusion and `native-admin-build` artifact must be checked before owner acceptance. Real Phantom/Wander extension behavior and settlement remain untested by the agent; no live SOL/AR operation or Pages publication was performed. See [Preservation V2 pilot](PRESERVATION_V2.md).

> **07.10.2026 — Preservation V2 branch:** See [Preservation V2 pilot](PRESERVATION_V2.md). The new native build has a separate one-session, reference-reconciled, signed-Arweave-resume path for the exact owner-approved ciphertext. Old records remain read-only history for V2. Synthetic tests and CI artifact must be reported for the final feature-branch SHA; real Phantom/Wander acceptance, SOL payment and AR upload have not been performed by the agent. No Pages publication from this work.

> **06.10.2026 — continuation hardening (CI evidence per final SHA):** successor is selected and its URL saved BEFORE unsigned payment preparation. A signed successor intent is retained separately so failure to append jobs cannot cause a second order signature on retry. Native order signatures/connection have bounded waits, unsupported message signing is explicit. Safe staged errors are available only in owner diagnostics; no archive bytes/words/key material are logged. User details no longer contain config/genesis/job controls; progress has three verified stages. The historical live exception before Phantom was NOT recorded by the old build and is not established from the old job alone. Exact old bytes/digest match; read-only quote on 06.10 is 3355956780 winston, reserve sufficient. These facts do NOT prove the original browser failure was resolved or that an upload occurred. No real wallet signature/payment/upload was performed.

> **05.10.2026 — явный выбор сохранения:** обычное новое сохранение не выбирает старый заказ по архиву или `active-saving`. Восстановление конкретной попытки — только через `order` в URL или явный выбор из истории. После создания нового заказа URL закрепляет его ID для безопасной перезагрузки. Старые неизвестные попытки и ограничения расходов сохранены; окончательные CI/Pages проверяются для соответствующего SHA.

> **05.10.2026 — пользовательский MVP (локальная работа; окончательный CI/SHA проверять отдельно):** основные разделы «Обзор / Сохранения / Финансы / Настройки»; одна основная команда сохранения, отдельное согласие точной суммы, проверка готовности до кошелька, срок ответа кошелька 60 секунд с сохранением поздней подписи без автоматической отправки. Подписанные настройки восстанавливаются автоматически; изменения показывают «Было / станет» и подписываются/проверяются одним действием, порог не понижается. Для неизвестной прежней попытки только DEVNET допускается отдельный явно подтверждённый владельцем связанный тест; прежняя неизвестность не снимается, архив тот же, повторная загрузка того же снимка локально заблокирована. Это принятие риска повторного тестового платежа, не доказательство отсутствия старого. Read-only сверка старого reference 05.10 снова вернула пустую выборку; отсутствие оплаты не доказано. Никаких платежей/подписей владельца/Arweave публикаций агентом не выполняется. Журнал и очередь — данные данного устройства, не общая сеть.

> **05.10.2026 — единое сохранение (проверки окончательного SHA смотреть в CI):** проверенный локальный trust anchor и подписанная цепочка восстанавливаются из IndexedDB; legacy-кеш без закреплённого корня требует один независимый импорт файла доверия, не повторное создание genesis. Зашифрованное задание автоматически видно оператору на том же устройстве; это не общая очередь. Подготовленный message/blockhash/lastValidBlockHeight записываются до Phantom, signed bytes/signature — до отправки. Старое задание `9bb9b792bbb948fe88935a1aa4a2cd51` сохранено вне Git без изменений: read-only devnet reference lookup не нашёл подтверждённого платежа, но message/срок старой попытки отсутствуют, поэтому отсутствие платежа НЕ доказано, новая оплата заблокирована. Реальные подписи/переводы/загрузки агентом не выполнялись. Новый полный browser journey использует программные подписанты и перехваченные ответы; production pilot остаётся ограничен прежним единственным ciphertext и 0.004 AR.

> **05.10.2026 — bounded manual Arweave pilot:** native production build enables only the owner-approved 28365-byte ciphertext / SHA-256 `19133b897f69e1f0d43a55217a00adee6b6dfefb73f0f6228008f5c8a702e6c8`, reserve `qgoIFw9WsusMRapWzcFg4jNW08HSWvQkpAKOz86BUuI`, max `4000000000` winston. General broadcast/config publication remain off. Owner must confirm manager, prepare next signed config with 30-minute window, sign/apply/export it, then create a NEW devnet order. Import original encrypted file via checkout; no re-encryption. Existing signed upload ID is persisted/exported and resumed; browser locks are local, not global on-chain protection. No owner signature, payment or Arweave broadcast was performed by the agent. Local 37 native fixture tests and TS passed; final CI/Pages evidence must be checked for the final commit.

> **02.10.2026 — independent native checks:** cold Vite reload fixed by build-time payment-module selection; software message/transaction rejection separated. Three authorized real devnet probes consumed 0.070015 SOL total; signatures/public evidence and dependency limitations are in [native independent checks](verification/2026-10-02-native-independent-checks.md). No storage execution/mainnet spend/real Phantom or Wander acceptance. Exact final CI/Pages SHA is reported with the completed run, not inherited from an older commit.

## 2026-10-01: native admin / direct Arweave manual pilot

Read [native admin pilot](NATIVE_ADMIN_PILOT.md). Local changes preserve previous preflight, now historical: Turbo quotes do not apply to native AR transactions. Open #/admin in the native build; no local password or private-key import. Verified config + independent genesis hash; public SOL service/fund and AR reserve roles; manual portable job and signed format-2 attempt. Mainnet SOL and AR broadcasts/publication disabled. No live expense/upload, Phantom/Wander acceptance or permanent settlement claimed. AO blocker persists. Native scripts: npm run native:build; npm run test:native-browser. Final SHA/CI reported in session, not inferred from earlier successful commits. Existing audit findings remain open; global uniqueness across unsynchronized offline copies is not guaranteed.

## 2026-10-01: permanent storage preflight — STOP до оплаты

[Read-only preflight](verification/2026-10-01-permanent-storage-preflight.json). Новый отдельный mainnet test treasury, encrypted portable backup и recovery material находятся вне Git в ~/.sejire-mainnet-preflight (каталог 700, файлы 600). Не выводить содержимое приватных файлов. ANS-104 item НЕ подписан; mainnet transfers/uploads NOT RUN. Перед отдельно разрешённым расходом повторить quote: node --experimental-loader ./scripts/offline-ts-loader.mjs scripts/permanent-storage-preflight.mjs. Скрипт не содержит broadcast/upload и повторно использует локальные keypair/архив. Loader только для локального совместимого запуска, не заменяет CI. Local encrypt/decrypt/portable backup exact roundtrip PASS. Цена SEJIRE 0.03 SOL не является стоимостью Turbo. AO blocker сохраняется независимо. Зашифрованную offline-копию keypair и отдельно recovery words сохранить на контролируемом носителе и проверить локально; не Git/чат/облако. Backup ключа владельцем ещё NOT RUN. Этот test treasury не становится production-казной.

## 2026-10-01: живой AO readiness

[Публичные результаты](verification/2026-10-01-ao-readiness.json): finalized payer balance проверен; devnet расходы разрешены. MU вернул 500, CU — 403 whitelist; AO process creation НЕ подтверждено. Подписанные байты попытки и новый test-only RSA signer сохранены вне Git в защищённом `.sejire-devnet`. Не создавать новый process ID вслепую; сперва сверить candidate и доступ CU/scheduler. `scripts/ao-live-readiness.mjs --execute` повторяет те же подписанные байты; `--selftest` не читает локальные ключи и не обращается к сети. Это readiness-процесс, НЕ платёжный журнал; его bootstrap не заменяет реализацию live journal gate. Полный AO/Solana/upload путь остаётся NOT RUN. Нужен доступ тестового процесса к работающему AO CU; облачный деплой не нужен.

# 2026-10-01: направление продолжения

Обязательный Cloudflare preview приостановлен владельцем. Новый локальный signed-journal пилот и переносимое восстановление: [PROTOCOL_CONTINUATION.md](PROTOCOL_CONTINUATION.md). Старые адаптеры сохранены; живой AO immutable runtime еще не доказан. Не запускать Cloudflare/ArNS/mainnet публикации. Следующие разделы описывают прежние проверки и не заменяют это уточнение.

# Продолжение SEJIRE на другом Mac через Codex CLI

> **01.10.2026 — активная цель: законченный devnet SOL-first checkout (0.03 SOL) и исполнение архива.** Начатый A2.2 сохранён и подключён к UI; старые ограничения отдельных этапов ниже исторические. Владелец разрешил код/CI/обычный push рабочей ветки. Preview/тестовый backend требуют отдельного согласования аккаунта, адресов и изолированного uploader signer; подписи выполняет владелец. См. [краткую точку продолжения](DEVNET_CHECKOUT_PREVIEW.md). Живой платёж и загрузка пока NOT RUN; sejire.ar.io/ArNS не изменялись.

> **30.09.2026 — A2.1:** владелец разрешил RPC decoder + постоянный SQLite Durable Object adapter и проверочный CI, без deploy/подписей/переводов. См. [границы и команды проверки](verification/2026-09-30-a2-1.md), [ADR 0008](adr/0008-solana-rpc-and-durable-ledger.md) и [таблицу web рисков](verification/2026-09-30-web-security-reachability.md). Штатный Ubuntu/Node 22 CI подтвердил 49 RPC и 14 реальных SQLite runtime сценариев, включая новый процесс и отсутствие повторного зачёта; на Catalina native runtime BLOCKED. Web audit остаётся FAIL; sponsor полный audit — 0 findings. Фактический окончательный SHA и CI-run сообщаются в заключении, не переносятся с прежнего SHA. Предыдущие запреты A2 ниже относятся к прежним этапам; текущий объём ограничен A2.1.

> **Фактический CI A0/A1:** commit `b04a0c5` отправлен; Ubuntu/Node 22 checks [36741938589](https://github.com/azovskaya/sejire_arweave_solana/actions/runs/36741938589) прошли. Полные тесты, TypeScript, lint, размеры и devnet build PASS; web audit FAIL (exit 1, 8 high/6 moderate/10 low), явно non-blocking. Подробности: [CI evidence](verification/2026-09-30-a0-a1-ci.md). Реальные платежи/расширение и persistent storage не проверены. Предыдущие статусы NOT RUN ниже относятся к историческому snapshot.

> **30.09.2026 — сохранение A0/A1 и штатный CI:** владелец разрешил commit/push только в `origin/feat/solana-preservation` и адресные исправления CI. Проверены совпадение историй после fetch, отсутствие repository webhooks, deploy только main/manual и Pages из gh-pages. Проверочный Ubuntu/Node 22 workflow включает отдельные install/test/typecheck/checkout/lint/measurement/devnet-build шаги; dependency audit явно non-blocking и сохраняет собственный неуспешный результат. На момент этой записи новый CI ещё NOT RUN; итоговый SHA/run нужно смотреть в GitHub Actions. Предыдущий отчёт ниже — исторический локальный snapshot. Реальные платежи и A2 не разрешены.

> **30.09.2026 — локальный A0/A1:** новая работа ещё не закоммичена и не отправлена; базовый HEAD `d76e2f5`, ветка `feat/solana-preservation`. См. [отчёт A0/A1](verification/2026-09-30-a0-a1-report.md). Владелец разрешил фундамент нового checkout; прежний direct Turbo-путь сохранён. Полное завершение A0 не заявлено: CI/настоящее расширение/оплаченный devnet требуют отдельной проверки.
>
> Этот Mac: Intel, Catalina 10.15.8, Node 18.20.7/npm 10.8.2. Node 22 и native esbuild здесь не поддерживаются штатно. Не менять ОС/глобальные инструменты/профиль Codex. Для доступных offline-проверок используется отдельный JS TypeScript loader; штатный Node 22 CI остаётся обязательным. Установка sponsor-зависимостей локальная; web-зависимости не устанавливались.

Передача работы: 29 сентября 2026. Репозиторий: `azovskaya/sejire_arvewe_solana`. Ветка: `feat/solana-preservation`; не `main`.

## С чего начать агенту

Прочитай этот файл и `SOLANA_PRESERVATION.md`, затем проверь `git status --short --branch`, `git remote -v` и `git log -3 --oneline`. Не предполагай, что локальные изменения другого компьютера уже сохранены в GitHub. Сохрани их; не используй reset/force-push и не стирай прежнюю папку проекта. Инструкции не дают разрешения на основную сеть, реальные расходы или публикацию заявки.

Владелец сообщил: кошелёк установлен в **Chrome на этом другом Mac**, Codex CLI тоже установлен. Уточни, это Phantom или Solflare: наличие обоих не подтверждено. Не переноси кошелёк с другого устройства, не проси его seed-фразу и не ищи ключи в профиле Chrome. Одобрение подключения и подписей выполняет владелец в расширении.

Текущая задача: довести и доказать путь **настоящее расширение → загрузка devnet → скачанная квитанция → восстановление в чистом браузерном хранилище**. Сначала воспроизвести, затем исправлять обнаруженные проблемы. Не начинать заново проектирование интерфейса или замену платёжной архитектуры.

## Что уже сделано и проверено

- Редактор родословной, RU/KK/EN, PDF/JSON, зашифрованные архивы AES-GCM и восстановление существовали в исходном проекте. Происхождение и границы новой работы описаны в README и `HACKATHON_2026.md`.
- Исправлен адаптер кошелька: настоящий `PublicKey.toBuffer()` для SDK; учёт смены адреса до/после подписи; поддерживаются форматы подписи Phantom/Solflare, провайдер расширения не мутируется.
- Сначала пробуются бесплатный лимит и Turbo-кредиты. Пополнение требует отдельного согласия, связано с расчётом/сетью/адресом/хешем, ограничено 0.01 SOL на хранение; комиссия сети отдельно.
- IndexedDB хранит подписанный шифротекст и ссылку на начатый платёж. Повтор отправляет те же байты, сверяет прежний платёж и не создаёт новый автоматически. Есть блокировка параллельных вкладок и возобновление прежнего снимка после перезагрузки.
- Импорт квитанции выбирает фиксированный шлюз нужной сети, ограничивает объём ответа и сверяет SHA-256/Vault-Id до расшифровки. Для восстановления кошелёк не нужен. Сохраняются все деревья, связи и история; testnet ID не становится mainnet-родителем.
- Пройдены веб-тесты, 46 проверок sponsor, TypeScript и production-сборка. Включены 20 сценариев сбоев загрузки/оплаты, реальные криптографические подписи с подставными ответами сервисов, тесты квитанций и обоих контрактов адаптера. Остаются 6 прежних lint-предупреждений и предупреждение `vm-browserify` о eval.
- Три реальные загрузки через одноразовый **программный**, не браузерный кошелёк, прошли в тестовом Turbo. Цена принятия — 0 winc; **переводов SOL не было**. Шлюз вернул архив, хеш совпал, восстановились два дерева со связями/историей.
- Повторный реальный POST тех же подписанных данных вернул тот же ID без новой подписи: `Hr2I-wT0ONvPbmPHZDs3EpoDIrkcBdSpUYuPxxu_p7w`.
- Квитанция другого прогона `_EbfgIBmLRveXVCFwNmsKj2ftw0bJKZoqQE82ahf8S0` восстановила синтетические данные через интерфейс на чистом origin и в production-сборке; ошибок консоли в production-прогоне нет. Проверен размер 390 px. Эти testnet-данные временные: при истечении срока создайте новый синтетический архив, не платите за повтор восстановления.

**Ещё не проверено:** настоящее расширение Phantom/Solflare, фактический перевод devnet SOL и его сверка после обрыва ответа; основная сеть; финальная запись в Arweave; Safari/iOS/Android. Не выдавай программный подписант за проверку расширения, а квитанцию — за подтверждение вечного хранения.

## Подготовка локальной копии

Если нужна отдельная чистая копия, в выбранной папке на другом Mac:

```sh
git clone --branch feat/solana-preservation https://github.com/azovskaya/sejire_arvewe_solana.git sejire-solana-test
cd sejire-solana-test
codex
```

Если папка уже существует, не удаляй её и не клонируй поверх. Сначала `git status`; при чистом дереве получи удалённые изменения, проверь ветку и обнови её только fast-forward. При расхождении истории или незакоммиченных правках согласуй сохранение, а не перезапись.

Используй актуальный Node 22.x (не ниже 22.12) или совместимый более новый Node. Из корня репозитория:

```sh
node --version
npm --version
npm ci --prefix apps/web
npm ci --prefix apps/sponsor
npm run solana:check
npm run solana:dev
```

`solana:check` выполняет все offline-тесты, TypeScript sponsor, lint и devnet-сборку; ничего не загружает в сеть и не оплачивает. `solana:dev` явно задаёт Solana/devnet, отключает QA-кассу и слушает только `127.0.0.1:5173`. Не перезаписывай существующий `.env.local`: переменные в команде задают нужный режим. Если порт занят, выясни, каким процессом, либо выбери другой; не завершай чужой процесс вслепую. Открой напечатанный локальный URL **на этом же Mac в Chrome с установленным расширением**, а не во встроенном браузере другого компьютера. Терминал с сервером должен оставаться запущенным.

Используй [чек-лист настоящего кошелька](SOLANA_WALLET_ACCEPTANCE.md) для записи результата. [Свежий отчёт](verification/2026-09-29-solana-report.md), [публичное доказательство тестовой загрузки](verification/2026-09-29-devnet-evidence.json) и [аудит зависимостей](verification/2026-09-29-web-production-audit.json) теперь входят в репозиторий; локальные папки другого Mac для них не нужны.

`npm ci` под npm 10 требует дополнительной записи optional peer `@solana/web3.js/node_modules/typescript@5.9.3`. Она намеренно сохранена в lock-файле, даже если npm 11 удаляет её при install; перед отправкой изменений проверяй чистую установку для CI на Node 22/npm 10.

## Следующий проверочный прогон

1. Создай только вымышленные семейные данные со связью родитель—ребёнок. Сохрани слова **SEJIRE** у владельца отдельно от зашифрованного файла. Это не слова кошелька. Не записывай их в публичный отчёт, Git, чат или скриншоты.
2. Подключи установленный кошелёк, убедись в правильном адресе и режиме devnet. Сначала откажи в подписи: данные и скачивание копии должны остаться доступны. Проверь смену аккаунта до завершения подписи.
3. Оставь пополнение выключенным. Подпиши архив в расширении, дождись принятия Turbo, скачай квитанцию и шифрованную копию. Нажми проверку скачивания. Если сервис требует пополнения, не обходи лимит и не переключайся на mainnet.
4. В отдельном профиле/браузере без кеша архива импортируй квитанцию и слова SEJIRE, не подключая кошелёк. Проверь данные, связи, историю и другие деревья. Отдельно восстанови скачанный зашифрованный файл без сети. Не очищай пользовательское хранилище ради теста.
5. Проверь повтор и возобновление того же снимка после перезагрузки: должен сохраняться data-item ID, а дополнительный платёж не должен возникать. Учти, что возобновлённый снимок не включает более поздние правки редактора.
6. Платный devnet-путь — отдельный прогон с явным согласием владельца на показанный предел и комиссию. Нужны тестовые SOL; не покупай SOL, не проси реальные средства, не обходи ограничения faucet. Не исчерпывай бесплатную квоту массовыми загрузками ради теста. Проверь сумму/получателя и сохранённую подпись перевода; после обрыва ответа сверяй тот же платёж. Если бесплатный лимит не позволяет естественно проверить оплату, честно оставь этот пункт непроверенным.
7. Если второго расширения нет, зафиксируй проверенное первое; не отмечай оба как проверенные и не устанавливай дополнительное без согласования.

Если CLI не имеет управления Chrome, это не блокирует ручной прогон: дай владельцу по одному шагу, попроси только безопасный текст ошибки/публичную квитанцию и сверяй результат по приложению и тестам. Не заявляй, что нажал кнопку расширения, без наблюдаемого результата.

Для повторения автоматических проверок:

```sh
npm run test:solana --prefix apps/web
# Опционально: живая тестовая сеть, только синтетические данные, переводы SOL запрещены адаптером:
SEJIRE_LIVE_DEVNET=1 npm run test:solana:live --prefix apps/web
```

## Карта кода и ожидаемый результат

- `apps/web/src/lib/solana/client.ts`: подключение провайдера и расчёт.
- `apps/web/src/lib/solana/upload.ts`, `journal.ts`: подпись, отправка, журнал и сверка оплаты.
- `apps/web/src/lib/solana/receipt.ts`: импорт, шлюз, лимит и хеш квитанции.
- `apps/web/src/components/SolanaPublishPanel.tsx`: согласия, этапы, повтор и проверка скачивания.
- `apps/web/src/components/RestoreSeed.tsx`, `apps/web/src/lib/crypto/backup.ts`: восстановление файла/квитанции/слов.
- `apps/web/src/lib/solana/*.selftest.ts`, `devnet.e2e.ts`: регрессионные и opt-in сетевые проверки.
- `docs/HACKATHON_2026.md`: глобальный Crypto World's Fair и Kazakhstan sidetrack; дедлайны/пригодность команды перепроверить перед подачей. Заявки ещё не отправлялись.

По завершении обнови `SOLANA_PRESERVATION.md` и этот файл: дата, ОС/Chrome/версия расширения, сеть, что фактически проверено, бесплатная или оплаченная загрузка, публичный data-item ID и при наличии ссылка на devnet-транзакцию, результат восстановления, оставшиеся ограничения. Не публикуй личные семейные сведения, ключи, cookies или секретные фразы. Не называй приём сервисом окончательной записью в Arweave.

Перед новой сменой компьютера сохраняй код **и этот контекст** в Git; отдельно сообщай владельцу, сделан ли push. История чата, локальное браузерное хранилище и запущенный сервер через Git не переносятся. Прежние JSON-отчёты вне репозитория не нужны для продолжения: результаты выше, новые доказательства создаются новым безопасным прогоном.

## Дополнительная проверка перед переходом, 29 сентября

Проверена неизменённая версия `4725b1e`. GitHub Actions run `36564863944` завершился успешно: чистые установки web/sponsor, тесты и production devnet-сборка на Ubuntu/Node 22. Локально повторно прошли все тесты, TypeScript sponsor, сборка, линтер (6 прежних предупреждений) и ещё пять прогонов Solana-набора.

Свежая бесплатная загрузка `PnLfyAI2gfLB_S8DYcHY8hslLJuTDMVVwLJUWQQP6X4` прошла с одноразовым программным подписантом: одна подпись сообщения, ноль переводов SOL, повторный POST вернул тот же ID. Шлюз/хеш/расшифровка восстановили два дерева и историю. В production-интерфейсе свежего origin восстановлена квитанция после исправления неверных слов. Реально скачанный зашифрованный файл проверен, затем импортирован на другом origin вместе с отдельным файлом публичных тестовых слов; после перезагрузки древо сохранилось. JSON-экспорт и одностраничный PDF тоже проверены; PDF отрендерен и просмотрен.

Дополнительные локальные проверки: 10 000 расчётов SOL/lamports, Unicode/AES-GCM и повреждение шифротекста, HTTP-ошибки/отмена, игнорирование внешних URL в квитанции, 50 записей искусственного IndexedDB с разделением сетей. Это не проверка настоящего расширения или реальной межвкладочной гонки Chrome.

Перед доработкой учесть: на ширине 390 px «Вместить» обрезает левую карточку на 11.8 px из-за минимального масштаба 0.55 (`pedigreeFit.ts`). После импорта файла слов подсказка говорит «Открыть», хотя кнопка — «Восстановить архив». Обратный UI-импорт JSON не завершён: управление встроенным браузером зависло на выборе файла; в коде импорт требует `window.confirm`. Повторить подтверждение/отмену в Chrome вручную, не считать это доказанным дефектом самого импортера. Production-only аудит web: 0 critical / 8 high / 6 moderate / 10 low; sponsor: 0. Зависимости не менялись.

Настоящий кошелёк и платный devnet-путь всё ещё требуют владельца. В последующий пакет передачи включены эта запись, подробный отчёт и публичные доказательства из `docs/verification/`. Дополнительные проверки перенесены в `apps/web/src/lib/solana/boundaries.selftest.ts` и включены в `npm test`/CI; они не зависят от личных файлов, живого шлюза или пути к прежнему Mac. Найденные UI-ограничения пока не исправлены.


### Продолжение 6 октября 2026: сообщения чтения истории

Read-only ошибки истории кошельков отделены от неопределённых подписей и платежей. `rpc-timeout` (и вариант с подчёркиванием) показывает «Сеть не ответила вовремя. Попробуйте ещё раз.»; полученный баланс остаётся доступен. Payment/signing предупреждения не ослаблены. Сохранены предшествующие локальные проверки сети перед successor и диагностика подготовки без подключения кошелька. Локальный browser-запуск остановился до тестов: Playwright отсутствует; браузерные доказательства нужно брать из окончательного Ubuntu CI. Реальные SOL/AR операции не выполнялись.

### 6 октября 2026: exact configuration / несколько вкладок

Прежний `trustChain()` воспроизведён офлайн: stale in-memory v3 перезаписывал persistent v4 обратно в v3. Исправление сериализует вкладки через Web Locks, перечитывает persistent trusted-session и атомарно сохраняет согласованные chain/trusted-session/подписанную историю. Более короткий префикс принимает новую версию, fork отклоняется. Историческая настройка заказа восстанавливается только из криптографически проверенной цепочки с тем же ранее закреплённым корнем; hash/подписанные условия заказа не меняются.

Локально обнаружен только экспорт исходного 9bb9… с configHash b4808c6a54d8e19d1744df1c902f5a443a2ee5fbf61cd49599e177befb723c9d и версиями 1–3. Реального экспорта 8a035… нет: его hash, признаки оплаты и итог restored/orphaned нельзя утверждать из этого рабочего окружения. В браузере владельца стадия successor_restore сохраняет безопасное сравнение точного hash и подписанных версий, признаки payment state и ID проверяемого заказа, без архива и секретов.

Если точная конфигурация не найдена, только DEVNET-подготовка без каких-либо признаков начала подписи/оплаты допускает одну явно согласованную связанную замену. Прежние записи остаются неизменными; подготовка, которую заменили, не может снова подготовить/подписать платёж. Неизвестная исходная оплата не объявляется отсутствующей. Никаких реальных переводов, подписей владельца или AR-публикаций при разработке не выполнялось. Browser regressions выполняются в Ubuntu CI; локально native selftests и TypeScript.

Browser regression также выявил, что stale authorize мог затереть единственную восстанавливаемую signed chain в `chain`: теперь этот cache криптографически проверяется с закреплённым корнем до перезаписи. Возврат к прежнему URL после replaceState должен инициировать новое чтение выбранной попытки, даже если React помнит тот же старый route key. Исправления проверяются полным CI перед Pages.
