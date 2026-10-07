import { PublicKey } from '@solana/web3.js';
import { assertArchive, PRESERVATION_V2_PILOT_POLICY as P, saveId, sha256 } from './policy';
import type { SaveSession, SaveState } from './types';

const DB = 'sejire-preservation-v2';
const TABLE = 'sessions';
const transitions: Record<SaveState, SaveState[]> = {
  READY: ['SOLANA_PREPARED', 'BLOCKED'], SOLANA_PREPARED: ['SOLANA_PENDING', 'READY', 'BLOCKED'],
  SOLANA_PENDING: ['SOLANA_PAID', 'SOLANA_PREPARED', 'READY', 'BLOCKED'],
  SOLANA_PAID: ['AR_READY', 'BLOCKED'], AR_READY: ['AR_SIGNED', 'BLOCKED'],
  AR_SIGNED: ['AR_UPLOADING', 'BLOCKED'], AR_UPLOADING: ['AR_PENDING_CONFIRMATION', 'BLOCKED'],
  AR_PENDING_CONFIRMATION: ['COMPLETE', 'BLOCKED'], COMPLETE: [], BLOCKED: [],
};

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(TABLE, { keyPath: 'saveId' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function readSession(id: string): Promise<SaveSession | undefined> {
  const db = await openDb();
  try { return await new Promise((resolve, reject) => {
    const req = db.transaction(TABLE, 'readonly').objectStore(TABLE).get(id);
    req.onsuccess = () => resolve(req.result as SaveSession | undefined);
    req.onerror = () => reject(req.error);
  }); } finally { db.close(); }
}

export async function updateSession(id: string, update: (s: SaveSession) => SaveSession): Promise<SaveSession> {
  const db = await openDb();
  try { return await new Promise((resolve, reject) => {
    const tx = db.transaction(TABLE, 'readwrite');
    const table = tx.objectStore(TABLE);
    let next: SaveSession | undefined;
    const req = table.get(id);
    req.onsuccess = () => {
      try {
        const old = req.result as SaveSession | undefined;
        if (!old) throw Error('session_missing');
        next = update(old);
        if (next.saveId !== old.saveId || next.schema !== old.schema || next.archiveDigest !== old.archiveDigest ||
            next.archiveText !== old.archiveText || next.payer !== old.payer || next.solanaReference !== old.solanaReference)
          throw Error('immutable_session_binding');
        if (next.state !== old.state && !transitions[old.state].includes(next.state)) throw Error('invalid_state_transition');
        next.revision = old.revision + 1; next.updatedAt = Date.now();
        table.put(next);
      } catch (error) { tx.abort(); reject(error); }
    };
    tx.oncomplete = () => resolve(next!);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? Error('session_update_aborted'));
  }); } finally { db.close(); }
}

export async function startSession(archiveText: string): Promise<SaveSession> {
  await assertArchive(archiveText);
  const id = await saveId();
  // A 32-byte deterministic, non-secret reference remains stable across all retries.
  const reference = new PublicKey(Uint8Array.from((await sha256(new TextEncoder().encode(`reference\0${id}`))).match(/../g)!.map(x => parseInt(x, 16)))).toBase58();
  const db = await openDb();
  try { return await new Promise((resolve, reject) => {
    const tx = db.transaction(TABLE, 'readwrite'); const table = tx.objectStore(TABLE);
    let session: SaveSession;
    const req = table.get(id);
    req.onsuccess = () => {
      const existing = req.result as SaveSession | undefined;
      if (existing) {
        if (existing.archiveText !== archiveText || existing.solanaReference !== reference) { tx.abort(); reject(Error('session_binding_mismatch')); return; }
        session = existing;
      } else {
        session = { schema: 'sejire/preservation-v2/v1', saveId: id, vaultId: P.vaultId,
          archiveDigest: P.archiveDigest, archiveBytes: P.archiveBytes, archiveText,
          payer: P.payer, solanaReference: reference, state: 'READY',
          createdAt: Date.now(), updatedAt: Date.now(), revision: 0 };
        table.put(session);
      }
    };
    tx.oncomplete = () => resolve(session!);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? Error('session_start_aborted'));
  }); } finally { db.close(); }
}

export async function withSessionLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
  if (!navigator.locks?.request) throw Error('browser_locks_required');
  return navigator.locks.request(`sejire-preservation-v2-${id}`, { mode: 'exclusive' }, fn);
}
