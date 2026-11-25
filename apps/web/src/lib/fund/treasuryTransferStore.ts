/** Public native AR transaction journal only. No administrator credential or wallet secret. */
export type TransferWire = { claimId: string; unsignedTx: string; signedTx: string | null; txId: string | null };
export type TransferAttempt = TransferWire & { schema: 'sejire/treasury-transfer/v1'; id: string; walletInvoked: boolean;
  submissionStarted: boolean; acknowledged: boolean; revision: number; createdAt: number };
const DATABASE = 'sejire-treasury-transfers-v1', TABLE = 'transfers';
const hex = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
const raw = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 65536;
export function checkedTransferWire(value: unknown): TransferWire {
  if (!value || typeof value !== 'object') throw Error('topup_transfer_invalid');
  const row = value as TransferWire;
  if (!hex(row.claimId) || !raw(row.unsignedTx) || !(row.signedTx === null || raw(row.signedTx)) ||
      !(row.txId === null || typeof row.txId === 'string' && /^[A-Za-z0-9_-]{43}$/.test(row.txId)) ||
      (row.signedTx === null) !== (row.txId === null)) throw Error('topup_transfer_invalid');
  return { claimId: row.claimId, unsignedTx: row.unsignedTx, signedTx: row.signedTx, txId: row.txId };
}
function checkedAttempt(value: unknown): TransferAttempt {
  const row = value as TransferAttempt, wire = checkedTransferWire(value);
  const keys = ['schema', 'id', 'claimId', 'unsignedTx', 'signedTx', 'txId', 'walletInvoked', 'submissionStarted', 'acknowledged', 'revision', 'createdAt'];
  if (Object.keys(row).some(key => !keys.includes(key)) || row.schema !== 'sejire/treasury-transfer/v1' || !hex(row.id) ||
      typeof row.walletInvoked !== 'boolean' || typeof row.submissionStarted !== 'boolean' || typeof row.acknowledged !== 'boolean' ||
      !Number.isSafeInteger(row.revision) || row.revision < 0 || !Number.isSafeInteger(row.createdAt) || row.createdAt < 0 ||
      (row.signedTx !== null && !row.walletInvoked) || (row.submissionStarted && !row.signedTx) || (row.acknowledged && !row.submissionStarted)) throw Error('topup_transfer_invalid');
  return { schema: row.schema, id: row.id, ...wire, walletInvoked: row.walletInvoked, submissionStarted: row.submissionStarted,
    acknowledged: row.acknowledged, revision: row.revision, createdAt: row.createdAt };
}
function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let request: IDBOpenDBRequest;
    try { request = indexedDB.open(DATABASE, 1); } catch { reject(Error('topup_transfer_storage')); return; }
    request.onupgradeneeded = () => request.result.createObjectStore(TABLE, { keyPath: 'id' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = request.onblocked = () => reject(Error('topup_transfer_storage'));
  });
}
export async function withTransferLock<T>(id: string, action: () => Promise<T>): Promise<T> {
  if (!hex(id) || typeof navigator === 'undefined' || !navigator.locks?.request) throw Error('topup_transfer_lock');
  return navigator.locks.request(`sejire-treasury-transfer:${id}`, { mode: 'exclusive' }, action);
}
export async function readTransferAttempt(id: string): Promise<TransferAttempt | null> {
  if (!hex(id)) throw Error('topup_transfer_invalid');
  const db = await database();
  try { return await new Promise((resolve, reject) => {
    const request = db.transaction(TABLE).objectStore(TABLE).get(id);
    request.onsuccess = () => { try { resolve(request.result ? checkedAttempt(request.result) : null); } catch (error) { reject(error); } };
    request.onerror = () => reject(Error('topup_transfer_storage'));
  }); } finally { db.close(); }
}
/** Callers hold the browser lock. CAS and immutable bytes also guard late wallet callbacks. */
export async function writeTransferAttempt(previous: TransferAttempt | null, value: TransferAttempt): Promise<TransferAttempt> {
  const next = checkedAttempt(value), db = await database();
  try { return await new Promise((resolve, reject) => {
    const tx = db.transaction(TABLE, 'readwrite'), store = tx.objectStore(TABLE), request = store.get(next.id);
    let failure: unknown;
    request.onsuccess = () => {
      try {
        const old = request.result ? checkedAttempt(request.result) : null;
        if (previous ? !old || old.revision !== previous.revision : old) throw Error('topup_transfer_conflict');
        if (old && (old.claimId !== next.claimId || old.unsignedTx !== next.unsignedTx || old.createdAt !== next.createdAt ||
            old.walletInvoked && !next.walletInvoked || old.submissionStarted && !next.submissionStarted || old.acknowledged && !next.acknowledged ||
            old.signedTx && (old.signedTx !== next.signedTx || old.txId !== next.txId))) throw Error('topup_transfer_conflict');
        next.revision = old ? old.revision + 1 : 0; store.put(next);
      } catch (error) { failure = error; tx.abort(); }
    };
    tx.oncomplete = () => resolve(next);
    tx.onabort = tx.onerror = () => reject(failure ?? Error('topup_transfer_storage'));
  }); } finally { db.close(); }
}
