> Historical AO draft retained for compatibility. The active Arweave-only release contract is [PROTOCOL.md](PROTOCOL.md). This document does not assert a deployed AO process.

# SEJIRE Protocol Specification

**Status:** Draft v0.3
**Schema namespace:** `sejire/*`
**App tag:** `Protocol=sejire/v0.3`
**Normative language:** MUST / SHOULD / MAY (RFC 2119)

v0.3 adds Tree Process kinship queries (`GetAncestors`, `GetJetiAta`, `Relate`).
Commit schema remains `sejire/commit/v1`. Encrypted vault envelopes on Arweave are unchanged.

---

## 1. Purpose

SEJIRE is a decentralized application protocol for **versioned genealogical trees**.

Core guarantee:

> Every mutation of a family tree MUST produce a new immutable commit.
> Prior commits MUST remain readable forever. History MUST NOT be erased.

SEJIRE is **not** a hosted SaaS database. It is a data + compute layer on Arweave + AO.

---

## 2. Actors

| Actor | Role |
|-------|------|
| **Owner** | Arweave address authorized to `Commit` / manage ACL |
| **Reader** | Anyone who can query public process state / history |
| **Factory Process** | Spawns Tree Processes |
| **Tree Process** | One autonomous AO process per family tree |
| **Client (UI)** | Signs messages, holds draft, renders versions |
| **Gateway / HyperBEAM** | Message delivery + HTTP state access (replaceable) |

---

## 3. Identifiers

| ID | Format | Notes |
|----|--------|-------|
| `tree_id` | AO process id | Equals `ao.id` of Tree Process after spawn |
| `commit_id` | `c_<version>_<suffix>` | Unique within tree |
| `person.id` | opaque string | Stable across commits if same person |
| `media.tx` | Arweave TX id | 43-char base64url typical |

---

## 4. Data model

### 4.1 Person

See `packages/schema/person-v1.schema.json`.

Required: `id`, `name`.
Optional: `born`, `died`, `place`, `parents[]`, `media[]`, `notes`, `tombstone`.

`tombstone: true` means the person is **removed in this version**, not deleted from history.

### 4.2 Snapshot

```json
{ "persons": { "<person_id>": { /* Person */ } } }
```

A snapshot is a **complete** tree state at a version (not a delta).
Clients MAY compute deltas for UX, but the protocol stores full snapshots.

### 4.3 Commit

See `packages/schema/commit-v1.schema.json`.

| Field | Rule |
|-------|------|
| `schema` | MUST be `sejire/commit/v1` |
| `parent_commit_id` | MUST equal current HEAD (or `null` for genesis) |
| `version` | MUST be monotonic integer starting at 1 |
| `snapshot` | MUST contain full `persons` map |
| `message` | SHOULD describe the human intent of the change |

### 4.4 Tree Process State

```
Tree = {
  id, title, owners{},
  head,                    -- commit_id | nil
  commits{commit_id},      -- immutable map
  versions{n -> commit_id},
  next_version,            -- integer
  created_at
}
```

---

## 5. Versioning rules (normative)

1. `Commit` MUST NOT mutate an existing commit object.
2. `Commit` MUST set `parent_commit_id` to current `head` (linear history in v1).
3. If a **string** `parent_commit_id` is provided and ≠ `head`, process MUST reject with `StaleParent`. Omitting the field or sending JSON `null` means “use current HEAD”.
4. Soft-delete MUST use `tombstone` inside a new commit.
5. Clients MUST be able to reconstruct any past version via `GetCommit`.

Forks (branching history) are **out of scope for v1** (see ADR-0004).

---

## 6. Storage tiers

| Tier | Stores | Must not store |
|------|--------|----------------|
| AO Tree Process | graph, commits, ACL, media refs, kinship query results | large binaries |
| Arweave Permaweb | SPA, photos, scans, encrypted vault envelopes | authoritative graph alone |
| Client local draft | uncommitted edits | source of truth after commit |

---

## 7. Authorization

1. First successful `Init` or `Commit` from address A bootstraps `owners[A]=true` if owners empty.
2. Subsequent `Commit` / `AddOwner` / `RemoveOwner` MUST require `is_owner(msg.From)`.
3. `Info`, `GetHead`, `GetCommit`, `History`, `Ping`, `GetAncestors`, `GetJetiAta`, `Relate` MAY be public (v1 default).

Encryption of person names (client-side AES + BIP-39) is the **product vault path** (envelope on Arweave).
AO Tree Process v0.3 still stores plaintext snapshots so queries can run on-process; production public trees SHOULD be opt-in, and private trees SHOULD stay in the encrypted envelope until an encrypted-commit profile is specified.

---

## 8. Message surface

Normative catalog: [`processes/MESSAGE_CATALOG.md`](./processes/MESSAGE_CATALOG.md).

Tree Process actions: `Init`, `Info`, `Commit`, `GetHead`, `GetCommit`, `History`, `AddOwner`, `RemoveOwner`, `Ping`, `GetAncestors`, `GetJetiAta`, `Relate`.
Factory Process actions: `SpawnTree`, `RegisterTree`, `ListTrees`, `Info`, `Ping`.

### 8.1 Kinship queries (v0.3)

Queries run against **HEAD** unless tag `Commit-Id` selects a historical commit.
They MUST NOT mutate state. Missing `Person-Id` / `Person-A`+`Person-B` → `BadPersonId`. No commits yet → `EmptyTree`.

| Action | Result schema | Meaning |
|--------|---------------|---------|
| `GetAncestors` | `sejire/ancestors/v1` | BFS up `parents[]`, self at distance 0; optional `Max-Depth` |
| `GetJetiAta` | `sejire/jeti-ata/v1` | Paternal line, generation 0 = focus, max 7 people (SPA depth) |
| `Relate` | `sejire/relate/v1` | Kinship of A **relative to** B; `code` from `packages/schema/kinship-codes.json` |

`Relate.code` is language-neutral. Clients MAY map codes to UI strings.
`da` = steps from A to LCA, `db` = steps from B to LCA, `degree` = `da+db`.
`unrelated` omits `lca` / `da` / `db` / `degree`.

Father for `GetJetiAta` uses the same split as the SPA (`sex=M`, else first remaining parent).

---

## 9. Compatibility

| Version | Notes |
|---------|-------|
| `sejire/v0.3` | Kinship queries; `Info.release`; StaleParent only if parent is a string |
| `sejire/commit/v1` | Current commit payload (unchanged) |
| `sejire/tree/v1` | Tree data model / Info.protocol |
| `sejire/v0.2` | Messages without kinship actions |

Clients MUST ignore unknown person fields (forward compatible).
v0.2 clients MUST ignore unknown `Info` fields (`release`, `queries`).
Process SHOULD reject unknown required schema constants.

---

## 10. Reference implementation map

| Concern | Path |
|---------|------|
| Tree AO logic | `ao/processes/tree.lua` |
| Factory AO logic | `ao/processes/factory.lua` |
| Local Tree/Factory (testable double) | `apps/web/src/lib/ao/treeProcess.ts`, `factoryProcess.ts` |
| AO client | `apps/web/src/lib/ao/client.ts` |
| Local engine (draft UX) | `apps/web/src/lib/treeEngine.ts` |
| JSON Schemas | `packages/schema/` |
| Process docs | `docs/processes/` |
