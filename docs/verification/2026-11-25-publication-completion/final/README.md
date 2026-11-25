# Финальные доказательства: исходники подготовлены, публикация заблокирована

Дата: 25 ноября 2026, Asia/Almaty. Точный исходный кандидат `ba6777ac9c780627a6cdceafe947fed08ddaca63`, tree `79e4286c3217bc5b59abcfd2a76905b221b932be`. Код находится в `feat/funded-portable-release-20261125`; эта evidence-ветка не является source-веткой выпуска.

**Принятого полного CI и принятого portable GitHub artifact текущего кандидата нет.** Публикация в Arweave и смена ArNS Target не выполнялись и этим отчётом не разрешаются. Главный [план владельца](../../2026-11-25-publication-plan-and-readiness.md) описывает последовательность после устранения блокеров. Машинные факты — [summary.json](summary.json).

## Источник результатов

| Проверка | Где находится подтверждение | Фактический итог |
|---|---|---|
| Полный CI точного source | [run 45603078598](https://github.com/azovskaya/sejire_arweave_solana/actions/runs/45603078598), `ci-run.json`, `ci-attempt2-jobs.json` | Попытки 1 и 2 завершились failure на live native API readiness. До отказа Node/unit, typecheck, SQL/backup/restore/Docker и PDF прошли. Поздние шаги не выполнены. |
| Редактор и админка | [job 139176202845](https://github.com/azovskaya/sejire_arweave_solana/actions/runs/45605798546/job/139176202845), selected stdout | 24 + 21 PASS |
| Оплата, promo, recovery | [job 139176203136](https://github.com/azovskaya/sejire_arweave_solana/actions/runs/45605798546/job/139176203136), selected stdout | 48 + 27 + 35 PASS |
| Дополнительный native probe | [job 139176203035](https://github.com/azovskaya/sejire_arweave_solana/actions/runs/45605798546/job/139176203035), `native-network-diagnostic.json` | Тот же gate FAIL: 1/2 узлов, timeout/ECONNRESET. Порог и тайм-ауты не изменены. |
| Dependencies | [job 139176202572](https://github.com/azovskaya/sejire_arweave_solana/actions/runs/45605798546/job/139176202572), `dependency-audits/` | Production high/critical 0; low/moderate сохраняются. Full sponsor test tooling high3. |
| Локальная production-сборка | `local-candidate/` | Build + preparePermaweb + verifyRelease PASS, но LOCAL_CANDIDATE_NOT_ACCEPTED_FULL_CI |
| Старый operator tooling | [pinned source](https://github.com/azovskaya/sejire_arweave_solana/tree/7eb522e6cae947132f792a010312a7a6c41ddb19/deployment/legacy-export), отдельный evidence | 15 синтетических групп + TypeScript PASS; production control plane/import не выполнялись |

Диагностическая ветка содержит один дополнительный workflow, каждый job которого checkout-ит именно `ba6777ac…`. Она не может удовлетворить release contract и не производит accepted artifact. `diagnostic-run.json` и `diagnostic-jobs.json` сохраняют полный публичный GitHub metadata snapshot; `exact-diagnostic-workflow.yml` — точный исполнявшийся workflow. Selected stdout — выбранные неизменённые строки публичного лога с тестами и итоговыми counts, а не полный transcript. Все 155 browser executions используют Chromium, синтетические данные и подменённые/закрытые внешние запросы.

Предыдущие 78 independent и 33 portable executions в трёх браузерах проходили на parent `66512ee`, до последнего исправления PersonPanel. Они зафиксированы в истории, но не подменяют полный CI текущего source. OS-isolated browser recovery текущей полной попыткой не выполнялся после сетевого отказа. Локальная сборка проверяет нынешний набор модулей и recovery files, а не фактическую сеть/extension/production API.

## Контрольные суммы скачанных diagnostics

| Artifact | SHA-256 ZIP |
|---|---|
| Dependency audits `15017811153` | `d8c556fb4742b78bcf224c2536cfea707d540edfab3e052bad5c0e5df914f0b7` |
| Native network `15017327230` | `1a6eecb826d6cfa201e5670dd47f76867b5f07e237fc8ba73d97ad60d4e9e7de` |
| Admin screenshot `15016329127` | `17fbe2e15896a0d629e38676dc844b0d8bb5dc88d133be371cd67bc44f3945d3` |

ZIP размер и digest сверены со свежим GitHub artifact metadata перед распаковкой. JSON из первых двух артефактов сохранён здесь без изменения. Root визуально просмотрел мобильный скрин админки 390 px: карточки и кнопки помещаются, форма прокручивается вертикально. Балансы, адреса, время, промокод и операции на скрине синтетические и не доказывают production setup.

## Локальный пакет и воспроизводимость

`local-candidate/summary.json`, `release-manifest.json`, profile и bundle boundary сохранены побайтно. Полные build/prepare stdout имеют только переименованное расширение `.stdout.txt`; внутренние исторические пути в summary относятся к первоначальной проверке. Копия `prepare-local-candidate.original.mjs` — архив исходной локальной обёртки: её относительные imports и `source.json` предполагают исходное размещение `.cache/publication-completion/local-portable-ba6777ac/`, а не запуск из этого evidence-каталога.

CLI prepare берёт локальный git HEAD. В проверке использован существующий программный экспорт с явным remote SHA после доказанного совпадения local/remote tree. Это допустимо для локального анализа пакета и **не является GitHub provenance**. Новый полный CI должен создать свой ZIP, который затем отдельно принимается по run/attempt/source/digest/files; локальный manifest digest не назначается ему заранее.

## Сохраняющиеся ограничения

Production host, секреты, реальные данные, старые KV/protocol journals, single-executor handoff, независимый backup/restore, реальные Phantom/Solflare/Wander approvals, получение действительного ciphertext и восстановление владельцем не проверялись. Существующий незавершённый архив сохраняет прежний ID/bytes/receipt/journal. Успех software fixtures не заменяет ни один из этих фактов.
