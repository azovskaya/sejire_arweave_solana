import type Arweave from 'arweave';
import type Transaction from 'arweave/web/lib/transaction';
import { resolveArweaveStatic } from '../arweave/client';
import { PRESERVATION_V2_PILOT_POLICY as P, assertArchive } from './policy';
import { verifyRetrievedArchive } from './verify';
import type { SaveSession } from './types';

const NODE = 'https://arweave.net';
export type Wander = {
  connect(permissions: string[]): Promise<void>;
  getActiveAddress(): Promise<string>;
  getActivePublicKey(): Promise<string>;
  sign(tx: unknown, options?: unknown): Promise<unknown>;
};
export function wander(): Wander {
  const wallet = (window as Window & {arweaveWallet?: Wander}).arweaveWallet;
  if (!wallet) throw Error('wander_unavailable');
  return wallet;
}
function client(): Arweave {
  return resolveArweaveStatic().init({host:'arweave.net', port:443, protocol:'https', timeout:15_000});
}
function amount(value: string): bigint {
  if (!/^(0|[1-9]\d{0,29})$/.test(value)) throw Error('invalid_winston');
  return BigInt(value);
}
export function assertArQuote(address: string, bytes: number, reward: string, balance: string): void {
  if (address !== P.arReserve || bytes !== P.archiveBytes || amount(reward) > P.maxWinston ||
      amount(balance) < amount(reward) || amount(reward) <= 0n) throw Error('ar_budget_unavailable');
}
async function assertNetwork(ar: Arweave): Promise<void> {
  if ((await ar.network.getInfo()).network !== P.arweaveNetwork) throw Error('wrong_arweave_network');
}

export async function quoteArchive(address: string, bytes: number = P.archiveBytes): Promise<{reward: string; balance: string}> {
  if (address !== P.arReserve || bytes !== P.archiveBytes) throw Error('ar_pilot_binding');
  const ar = client(); await assertNetwork(ar);
  const [reward, balance] = await Promise.all([ar.transactions.getPrice(bytes), ar.wallets.getBalance(address)]);
  assertArQuote(address, bytes, reward, balance);
  return {reward, balance};
}

export async function validateSigned(session: SaveSession): Promise<Transaction> {
  await assertArchive(session.archiveText);
  if (!session.arSignedTransaction || !session.arTransactionId || !session.arRewardWinston) throw Error('unsigned_ar_transaction');
  const ar = client();
  const tx = ar.transactions.fromRaw(session.arSignedTransaction);
  if (tx.format !== 2 || tx.id !== session.arTransactionId || tx.reward !== session.arRewardWinston ||
      amount(tx.reward) > P.maxWinston || amount(tx.reward) <= 0n || tx.quantity !== '0' || tx.target !== '' ||
      tx.data_size !== String(P.archiveBytes) || new TextDecoder().decode(tx.data) !== session.archiveText ||
      await ar.wallets.ownerToAddress(tx.owner) !== P.arReserve || !await ar.transactions.verify(tx))
    throw Error('signed_ar_transaction_mismatch');
  if (tx.tags.length !== 3 ||
      tx.tags[0].get('name',{decode:true,string:true}) !== 'App-Name' || tx.tags[0].get('value',{decode:true,string:true}) !== 'SEJIRE' ||
      tx.tags[1].get('name',{decode:true,string:true}) !== 'Type' || tx.tags[1].get('value',{decode:true,string:true}) !== 'vault-envelope' ||
      tx.tags[2].get('name',{decode:true,string:true}) !== 'Save-Id' || tx.tags[2].get('value',{decode:true,string:true}) !== session.saveId)
    throw Error('signed_ar_tags_mismatch');
  const copy = ar.transactions.fromRaw({...session.arSignedTransaction, data_root:''});
  await copy.prepareChunks(tx.data);
  if (copy.data_root !== tx.data_root) throw Error('signed_ar_data_root_mismatch');
  return tx;
}

/** Caller persists signing intent before this function and signed result immediately after it. */
export async function signArchive(session: SaveSession, wallet: Wander, expectedReward: string): Promise<{id: string; reward: string; signed: ReturnType<Transaction['toJSON']>}> {
  await assertArchive(session.archiveText);
  if (await wallet.getActiveAddress() !== P.arReserve) throw Error('wrong_wander_address');
  const ar = client(); await assertNetwork(ar);
  const quote = await quoteArchive(P.arReserve);
  if (quote.reward !== expectedReward) throw Error('ar_quote_changed');
  const owner = await wallet.getActivePublicKey();
  if (await ar.wallets.ownerToAddress(owner) !== P.arReserve) throw Error('wrong_wander_address');
  const tx = await ar.createTransaction({data:new TextEncoder().encode(session.archiveText), owner, reward:quote.reward});
  tx.addTag('App-Name', 'SEJIRE'); tx.addTag('Type', 'vault-envelope'); tx.addTag('Save-Id', session.saveId);
  const result = await wallet.sign(tx, {name:'SEJIRE encrypted archive preservation'});
  const signed = ar.transactions.fromRaw(result as ReturnType<Transaction['toJSON']>);
  // Return the exact wallet result promptly. The caller journals it before validation or any upload.
  return {id:signed.id, reward:signed.reward, signed:signed.toJSON()};
}

export async function uploadSigned(session: SaveSession, persist: (progress: SaveSession['arUploadProgress']) => Promise<void>): Promise<void> {
  const tx = await validateSigned(session);
  const ar = client(); await assertNetwork(ar);
  const uploader = await ar.transactions.getUploader(session.arUploadProgress ?? tx, tx.data);
  while (!uploader.isComplete) {
    try { await uploader.uploadChunk(); }
    finally { await persist(uploader.toJSON()); }
  }
}

export async function verifyArweave(session: SaveSession): Promise<void> {
  if (!session.arTransactionId) throw Error('missing_ar_transaction');
  const ar = client(); await assertNetwork(ar);
  const status = await ar.transactions.getStatus(session.arTransactionId);
  if (status.status !== 200 || !status.confirmed || status.confirmed.number_of_confirmations < 1)
    throw Error('ar_confirmation_pending');
  const response = await fetch(`${NODE}/${session.arTransactionId}`, {credentials:'omit', referrerPolicy:'no-referrer', redirect:'error', signal:AbortSignal.timeout(15_000)});
  if (!response.ok || !response.body) throw Error('ar_retrieval_pending');
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let length = 0;
  try { for (;;) { const next = await reader.read(); if (next.done) break;
    length += next.value.length; if (length > P.archiveBytes) { await reader.cancel(); throw Error('retrieved_archive_too_large'); }
    chunks.push(next.value);
  } } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length); let offset=0;
  for (const chunk of chunks) { bytes.set(chunk,offset); offset += chunk.length; }
  await verifyRetrievedArchive(bytes);
}
