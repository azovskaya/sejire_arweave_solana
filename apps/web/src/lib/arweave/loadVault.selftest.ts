/**
 * Vault load policy: poison tags must not become an empty "new" vault.
 */
import { emptyVault, sealVault, type VaultV1 } from "../crypto/vault";
import { loadVaultForPublish, resolvePublishVault, VAULT_POISONED_RU } from "./loadVault";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const empty = emptyVault("vault-test");
const real: VaultV1 = { ...empty, active_tree_id: "tree_1" };
const local: VaultV1 = { ...empty, active_tree_id: "tree_local" };

const opened = resolvePublishVault({
  opened: real,
  remoteListed: 3,
  remoteDecryptFails: 2,
  local,
  empty,
});
assert(opened.ok && opened.vault.active_tree_id === "tree_1", "opened wins");

const poison = resolvePublishVault({
  opened: null,
  remoteListed: 3,
  remoteDecryptFails: 3,
  local: null,
  empty,
});
assert(!poison.ok && poison.error === VAULT_POISONED_RU, "poison without local refuses empty");

const mixedPoison = resolvePublishVault({
  opened: null,
  remoteListed: 3,
  remoteDecryptFails: 1,
  local: null,
  empty,
});
assert(!mixedPoison.ok, "any undecryptable Vault-Id listing refuses empty");

const poisonLocal = resolvePublishVault({
  opened: null,
  remoteListed: 2,
  remoteDecryptFails: 2,
  local,
  empty,
});
assert(poisonLocal.ok && poisonLocal.vault.active_tree_id === "tree_local", "poison with local keeps local");

const fresh = resolvePublishVault({
  opened: null,
  remoteListed: 0,
  remoteDecryptFails: 0,
  local: null,
  empty,
});
assert(fresh.ok && fresh.vault === empty, "no remote → empty ok");

const localOnly = resolvePublishVault({
  opened: null,
  remoteListed: 0,
  remoteDecryptFails: 0,
  local,
  empty,
});
assert(localOnly.ok && localOnly.vault.active_tree_id === "tree_local", "offline local");

console.log("loadVault.selftest: OK");

// Integration regression: a network outage must not silently replace an existing
// multi-tree vault with an empty vault. Freshly generated keys can work offline.
const { deriveKeysFromMnemonic } = await import("../crypto/keys");
const { isGatewayUnavailable } = await import("./gateways");
const { createTree } = await import("../treeEngine");
const keys = deriveKeysFromMnemonic("abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about");
const savedFetch = globalThis.fetch;
const storage = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => storage.set(key, value),
  removeItem: (key: string) => storage.delete(key),
  key: (index: number) => [...storage.keys()][index] ?? null,
  get length() { return storage.size; },
} });
globalThis.fetch = async () => new Response("unavailable", { status: 503 });
try {
  let refused = false;
  try { await loadVaultForPublish(keys); } catch (e) { refused = isGatewayUnavailable(e); }
  assert(refused, "existing key + offline + no local backup must refuse to overwrite");
  const freshOffline = await loadVaultForPublish(keys, { freshKey: true });
  assert(Object.keys(freshOffline.vault.trees).length === 0, "new random key can create offline");
  const firstTree = createTree("Synthetic family A");
  const otherTree = createTree("Synthetic family B");
  const preserved = { ...emptyVault(keys.vaultId), active_tree_id: firstTree.meta.id,
    trees: { [firstTree.meta.id]: firstTree, [otherTree.meta.id]: otherTree } };
  await sealVault(keys, preserved);
  const offlineLocal = await loadVaultForPublish(keys);
  assert(offlineLocal.vault.active_tree_id === firstTree.meta.id, "existing local vault preserved offline");
  assert(offlineLocal.vault.trees[otherTree.meta.id].meta.title === "Synthetic family B", "second tree survives offline save");
} finally { globalThis.fetch = savedFetch; }
console.log("loadVault.offline.selftest: OK");
