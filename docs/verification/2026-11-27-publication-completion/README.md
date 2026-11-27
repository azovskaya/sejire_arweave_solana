# Итоговая приёмка кода и CI-пакета — 27 ноября 2026

**Код и оригинальный статический ZIP проверены. Production-переход пока NO_GO.**

- Source: `ef0252025c32687dce018368ea94d74af2728c66`.
- Ветка: `feat/funded-portable-release-20261125`.
- Tree: `1bf283fa8fd157348cf7bb4cf67e49c0f93e5cbb`.
- Локальный эквивалент: `92ebed7bd7f0455a2c72296b8271fccaa1f0f4b3`.
- [CI 45984285862](https://github.com/azovskaya/sejire_arweave_solana/actions/runs/45984285862), attempt 1, verify job 140455799472: **SUCCESS**. 83 successful steps; один разрешённый skip — только failure diagnostics.
- Финальный CI завершён 27 ноября в 15:59:40 Asia/Almaty. Квитанция проверки пакета создана в 16:00:22.

Полный порядок production-перехода и данные владельца — [в инструкции](../2026-11-27-publication-plan-and-readiness.md). Структурированный итог — [summary.json](summary.json).

## Проверенный пакет

[Artifact 15190448748](https://github.com/azovskaya/sejire_arweave_solana/actions/runs/45984285862/artifacts/15190448748), имя `permaweb-portable-funded-release`.

| Параметр | Значение |
|---|---|
| Исходный ZIP | 1 684 182 байта |
| SHA-256 ZIP | `c7e351591f5df3677b81ed5aba1aa7baa44c76706c00f56bf14af4e4d800efcf` |
| Все файлы | 43 / 4 395 526 байт |
| Payload manifest | 42 файла / 4 390 757 байт |
| Manifest SHA-256 | `68e2e8ea064b61bcaf7ac902cfdd6247e1b19c5370b8cb25d9fc9f69274c47b0` |
| Профиль | `portable-funded-mainnet` |
| JavaScript / modules / recovery | 13 / 736 / 8 |
| API origin | `https://sejire-api.azovskaya.prod.page` — пока планируемый |
| GitHub artifact retention | До 11 декабря 2026; перед публикацией нужна актуальная проверка доступности evidence |

Прямо проверены полный список metadata, единственность артефакта, head SHA, run/attempt, окно времени создания, размер и digest ZIP, безопасный состав архива, hashes каждого файла, profile, весь JS boundary, относительные assets, одинаковые index/fallback и автономный recovery kit. Штатные `validateReleaseEvidence`, `acceptedArtifact`, `extractAcceptedZip`, `verifyRelease` и `verifyPortableFundedBuild` прошли.

[package-check.json](ci/package-check.json) содержит все 43 hashes. [accepted-build.json](ci/accepted-build.json) содержит пересчитанный provenance. В оригинальный CI ZIP не добавлялся `build-provenance.json`: квитанция приёмки хранится отдельно. Manual workflow при подготовке accepted directory добавляет собственную проверенную квитанцию.

Независимое read-only review дополнительно сверило байты ZIP, каждый manifest hash, извлечённую папку и пересчитанный provenance; дефектов не выявлено. `mandatorySejireService=true`: этот профиль требует работающий API. `mandatoryCloudflare=false` не означает отсутствие backend.

## Тесты

[Машинные счётчики](test-results.json): **373 успешных Playwright исполнения в 15 наборах**, без отказов. Это число исполнений: один и тот же сценарий может выполняться в разных браузерах или отдельном regression-прогоне.

| Набор | PASS |
|---|---:|
| Independent static | 78 |
| Portable funded static | 33 |
| Editor safety | 24 |
| Checkout / protocol | 5 + 5 |
| Legacy funded static | 9 |
| Wallet history regression / native admin / native pilot | 1 + 21 + 3 |
| V2 / server admin / V2 recovery | 15 + 21 + 35 |
| Promo / paid SOL | 27 + 48 |
| Native journey | 48 |

Дополнительно standalone recovery прошёл в Chromium, Firefox и WebKit при проверенной изоляции сети на уровне ОС: [log excerpt](offline-recovery-ci-excerpt.log). Node suite содержит четыре проверки, включая проверку самой изоляции; эти исполнения не подмешаны в число 373.

[PDF evidence](pdf-ci-excerpt.log): **89 файлов, 779 страниц, 89 PASS, findings {}**. Полный CI также выполнил Node/unit, TypeScript, SQL/API/protocol, Linux writer, migration/import, online backup/restore, production Docker с persistent SQLite и выключенным приёмом новых операций. Read-only native API/CORS, recovery gateways и public SOL read diagnostic прошли в условиях этого прогона.

Синтетические платежи и программные подписанты не являются реальной приёмкой Phantom/Solflare, production RPC, казны и платного хранения. Физические iOS/Android in-app wallets и ёмкость будущего production-хоста этим не сертифицируются.

## Последние исправления

1. Production-аудиты web и sponsor стали блокировать high/critical и ошибки исполнения в CI. `pipefail` сохраняет отказ npm при выводе через `tee`; все JSON-отчёты сохраняются также после отказов.
2. Ручная публикация заново проверяет production-зависимости обоих пакетов.
3. Docker production dependencies проходят audit; операторская команда использует `--pull --no-cache`.
4. V2 diagnostics test приведён к существующей серверной авторизации: старый публичный lock fixture заменён серверным mock; role=tab, проверены неверный пароль, Bearer-вход и logout. Runtime авторизации не ослаблен.

Первые три пункта — четыре файла commit `081995ce29f8cfca825861102ed3abb63f944d19`; четвёртый — один тестовый файл в окончательном source `ef025202…`. Package manifests, lockfiles и продуктовая логика в этом последнем проходе не менялись. Предыдущие runtime-исправления уже входят в source и прошли этот общий CI.

Baseline `ba6777ac…` attempt 3 прошёл живую native сеть, но упал на устаревшем V2 test setup. Его metadata и error context сохранены как история; его ZIP не принимался. Ранние сетевые failures и диагностические 155 исполнения от 25 ноября остаются [в прежнем evidence](../2026-11-25-publication-completion/final/README.md).

## Зависимости

| Scope | Low | Moderate | High | Critical |
|---|---:|---:|---:|---:|
| Web production | 13 | 10 | 0 | 0 |
| Sponsor production | 13 | 1 | 0 | 0 |
| Web full | 18 | 11 | 0 | 0 |
| Sponsor full | 13 | 1 | 3 | 0 |

[Четыре полных JSON-отчёта и summary](dependency-audits/summary.json) извлечены из artifact 15190874906 с проверкой ZIP digest. Sponsor dev/test findings относятся к Miniflare/sharp/undici; production Docker устанавливает зависимости с `--omit=dev`. Автоматический downgrade Miniflare не выполнялся. Это не полный audit всех сторонних исходников или пакетов ОС.

## Старое архивное обязательство

[Readback 27 ноября](historical-readback/result.json): `AtwLYx509C9jWIFKUNg7dy1GSgiaDbXVK1YEQbBWfHY` имеет status/header HTTP 200, но raw на arweave.net и turbo-gateway.com вернули 404. Ожидаемые 25269 байт и SHA-256 `96bb194c3fbcf1dfea7e738cf91d758b8cfdaabb5be934df8dacd96a65c7be85` не подтверждены; итог **UNRESOLVED**.

[Diagnostic run 45985281069](https://github.com/azovskaya/sejire_arweave_solana/actions/runs/45985281069) успешен только как выполнение четырёх ограниченных GET. Его green status не является успешным восстановлением архива и не заменяет release CI. Два raw 404 не доказывают отсутствие данных во всей сети. Сохранить исходные ciphertext, signed bytes, receipt и журнал; нового платежа или нового архива взамен не создавать.

## Что остаётся для production

Фактический always-on Linux host/HTTPS/persistent disk/ingress; согласованный перенос частного старого ledger и остальных legacy journals; один исполнитель; защищённые настройки владельца, получатели и AR-фонд; off-host backup и пробное восстановление; реальные SOL/promo save → raw bytes/hash → clean-browser/offline recovery; проверка actual ArNS Owner/Controller, старого Target/TTL, согласование upload quote и проверка нового публичного manifest.

Ни один из этих фактов не выведен из green CI. На момент отчёта SEJIRE app отсутствует в подключённом хостинге, аккаунт Free; точный API origin ещё не развёрнут/не зарезервирован.

Регистрационный [draft PR 12](https://github.com/azovskaya/sejire_arweave_solana/pull/12), head `f996e3b8d30a3f91a2d8704d94f3eb62cdfaf73c`, открыт и не слит. Его [отдельный CI](https://github.com/azovskaya/sejire_arweave_solana/actions/runs/45984027932) также успешен. Main остался `897559c197bc90ae9fac66abaefe000df2a2b51c`.

## Повторение offline-проверки

Из корня repository checkout с этим evidence и проверенным source:

```bash
node docs/verification/2026-11-27-publication-completion/verify-ci-package.mjs \
  docs/verification/2026-11-27-publication-completion/ci \
  /path/to/sejire-portable-ef025202-ci.zip \
  /new/path/verified-release
```

Output directory должен ещё не существовать. Helper читает сохранённые GitHub metadata и исходный ZIP, выполняет штатные validators, извлекает новую папку и печатает JSON в stdout. Он не перезаписывает сохранённые квитанции. Это проверка записанного evidence; актуальность head/CI/artifact перед upload проверяется новым обращением manual workflow к GitHub.

В этом проходе выполнены source/docs commits, CI и read-only проверки. Production deployment, permanent upload, ArNS Target change, реальные траты и использование кошелька владельца не выполнялись. Wallet recovery words и private keys не запрашивались и не читались.

