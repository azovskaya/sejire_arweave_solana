# Независимый просмотр операторского комплекта

Дата: 25 ноября 2026. Режим: read-only code review и проверка состава переносимого комплекта. Реальный Cloudflare аккаунт, прежние секреты и private ledger не открывались. Deployment и внешние записи не выполнялись.

## Объём

Комплект `deployment/legacy-export` сопровождает приложение отдельной evidence-веткой. Он не входит в принятый статический пакет и не выдаётся за часть полного CI приложения. Его собственные синтетические проверки: 15 групп PASS, TypeScript exit 0. Полные stdout и хеши 24 файлов сохранены в `deployment/legacy-export/evidence/summary.json`; сама summary — 25-й файл комплекта.

При переносе проверены SHA-256 каждого файла, отсутствие symlink и небезопасных относительных путей; скопированы только перечисленные source/templates/evidence. node_modules, cache, test DB и приватные выходы подготовки не копировались. Два vendor-файла побайтно совпали с исходниками кандидата `ba6777ac9c780627a6cdceafe947fed08ddaca63`, tree `79e4286c3217bc5b59abcfd2a76905b221b932be`.

Основной экспортёр и collector прошли отдельный просмотр другим участником. Root дополнительно прочитал proxy runtime, config, preparation и collector. Проверены фиксированный upstream HTTPS origin, source identity/freeze/seal pins, разрешённые пути и методы, сохранение Authorization/Idempotency/Origin и точного тела, удаление старого Host и подставленных forwarding-IP заголовков, ограничения тела и времени, отказ на redirects, отсутствие автоматических повторов при неопределённом POST. Нового блокирующего дефекта в просмотренном коде не обнаружено.

Proxy SHA-256: `bc1bf64d6e3e8d51615618778f5fb0f00529e185170fea45b9af6569a44ff4d9`.

README SHA-256: `08c6dea7390a3eb792fc845b4d99928edc53b8ade91f462f2e2aa2a394050958`.

## Существенные свойства

- Подготовка использует точные прежние Worker/class/namespace/object и сохраняет типы bindings без чтения значений секретов. Metadata: старый migration tag сохраняется, lifecycle steps пусты.
- Предварительная подготовка означает только намерение обслуживания. Отдельный seal допускается после установки на 100% и подтверждённой остановки прежнего исполнения.
- Наблюдение `getAlarm() == null` сохраняется как неопределённое; не подменяется отсутствием обязательства. Требуется отдельная зафиксированная сверка.
- Снимок блокируется при активных leases или неизвестной SQL-схеме. Collector сохраняет status/snapshot/status, хеши и freeze sidecar приватными файлами; completion пишется последним.
- Compatibility proxy не импортирует SQL, не снимает Linux review marker и не запускает прежние jobs. Он нужен только старым клиентам, в которых API URL уже неизменяем.
- Реальная workerd-проверка выявила неподдержанный `redirect:error`. Исправленный proxy использует `manual` и обязательный отказ всех 3xx; проверка сохранена.
- Установка зависимостей документирована через sponsor lockfile и новую относительную symlink. Самостоятельная воспроизводимость без этого checkout/lockfile не заявляется.

## Условия, которые тестовый комплект не устанавливает

Фактическое принятие metadata Cloudflare control plane и сохранность всех secret bindings после установки не проверены. Владелец должен сверить реальный source deployment, все namespace/objects, adoption/quiescence и неизвестные внешние операции. Импорт Linux, единственный исполнитель, фактические старые browser origins/capabilities, trusted ingress/rate limits и реальный объём данных требуют приёмки на месте.

Legacy KV `/v1`, protocol journals, другие классы/объекты и неподдержанные схемы не входят в снимок и не покрываются proxy. First-running-alarm/null проверен моделью документированной семантики; это не утверждение о полном воспроизведении production scheduler. Тесты ограничений размера, transport error/no-retry и redirects не подменяют отдельную проверку реального 55-секундного timeout.

Операторские attestations фиксируют решение владельца и ссылку на его private evidence; они не доказывают автоматически состояние блокчейна или остановку другого процесса. Не запускать комплект против production до отдельного просмотра его конкретных подготовленных файлов и целевого Worker.

## Официальные основания

- https://developers.cloudflare.com/durable-objects/api/alarms/
- https://developers.cloudflare.com/workers/runtime-apis/request/
- https://developers.cloudflare.com/api/resources/workers/subresources/scripts/methods/update/
