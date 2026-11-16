# Sejire — фактический выпуск и приёмка 16.11.2026

## Итог

Исправления приложения опубликованы в основной GitHub Pages и production Worker. Выпущенный исходный commit: **8b07f9f5a3dae939f7d519f4e3c65ac9d49dfa09**, ветка **feat/promo-funded-preservation**. Полный CI и отдельные проверки выпуска прошли.

**Готовность платного пилота остаётся неподтверждённой:** после выпуска прежний оплаченный архив AtwLYx509C9jWIFKUNg7dy1GSgiaDbXVK1YEQbBWfHY всё ещё не отдаёт данные на проверенных путях. Новая SOL-оплата и замена архива не выполнялись. Следующий необходимый шаг — посмотреть/продолжить тот же заказ из прежнего браузера владельца и получить безопасный статус. Настоящие слова восстановления вводит только владелец в интерфейсе Sejire.

Эта запись сохраняется отдельно в docs/pilot-release-evidence-20261116, чтобы не изменять точный принятый SHA production-ветки после её выпуска. Прежние рабочие каталоги, история и локальные незакоммиченные работы сохранены.

## Что изменено

- Включён подготовленный пакет 15 ноября: передача всех подписанных Arweave chunks, в том числе одного короткого чанка; запасной путь чтения с проверкой размера и SHA-256; обнаружение прежнего paid-заказа при смене локального tree ID; актуальный снимок редактора перед сохранением/экспортом и безопасный undo; статический ArNS-клиент со встроенным адресом Worker.
- Ошибка досылки прежних подписанных данных сохраняет безопасный код storage_data_replay_unavailable. Ошибки целостности имеют приоритет; успешная проверка очищает ошибку. Тело ответа провайдера и ciphertext не попадают в диагностику.
- При ошибке чтения payload после захвата lease сервер освобождает собственный lease, сохраняет обязательство по оплаченному заказу и использует прежний backoff. Два SQLite-регрессионных теста воспроизвели ошибки и прошли после исправления.
- Закрыты high/critical findings в выпущенных production-зависимостях: node-forge 1.4.3, DOMPurify 3.4.18, follow-redirects 1.16.3; bigint-buffer заменён точным override на @vekexasia/bigint-buffer2 1.1.1. Turbo 2.1.0 и Solana web3.js 1.99.0 сохранены; добавлены 98 проверок фактически используемых SPL-преобразований чисел.
- В полный CI добавлена проверка готовой статической ArNS-сборки и её браузерного промо-сценария.
- Исправлена совместимость lockfile с Node 22.23.4 / npm 10.9.9: штатным npm восстановлена одна optional peer запись TypeScript 5.9.3. Холодная установка и последующий полный CI прошли.

[Протокол подготовки и подробности изменений](2026-11-16-pilot-release.md).

## Доказательства выпуска

| Проверка / выпуск | Источник | Результат |
|---|---|---|
| Полный SEJIRE checks | [43854395821](https://github.com/azovskaya/sejire_arweave_solana/actions/runs/43854395821), attempt 1, push на 8b07f9f | SUCCESS |
| SOL recipient admin checks | [43854395870](https://github.com/azovskaya/sejire_arweave_solana/actions/runs/43854395870) | SUCCESS |
| Основной Pages | [43858205575](https://github.com/azovskaya/sejire_arweave_solana/actions/runs/43858205575), attempt 1 | SUCCESS, 11:30:52 UTC |
| Production Worker | [43859411113](https://github.com/azovskaya/sejire_arweave_solana/actions/runs/43859411113), attempt 1 | SUCCESS, 11:38:54 UTC; 20/20 steps |

Оба Worker release gate подтвердили точные branch HEAD, source SHA, CI run и attempt. Перед deploy повторно выполнен блокирующий production audit. Cloudflare Version ID: **378b587a-3402-4e76-9115-938e299d1876**.

[Публичный сайт](https://azovskaya.github.io/sejire_arweave_solana/) и [build-provenance.json](https://azovskaya.github.io/sejire_arweave_solana/build-provenance.json) отвечают HTTP 200. В provenance sourceCommit и publishedByCommit равны 8b07f9f5a3dae939f7d519f4e3c65ac9d49dfa09; accepted CI — 43854395821, artifact — native-admin-build, ID 14219388035. SHA-256 принятого ZIP: 7ef7e301c750cdfa1962ab98e02e7789bfed38a051e5b38b462ba8e6c42f46c6.

Публичный HTML и все 7 непосредственно подключённых JS/CSS assets отвечают 200 и совпали побайтово с accepted artifact. Реальный public HTTPS smoke прошёл в двух новых Chromium-контекстах 1280×900 и 390×844: главная, защищённая админка, отказ с заведомо неверным тестовым паролем, отдельная форма восстановления, корректные root assets. Пароль владельца не использовался. Это проверка viewport в Chromium, не отдельного физического телефона или Safari.

[Public evidence artifact 14221029587](https://github.com/azovskaya/sejire_arweave_solana/actions/runs/43858205575/artifacts/14221029587) содержит root-result.json: PASS, contexts=2, routes=/, #/admin, #/restore, ownerPasswordUsed=false, assetsFromRoot=true.

## Существенные тесты принятого приложения

| Набор | Прошло |
|---|---:|
| Editor safety | 7/7 |
| Checkout / protocol browser | 5/5 и 5/5 |
| Static ArNS browser | 2/2 |
| Native browser / pilot | 21/21 и 3/3 |
| Preservation V2 / admin browser | 15/15 и 14/14 |
| V2 recovery browser | 35/35 |
| Promo save/reload/editor | 25/25 |
| Paid SOL save/recovery/editor | 46/46 |
| Полный пользовательский маршрут | 48/48 |
| Paid SQLite | 35 |
| Direct workerd / paid API workerd | 8 и 26 |
| Release gate regressions | 53 |

Платёжные сценарии синтетические, с имитацией сети. Они не являются доказательством доставки старого личного архива или нового реального Mainnet-платежа.

## Зависимости

Свежий блокирующий audit в production Worker deploy использовал --omit=dev --audit-level=high и завершился успешно:

| Область | Low | Moderate | High | Critical |
|---|---:|---:|---:|---:|
| Web production выпущенной версии | 13 | 10 | 0 | 0 |
| Sponsor production выпущенной версии | 13 | 1 | 0 | 0 |

Low/moderate замечания остаются. Sponsor вместе с тестовыми инструментами имеет 3 high findings; полный dependency audit не объявляется чистым. Прежняя кодовая база main также содержит старые уязвимые зависимости; приложение из main не публиковалось.

## Исправление регистрации ручного Worker workflow

GitHub не показывал Run workflow: файл существовал в feature, но отсутствовал в default branch. [PR 9](https://github.com/azovskaya/sejire_arweave_solana/pull/9) добавил в main точную копию принятого Worker YAML, blob 2f6df4104f60525b5eba6d47a7e9bcc5c8cd06a0. Условие разрешает job только вручную из feat/promo-funded-preservation с DEPLOY; проверки CI и production audit сохранены.

CI PR выявил старый runner mismatch: ubuntu-latest выбрал Ubuntu 26.04, не поддерживаемую установленным Playwright. Единственная дополнительная правка — runs-on: ubuntu-24.04 в существующем main checks.yml. Все проверки сохранены. [CI 43857862992](https://github.com/azovskaya/sejire_arweave_solana/actions/runs/43857862992) прошёл на head 506fe0da0bb06006fb048b00afc42bc8d023cfa6; PR принят обычным merge **10f2bf53f4556099de2530586dbc09d037717bc8**. В main изменены только два workflow; приложение не переносилось. Release evidence приложения остаётся 43854395821, не CI старого main.

## Прежний оплаченный архив после выпуска

Однократная read-only проверка **16.11.2026, 11:40:18 UTC**, после успешного Worker deploy:

| Маршрут arweave.net для AtwLYx509C9jWIFKUNg7dy1GSgiaDbXVK1YEQbBWfHY | Результат |
|---|---|
| /tx/{id}/status | 200; block_height 2035774; 7675 подтверждений |
| /tx/{id}/offset | 200; size 25269; offset 392934894928811 |
| /raw/{id} | 404 |
| /{id} | 404 |

Есть подтверждённый заголовок, но байты на проверенных маршрутах недоступны. Это не доказывает безвозвратную утрату. Длина фактически загруженного ciphertext, его SHA-256 и восстановление исходного дерева по настоящим словам пока не подтверждены.

Нужен существующий авторизованный контекст заказа в прежнем браузере владельца: открыть Сохранить → Через Solana и использовать «Продолжить сохранение» или «Повторить проверку» для прежнего заказа. Содержимое payload, recovery words, wallet keys и bearer tokens нельзя запрашивать в чате или публиковать. Для дальнейшей диагностики достаточно безопасного кода/статуса из «Подробнее». Новый заказ, новая SOL-оплата или замена исходного архива не являются продолжением прежнего оплаченного обязательства.

ArNS-пакет подготовлен и проверен в CI (artifact permaweb-static-release 14219962870); загрузка сайта в Arweave и Target имени sejire не менялись. Переключение ArNS следует выполнять после завершения этой приёмки: browser journal прежнего origin автоматически на ar.io не переносится. Сам deploy и зелёный CI не заменяют проверку доставки архива и восстановления в чистом браузере владельца.
