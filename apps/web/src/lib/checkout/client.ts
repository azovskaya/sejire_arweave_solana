import { canonical } from '../../../../../packages/protocol/wire';
import { PublicKey, Keypair, Transaction, TransactionInstruction, Connection } from '@solana/web3.js';
import bs58 from 'bs58';
import { Buffer } from 'buffer';
import type { SolanaWalletAdapter } from '@ardrive/turbo-sdk/web';
import { parseAmount, totalUnits } from '../../../../../packages/checkout/amounts';
import { assertOrder, type Order } from '../../../../../packages/checkout/order';
import type { EnvelopeV1 } from '../crypto/encrypt';
import { serializeEnvelope } from '../crypto/envelope';
import { envelopeDigest } from '../solana/policy';
import type { PreservationReceipt } from '../solana/receipt';
export type Intent = { kind: 'preservation' | 'contribution'; contribution: string; payer: string; archive?: { digest: string; bytes: number } };
export type Snapshot = { record: { order: Order; pendingSignature?: string; states: { payment: string; contribution: string; preservation: string }; payment?: { signature: string; feeLamports: string } };
  execution?: { id: string; accepted: { id: string; winc: string; [key: string]: unknown } | null; retrieved: boolean; vaultId: string } | null; verification?: { status: string; reason?: string } };
export type Operation = { authorizationCommitted?: boolean; authorization?: { message: Record<string, unknown>; signatures?: {publicKey:string;signature:string}[] }; id: string; token: string; intent: Intent; envelope?: EnvelopeV1; order?: Order; signature?: string; signedTransaction?: string; snapshot?: Snapshot; signingStarted?: boolean };
type Session = { id: 'session'; token: string; expiresAt: number };
function endpoint(): string {
  const configured = import.meta.env.VITE_CHECKOUT_API_URL || location.origin;
  const url = new URL(configured);
  if (url.origin !== configured || (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1')) throw new Error('invalid_checkout_endpoint');
  return url.origin + '/api/checkout';
}
async function api<T>(path: string, token?: string, payload?: unknown, key?: string): Promise<T> {
  const response = await fetch(endpoint() + path, { method: payload === undefined ? 'GET' : 'POST', credentials: 'omit', referrerPolicy: 'no-referrer',
    headers: { ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(key ? { 'Idempotency-Key': key } : {}) },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }), signal: AbortSignal.timeout(30000) });
  const value = await response.json();
  if (!response.ok) throw new Error(typeof value.error === 'string' ? value.error : 'checkout_requires_reconciliation');
  return value as T;
}
function db(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('sejire-checkout-journal', 1);
    request.onupgradeneeded = () => { request.result.createObjectStore('operations', { keyPath: 'id' }); request.result.createObjectStore('session', { keyPath: 'id' }); };
    request.onerror = () => reject(new Error('checkout_journal_unavailable'));
    request.onsuccess = () => resolve(request.result);
  });
}
async function save<T extends { id: string }>(store: string, value: T): Promise<void> {
  const database = await db();
  try { await new Promise<void>((resolve, reject) => { const tx = database.transaction(store, 'readwrite'); tx.objectStore(store).put(value); tx.oncomplete = () => resolve(); tx.onabort = tx.onerror = () => reject(new Error('checkout_journal_unavailable')); }); }
  finally { database.close(); }
}
export const saveOperation = (op: Operation) => save('operations', op);
export async function operations(): Promise<Operation[]> {
  const database = await db();
  try { return await new Promise((resolve, reject) => { const request = database.transaction('operations').objectStore('operations').getAll(); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(new Error('checkout_journal_unavailable')); }); }
  finally { database.close(); }
}
async function access(): Promise<string> {
  const database = await db(); let previous: Session | undefined;
  try { previous = await new Promise((resolve, reject) => { const request = database.transaction('session').objectStore('session').get('session'); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(new Error('checkout_journal_unavailable')); }); }
  finally { database.close(); }
  if (previous && previous.expiresAt > Date.now() + 60000) return previous.token;
  const result = await api<{ accessToken: string; expiresAt: number }>('/session', undefined, {});
  await save('session', { id: 'session', token: result.accessToken, expiresAt: result.expiresAt });
  return result.accessToken;
}
export async function startOrder(payer: string, contribution: string, envelope?: EnvelopeV1, wallet?: SolanaWalletAdapter): Promise<Operation> {
  const units = parseAmount(contribution, 9); totalUnits('0', units);
  if (!envelope && units === '0') throw new Error('invalid_contribution_order');
  const serialized = envelope ? serializeEnvelope(envelope) : undefined;
  const intent: Intent = { kind: envelope ? 'preservation' : 'contribution', payer, contribution,
    ...(serialized ? { archive: { digest: await envelopeDigest(serialized), bytes: new TextEncoder().encode(serialized).length } } : {}) };
  const op: Operation = { id: crypto.randomUUID().replace(/-/g, ''), token: await access(), intent, ...(envelope ? { envelope } : {}) };
  await saveOperation(op); // Idempotency key + intent survive LOST create response.
  return createOrResume(op, wallet);
}
export async function createOrResume(op: Operation, wallet?: SolanaWalletAdapter): Promise<Operation> {
  if (!op.order) {
    const result = await api<Snapshot & {authorization?:Record<string,unknown>}>('/orders', op.token, op.intent, op.id);
    assertOrder(result.record.order);
    const order = result.record.order;
    if (order.network !== 'devnet' || order.asset.symbol !== 'SOL' || order.payer !== op.intent.payer || order.kind !== op.intent.kind || order.fundContribution.amount !== parseAmount(op.intent.contribution, 9) || (op.intent.kind === 'preservation' ? BigInt(order.servicePayment.amount) <= 0n : order.servicePayment.amount !== '0') || order.archive?.digest !== op.intent.archive?.digest || order.archive?.bytes !== op.intent.archive?.bytes) throw new Error('checkout_order_mismatch');
    op.order = order; op.snapshot = result;
    if (result.authorization) {
      const cap=Keypair.fromSeed(Buffer.from(op.token,'hex')).publicKey.toBase58();
      const accessHash=await envelopeDigest(canonical(cap));
      const expected={order,accessHash};
      if(canonical(result.authorization.body)!==canonical(expected)||result.authorization.domain!=='sejire/protocol-journal/v1')throw new Error('unsigned_order_mismatch');
      op.authorization={message:result.authorization};
    }
    await saveOperation(op);
  }
  if(op.authorization&&!op.authorizationCommitted){
    if(!op.authorization.signatures){
      if(!wallet||wallet.publicKey.toString()!==op.order!.payer)throw new Error('order_signature_required');
      const signature=await wallet.signMessage(new TextEncoder().encode(canonical(op.authorization.message)));
      op.authorization.signatures=[{publicKey:op.order!.payer,signature:bs58.encode(signature instanceof Uint8Array?signature:signature.signature)}];await saveOperation(op);
    }
    op.snapshot=await api<Snapshot>(`/orders/${op.order!.id}/authorize`,op.token,op.authorization);
    op.authorizationCommitted=true;
    await saveOperation(op);
  }
  return op;
}
export async function refresh(op: Operation): Promise<Snapshot> {
  if (!op.order) await createOrResume(op);
  const snapshot = await api<Snapshot>(`/orders/${op.order!.id}`, op.token);
  if (JSON.stringify(snapshot.record.order) !== JSON.stringify(op.order)) throw new Error('checkout_order_mismatch');
  op.snapshot = snapshot;
  if (snapshot.record.pendingSignature) {
    if (op.signature && op.signature !== snapshot.record.pendingSignature) throw new Error('checkout_signature_mismatch');
    op.signature = snapshot.record.pendingSignature;
  }
  await saveOperation(op); return snapshot;
}
export type Prepared = { transaction: Transaction; lastValidBlockHeight: number; feeLamports: string };
export async function prepare(op: Operation): Promise<Prepared> {
  if (!op.order || op.signature || op.signingStarted) throw new Error('previous_payment_unresolved');
  const order = op.order;
  const accounts = await api<{ source: string; serviceDestination?: string; fundDestination?: string; blockhash: string; lastValidBlockHeight: number }>(`/orders/${order.id}/prepare`, op.token, {});
  const tx = new Transaction({ feePayer: new PublicKey(order.payer), recentBlockhash: accounts.blockhash });
  for (const purpose of ['servicePayment', 'fundContribution'] as const) {
    const part = order[purpose]; if (part.amount === '0') continue;
    const data = Buffer.alloc(12); data.writeUInt32LE(2, 0); data.writeBigUInt64LE(BigInt(part.amount), 4);
    tx.add(new TransactionInstruction({ programId: new PublicKey(order.asset.program), data, keys: [
      { pubkey: new PublicKey(order.payer), isSigner: true, isWritable: true },
      { pubkey: new PublicKey(part.recipient), isSigner: false, isWritable: true },
      { pubkey: new PublicKey(order.reference), isSigner: false, isWritable: false },
    ] }));
  }
  const connection = new Connection('https://api.devnet.solana.com', 'finalized');
  const fee = await connection.getFeeForMessage(tx.compileMessage(), 'finalized');
  if (fee.value === null || !Number.isSafeInteger(fee.value) || fee.value <= 0 || fee.value > 100000) throw new Error('network_fee_not_ready');
  return { transaction: tx, lastValidBlockHeight: accounts.lastValidBlockHeight, feeLamports: String(fee.value) };
}
export async function pay(op: Operation, wallet: SolanaWalletAdapter, prepared: Prepared): Promise<Snapshot> {
  if (!op.order || op.signature || op.signingStarted || wallet.publicKey.toString() !== op.order.payer) throw new Error('previous_payment_unresolved');
  if (op.order.expiresAt <= Date.now()) throw new Error('order_expired');
  const expected = prepared.transaction.serializeMessage().toString('base64');
  op.signingStarted = true; await saveOperation(op); // Reload while signing cannot start a new payment blindly.
  let signed;
  try { signed = await wallet.signTransaction(prepared.transaction); }
  catch (error) {
    // Explicit wallet rejection (4001), ONLY, proves no transaction was returned to broadcast.
    if (error && typeof error === 'object' && 'code' in error && error.code === 4001) { op.signingStarted = false; await saveOperation(op); }
    throw error;
  }
  if (signed.serializeMessage().toString('base64') !== expected || wallet.publicKey.toString() !== op.order.payer || !signed.signatures[0]?.signature) throw new Error('wallet_changed');
  op.signature = bs58.encode(signed.signatures[0].signature);
  const signedBytes: string = signed.serialize().toString('base64'); op.signedTransaction = signedBytes;
  await saveOperation(op); // Exact signature + bytes are durable BEFORE broadcast.
  // Reserve the signature server-side BEFORE network broadcast; null RPC is uncertainty, never unpaid.
  if (op.order.expiresAt <= Date.now()) throw new Error('order_expired_not_broadcast');
  await api(`/orders/${op.order.id}/reserve`, op.token, { signature: op.signature });
  const connection = new Connection('https://api.devnet.solana.com', 'finalized');
  try { await connection.sendRawTransaction(Buffer.from(signedBytes, 'base64'), { skipPreflight: false, maxRetries: 2 }); }
  catch { return refresh(op); } // Unknown result: retry ONLY identical bytes/reconcile.
  return reconcile(op);
}
export async function reconcile(op: Operation): Promise<Snapshot> {
  await refresh(op);
  if (!op.order || !op.signature) throw new Error('no_pending_payment');
  const snapshot = op.snapshot?.record.pendingSignature
    ? await api<Snapshot & { reason?: string }>(`/orders/${op.order.id}/reconcile`, op.token, {})
    : await api<Snapshot & { reason?: string }>(`/orders/${op.order.id}/verify`, op.token, { signature: op.signature });
  if (!snapshot.record.payment && snapshot.reason === 'not-found' && op.signedTransaction && op.order.expiresAt > Date.now()) {
    // Re-submit the EXACT signed transaction if reserve response/broadcast response was lost.
    // Same signature means no new payment, even if the first broadcast already succeeded.
    try { await new Connection('https://api.devnet.solana.com', 'finalized').sendRawTransaction(Buffer.from(op.signedTransaction, 'base64'), { skipPreflight: false, maxRetries: 2 }); } catch { /* retain uncertainty */ }
  }
  op.snapshot = snapshot; await saveOperation(op); return snapshot;
}
export async function execute(op: Operation): Promise<Snapshot> {
  if (!op.order || !op.envelope) throw new Error('no_archive');
  const snapshot = await api<Snapshot>(`/orders/${op.order.id}/execute`, op.token, { serialized: serializeEnvelope(op.envelope) });
  op.snapshot = snapshot; await saveOperation(op); return snapshot;
}
export function preservationReceipt(op: Operation): PreservationReceipt & { checkout: { orderId: string; paymentSignature: string; servicePayment: Order['servicePayment']; fundContribution: Order['fundContribution']; networkFeeLamports: string } } {
  const snapshot = op.snapshot, accepted = snapshot?.execution?.accepted;
  if (!op.order || !op.envelope || !accepted || !snapshot.record.payment) throw new Error('receipt_not_ready');
  return { schema: 'sejire/preservation-receipt/v1', network: 'devnet', status: 'accepted-by-turbo', wallet: op.order.payer,
    vaultId: op.envelope.vault_id, envelopeSha256: op.order.archive!.digest, acceptedAt: typeof accepted.sejireAcceptedAt === 'string' ? accepted.sejireAcceptedAt : new Date().toISOString(),
    receipt: accepted as PreservationReceipt['receipt'], checkout: { orderId: op.order.id, paymentSignature: snapshot.record.payment.signature, servicePayment: op.order.servicePayment, fundContribution: op.order.fundContribution, networkFeeLamports: snapshot.record.payment.feeLamports } };
}
