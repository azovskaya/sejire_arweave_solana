import { parseEnvelope, serializeEnvelope } from './crypto/envelope';
import { DirectError, requireDirect } from './directArweave/errors';
import { verifyArchiveBinding } from './directArweave/format';
import { listDirectOperations, requireOperation, withDirectLock } from './directArweave/journal';
import { archiveLocalVaultVersion, getLocalVaultVersion } from './vaultSession/localArchive';
import { getVaultSession, setVaultSessionChecked } from './vaultSession/session';

/** Finalize only the local view of a previously verified, immutable operation.
 * There is no signing, upload, status fetch, draft replacement or vault selection. */
export async function finalizeIndependentOperation(id: string) {
  // Finalizers for different transactions must not race over the same local cache.
  return withDirectLock('local-finalization', () => withDirectLock(id, async () => {
    const operation = await requireOperation(id);
    requireDirect(operation.state === 'complete' && !operation.lastError && operation.txId &&
      operation.verification?.confirmed && operation.verification.bytesVerified, 'not_complete');
    await verifyArchiveBinding(operation);
    const otherOperations = await listDirectOperations({ vaultId: operation.vaultId });
    const envelope = parseEnvelope(JSON.parse(operation.archiveText));
    // This cache contains the parsed envelope. Exact original serialized bytes
    // remain unchanged in the durable journal and portable operation package.
    const canonical = serializeEnvelope(envelope);
    let saved = getLocalVaultVersion(operation.vaultId, operation.txId);
    if (!saved || saved.parentId !== operation.parentTxId || serializeEnvelope(saved.envelope) !== canonical) {
      archiveLocalVaultVersion({ id: operation.txId, vaultId: operation.vaultId, parentId: operation.parentTxId,
        source: 'network', envelope, savedAt: new Date(operation.updatedAt).toISOString() });
      saved = getLocalVaultVersion(operation.vaultId, operation.txId);
    }
    requireDirect(saved && saved.parentId === operation.parentTxId && serializeEnvelope(saved.envelope) === canonical, 'storage_unavailable');

    // Read session/cache only after all awaits. Do not change an explicitly
    // selected file, another vault, a newer head, or a subsequent preparation.
    const current = getVaultSession();
    if (!current || current.vaultId !== operation.vaultId || current.headTxId === operation.txId ||
      current.headTxId !== null && current.headTxId !== operation.parentTxId) return { operation, advanced: false };
    let cached: string | null;
    try { cached = localStorage.getItem('sejire.envelope.' + operation.vaultId); }
    catch { throw new DirectError('storage_unavailable'); }
    const explicitLocal = current.source === 'file' || current.source === 'local';
    if ((explicitLocal || current.headTxId === null) && cached !== operation.archiveText) return { operation, advanced: false };
    // localStorage is shared across tabs, sessionStorage is not. A later local
    // preparation may already own this exact cache even while this tab still
    // reports its network parent. Background completion must preserve it in
    // every unfinished state, including a cancelled free backup or a wallet
    // request whose result is unknown. It is not replaced by an older archive.
    if (otherOperations.some(other => other.id !== operation.id && other.state !== 'complete' &&
      other.archiveText === cached)) return { operation, advanced: false };

    const cacheKey = 'sejire.envelope.' + operation.vaultId;
    try {
      localStorage.setItem(cacheKey, canonical);
      requireDirect(localStorage.getItem(cacheKey) === canonical, 'storage_unavailable');
      // Omitted mnemonic preserves the existing matching in-memory phrase.
      // A failed session write rolls itself back before the previous cache is
      // restored below. No awaits may separate these two local selection writes.
      setVaultSessionChecked({ vaultId: operation.vaultId, headTxId: operation.txId, source: 'publish' });
    } catch {
      try {
        if (cached === null) localStorage.removeItem(cacheKey);
        else localStorage.setItem(cacheKey, cached);
      } catch { /* report failure even if storage also prevents rollback */ }
      // The immutable journal and archived version remain available for retry.
      throw new DirectError('storage_unavailable');
    }
    return { operation, advanced: true };
  }));
}

/** Repair local finalization after closing/reloading any completion screen. */
export async function reconcileIndependentCompletions(vaultId: string): Promise<void> {
  const operations = (await listDirectOperations({ vaultId })).filter(operation =>
    operation.state === 'complete' && !operation.lastError && operation.txId &&
    operation.verification?.confirmed && operation.verification.bytesVerified)
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  for (const operation of operations) await finalizeIndependentOperation(operation.id);
}
