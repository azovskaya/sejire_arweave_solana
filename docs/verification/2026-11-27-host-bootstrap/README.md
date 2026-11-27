# SEJIRE: подготовка первого запуска сервера, 27 ноября 2026

**Принятый код и статический CI-пакет сохранены. Операторский комплект подготовлен и проверен. Production ещё не развёрнут.** Этот отчёт относится к следующему этапу после [принятия полного CI](../2026-11-27-publication-completion/README.md); он не заменяет его и не повторяет проверки без причины.

## Сделано

- Через подключённый хостинг повторно прочитаны тариф, использование и список адресов: Free, 2/5 apps, 352/512 MiB резервирования, sleep 30 минут; SEJIRE app отсутствует. Другие приложения не менялись.
- На GitHub создана отдельная ветка `release/sejire-api-ef025202`, head `ef0252025c32687dce018368ea94d74af2728c66`. Повторное чтение подтвердило точный SHA. Это не branch protection; перед deployment требуется повторная проверка. Принятая feature branch не менялась.
- Подготовлены точные deployment arguments, только публичное закрытое окружение, host-specific порядок проверки и отдельный probe: [deployment/blitz](../../../deployment/blitz/README.md).
- Новый probe прошёл **6/6 тестов, 0 failed, 0 skipped**, включая 8 HTTP-проверок собранного принятого runtime на синтетической пустой SQLite. Исходящий `fetch` сервера был заменён отказом; внешних запросов в этой проверке не наблюдалось. Это не OS network isolation и не real-wallet тест.
- Независимое ревью обнаружило два несовпадения инструкции и инструмента: обязательный CLI `--expected-commit` и строку scope. Оба исправлены; runtime и ранее принятый пакет не менялись.
- Панель Blitz открыта для проверки отсутствующих в connector настроек. Она показывает обычный экран входа; авторизованная сессия ещё не получена. Защищённый запрос на вход завершился `declined`; авторизация не подтверждена, credentials не получены. Повторный запрос не выполнялся. Страница сохранена для продолжения по инициативе владельца.

## Важные выводы для запуска

**Нужен always-on.** Free подходит только для пустой проверки хоста. В опубликованных 26 ноября тарифах один Pro app стоит €3/месяц за 512 MB или €5/месяц за 1 GB; весь аккаунт Pro — €9/месяц. Подписка не оформлена, минимальный размер ещё не проверен под нагрузкой. Nightly off-host files для отдельного Pro app не считаются подтверждёнными по документации аккаунтного Pro.

**Три механизма автоматических изменений проверяются отдельно.** `Only use my Dockerfile`, `Deploy every push` и сборка на собственных GitHub Actions не входят в текущую схему подключённого deploy tool. `autoUpdate:false` не закрывает все три условия. Документы расходятся по Free build default, поэтому нужен просмотр фактической панели. Автоматический workflow commit не должен менять принятый source.

**Стандартный rolling deploy ещё не принят для SQLite executor.** При общей базе второй writer должен отказать; при копиях volume локальная блокировка не исключает двух исполнителей. Нужен конкретный host-level тест stop-before-start, persistent storage и завершения процесса до подключения старого состояния и signer. Также остаются неизвестными доверенные ingress CIDR/forwarded-header contract.

**Выключенные admissions не останавливают старые операции.** Paid runner может продолжить сохранённые signed SOL bytes до проверки AR execution flag; promo alarms также продолжают принятые задания. Импортированный ledger остаётся за review marker до завершения остановки источника и сверки. История и unresolved archive не удаляются и не заменяются новым платежом.

## Что ещё не выполнено

| Этап | Статус |
|---|---|
| Код, полный CI 45984285862 и точный static ZIP | Ранее PASS, source не менялся |
| Отдельная API deployment branch | Создана и проверена |
| Operator pack и synthetic probe tests | PASS |
| Настройки в авторизованной панели, реальное создание app | Требуется вход владельца; NOT RUN |
| Always-on и host-level storage/lock/ingress/restore | NOT RUN |
| Private legacy export/import и secret handoff | NOT RUN |
| Authenticated production preflight и real-wallet SOL/promo | NOT RUN |
| Permanent upload, manifest verification, ArNS `@` change | NOT RUN |

Первый следующий шаг — войти в **существующий аккаунт Blitz**, чтобы проверить фактические параметры сборки и подготовить пустой сервер. Затем выбирается подходящий always-on и проверяются свойства хоста. Кошелёк и `console.ar.io/domains/sejire` нужны после этих шагов. Восстановительные слова, JWK, admin token и private backups не передаются в чат.

## Доказательства и воспроизведение

- [summary.json](summary.json): scope, исходник, host observations, тесты, ограничения и hashes пяти файлов operator pack.
- [probe-tests.log](probe-tests.log): фактический локальный результат 6/6.
- [План с точными аргументами](../../../deployment/blitz/release-plan.json).

Тест воспроизводится на Node 24 из operator checkout, с заранее собранным **тем же принятым** source:

```bash
SEJIRE_BOOTSTRAP_TEST_BUNDLE=/absolute/path/to/accepted-source/apps/sponsor/build/server.mjs \
  node --test deployment/blitz/verify-closed-bootstrap.test.mjs
```

Без `SEJIRE_BOOTSTRAP_TEST_BUNDLE` интеграционный сценарий честно пропускается. Такой результат не равен записанным здесь 6/6 без skips. Новая локальная сборка не подменяет принятый GitHub artifact.

Официальные источники, сверенные в этом проходе: [pricing](https://blitz.cloud/pricing/), [GitHub deployment](https://blitz.cloud/docs/deploy-from-github/), [limits](https://blitz.cloud/docs/limits/), [persistent files](https://blitz.cloud/docs/settings-and-files/), [backups](https://blitz.cloud/docs/backups/), [HTTPS/errors](https://blitz.cloud/docs/addresses-and-https/). Эти документы описывают платформу; фактическая приёмка конкретного SEJIRE instance остаётся отдельным действием.
