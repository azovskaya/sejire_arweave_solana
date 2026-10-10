import type Arweave from 'arweave';
import type Transaction from 'arweave/web/lib/transaction';
import { resolveArweaveStatic } from '../arweave/client';
import { PRESERVATION_V2_PILOT_POLICY as P, assertArchive } from './policy';
import { verifyRetrievedArchive } from './verify';
import { withTimeout } from './timeout';
import legacyLocators from '../recovery/legacy-locators.v1.json';
import type { SaveSession } from './types';

const NODE = 'https://arweave.net';
const RAW_GATEWAYS = [NODE, 'https://ar-io.net', 'https://g8way.io'] as const;
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

export function preservationV2Tags(session: Pick<SaveSession,'saveId'|'vaultId'|'archiveDigest'|'archiveBytes'> & {parentTxId?:string|null}): {name:string;value:string}[] {
  return [{name:'App-Name',value:'SEJIRE'},{name:'Type',value:'vault-envelope'},
    {name:'Save-Id',value:session.saveId},{name:'Vault-Id',value:session.vaultId},
    {name:'Archive-SHA256',value:session.archiveDigest},{name:'Archive-Bytes',value:String(session.archiveBytes)},
    {name:'Schema',value:'sejire/envelope/v1'},{name:'Protocol-Version',value:'sejire/v0.3'},
    ...(session.parentTxId?[{name:'Parent-Tx',value:session.parentTxId}]:[])];
}

export function assertSignedArTags(tags:{name:string;value:string}[],session:Pick<SaveSession,'saveId'|'vaultId'|'archiveDigest'|'archiveBytes'> & {parentTxId?:string|null},allowLegacy=false):void {
  const names=tags.map(tag=>tag.name);
  if (new Set(names).size!==names.length) throw Error('signed_ar_tags_mismatch');
  const required=new Map(preservationV2Tags(session).map(tag=>[tag.name,tag.value]));
  if (allowLegacy) for(const name of ['Vault-Id','Archive-SHA256','Archive-Bytes','Schema','Protocol-Version'])
    if(!tags.some(tag=>tag.name===name))required.delete(name);
  for(const [name,value] of required)if(tags.find(tag=>tag.name===name)?.value!==value)throw Error('signed_ar_tags_mismatch');
  for(const tag of tags){
    if(required.has(tag.name))continue;
    if(tag.name==='Signing-Client' && ['Wander','Wander Connect'].includes(tag.value))continue;
    if(tag.name==='Signing-Client-Version' && tag.value.length>0 && tag.value.length<=64)continue;
    throw Error('signed_ar_tags_mismatch');
  }
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
  const tags=tx.tags.map(tag=>({name:tag.get('name',{decode:true,string:true}),value:tag.get('value',{decode:true,string:true})}));
  const legacy=legacyLocators.entries.some(entry=>entry.txIds.includes(session.arTransactionId!)&&entry.vaultId===session.vaultId&&
    entry.archiveBytes===session.archiveBytes&&entry.archiveSha256===session.archiveDigest);
  assertSignedArTags(tags,session,legacy);
  const copy = ar.transactions.fromRaw({...session.arSignedTransaction, data_root:''});
  await copy.prepareChunks(tx.data);
  if (copy.data_root !== tx.data_root) throw Error('signed_ar_data_root_mismatch');
  return tx;
}

/** Caller persists signing intent before this function and signed result immediately after it. */
export async function signArchive(session: SaveSession, wallet: Wander, expectedReward: string, beforeSign?:()=>Promise<void>, signTimeoutMs=60_000): Promise<{id: string; reward: string; signed: ReturnType<Transaction['toJSON']>}> {
  await assertArchive(session.archiveText);
  if (await wallet.getActiveAddress() !== P.arReserve) throw Error('wrong_wander_address');
  const ar = client(); await assertNetwork(ar);
  const quote = await quoteArchive(P.arReserve);
  if (quote.reward !== expectedReward) throw Error('ar_quote_changed');
  const owner = await wallet.getActivePublicKey();
  if (await ar.wallets.ownerToAddress(owner) !== P.arReserve) throw Error('wrong_wander_address');
  const tx = await ar.createTransaction({data:new TextEncoder().encode(session.archiveText), owner, reward:quote.reward});
  for (const tag of preservationV2Tags(session)) tx.addTag(tag.name,tag.value);
  await beforeSign?.();
  const result = await withTimeout(wallet.sign(tx, {name:'SEJIRE encrypted archive preservation'}),signTimeoutMs,'wander_response_timeout');
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

export async function retrieveVerifiedArchive(
  transactionId: string,
  gateways: string | readonly string[] = RAW_GATEWAYS,
  expected: Parameters<typeof verifyRetrievedArchive>[1] = P,
): Promise<void> {
  let pending = false;
  let verificationError: Error | undefined;
  for (const gateway of typeof gateways === 'string' ? [gateways] : gateways) {
    try {
      await retrieveFromGateway(transactionId, gateway, expected);
      return;
    } catch (error) {
      if (error instanceof Error && error.message === 'ar_retrieval_pending') pending = true;
      else if (error instanceof Error && error.message !== 'ar_retrieval_failed') verificationError ??= error;
    }
  }
  if (verificationError) throw verificationError;
  throw Error(pending ? 'ar_retrieval_pending' : 'ar_retrieval_failed');
}

async function retrieveFromGateway(
  transactionId: string,
  gateway: string,
  expected: NonNullable<Parameters<typeof verifyRetrievedArchive>[1]>,
): Promise<void> {
  let response: Response;
  try {
    response = await fetch(`${gateway.replace(/\/+$/, '')}/raw/${transactionId}`, {credentials:'omit', referrerPolicy:'no-referrer', redirect:'follow', signal:AbortSignal.timeout(15_000)});
  } catch { throw Error('ar_retrieval_failed'); }
  if (response.status === 404 || response.status === 202) throw Error('ar_retrieval_pending');
  if (!response.ok || !response.body) throw Error('ar_retrieval_failed');
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let length = 0;
  try { for (;;) { const next = await reader.read(); if (next.done) break;
    length += next.value.length; if (length > expected.archiveBytes) { await reader.cancel(); throw Error('retrieved_archive_too_large'); }
    chunks.push(next.value);
  } } catch(error) {
    if (error instanceof Error && error.message === 'retrieved_archive_too_large') throw error;
    throw Error('ar_retrieval_failed');
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length); let offset=0;
  for (const chunk of chunks) { bytes.set(chunk,offset); offset += chunk.length; }
  await verifyRetrievedArchive(bytes,expected);
}

export async function verifyArweave(session: SaveSession): Promise<void> {
  if (!session.arTransactionId) throw Error('missing_ar_transaction');
  const ar = client(); await assertNetwork(ar);
  const status = await ar.transactions.getStatus(session.arTransactionId);
  if (status.status !== 200 || !status.confirmed || status.confirmed.number_of_confirmations < 1)
    throw Error('ar_confirmation_pending');
  await retrieveVerifiedArchive(session.arTransactionId);
}
