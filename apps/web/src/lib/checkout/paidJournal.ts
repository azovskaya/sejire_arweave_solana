import { canonical } from '../../../../../packages/protocol/wire';
import { assertOrder } from '../../../../../packages/checkout/order';
import { paidPolicyHash, validatePaidPolicy } from '../../../../../packages/checkout/paid';
import { parseEnvelope, serializeEnvelope } from '../crypto/envelope';
import { envelopeDigest } from '../solana/policy';
import type { PaidOperation } from './paidTypes';

export type AttemptLookup = { vaultId?: string | null; treeId?: string | null };
const ID = /^[a-f0-9]{32}$/;
const HASH = /^[a-f0-9]{64}$/;
const TX = /^[A-Za-z0-9_-]{43}$/;
const TREE = /^[A-Za-z0-9_.:-]{1,128}$/;
const MAX_BYTES = 10 * 1024 * 1024;

// Use the existing database and stores. Old v1 records and their tokens survive
// upgrades, and old clients can still open database version 1 after rollback.
function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('sejire-checkout-journal', 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('operations', { keyPath: 'id' });
      request.result.createObjectStore('session', { keyPath: 'id' });
    };
    request.onerror = () => reject(Error('checkout_journal_unavailable'));
    request.onsuccess = () => resolve(request.result);
  });
}

async function read<T>(store: string, id?: string): Promise<T> {
  const database = await openDatabase();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = database.transaction(store);
      const request = id === undefined ? tx.objectStore(store).getAll() : tx.objectStore(store).get(id);
      request.onsuccess = () => resolve(request.result as T);
      request.onerror = () => reject(Error('checkout_journal_unavailable'));
    });
  } finally { database.close(); }
}

export async function validatePaidOperation(value: unknown): Promise<PaidOperation> {
  const op = value as PaidOperation;
  try {
    if (!op || op.version !== 2 || !ID.test(op.id) || !HASH.test(op.token) ||
        !Number.isSafeInteger(op.revision) || op.revision < 0 || !Number.isSafeInteger(op.createdAt) || op.createdAt <= 0 ||
        (op.treeId !== null && (typeof op.treeId !== 'string' || !TREE.test(op.treeId))) ||
        typeof op.serialized !== 'string' || op.serialized.length > MAX_BYTES ||
        !op.archive || !HASH.test(op.archive.digest) || !ID.test(op.archive.vaultId) ||
        (op.archive.parentTxId !== null && !TX.test(op.archive.parentTxId)) ||
        typeof op.createAttempted !== 'boolean' || typeof op.signingStarted !== 'boolean' ||
        !['pending', 'done', 'released'].includes(op.localCompletion) || op.intent?.kind !== 'preservation' ||
        !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(op.intent.payer) || typeof op.intent.contribution !== 'string') throw Error();
    const envelope = parseEnvelope(JSON.parse(op.serialized));
    if (serializeEnvelope(envelope) !== op.serialized || envelope.vault_id !== op.archive.vaultId ||
        new TextEncoder().encode(op.serialized).byteLength !== op.archive.bytes ||
        await envelopeDigest(op.serialized) !== op.archive.digest) throw Error();
    validatePaidPolicy(op.policy);
    if (await paidPolicyHash(op.policy) !== op.policyHash) throw Error();
    if (op.order) {
      assertOrder(op.order);
      if (op.order.schema !== 'sejire/order/v2' || op.order.policyHash !== op.policyHash ||
          op.order.payer !== op.intent.payer || canonical(op.order.archive) !== canonical(op.archive)) throw Error();
    }
    if (op.snapshot && (!op.order || canonical(op.snapshot.record.order) !== canonical(op.order))) throw Error();
    if (op.signature && !/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(op.signature)) throw Error();
    if (op.signedTransaction && (!op.signature || !op.signingStarted || op.signedTransaction.length > 4096)) throw Error();
    if (op.cancellationRequested !== undefined && typeof op.cancellationRequested !== 'boolean') throw Error();
    if (op.creationCancelled !== undefined && typeof op.creationCancelled !== 'boolean') throw Error();
    if (op.creationCancelled && (op.order || op.preparation || op.signature || op.signingStarted || op.snapshot)) throw Error();
    if (op.localCompletion === 'done' && op.snapshot?.execution?.status !== 'completed') throw Error();
    if (op.localCompletion === 'released' && ((!op.creationCancelled && !op.snapshot?.expired) || op.signingStarted || op.signature ||
        op.snapshot?.record.pendingSignature || op.snapshot?.record.payment || op.snapshot?.execution)) throw Error();
    return structuredClone(op);
  } catch { throw Error('invalid_paid_attempt'); }
}

export async function readPaidOperation(id: string): Promise<PaidOperation | null> {
  if (!ID.test(id)) throw Error('invalid_paid_attempt');
  const value = await read<unknown>('operations', id);
  if (value === undefined) return null;
  return validatePaidOperation(value);
}

/** Revision CAS also rejects a stale async callback if a second tab progressed. */
export async function writePaidOperation(op: PaidOperation): Promise<PaidOperation> {
  const checked = await validatePaidOperation(op);
  const database = await openDatabase();
  const next = { ...checked, revision: checked.revision + 1 };
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = database.transaction('operations', 'readwrite'), store = tx.objectStore('operations');
      const request = store.get(op.id);
      let failure = 'checkout_journal_unavailable';
      request.onsuccess = () => {
        const previous = request.result as PaidOperation | undefined;
        const immutable = (item: PaidOperation) => canonical({ id: item.id, token: item.token, createdAt: item.createdAt,
          treeId: item.treeId, serialized: item.serialized, archive: item.archive, policy: item.policy,
          policyHash: item.policyHash, intent: item.intent });
        if (previous ? previous.version !== 2 || previous.revision !== op.revision || immutable(previous) !== immutable(op) ||
            (previous.order && canonical(previous.order) !== canonical(op.order)) ||
            (previous.signature && previous.signature !== op.signature) ||
            (previous.signedTransaction && previous.signedTransaction !== op.signedTransaction) ||
            (previous.createAttempted && !op.createAttempted) ||
            (previous.cancellationRequested && !op.cancellationRequested) ||
            (previous.creationCancelled && !op.creationCancelled) ||
            (previous.localCompletion !== 'pending' && op.localCompletion !== previous.localCompletion) : op.revision !== 0) {
          failure = 'paid_attempt_changed'; tx.abort(); return;
        }
        try { store.put(next); } catch { tx.abort(); }
      };
      tx.oncomplete = () => resolve();
      tx.onabort = tx.onerror = () => reject(Error(failure));
    });
  } finally { database.close(); }
  const saved = await readPaidOperation(op.id);
  if (!saved || canonical(saved) !== canonical(next)) throw Error('checkout_journal_unavailable');
  return saved;
}

export async function findPaidAttempt(lookup: AttemptLookup): Promise<PaidOperation | null> {
  if (lookup.vaultId != null && !ID.test(lookup.vaultId)) throw Error('invalid_paid_attempt');
  if (lookup.treeId != null && !TREE.test(lookup.treeId)) throw Error('invalid_paid_attempt');
  const all = await read<unknown[]>('operations');
  if (all.length > 1000) throw Error('checkout_journal_unavailable');
  const paid: PaidOperation[] = [];
  for (const item of all) {
    if (item && typeof item === 'object' && 'version' in item && item.version === 2) {
      const op = await validatePaidOperation(item);
      if (op.localCompletion === 'pending') paid.push(op);
    } else {
      // An unresolved v1 preservation must not be silently replaced with a v2
      // payment. Its original UI/journal retains its separate execution path.
      const old = item as { envelope?: { vault_id?: string }; snapshot?: { record?: { states?: { preservation?: string } } } };
      if (old?.envelope?.vault_id && (!lookup.vaultId || old.envelope.vault_id === lookup.vaultId) &&
          old.snapshot?.record?.states?.preservation !== 'completed') throw Error('legacy_checkout_pending');
    }
  }
  const matches = paid.filter(op => (lookup.vaultId && op.archive.vaultId === lookup.vaultId) || (lookup.treeId && op.treeId === lookup.treeId));
  if (matches.length > 1 || (lookup.vaultId && matches.some(op => op.archive.vaultId !== lookup.vaultId)) ||
      (!lookup.vaultId && !lookup.treeId && paid.length) ||
      (!lookup.vaultId && !matches.length && paid.some(op => op.treeId === null))) throw Error('preservation_attempt_in_progress');
  return matches[0] ?? null;
}

type Session = { id: 'session'; token: string; expiresAt: number };
export const readPaidAccess = () => read<Session | undefined>('session', 'session');
export async function writePaidAccess(token: string, expiresAt: number): Promise<void> {
  if (!HASH.test(token) || !Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()) throw Error('invalid_checkout_session');
  const database = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = database.transaction('session', 'readwrite');
      tx.objectStore('session').put({ id: 'session', token, expiresAt });
      tx.oncomplete = () => resolve();
      tx.onabort = tx.onerror = () => reject(Error('checkout_journal_unavailable'));
    });
  } finally { database.close(); }
  const saved = await readPaidAccess();
  if (saved?.token !== token || saved.expiresAt !== expiresAt) throw Error('checkout_journal_unavailable');
}
