# Admin: восстановление пополнения после reload — исправление локатора CI

## Исходное доказательство

- Диагностический run: [45601069511](https://github.com/azovskaya/sejire_arweave_solana/actions/runs/45601069511), diagnostic head `373580b` (runtime приложения соответствует проверяемому `66512ee`; в диагностическую ветку добавлен workflow).
- Admin job: [139159817979](https://github.com/azovskaya/sejire_arweave_solana/actions/runs/45601069511/job/139159817979).
- Фактический результат до исправления: **20 из 21 теста PASS**, один timeout. Это диагностический прогон, а не принятый полный release CI.
- Artifact: `15016120620`; SHA-256 ZIP: `edf18f66b89124545336eba2c8d561c1eeb1253f38aea9cd4ae6eb94a15c47b3`.
- Сохранённый snapshot: `.cache/publication-completion/ci45601069511/diagnostics/admin-password-unknown-nat-bcc1a-t-a-second-Wander-signature/error-context.md`.

Падал `tests/admin-password.spec.mjs:245`: `unknown native submit response and reload preserve the exact transaction without a second Wander signature`. После успешного сохранения подписи, неоднозначного native submit и reload/login тест ожидал на прежней строке 257:

```text
getByRole('region', { name: 'Пополнение фонда AR', exact: true })
  .getByLabel('Заявка для перевода или проверки', { exact: true })
  .selectOption(intentId)
```

Call log сообщает только ожидание локатора до timeout 60000 ms, без ошибки отсутствующего option. Snapshot показывает включённый `combobox` с доступным именем «Заявка для перевода или проверки» и сохранённым вариантом заявки `7725b8578eb4020f05b3e6317da06d5c`. Журнал заявок после reload загружен.

## Причина и изменение

`select` находится внутри `label` вместе с `option`. Установленный Playwright получает `getByLabel` через `getElementLabels` → рекурсивный `elementText(label)`, который включает тексты вариантов. Поэтому точное совпадение только с заголовком не находит элемент. Доступное имя combobox из браузерного snapshot совпадает с требуемым заголовком.

Изменён только `apps/web/tests/admin-password.spec.mjs`: выбран scoped `getByRole('combobox', { name, exact: true })`. Runtime, API, хранилище подписей, single-claim и single-signature guards не менялись.

Сохранены прежние проверки видимости восстановленного перевода, точных повторно отправляемых подписанных байтов и отсутствия новой подписи Wander. Добавлены явные проверки:

- выбран именно прежний `intentId`;
- до reload получена ровно одна подпись;
- восстановленный интерфейс показывает ID прежней подписанной транзакции;
- после reload выполнено новое авторизованное чтение серверного transfer;
- сервер хранит те же `signedTx` и единственную запись перевода;
- после reload и после повторной отправки счётчик новых подписей Wander остаётся нулевым.

## Фактически выполненная локальная проверка

| Проверка | Результат |
|---|---|
| `node --check apps/web/tests/admin-password.spec.mjs` | PASS; включает окончательный вариант с сохранённой проверкой видимости |
| `git diff --check -- apps/web/tests/admin-password.spec.mjs` | PASS |
| `./node_modules/.bin/playwright test --config=playwright.admin-password.config.ts --list --grep 'unknown native submit response'` из `apps/web` | Собран **1 тест**; это collection, не выполнение браузера |

Локального Chromium нет; после исправления браузерный тест здесь не выполнялся. Успех исправленного сценария должен подтвердить следующий CI. Реальные кошельки, ключи и средства не использовались. Эта запись не утверждает production-ready или успешную реальную отправку/миграцию.
