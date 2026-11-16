import { DirectError, requireDirect } from './errors';
import { archiveInput, exactKeys, MAX_BACKUP_BYTES, sha256, validateOperation } from './format';
import type { DirectArchiveInput, DirectOperation, DirectOperationPackage } from './types';
import { assertNoLegacyPreservation } from '../legacyPreservationGuard';
import { verifyDirectSigned } from './transaction';

const DATABASE = 'sejire-direct-arweave-v1', TABLE = 'operations';
function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let request: IDBOpenDBRequest;
    try { request = indexedDB.open(DATABASE, 1); } catch { reject(new DirectError('storage_unavailable')); return; }
    request.onupgradeneeded = () => request.result.createObjectStore(TABLE, { keyPath: 'id' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = request.onblocked = () => reject(new DirectError('storage_unavailable'));
  });
}
export async function withDirectLock<T>(id: string, action: () => Promise<T>): Promise<T> {
  requireDirect(typeof navigator !== 'undefined' && navigator.locks?.request, 'browser_locks_required');
  return navigator.locks.request(`sejire-direct-arweave:${id}`, { mode: 'exclusive' }, action);
}
/** Shared with previous paid/promo tabs on this origin; never queries their services. */
async function withPreservationLock<T>(action: () => Promise<T>): Promise<T> {
  requireDirect(typeof navigator !== 'undefined' && navigator.locks?.request, 'browser_locks_required');
  return navigator.locks.request('sejire.preservation-attempts.v1', { mode: 'exclusive' }, action);
}
export async function withPreservationGuard<T>(action: () => Promise<T>): Promise<T> {
  return withPreservationLock(async () => {
    await assertNoLegacyPreservation();
    return action();
  });
}
export async function readDirectOperation(id: string): Promise<DirectOperation | null> {
  const db = await database();
  try { return await new Promise((resolve, reject) => {
    const request = db.transaction(TABLE).objectStore(TABLE).get(id);
    request.onsuccess = () => { try { resolve(request.result ? validateOperation(request.result) : null); } catch (error) { reject(error); } };
    request.onerror = () => reject(new DirectError('storage_unavailable'));
  }); } finally { db.close(); }
}
export async function listDirectOperations(filter: { vaultId?: string; treeId?: string | null } = {}): Promise<DirectOperation[]> {
  const db = await database();
  try { return await new Promise((resolve, reject) => {
    const request = db.transaction(TABLE).objectStore(TABLE).getAll();
    request.onsuccess = () => {
      try { resolve((request.result as DirectOperation[]).map(validateOperation).filter(operation =>
        (!filter.vaultId || operation.vaultId === filter.vaultId) && (filter.treeId === undefined || operation.treeId === filter.treeId))
        .sort((a, b) => b.updatedAt - a.updatedAt)); } catch (error) { reject(error); }
    };
    request.onerror = () => reject(new DirectError('storage_unavailable'));
  }); } finally { db.close(); }
}
const immutable = ['schema', 'id', 'vaultId', 'treeId', 'parentTxId', 'archiveText', 'archiveDigest', 'archiveBytes', 'createdAt'] as const;
/** Callers hold the operation lock; revision comparison also protects late wallet results. */
export async function writeDirectOperation(previous: DirectOperation | null, next: DirectOperation,
  options: { unrequestedSignatureReset?: boolean } = {}): Promise<DirectOperation> {
  validateOperation(next);
  const snapshot = structuredClone(next), db = await database();
  try { return await new Promise((resolve, reject) => {
    const tx = db.transaction(TABLE, 'readwrite'), table = tx.objectStore(TABLE), request = table.get(snapshot.id);
    let failure: unknown;
    request.onsuccess = () => {
      try {
        const old = request.result as DirectOperation | undefined;
        requireDirect(previous ? old?.revision === previous.revision : !old, 'storage_conflict');
        if (old) {
          validateOperation(old);
          requireDirect(immutable.every(key => old[key] === snapshot[key]), 'storage_conflict');
          requireDirect(!old.signedTx || JSON.stringify(old.signedTx) === JSON.stringify(snapshot.signedTx) && old.txId === snapshot.txId, 'storage_conflict');
          const safeReset = old.state === 'signing' && snapshot.state === 'prepared' && !snapshot.signingIntent && !old.signedTx &&
            (snapshot.lastError === 'wallet_rejected' || options.unrequestedSignatureReset === true && snapshot.lastError === 'operation_cancelled');
          requireDirect(!old.signingIntent || snapshot.signingIntent?.id === old.signingIntent.id || safeReset, 'storage_conflict');
          requireDirect(!old.signingIntent || !snapshot.signingIntent ||
            JSON.stringify(old.signingIntent) === JSON.stringify(snapshot.signingIntent), 'storage_conflict');
          requireDirect(!old.signingIntent || JSON.stringify(old.quote) === JSON.stringify(snapshot.quote), 'storage_conflict');
          requireDirect(old.state !== 'complete' || snapshot.state === 'complete', 'storage_conflict');
        }
        snapshot.revision = old ? old.revision + 1 : 0; snapshot.updatedAt = Date.now();
        table.put(snapshot);
      } catch (error) { failure = error; tx.abort(); }
    };
    tx.oncomplete = () => resolve(snapshot);
    tx.onerror = tx.onabort = () => reject(failure ?? new DirectError('storage_unavailable'));
  }); } finally { db.close(); }
}
export async function createDirectOperation(input: DirectArchiveInput): Promise<DirectOperation> {
  const archive = await archiveInput(input);
  const id = await operationId(archive.vaultId, archive.archiveDigest);
  return withPreservationGuard(() => withDirectLock('create', async () => {
    const all = await listDirectOperations({ vaultId: archive.vaultId });
    const existing = all.find(operation => operation.id === id);
    if (existing) {
      requireDirect(existing.parentTxId === archive.parentTxId, 'storage_conflict');
      if (existing.state !== 'cancelled') return existing;
      requireDirect(!all.some(operation => operation.id !== existing.id && !['complete', 'cancelled'].includes(operation.state)), 'pending_direct_operation');
      return writeDirectOperation(existing, { ...existing, state: 'prepared', quote: null, ownerAddress: null, lastError: null });
    }
    requireDirect(!all.some(operation => !['complete', 'cancelled'].includes(operation.state)), 'pending_direct_operation');
    const now = Date.now();
    return writeDirectOperation(null, { schema: 'sejire/direct-arweave-operation/v1', id, ...archive, state: 'prepared',
      ownerAddress: null, quote: null, signingIntent: null, signedTx: null, txId: null,
      uploadProgress: { node: null, headerAccepted: false, uploadedChunks: 0, totalChunks: 0 }, verification: null,
      lastError: null, createdAt: now, updatedAt: now, revision: 0 });
  }));
}
/** Cancels only a local preparation with no wallet signing intent; never deletes the backup. */
export async function cancelDirectOperation(id: string): Promise<DirectOperation> {
  return withPreservationLock(() => withDirectLock(id, async () => {
    const operation = await requireOperation(id);
    if (operation.state === 'cancelled') return operation;
    requireDirect(operation.state === 'prepared' && !operation.signingIntent && !operation.signedTx && !operation.txId, 'signature_pending');
    return writeDirectOperation(operation, { ...operation, state: 'cancelled', lastError: null });
  }));
}
async function operationId(vaultId: string, digest: string) {
  return sha256(new TextEncoder().encode(`sejire/direct-arweave/v1\0${vaultId}\0${digest}`));
}
export function exportDirectOperation(operation: DirectOperation): DirectOperationPackage {
  validateOperation(operation);
  requireDirect(operation.signedTx && operation.txId, 'signature_pending');
  return { schema: 'sejire/direct-arweave-package/v1', operation: structuredClone(operation) };
}
export async function importDirectOperation(value: unknown): Promise<DirectOperation> {
  requireDirect(new TextEncoder().encode(JSON.stringify(value)).length <= MAX_BACKUP_BYTES * 4 + 32_768, 'archive_too_large');
  exactKeys(value, ['schema', 'operation']);
  requireDirect(value.schema === 'sejire/direct-arweave-package/v1', 'invalid_operation');
  const incoming = validateOperation(structuredClone(value.operation) as DirectOperation);
  requireDirect(incoming.signedTx && incoming.txId && incoming.id === await operationId(incoming.vaultId, incoming.archiveDigest), 'signature_invalid');
  const tx = await verifyDirectSigned(incoming);
  const totalChunks = tx.chunks?.chunks.length; requireDirect(totalChunks && totalChunks <= 41, 'signature_invalid');
  return withPreservationGuard(() => withDirectLock('create', () => withDirectLock(incoming.id, async () => {
    const all = await listDirectOperations({ vaultId: incoming.vaultId }), old = all.find(operation => operation.id === incoming.id) ?? null;
    requireDirect(!all.some(operation => operation.id !== incoming.id && !['complete', 'cancelled'].includes(operation.state)), 'pending_direct_operation');
    if (old) {
      requireDirect(old.archiveText === incoming.archiveText && old.parentTxId === incoming.parentTxId, 'storage_conflict');
      if (old.signedTx) {
        requireDirect(JSON.stringify(old.signedTx) === JSON.stringify(incoming.signedTx) && old.txId === incoming.txId, 'storage_conflict');
        await verifyDirectSigned(old); return old;
      }
      if (old.signingIntent) requireDirect(JSON.stringify(old.signingIntent) === JSON.stringify(incoming.signingIntent) &&
        JSON.stringify(old.quote) === JSON.stringify(incoming.quote), 'storage_conflict');
    }
    // A portable package never imports a claim of network completion or upload progress.
    return writeDirectOperation(old, { ...(old ?? incoming), ownerAddress: incoming.ownerAddress, quote: incoming.quote,
      signingIntent: incoming.signingIntent, signedTx: incoming.signedTx, txId: incoming.txId,
      state: 'signed', verification: null, lastError: null,
      uploadProgress: { node: null, headerAccepted: false, uploadedChunks: 0, totalChunks } });
  })));
}
export async function requireOperation(id: string): Promise<DirectOperation> {
  const operation = await readDirectOperation(id); requireDirect(operation, 'operation_missing'); return operation;
}
