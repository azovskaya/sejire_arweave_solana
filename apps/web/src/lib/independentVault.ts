import type { SejireKeys } from './crypto/keys';
import { openLocalVault } from './crypto/vault';
import { coerceTreeStore } from './treeJson';
import { getVaultSession } from './vaultSession/session';
import { loadVaultForPublish } from './arweave/loadVault';
import { reconcileIndependentCompletions } from './independentFinalization';

/** An explicitly opened offline snapshot is the user's chosen complete vault.
 * Replacing it with an older network version would silently drop other trees. */
export async function loadIndependentVaultForPublish(keys: SejireKeys, options: { parentTxId?: string | null; freshKey?: boolean } = {}) {
  const before = getVaultSession();
  if (!options.freshKey) await reconcileIndependentCompletions(keys.vaultId);
  const session = getVaultSession();
  const adjusted = before?.vaultId === keys.vaultId && session?.vaultId === keys.vaultId &&
    options.parentTxId === before.headTxId ? { ...options, parentTxId: session.headTxId } : options;
  if (!options.freshKey && session?.vaultId === keys.vaultId &&
      (session.source === 'file' || session.source === 'local')) {
    const vault = await openLocalVault(keys);
    if (!vault || vault.schema !== 'sejire/vault/v1' || vault.vault_id !== keys.vaultId ||
      !vault.trees || typeof vault.trees !== 'object' || Array.isArray(vault.trees) ||
      !Object.keys(vault.trees).length || Object.entries(vault.trees).some(([id, tree]) =>
        ['__proto__', 'constructor', 'prototype'].includes(id) || !coerceTreeStore(tree)) ||
      (vault.active_tree_id !== null && !Object.hasOwn(vault.trees, vault.active_tree_id))) throw Error('invalid_archive');
    return { vault, parentTxId: session.headTxId };
  }
  return loadVaultForPublish(keys, adjusted);
}
