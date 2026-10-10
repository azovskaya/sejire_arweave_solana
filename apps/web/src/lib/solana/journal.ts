import type { EnvelopeV1 } from "../crypto/encrypt";
import type { SolanaNetwork } from "./policy";
import type { PreservationReceipt } from "./receipt";

export type UploadOperation = {
  key: string;
  walletKey: string;
  network: SolanaNetwork;
  address: string;
  digest: string;
  envelope: EnvelopeV1;
  parentTxId?: string | null;
  dataItemId: string;
  signedData: Blob;
  createdAt: string;
  payment?: { signature?: string; lamports: string; status: "signing" | "signed" | "credited" };
  receipt?: PreservationReceipt;
};

export interface UploadJournal {
  get(key: string): Promise<UploadOperation | undefined>;
  put(operation: UploadOperation): Promise<void>;
  forWallet(walletKey: string): Promise<UploadOperation[]>;
}

/** Signed ciphertext and payment references survive reloads. Never stores recovery words or private keys. */
export function createUploadJournal(): UploadJournal {
  let opened: Promise<IDBDatabase> | undefined;
  function db() {
    return opened ??= new Promise<IDBDatabase>((resolve, reject) => {
      if (typeof indexedDB === "undefined") { reject(new Error("journal_unavailable")); return; }
      const request = indexedDB.open("sejire-preservation-v1", 1);
      request.onupgradeneeded = () => {
        const store = request.result.createObjectStore("uploads", { keyPath: "key" });
        store.createIndex("walletKey", "walletKey");
      };
      request.onsuccess = () => {
        request.result.onversionchange = () => { request.result.close(); opened = undefined; };
        resolve(request.result);
      };
      request.onerror = () => reject(new Error("journal_unavailable"));
      request.onblocked = () => reject(new Error("journal_unavailable"));
    });
  }
  async function transaction<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>) {
    try {
      const database = await db();
      return await new Promise<T>((resolve, reject) => {
        const tx = database.transaction("uploads", mode);
        const request = action(tx.objectStore("uploads"));
        tx.oncomplete = () => resolve(request.result);
        tx.onerror = tx.onabort = () => reject(new Error("journal_unavailable"));
      });
    } catch { throw new Error("journal_unavailable"); }
  }
  return {
    get: (key) => transaction<UploadOperation | undefined>("readonly", (store) => store.get(key)),
    put: async (operation) => { await transaction("readwrite", (store) => store.put(operation)); },
    forWallet: (key) => transaction<UploadOperation[]>("readonly", (store) => store.index("walletKey").getAll(key)),
  };
}

export const uploadJournal = createUploadJournal();

const running = new Set<string>();
export async function withUploadLock<T>(walletKey: string, action: () => Promise<T>): Promise<T> {
  if (running.has(walletKey)) throw new Error("upload_in_progress");
  running.add(walletKey);
  try {
    if (typeof navigator !== "undefined" && navigator.locks) {
      return await navigator.locks.request(`sejire:${walletKey}`, { ifAvailable: true }, async (lock) => {
        if (!lock) throw new Error("upload_in_progress");
        return action();
      });
    }
    // Headless Node tests inject a journal; browser uploads require cross-tab exclusion.
    if (typeof window !== "undefined") throw new Error("upload_lock_unavailable");
    return await action();
  } finally { running.delete(walletKey); }
}
