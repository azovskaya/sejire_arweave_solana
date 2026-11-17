import type { SejireKeys } from './crypto/keys';
import { emptyVault, openEnvelope, openLocalVault, type VaultV1 } from './crypto/vault';
import { parseEnvelope } from './crypto/envelope';
import { coerceTreeStore } from './treeJson';
import { getVaultSession } from './vaultSession/session';
import { isGatewayUnavailable, listVaultVersions } from './arweave/fetch';
import { reconcileIndependentCompletions } from './independentFinalization';
import { retrieveNativeVault } from './recovery/historicalNative';
import { LegacyLocatorProvider } from './recovery/providers/legacyLocatorProvider';
import { active, scoped } from './directArweave/network';
import { DirectError, requireDirect } from './directArweave/errors';
import { listDirectOperations } from './directArweave/journal';
import { verifyDirectSigned } from './directArweave/transaction';
import { sha256, verifyArchiveBinding } from './directArweave/format';
import type { DirectOperation } from './directArweave/types';

function validVault(vault: VaultV1 | null, vaultId: string, allowEmpty = false): vault is VaultV1 {
  return Boolean(vault && vault.schema === 'sejire/vault/v1' && vault.vault_id === vaultId &&
    vault.trees && typeof vault.trees === 'object' && !Array.isArray(vault.trees) &&
    (allowEmpty || Object.keys(vault.trees).length > 0) && Object.entries(vault.trees).every(([id, tree]) =>
      !['__proto__', 'constructor', 'prototype'].includes(id) && coerceTreeStore(tree)) &&
    (vault.active_tree_id === null || Object.hasOwn(vault.trees, vault.active_tree_id)));
}

async function cachedPreparation(keys: SejireKeys, knownParent: string | null, operations: DirectOperation[]) {
  let cachedText: string | null;
  try { cachedText = localStorage.getItem('sejire.envelope.' + keys.vaultId); }
  catch { throw new DirectError('storage_unavailable'); }
  const preparation = operations.find(operation => ['prepared', 'cancelled'].includes(operation.state) &&
    operation.archiveText === cachedText);
  if (!preparation) return null;
  // localStorage is shared between tabs, sessionStorage is not. A cancelled
  // free preparation can therefore be newer than this tab's network session.
  // Use only its exact journaled bytes, never an arbitrary generic cache.
  await verifyArchiveBinding(preparation);
  requireDirect(preparation.id === await sha256(new TextEncoder().encode(
    `sejire/direct-arweave/v1\0${preparation.vaultId}\0${preparation.archiveDigest}`)), 'storage_conflict');
  requireDirect(preparation.parentTxId === knownParent, 'storage_conflict');
  const vault = await openEnvelope(keys, parseEnvelope(JSON.parse(preparation.archiveText)));
  if (!validVault(vault, keys.vaultId)) throw Error('invalid_archive');
  return { vault, parentTxId: knownParent };
}

/** An explicitly opened offline snapshot is the user's chosen complete vault.
 * Replacing it with an older network version would silently drop other trees. */
export async function loadIndependentVaultForPublish(keys: SejireKeys, options: { parentTxId?: string | null; freshKey?: boolean } = {}) {
  const before = getVaultSession();
  const matchingSession = before?.vaultId === keys.vaultId;
  if (!options.freshKey && matchingSession && options.parentTxId !== undefined) {
    // A render-time prop must not move an already selected vault back to an
    // older HEAD. Explicit version selection changes the session first.
    requireDirect(options.parentTxId === before.headTxId, 'storage_conflict');
  }
  const requested = !options.freshKey && matchingSession && options.parentTxId === undefined
    ? { ...options, parentTxId: before.headTxId } : options;
  if (!options.freshKey && before?.vaultId === keys.vaultId && before.source !== 'file' && before.source !== 'local') {
    // Preserve an existing local preparation before completion reconciliation
    // can advance a stale network session or replace its generic cache.
    const prepared = await cachedPreparation(keys, requested.parentTxId ?? null, await listDirectOperations({ vaultId: keys.vaultId }));
    if (prepared) return prepared;
  }
  if (!options.freshKey) await reconcileIndependentCompletions(keys.vaultId);
  const session = getVaultSession();
  const adjusted = before?.vaultId === keys.vaultId && session?.vaultId === keys.vaultId &&
    requested.parentTxId === before.headTxId ? { ...requested, parentTxId: session.headTxId } : requested;
  if (!options.freshKey && session?.vaultId === keys.vaultId &&
      (session.source === 'file' || session.source === 'local')) {
    const vault = await openLocalVault(keys);
    if (!validVault(vault, keys.vaultId)) throw Error('invalid_archive');
    return { vault, parentTxId: session.headTxId };
  }
  const cached = await openLocalVault(keys);
  const local = validVault(cached, keys.vaultId, options.freshKey === true) ? cached : null;
  // Only the caller that generated brand-new words may bypass discovery.
  if (options.freshKey) return { vault: local ?? emptyVault(keys.vaultId), parentTxId: null };
  const suppliedParent = adjusted.parentTxId ?? null;
  const knownParent = suppliedParent && session?.headTxId === suppliedParent && session.vaultId !== keys.vaultId
    ? null : suppliedParent;
  const operations = await listDirectOperations({ vaultId: keys.vaultId });
  const prepared = await cachedPreparation(keys, knownParent, operations);
  if (prepared) return prepared;
  if (knownParent) {
    // A completed local journal keeps the original signed header and exact
    // ciphertext. Re-verify that binding so a new local backup remains possible
    // offline, without trusting a generic cache or an unproven version label.
    const journaled = operations.find(operation =>
      operation.txId === knownParent && operation.state === 'complete');
    if (journaled) {
      await verifyDirectSigned(journaled);
      const vault = await openEnvelope(keys, parseEnvelope(JSON.parse(journaled.archiveText)));
      if (!validVault(vault, keys.vaultId)) throw Error('invalid_archive');
      return { vault, parentTxId: knownParent };
    }
    // A known network version must be bound to its native transaction, not just
    // to a digest supplied by the same gateway. If its metadata is unavailable,
    // leave the selected version and local cache intact; an older discovered
    // version must never silently replace this HEAD during a new save.
    const verified = await retrieveNativeVault(knownParent, keys);
    return { vault: verified.vault, parentTxId: knownParent };
  }
  return scoped({}, async readOptions => {
    const signal = readOptions.signal!;
    const legacy = (await new LegacyLocatorProvider().discover({ vaultId: keys.vaultId, signal, fetcher: fetch })).candidates;
    let versions;
    try { versions = await listVaultVersions(keys.vaultId, { limit: 15, signal }); }
    catch (error) {
      active(signal);
      if (isGatewayUnavailable(error) && local) return { vault: local, parentTxId: null };
      throw error;
    }
    const ids = [...new Set([...versions.map(version => version.txId), ...legacy.map(candidate => candidate.txId)])];
    let last: unknown = new DirectError('archive_unavailable');
    for (const txId of ids) {
      active(signal);
      try {
        // Indexes and historical locator lists discover IDs only. Every selected
        // native version still passes the same signature and exact-byte checks.
        const verified = await retrieveNativeVault(txId, keys, readOptions);
        return { vault: verified.vault, parentTxId: txId };
      } catch (error) { last = error; }
    }
    active(signal);
    if (local) return { vault: local, parentTxId: null };
    if (ids.length) throw last;
    return { vault: emptyVault(keys.vaultId), parentTxId: null };
  });
}
