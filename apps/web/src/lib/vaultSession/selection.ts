import type { EnvelopeV1 } from '../crypto/encrypt';
import { serializeEnvelope } from '../crypto/envelope';
import type { VaultV1 } from '../crypto/vault';
import { DRAFT_KEY, saveDraftTree } from '../draftStorage';
import { coerceTreeStore } from '../treeJson';
import type { TreeStore } from '../types';
import {
  clearVaultSession, getSessionMnemonic, getVaultSession, setVaultSession, setVaultSessionChecked,
  VAULT_SESSION_META_KEY, type VaultSessionMeta,
} from './session';

/** A decrypted, complete snapshot. A network HEAD is supplied only by a reader
 * that verified its transaction; local version labels are never network IDs. */
export type VaultVersionSelection = {
  vault: VaultV1;
  envelope: EnvelopeV1;
  session: VaultSessionMeta;
  mnemonic: string;
};

function restoreValue(storage: Storage, key: string, value: string | null) {
  if (value === null) storage.removeItem(key);
  else storage.setItem(key, value);
}

/** Commit all selection state only after the owner accepts replacing the draft.
 * Writes are synchronous; a failed browser write rolls back the previous bytes.
 * A cancelled choice cannot change the next save's vault, phrase, or parent. */
export function acceptVaultVersion(
  selection: VaultVersionSelection,
  confirm: () => boolean,
): TreeStore | null {
  const { vault, envelope, session, mnemonic } = selection;
  const canonical = serializeEnvelope(envelope);
  if (!vault || vault.schema !== 'sejire/vault/v1' || vault.vault_id !== envelope.vault_id ||
      session.vaultId !== vault.vault_id || !vault.trees || typeof vault.trees !== 'object' ||
      Array.isArray(vault.trees) || !Object.keys(vault.trees).length ||
      Object.entries(vault.trees).some(([id, tree]) => ['__proto__', 'constructor', 'prototype'].includes(id) || !coerceTreeStore(tree)) ||
      (vault.active_tree_id !== null && !Object.hasOwn(vault.trees, vault.active_tree_id)) ||
      (session.headTxId !== null && !/^[A-Za-z0-9_-]{43}$/.test(session.headTxId))) {
    throw Error('invalid_backup');
  }
  const tree = coerceTreeStore(vault.active_tree_id ? vault.trees[vault.active_tree_id] : Object.values(vault.trees)[0]);
  if (!tree) throw Error('invalid_backup');
  if (!confirm()) return null;

  const cacheKey = 'sejire.envelope.' + vault.vault_id;
  // Read after confirmation, since flushing the current editor can itself
  // persist the user's latest edits before this snapshot replaces it.
  const previousCache = localStorage.getItem(cacheKey);
  const previousDraft = localStorage.getItem(DRAFT_KEY);
  const previousSessionRaw = sessionStorage.getItem(VAULT_SESSION_META_KEY);
  const previousSession = getVaultSession(), previousMnemonic = getSessionMnemonic();
  try {
    localStorage.setItem(cacheKey, canonical);
    if (!saveDraftTree(tree)) throw Error('storage_unavailable');
    setVaultSessionChecked(session, mnemonic);
    const storedSession = getVaultSession();
    if (localStorage.getItem(cacheKey) !== canonical || localStorage.getItem(DRAFT_KEY) !== JSON.stringify(tree) ||
        !storedSession || storedSession.vaultId !== session.vaultId ||
        storedSession.headTxId !== session.headTxId || storedSession.source !== session.source ||
        getSessionMnemonic() !== mnemonic) throw Error('storage_unavailable');
  } catch {
    // Restore the session phrase as well as the raw browser values. Rollback
    // failures are still surfaced as storage failure, never as successful open.
    const rollbacks = [
      () => {
      if (previousSession) setVaultSession(previousSession, previousMnemonic);
      else clearVaultSession();
      restoreValue(sessionStorage, VAULT_SESSION_META_KEY, previousSessionRaw);
      },
      () => restoreValue(localStorage, DRAFT_KEY, previousDraft),
      () => restoreValue(localStorage, cacheKey, previousCache),
    ];
    for (const rollback of rollbacks) {
      try { rollback(); } catch { /* attempt every rollback even if one store is unavailable */ }
    }
    throw Error('storage_unavailable');
  }
  return tree;
}
