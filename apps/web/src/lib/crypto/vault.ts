import type { TreeStore } from "../types";
import type { EnvelopeV1 } from "./encrypt";
import { decryptJson, encryptJson } from "./encrypt";
import type { SejireKeys } from "./keys";
import { setLocalJson } from "../storageQuota";
import { downloadJson } from "../download";

export type VaultV1 = {
  schema: "sejire/vault/v1";
  vault_id: string;
  updated_at: string;
  trees: Record<string, TreeStore>;
  active_tree_id: string | null;
};

const LOCAL_PREFIX = "sejire.envelope.";

export function emptyVault(vaultId: string): VaultV1 {
  return {
    schema: "sejire/vault/v1",
    vault_id: vaultId,
    updated_at: new Date().toISOString(),
    trees: {},
    active_tree_id: null,
  };
}

export function putTree(vault: VaultV1, store: TreeStore): VaultV1 {
  return {
    ...vault,
    updated_at: new Date().toISOString(),
    trees: { ...vault.trees, [store.meta.id]: store },
    active_tree_id: store.meta.id,
  };
}

export async function sealVault(keys: SejireKeys, vault: VaultV1): Promise<EnvelopeV1> {
  const envelope = await encryptJson(keys.encKey, keys.vaultId, vault);
  setLocalJson(LOCAL_PREFIX + keys.vaultId, envelope);
  return envelope;
}

export async function openLocalVault(keys: SejireKeys): Promise<VaultV1 | null> {
  try {
    const raw = localStorage.getItem(LOCAL_PREFIX + keys.vaultId);
    if (!raw) return null;
    const envelope = JSON.parse(raw) as EnvelopeV1;
    return await decryptJson<VaultV1>(keys.encKey, envelope);
  } catch {
    return null;
  }
}

export function clearLocalVault(vaultId: string) {
  try { localStorage.removeItem(LOCAL_PREFIX + vaultId); } catch { /* browser storage disabled */ }
}

export async function openEnvelope(keys: SejireKeys, envelope: EnvelopeV1): Promise<VaultV1> {
  if (envelope.vault_id !== keys.vaultId) {
    throw new Error("Vault-Id mismatch");
  }
  return decryptJson<VaultV1>(keys.encKey, envelope);
}

export function downloadEnvelope(envelope: EnvelopeV1, filename?: string) {
  downloadJson(envelope, filename ?? `sejire-vault-${envelope.vault_id.slice(0, 8)}.json`);
}
