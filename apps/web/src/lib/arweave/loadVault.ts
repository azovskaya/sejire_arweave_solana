/**
 * Load a vault before sealing a new version.
 * Never treat an undecryptable "latest" tag as an empty vault — that forks history.
 */
import { type SejireKeys } from "../crypto/keys";
import {
  emptyVault,
  openEnvelope,
  openLocalVault,
  type VaultV1,
} from "../crypto/vault";
import {
  fetchEnvelopeByTx,
  GatewayUnavailableError,
  isGatewayUnavailable,
  listVaultVersions,
} from "./fetch";

export type { SejireKeys };

export const VAULT_POISONED_RU =
  "В сети есть записи этого сейфа, но они не открываются вашими 12 словами. Не сохраняйте поверх — проверьте фразу.";

export type PublishVaultChoice =
  | { ok: true; vault: VaultV1 }
  | { ok: false; error: string };

/** Pure: decide what to publish against after the network walk. */
export function resolvePublishVault(input: {
  opened: VaultV1 | null;
  remoteListed: number;
  remoteDecryptFails: number;
  local: VaultV1 | null;
  empty: VaultV1;
}): PublishVaultChoice {
  if (input.opened) return { ok: true, vault: input.opened };
  const poisoned = input.remoteListed > 0 && input.remoteDecryptFails > 0;
  if (poisoned && !input.local) return { ok: false, error: VAULT_POISONED_RU };
  if (input.local) return { ok: true, vault: input.local };
  return { ok: true, vault: input.empty };
}

export type LoadedPublishVault = {
  vault: VaultV1;
  parentTxId: string | null;
};

async function tryOpenTx(
  keys: SejireKeys,
  txId: string
): Promise<{ vault: VaultV1 } | { decryptFailed: true } | { miss: true }> {
  try {
    const envelope = await fetchEnvelopeByTx(txId);
    if (!envelope || envelope.vault_id !== keys.vaultId) return { decryptFailed: true };
    try {
      const vault = await openEnvelope(keys, envelope);
      return { vault };
    } catch {
      return { decryptFailed: true };
    }
  } catch (e) {
    if (isGatewayUnavailable(e)) throw e;
    return { miss: true };
  }
}

export async function loadVaultForPublish(
  keys: SejireKeys,
  opts?: { parentTxId?: string | null; freshKey?: boolean }
): Promise<LoadedPublishVault> {
  const local = await openLocalVault(keys);
  // Only the caller that generated a brand-new random mnemonic may bypass lookup.
  if (opts?.freshKey) return { vault: local ?? emptyVault(keys.vaultId), parentTxId: null };
  let opened: VaultV1 | null = null;
  let parentTxId: string | null = null;
  let remoteListed = 0;
  let remoteDecryptFails = 0;
  let offline = false;

  const consider = async (txId: string) => {
    const result = await tryOpenTx(keys, txId);
    if ("vault" in result) {
      opened = result.vault;
      parentTxId = txId;
      return true;
    }
    remoteListed += 1;
    if ("decryptFailed" in result) remoteDecryptFails += 1;
    return false;
  };

  try {
    if (opts?.parentTxId) {
      await consider(opts.parentTxId);
    }
    if (!opened) {
      const versions = await listVaultVersions(keys.vaultId, { limit: 15 });
      for (const v of versions) {
        if (v.txId === opts?.parentTxId) {
          remoteListed += 1;
          continue;
        }
        if (await consider(v.txId)) break;
      }
    }
  } catch (e) {
    if (isGatewayUnavailable(e)) offline = true;
    else throw e;
  }

  if (offline) {
    if (!local && !opened) throw new GatewayUnavailableError();
    return {
      vault: opened ?? local!,
      parentTxId: opened ? parentTxId : opts?.parentTxId ?? null,
    };
  }

  const decided = resolvePublishVault({
    opened,
    remoteListed,
    remoteDecryptFails,
    local,
    empty: emptyVault(keys.vaultId),
  });
  if (!decided.ok) throw new Error(decided.error);
  return { vault: decided.vault, parentTxId: opened ? parentTxId : null };
}
