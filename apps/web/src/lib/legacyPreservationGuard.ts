/** Read-only migration boundary. Never resumes, changes or deletes a service order. */
export const LEGACY_APP_URL = 'https://azovskaya.github.io/sejire_arweave_solana/';
type Row = Record<string, unknown>;
const object = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};

async function existingRows(database: string, store: string, key?: string): Promise<unknown[]> {
  if (!globalThis.indexedDB) throw Error('legacy_journal_unavailable');
  return new Promise((resolve, reject) => {
    let absent = false;
    const request = indexedDB.open(database);
    // Abort an attempted creation. Reading the migration guard must not create,
    // upgrade or otherwise alter an old application's database.
    request.onupgradeneeded = () => { absent = true; request.transaction?.abort(); };
    request.onerror = () => absent ? resolve([]) : reject(Error('legacy_journal_unavailable'));
    request.onblocked = () => reject(Error('legacy_journal_unavailable'));
    request.onsuccess = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(store)) { db.close(); reject(Error('legacy_journal_unavailable')); return; }
      const tx = db.transaction(store, 'readonly');
      const read = key === undefined ? tx.objectStore(store).getAll(undefined, 1001) : tx.objectStore(store).get(key);
      let rows: unknown[] = [];
      read.onsuccess = () => { rows = key === undefined ? read.result : read.result === undefined ? [] : [read.result]; };
      tx.oncomplete = () => { db.close(); if (rows.length > 1000) reject(Error('legacy_journal_unavailable')); else resolve(rows); };
      tx.onerror = tx.onabort = () => { db.close(); reject(Error('legacy_journal_unavailable')); };
    };
  });
}

export async function hasLegacyPreservation(): Promise<boolean> {
  try {
    for (const storage of [localStorage, sessionStorage]) {
      for (let i = 0; i < storage.length; i++) {
        const key = storage.key(i);
        if (key?.startsWith('sejire.fundAttempt.v1.') || key?.startsWith('sejire-funded:')) return true;
      }
    }
    const [paid, pilot, native] = await Promise.all([
      existingRows('sejire-checkout-journal', 'operations'),
      existingRows('sejire-preservation-v2', 'sessions'),
      existingRows('sejire-native-pilot', 'cache', 'jobs'),
    ]);
    for (const raw of paid) {
      const row = object(raw);
      if (object(row.intent).kind === 'contribution') continue;
      if (row.version === 2 && (row.localCompletion === 'done' || row.localCompletion === 'released')) continue;
      if (row.version !== 2 && object(object(object(row.snapshot).record).states).preservation === 'completed') continue;
      return true;
    }
    if (pilot.some(raw => object(raw).state !== 'COMPLETE')) return true;
    // Old native jobs lack a portable completion marker in this cache. Their
    // original application must resolve them; a new payment is never inferred.
    for (const rows of native) {
      if (!Array.isArray(rows)) throw Error('legacy_journal_unavailable');
      if (rows.some(raw => object(object(raw).order).kind !== 'contribution')) return true;
    }
    return false;
  } catch (error) {
    if (error instanceof Error && error.message === 'legacy_journal_unavailable') throw error;
    throw Error('legacy_journal_unavailable');
  }
}

export async function assertNoLegacyPreservation(): Promise<void> {
  if (await hasLegacyPreservation()) throw Error('legacy_preservation_requires_original_app');
}
