> **Historical, optional AO experiment.** The current Arweave-only application neither deploys nor calls these processes. Local editor computations are ordinary browser logic, not live AO settlement. See [the active protocol contract](../docs/PROTOCOL.md). The examples below are retained as historical documentation and are not current deployment instructions.

# AO processes — SEJIRE

| Process | File | Spec |
|---------|------|------|
| Tree | [`processes/tree.lua`](./processes/tree.lua) | [`docs/processes/TREE.md`](../docs/processes/TREE.md) |
| Factory | [`processes/factory.lua`](./processes/factory.lua) | [`docs/processes/FACTORY.md`](../docs/processes/FACTORY.md) |

Message catalog: [`docs/processes/MESSAGE_CATALOG.md`](../docs/processes/MESSAGE_CATALOG.md)

Protocol release: **`sejire/v0.3`** (kinship queries on Tree Process).

Local double (без aos): `apps/web/src/lib/ao/` — `cd apps/web && npm run test:protocol`.

## Deploy (aos)

```bash
npm i -g https://get_ao.arweave.net
aos --node https://push.forward.computer
```

### Tree

```lua
.load processes/tree.lua
Send({ Target = ao.id, Tags = { Action = "Init", Title = "Sultanov Family" } })
Send({
  Target = ao.id,
  Tags = { Action = "Commit" },
  Data = '{"message":"genesis","snapshot":{"persons":{"c":{"id":"c","name":"Child","sex":"M","parents":[],"media":[]}}}}'
})
Send({ Target = ao.id, Tags = { Action = "GetJetiAta", ["Person-Id"] = "c" } })
Send({ Target = ao.id, Tags = { Action = "Relate", ["Person-A"] = "c", ["Person-B"] = "c" } })
Send({ Target = ao.id, Tags = { Action = "History" } })
```

### Factory

```lua
.load processes/factory.lua
Send({ Target = ao.id, Tags = { Action = "SpawnTree", Title = "Sultanov Family" } })
Send({ Target = ao.id, Tags = { Action = "ListTrees" } })
```

После `SpawnTree` клиент загружает `tree.lua` в новый process (или использует prebuilt module) и вызывает `Init` → `Commit`.

Live ids: `VITE_SEJIRE_FACTORY_ID` / tree id в env клиента (`apps/web/.env.ao.example`).

HTTP patch (HyperBEAM):

```
https://push.forward.computer/<process-id>~process@1.0/compute/sejire
https://push.forward.computer/<factory-id>~process@1.0/compute/sejire_factory
```
