import type { EnvelopeV1 } from '../crypto/encrypt';
import { serializeEnvelope } from '../crypto/envelope';
import type { VaultV1 } from '../crypto/vault';
import { DRAFT_KEY, saveDraftTree } from '../draftStorage';
import { GUIDE_KEY, assertDraftWriteToken, captureDraftWriteToken, rollbackDraftValue, type DraftWriteToken } from '../draftOwnership';
import { defaultGuide, saveGuide } from '../guide';
import { pickHomeFocus } from '../pedigree';
import { coerceTreeStore } from '../treeJson';
import type { TreeStore } from '../types';
import {
  clearVaultSession, getSessionMnemonic, getVaultSession, setVaultSession, setVaultSessionChecked,
  VAULT_SESSION_META_KEY, vaultEnvelopeDigest, type VaultSessionMeta,
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

export type VaultPreparationSnapshot = {
  vaultId: string;
  cache: string | null;
  session: string | null;
  draftToken: DraftWriteToken;
};

/** Capture before asynchronous loading/encryption. A later local selection or
 * another tab's preparation must not be overwritten by its delayed result. */
export function captureVaultPreparation(vaultId: string): VaultPreparationSnapshot {
  try {
    return { vaultId, draftToken: captureDraftWriteToken(), cache: localStorage.getItem('sejire.envelope.' + vaultId),
      session: sessionStorage.getItem(VAULT_SESSION_META_KEY) };
  } catch { throw Error('storage_unavailable'); }
}

/** Preserve the complete prepared ciphertext and its tab-local digest together.
 * This is only a local preparation; it does not claim a new network HEAD or
 * replace the editor draft. Failure leaves the prior selection retryable. */
export function acceptPreparedVault(
  envelope: EnvelopeV1,
  parentTxId: string | null,
  mnemonic: string,
  before: VaultPreparationSnapshot,
): void {
  assertDraftWriteToken(before.draftToken);
  const canonical = serializeEnvelope(envelope);
  if (envelope.vault_id !== before.vaultId ||
      (parentTxId !== null && !/^[A-Za-z0-9_-]{43}$/.test(parentTxId))) throw Error('invalid_backup');
  const current = captureVaultPreparation(before.vaultId);
  if (current.cache !== before.cache || current.session !== before.session) throw Error('vault_selection_changed');
  const cacheKey = 'sejire.envelope.' + before.vaultId;
  const previousSession = getVaultSession(), previousMnemonic = getSessionMnemonic();
  try {
    localStorage.setItem(cacheKey, canonical);
    if (localStorage.getItem(cacheKey) !== canonical) throw Error('storage_unavailable');
    setVaultSessionChecked({ vaultId: before.vaultId, headTxId: parentTxId,
      source: 'local', cacheDigest: vaultEnvelopeDigest(envelope) }, mnemonic);
    if (localStorage.getItem(cacheKey) !== canonical) throw Error('storage_unavailable');
  } catch {
    const rollbacks = [
      () => {
        if (previousSession) setVaultSession(previousSession, previousMnemonic);
        else clearVaultSession();
        restoreValue(sessionStorage, VAULT_SESSION_META_KEY, before.session);
      },
      () => {
        // Do not replace a concurrent tab's new cache while rolling back ours.
        if (localStorage.getItem(cacheKey) === canonical) restoreValue(localStorage, cacheKey, before.cache);
      },
    ];
    for (const rollback of rollbacks) { try { rollback(); } catch { /* report the failure below */ } }
    throw Error('storage_unavailable');
  }
}

/** Commit all selection state only after the owner accepts replacing the draft.
 * Writes are synchronous; a failed browser write rolls back the previous bytes.
 * A cancelled choice cannot change the next save's vault, phrase, or parent. */
export function acceptVaultVersion(
  selection: VaultVersionSelection,
  confirm: () => boolean,
  draftToken: DraftWriteToken = captureDraftWriteToken(),
): TreeStore | null {
  assertDraftWriteToken(draftToken);
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
  assertDraftWriteToken(draftToken);

  const cacheKey = 'sejire.envelope.' + vault.vault_id;
  // Read after confirmation, since flushing the current editor can itself
  // persist the user's latest edits before this snapshot replaces it.
  const previousCache = localStorage.getItem(cacheKey);
  const previousDraft = localStorage.getItem(DRAFT_KEY);
  const previousGuide = localStorage.getItem(GUIDE_KEY);
  const guide = { ...defaultGuide(), step: 'done' as const, selfId: pickHomeFocus(tree.draft, null) };
  const previousSessionRaw = sessionStorage.getItem(VAULT_SESSION_META_KEY);
  const previousSession = getVaultSession(), previousMnemonic = getSessionMnemonic();
  try {
    localStorage.setItem(cacheKey, canonical);
    if (!saveDraftTree(tree)) throw Error('storage_unavailable');
    if (!saveGuide(guide)) throw Error('storage_unavailable');
    const selectedSession = session.source === 'file' || session.source === 'local'
      ? { ...session, cacheDigest: vaultEnvelopeDigest(envelope) } : session;
    setVaultSessionChecked(selectedSession, mnemonic);
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
      () => rollbackDraftValue(GUIDE_KEY, previousGuide, JSON.stringify(guide), draftToken),
      () => rollbackDraftValue(DRAFT_KEY, previousDraft, JSON.stringify(tree), draftToken),
      () => { if (localStorage.getItem(cacheKey) === canonical) restoreValue(localStorage, cacheKey, previousCache); },
    ];
    for (const rollback of rollbacks) {
      try { rollback(); } catch { /* attempt every rollback even if one store is unavailable */ }
    }
    throw Error('storage_unavailable');
  }
  return tree;
}
