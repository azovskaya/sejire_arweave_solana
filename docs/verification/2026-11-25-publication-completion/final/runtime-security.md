# Runtime и findings тестовых зависимостей

Fresh audit точного source: web production 13 low / 10 moderate / 0 high / 0 critical; sponsor production 13 low / 1 moderate / 0 high / 0 critical. Full sponsor tree содержит 3 high entries: Miniflare и его sharp/undici. Полные JSON сохранены в `dependency-audits/`; npm audit не является чистым и не превращается в PASS с нулём замечаний из-за non-blocking workflow.

`deployment/Dockerfile` фиксирует Node 24.22.3 и отдельную production-стадию `npm ci --omit=dev --ignore-scripts`; compiled server сохраняет внешние production packages. Miniflare, sharp и dev Undici в этот production dependency tree не входят. Обновление самого Node не исправляет произвольный установленный sharp: здесь разделение основано на упаковке и production audit.

Локально получено `process.versions`: Node 24.22.3, bundled Undici 7.30.2, OpenSSL 3.5.9. [Официальный Node 24.22.3 security release](https://nodejs.org/en/blog/release/v24.22.3/) от 11 ноября 2026 подтверждает Undici 7.30.2. [GHSA-2m5v-pch6-74hx](https://github.com/nodejs/undici/security/advisories/GHSA-2m5v-pch6-74hx) исправлен в 7.30.1; [GHSA-mqg3-3v4r-cm32](https://github.com/nodejs/undici/security/advisories/GHSA-mqg3-3v4r-cm32) — в 7.30.2. Эти конкретные findings нельзя переносить с dev package на исправленный встроенный fetch.

Вывод ограничен перечисленными версиями, advisories, Dockerfile и сохранёнными audit JSON. Не выполнялся полный построчный аудит всех third-party sources, всех CVE или vulnerability scan пакетов ОС контейнера. Тестовые tooling findings и оставшиеся low/moderate не скрываются; слепой force downgrade npm не выполнялся. Это заключение не закрывает сетевой release gate или production приёмку.
