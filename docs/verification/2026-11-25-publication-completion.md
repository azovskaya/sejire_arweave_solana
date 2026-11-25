# SEJIRE: завершение переносимого релиза SOL + промокод

Дата: **25 ноября 2026**, время пользователя Asia/Almaty. Source-кандидат: `feat/funded-portable-release-20261125`, поверх проверенного code-audit и сохранённого evidence предыдущего этапа.

**Эта версия документа сопровождает исходники до окончательного CI.** Итоговый SHA, результаты браузеров/контейнера и артефакт сохраняются отдельным финальным evidence, чтобы после приёмки не менять source head. Существующий сайт, ArNS Target и реальные средства этим документом не изменяются.

## Завершённые изменения

| Область | Что изменено и почему |
|---|---|
| Публичный пакет | Отдельный `portable-funded-mainnet`: новые предложения только Mainnet, 0.03 SOL, промокод, серверная админка, recovery kit. Точный HTTPS API origin, финальные hashes всех JS, отсутствие обязательных Workers/bundler imports, публичного admin verifier и тестовых драйверов. |
| Публикация | Отдельные artifact/branch/manual workflow. Проверяются exact source SHA, полный успешный CI attempt, digest ZIP, все файлы и manifest. Старый independent контракт сохранён. Upload требует свежего API preflight и owner acceptance; ArNS обновляется отдельно. |
| Сервер | Переносимый Node/Linux сервис, SQLite на постоянном диске, один kernel-protected writer, доверенный ingress, минимальный healthcheck, Docker с выключенными денежными admissions по умолчанию. |
| Продолжение | Durable очередь промокодных jobs и общий alarm runner. Начатые обязательства продолжаются без открытой вкладки; подписанные байты повторно отправляются без новой подписи или списания. |
| Админка | `/#/admin` и `/#/fund-admin` используют серверную авторизацию. Пароль только в памяти. Paid ledger отделяет Mainnet/Devnet и сервисную плату/добровольную помощь. Mutations проверяются readback, поздние ответы после logout недействительны. |
| Пополнение AR | Intent до перевода, будущий nonce в подписи, проверка native TX/адреса/суммы/включения двумя nodes, unique TX + CAS revision. Wander owner flow показывает сумму и комиссию, сохраняет единственную подпись локально и на сервере; retry и другой браузер продолжают тот же TX. |
| Черновик | Одна редактирующая вкладка через Web Locks; явная передача доступа; проверка исходных bytes и lifetime token; raw input сохраняется синхронно. При quota/конфликте остаётся локальная копия для экспорта. |
| Резервные копии | Согласованный online WAL snapshot, quick_check/SHA-256, частные права, retention. Restore только в новый путь, общий writer guard и fsync ordering. Старый snapshot не запускается до явной сверки обязательств. |
| Миграция | Полный private ledger snapshot, отдельно ожидаемый digest, allowlist/schema/count/hash/rowid/sequence checks и exact readback. Import только в новую DB, без сети и запуска executor, с блокирующим review marker. Quiescence источника остаётся обязательством оператора. |

Инструкция с конкретными файлами, переменными, командами и последующим переключением существующего имени: [deployment/README.md](../../deployment/README.md).

## Независимая повторная проверка

Три области проверялись параллельно и затем перекрёстно: backend/денежные инварианты; админка/кошелёк; черновики/release/backup. Обнаружены и исправлены дополнительные случаи:

1. Старый входящий перевод мог выглядеть новым при несовпадающем cache balance/head. Теперь обязательный непредсказуемый intent tag создаётся только после baseline.
2. Startup мог продолжить работу после устаревшего ENOENT review marker, пока restore публиковал старую DB. Restore/startup/ack теперь используют общий kernel guard; внутри него повторно проверяется marker до DB init/alarm. Добавлен детерминированный regression.
3. Readiness принимал gross balance и небольшую quote за доступное финансирование. Теперь проверяется quote для полного лимита архива и effective availability после всех shared holds/ceiling.

Отчёты и пофайловые SHA:

- [Независимый review release, backup и migration](2026-11-25-publication-completion/review/root-scripts-review.md)
- [Админка и защищённое пополнение](2026-11-25-publication-completion/admin/review.md)
- [Backend review](2026-11-25-publication-completion/backend/review.md)
- [Draft ownership evidence](2026-11-25-code-audit/frontend/draft-ownership/README.md)
- [Инструкция миграции](2026-11-25-publication-completion/backend/legacy-migration.md)

## Что является и не является результатом проверки

Локально пройдены 27 web unit groups, root release/backup/preflight regression, compiled-service restart, TypeScript и статическая portable сборка. Отдельные backend и admin доказательства находятся рядом с отчётами. Браузерная collection не означает фактический запуск. Окончательный общий CI, Docker image и браузерные выполнения необходимо прочитать по точному source commit; до их завершения нельзя писать «финальный CI PASS».

Синтетические тесты используют реальные криптографические проверки с временными программными ключами и подменённой сетью. Они не заменяют настоящий Phantom/Solflare/Wander extension roundtrip, постоянный production-хост, перенос реальной базы или окончательную доступность данных в Arweave. Ключи владельца, `.env`, реальные семейные архивы и средства не читались и не использовались.

## Оставшиеся production prerequisites

- Выбранный постоянно работающий хост, HTTPS, постоянный `/data`, проверенный ingress/CORS и отдельная защищённая off-host backup с пробным restore.
- Внесённые владельцем секреты и проверенные публичные адреса/бюджеты; серверный read-only preflight успешен для exact deployed source.
- Частный согласованный source export, проверенная миграция всех старых обязательств и single-executor handoff. Публичные admin summaries для этого недостаточны.
- Два реальных сохранения синтетической семьи: SOL Mainnet и промокод, с проверкой raw bytes/digest/receipt/restore; смена промокода и продолжение ранее принятого заказа.
- Подтверждённый Owner/Controller существующего имени, сохранённый прежний `@` Target/TTL, принятый upload quote, проверенный новый manifest и только затем смена Target.

До этих фактов **сайт с работающими оплатами и промокодом нельзя объявить готовым к production-переключению**. Зелёный build не закрывает перечисленные внешние условия и не даёт гарантии безотказности всех gateway/RPC/кошельков.
