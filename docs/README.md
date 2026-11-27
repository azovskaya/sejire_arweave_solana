# Активный выпуск: Arweave-only, 27 ноября 2026

Владелец отменил обязательный централизованный сервис. Текущая ветка — `feat/arweave-only-protocol-20261127`; default build — `decentralized-direct-arweave`.

- [Действующий протокол и границы доверия](PROTOCOL.md).
- [Публикация и приёмка независимого приложения](INDEPENDENT_RELEASE.md).
- [Точка продолжения и фактические результаты](CONTINUE_ON_ANOTHER_MAC.md).
- [Исторический AO draft](PROTOCOL_AO_V0_3.md).

Сохранённые ниже материалы SOL/promo/Worker/Linux относятся к прежним вариантам и совместимости. Они не требуют развёртывания сервера для текущего приложения.

---

# SEJIRE Documentation Index

Техническая документация протокола вечного версионного хранения генеалогических деревьев.

## Быстрая навигация

| Документ | Назначение |
|----------|------------|
| [ARCHITECTURE.ru.md](./ARCHITECTURE.ru.md) | Системная архитектура AO-first |
| [PROTOCOL.md](./PROTOCOL.md) | Спецификация протокола (нормативная) |
| [GLOSSARY.ru.md](./GLOSSARY.ru.md) | Термины |
| [VERIFICATION.ru.md](./VERIFICATION.ru.md) | Сверка с экосистемой Arweave/AO (2026) |
| [LIVE.md](./LIVE.md) | Публичные ссылки на работающее приложение |
| [COMPETITIVE.ru.md](./COMPETITIVE.ru.md) | SEJIRE vs Ancestry/MyHeritage vs DeepFamily |
| [SPONSOR_AND_PERMAWEB.ru.md](./SPONSOR_AND_PERMAWEB.ru.md) | Fiat $3 + Turbo + permaweb hosting |
| [PERMAWEB_ROLLOUT.ru.md](./PERMAWEB_ROLLOUT.ru.md) | Пошаговый план: языки, деплой, sponsor, безопасность |
| [LOCKED_DECISIONS.ru.md](./LOCKED_DECISIONS.ru.md) | Зафиксированные решения владельца (не переспрашивать) |
| [TREASURY_AND_ADMIN.ru.md](./TREASURY_AND_ADMIN.ru.md) | Казна: где хранить ключ, админка без данных людей |
| [CHECKPOINT.ru.md](./CHECKPOINT.ru.md) | Точка продолжения v0.5: протокол v0.3 + permaweb |
| [BUY_SEJIRE.ru.md](./BUY_SEJIRE.ru.md) | Как купить имя sejire: ArConnect, Binance, карта / ARIO |
| [CHECKLIST.md](./CHECKLIST.md) | Синхронизация код ↔ docs |
| [processes/](./processes/) | Логика каждого AO-процесса и хендлера |
| [flows/](./flows/) | Пользовательские и системные сценарии |
| [adr/](./adr/) | Architecture Decision Records |
| [security/](./security/) | Угрозы, ключи, доступ по 12 словам |
| [roadmap/PHASES.ru.md](./roadmap/PHASES.ru.md) | Фазы внедрения |

## Принцип документации

1. **Норматив** (`PROTOCOL.md`, schemas) — источник истины.
2. **Процессы** (`processes/*.md` + `ao/processes/*.lua`) — код и описание 1:1.
3. **Потоки** (`flows/*.md`) — как пользователь и система взаимодействуют.
4. **ADR** — почему выбрали так, а не иначе.

Любое изменение хендлера AO **обязано** обновить:
- Lua-файл
- `processes/<NAME>.md`
- `processes/MESSAGE_CATALOG.md`
- JSON Schema в `packages/schema/` при смене payload
