# Admin completion review — 25 ноября 2026

Frontend зафиксирован для общего build/CI. Изменения остаются локальным кандидатом на ветке `feat/funded-portable-release-20261125`; base HEAD на момент сохранения evidence — `5b35fe0072c50a321d879beee909acc93109d41f`. Этим агентом не выполнялись commit, deployment, чтение production secrets, подключение реального кошелька или перевод средств.

## Современная админка

`/#/admin` открывает единый `ServerAdminDesk`. Доступ предоставляет серверный API; публичный verifier не используется как серверная защита. Credential существует только в памяти страницы, передаётся в Authorization header только настроенному API, не попадает в URL, body, browser storage, public bundle или логи. Admin fetch запрещает redirects, ambient cookies и referrer. Scope/generation и AbortController отменяют запросы при выходе, размонтировании и замене credential; поздний ответ не восстанавливает доступ. Серверный вход не активирует legacy local treasury key store.

Раздел «Обзор Solana» читает авторизованный ledger с pagination. Mainnet и Devnet учитываются отдельно; суммы оплаты и помощи разделены, как и payment/storage statuses. Ссылки Solana Explorer соответствуют сети каждой записи. Неизвестное состояние не показывается нулём; failed refresh скрывает прежние итоги. Просмотр не вызывает reconciliation или публикацию. Современная ветка не исполняет прежний Devnet RPC/GraphQL overview.

Раздел фонда сохраняет смену/включение/выключение промокода, общий лимит и историю. Изменения подтверждаются readback; ошибка неизвестного результата убирает доверие к старому dashboard до обновления. Остаток нового лимита учитывает расходы и резервы. Получатели SOL изменяются с expectedRevision и повторным чтением. Сверка незавершённых сохранений запускается только явным действием и поясняет возможность досылки прежних signed bytes.

## AR-пополнение и Wander

1. Владелец подготавливает durable intent с точной суммой. После фиксации исходного ceiling сервер генерирует непредсказуемый nonce256bit.
2. Обязательный подписанный tag — `SEJIRE-Topup-Intent` со значением64hex. Legacy prepared intents без nonce не разрешают перевод/confirm.
3. Кнопка подключения Wander запрашивает только публичный адрес, public key и разрешение подписать транзакцию. До подписи показываются Arweave Mainnet, адреса, сумма, комиссия, итог и tag.
4. Перед `wallet.sign` сохраняются local journal и единственная server signing claim. Неизвестная claim/signature не истекает и не разрешает вторую подпись.
5. Подписанная native transaction проверяется по owner, recipient, quantity, reward, anchor, data fields, nonce и криптографической подписи/ID. Допускаются только ожидаемые дополнительные Signing-Client/Signing-Client-Version tags Wander.
6. Signed bytes фиксируются в IndexedDB и на сервере; server readback обязателен до network POST. Отправка — отдельная явная кнопка.
7. Повтор после неизвестного ответа отправляет те же signed bytes/TX ID. Чистый браузер получает тот же подписанный перевод из авторизованного server journal.
8. Кнопка «Проверить и учесть» не подписывает и не переводит деньги. Credited status/revision принимаются только после серверной проверки и readback.

Late wallet result после logout/timeout может сохранить проверенную публичную подпись локально, но не продолжает server mutation или broadcast. Journal содержит только публичные реквизиты и native transaction; секреты администратора и кошелька туда не записываются. Browser locks плюс IndexedDB CAS не позволяют позднему callback заменить уже сохранённые signed bytes. Существующий claim без подписи требует проверки прежнего окна/результата, а не автоматического создания новой оплаты.

## Независимый backend review

Обнаружен конкретный counterexample первоначальному baseline: wallet balance уже включал incoming TX на height101, а оба `/info` возвращали100. Только проверка `blockHeight > baselineHeight` могла повторно увеличить ceiling. Backend-agent добавил будущий server nonce после pin и проверку nonce в подписанном native transfer. Старый TX не может содержать неизвестный будущий nonce. Focused backend regression этого сценария описан в backend evidence; этот отчёт не выдаёт чужой запуск за собственный.

После fix повторно прочитаны `treasuryTopups.ts`, `treasuryProof.ts`, `treasuryGuard.ts`. Проверены exact amount/recipient/sender, RSA signature/TX ID, signed nonce tag, block height/hash, минимум12 confirmations и согласие двух nodes; atomic unique TX/CAS/revision и shared conservative ceiling; отсутствие сброса расходов/holds; immutable single signing claim и связь confirm с сохранённым TX. Новых blockers не найдено.

Backend-agent `/root/sol_promo_architecture` выполнил reciprocal read-only review frontend `treasuryTransfer.ts` и Store: blockers не обнаружены. Проверены claim-before-sign, matching wire/readback, late-IDB-only callback, immutable bytes beforePOST, clean-browser recovery, owner/fee/anchor/nonce matching и CAS. Дополнительный широкий запуск тестов этим review не подразумевается.

Граница доказательства: ответы двух доверенных nodes подтверждают включение и confirmations; это не локально проверяемый consensus proof. Реальный tagged AR transfer,12 confirmations, Wander acceptance и production Mainnet roundtrip остаются внешними release gates.

## Сохранённые результаты

| Проверка | Результат | Файл |
|---|---|---|
| admin authority/transport helper | PASS | `node-adminScope.stdout.txt` |
| native transfer safety | 6 сценариев PASS | `node-treasuryTransfer.stdout.txt` |
| последний совместный Node запуск | exit0 | `node-admin-safety-combined.stdout.txt` |
| apps/web TypeScript | exit0, без stdout | `typecheck.stdout.txt` |
| admin Playwright `--list` | 21 собранный тест | `playwright-admin-collection.stdout.txt` |
| promo-funded Playwright `--list` | 27 собранных тестов | `playwright-fund-collection.stdout.txt` |
| recipients Playwright `--list` | 3 собранных теста | `playwright-recipients-collection.stdout.txt` |

**Playwright collection — не execution.** Chromium локально отсутствовал; эти browser cases здесь не запускались. Node сценарии используют временный синтетический RSA4096 key и полностью mocked network, включая фактическую проверку подписи. Покрыты lost POST ACK, clean-browser recovery, unknown wallet response, late result after logout, lost claim ACK fence, changed recipient, missing readback, storage failure и fee change before signature.

Stdout перенесён дословно из результатов ранее завершённых tool calls; ради создания evidence тесты не запускались заново. Tool chunk provenance, команды, cwd, exit codes и SHA-256 файлов находятся в `summary.json`. Пустой `typecheck.stdout.txt` означает фактически завершившийся exit0 без вывода. Логи сохранены как `.stdout.txt`, чтобы не потеряться из-за общего ignore для `*.log`.

Hashes описывают frozen snapshot, а не подтверждение запуска каждого browser case на нём. Финальный exact-tree build/CI принадлежит root release-проходу. Runtime после freeze при сохранении этого evidence не изменялся.
