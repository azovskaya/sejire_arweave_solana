import { Buffer } from 'buffer';
import bs58 from 'bs58';
import { Message, Transaction } from '@solana/web3.js';
import type { SolanaWalletAdapter } from '@ardrive/turbo-sdk/web';
import { canonical } from '../../../../../packages/protocol/wire';
import { assertUnits, parseAmount, totalUnits } from '../../../../../packages/checkout/amounts';
import { parseRpcJson, rpcU64 } from '../../../../../packages/checkout/rpcJson';
import { assertBase58, assertOrder } from '../../../../../packages/checkout/order';
import {
  paidPolicyHash, validatePaidPolicy, validateContributionPolicy, validatePaidOrderPolicy, validatePaymentPreparation,
  validatePaidReceipt, SOLANA_RPCS, SOLANA_GENESIS, type DurablePaymentPreparation,
} from '../../../../../packages/checkout/paid';
import { parseEnvelope, serializeEnvelope } from '../crypto/envelope';
import { envelopeDigest } from '../solana/policy';
import { readPaidAccess, writePaidAccess, withPaidAccessLock, readPaidOperation, writePaidOperation, findContributionAttempt } from './paidJournal';
import { announcePreservationChange, reservePaidAttempt, withPaidOperationLock } from './vaultGuard';
import type { ContributionReceipt, PaidCompletion, PaidCreationCancellation, PaidInput, PaidOperation, PaidPolicyResponse, PaidSnapshot } from './paidTypes';

export class PaidApiError extends Error {
  readonly status: number;
  readonly stage: 'create' | 'other';
  constructor(code: string, status: number, stage: 'create' | 'other' = 'other') {
    super(code); this.name = 'PaidApiError'; this.status = status; this.stage = stage;
  }
}

function endpoint(): string {
  const raw = import.meta.env?.VITE_CHECKOUT_API_URL || import.meta.env?.VITE_FUND_API_URL || location.origin;
  const url = new URL(raw);
  if (url.origin !== raw || (url.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(url.hostname))) throw Error('invalid_checkout_endpoint');
  return url.origin + '/api/checkout';
}

async function jsonRequest(url: string, init: RequestInit, signal?: AbortSignal, decode: (source: string) => unknown = JSON.parse): Promise<{ status: number; value: unknown; retryAfter: string | null }> {
  const ctrl = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let body: ReadableStream<Uint8Array> | null = null;
  let rejectAbort: (error: Error) => void = () => {};
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  const cancel = () => { ctrl.abort(); void reader?.cancel().catch(() => {}); rejectAbort(Error('checkout_request_timed_out')); };
  if (signal?.aborted) cancel(); else signal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(cancel, 30000);
  const read = async () => {
    if (ctrl.signal.aborted) throw Error('checkout_request_timed_out');
    const response = await fetch(url, { ...init, credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error', cache: 'no-store', signal: ctrl.signal });
    body = response.body;
    const cap = 1024 * 1024;
    const declared = response.headers.get('content-length');
    if (declared && (!/^\d+$/.test(declared) || Number(declared) > cap)) throw Error('checkout_response_too_large');
    if (!response.body) throw Error('checkout_response_missing');
    reader = response.body.getReader(); let size = 0; const chunks: Uint8Array[] = [];
    for (;;) { const next = await reader.read(); if (ctrl.signal.aborted) throw Error('checkout_request_timed_out'); if (next.done) break; size += next.value.length; if (size > cap) throw Error('checkout_response_too_large'); chunks.push(next.value); }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return { status: response.status, value: decode(new TextDecoder('utf-8', { fatal: true }).decode(bytes)), retryAfter: response.headers.get('Retry-After') };
  };
  try { return await Promise.race([read(), aborted]); }
  finally { ctrl.abort(); void (reader ? reader.cancel() : (body as ReadableStream<Uint8Array> | null)?.cancel())?.catch(() => {}); clearTimeout(timer); signal?.removeEventListener('abort', cancel); }
}

async function api<T>(path: string, token?: string, payload?: unknown, key?: string, signal?: AbortSignal): Promise<T> {
  let response: Awaited<ReturnType<typeof jsonRequest>>;
  try {
    response = await jsonRequest(endpoint() + path, { method: payload === undefined ? 'GET' : 'POST',
      headers: { ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(key ? { 'Idempotency-Key': key } : {}) },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) }, signal);
  } catch (error) {
    if (path !== '/orders') throw error;
    const code = error instanceof Error && ['checkout_request_timed_out','checkout_response_too_large','checkout_response_missing'].includes(error.message)
      ? error.message : 'checkout_transport_failed';
    throw new PaidApiError(code, 0, 'create');
  }
  if (response.status < 200 || response.status >= 300) {
    const code = (response.value as { error?: unknown })?.error;
    throw new PaidApiError(typeof code === 'string' ? code : 'checkout_requires_reconciliation', response.status,
      path === '/orders' ? 'create' : 'other');
  }
  return response.value as T;
}

export async function readPaidPolicy(signal?: AbortSignal, kind: 'preservation' | 'contribution' = 'preservation'): Promise<PaidPolicyResponse> {
  const value = await api<PaidPolicyResponse>(kind === 'contribution' ? '/policy/contribution' : '/policy', undefined, undefined, undefined, signal);
  if (!value || typeof value.ready !== 'boolean' ||
      (value.contributionReady !== undefined && typeof value.contributionReady !== 'boolean')) throw Error('invalid_paid_policy');
  if (value.policy !== undefined) {
    validatePaidPolicy(value.policy);
    if (await paidPolicyHash(value.policy) !== value.policyHash) throw Error('paid_policy_mismatch');
  }
  if (value.contributionPolicy !== undefined) {
    validateContributionPolicy(value.contributionPolicy);
    if (await paidPolicyHash(value.contributionPolicy) !== value.contributionPolicyHash) throw Error('paid_policy_mismatch');
  }
  if ((value.ready && !value.policy) || (value.contributionReady && !value.contributionPolicy) ||
      (value.policyHash !== undefined && value.policy === undefined) ||
      (value.contributionPolicyHash !== undefined && value.contributionPolicy === undefined)) throw Error('invalid_paid_policy');
  return value;
}

async function access(): Promise<string> {
  return withPaidAccessLock(async () => {
    const previous = await readPaidAccess();
    if (previous && previous.expiresAt > Date.now() + 60000 && /^[a-f0-9]{64}$/.test(previous.token)) return previous.token;
    const value = await api<{ accessToken: string; expiresAt: number }>('/session', undefined, {});
    await writePaidAccess(value.accessToken, value.expiresAt);
    return value.accessToken;
  });
}

export async function validatePaidSnapshot(op: PaidOperation, value: unknown): Promise<PaidSnapshot> {
  const snapshot = value as PaidSnapshot;
  if (!snapshot?.record?.order || !snapshot.record.states) throw Error('checkout_order_mismatch');
  const order = snapshot.record.order;
  assertOrder(order);
  if (order.schema !== 'sejire/order/v2' || order.asset.symbol !== 'SOL' || order.payer !== op.intent.payer ||
      order.kind!==op.intent.kind || order.fundContribution.amount !== parseAmount(op.intent.contribution, 9) || canonical(order.archive??null) !== canonical(op.archive) ||
      order.policyHash !== op.policyHash || canonical(snapshot.policy) !== canonical(op.policy) ||
      (op.order && canonical(op.order) !== canonical(order))) throw Error('checkout_order_mismatch');
  await validatePaidOrderPolicy(order, op.policy);
  const states = snapshot.record.states;
  if (!['awaiting-payment', 'requires-reconciliation', 'verified'].includes(states.payment) ||
      !['not-requested', 'awaiting-payment', 'requires-reconciliation', 'received'].includes(states.contribution) ||
      !['awaiting-payment', 'ready', 'running', 'requires-reconciliation', 'completed', 'not-applicable'].includes(states.preservation) ||
      (order.kind === 'contribution' ? states.preservation !== 'not-applicable' : states.preservation === 'not-applicable')) throw Error('checkout_state_mismatch');
  const expectedContribution = order.fundContribution.amount === '0' ? 'not-requested' :
    states.payment === 'verified' ? 'received' : states.payment;
  if (states.contribution !== expectedContribution) throw Error('checkout_state_mismatch');
  const signature = snapshot.record.payment?.signature ?? snapshot.record.pendingSignature;
  if (signature !== undefined) { assertBase58(signature, 64); if (op.signature && signature !== op.signature) throw Error('checkout_signature_mismatch'); }
  if (snapshot.record.payment) {
    if (states.payment !== 'verified' || typeof snapshot.record.payment.feeLamports !== 'string' ||
        (snapshot.record.pendingSignature && snapshot.record.pendingSignature !== snapshot.record.payment.signature)) throw Error('checkout_payment_mismatch');
    assertUnits(snapshot.record.payment.feeLamports);
  } else if (states.payment === 'verified') throw Error('checkout_payment_mismatch');
  if (snapshot.preparation) {
    await validatePaymentPreparation(order, snapshot.preparation);
    if (op.signingStarted && op.preparation && canonical(op.preparation) !== canonical(snapshot.preparation)) throw Error('payment_preparation_mismatch');
  }
  if ((snapshot.expired !== undefined && typeof snapshot.expired !== 'boolean') ||
      (snapshot.cancelled !== undefined && typeof snapshot.cancelled !== 'boolean')) throw Error('checkout_state_mismatch');
  if (snapshot.cancelled && !snapshot.expired) throw Error('checkout_state_mismatch');
  if (snapshot.expired && (snapshot.record.payment || snapshot.record.pendingSignature || snapshot.execution ||
      op.signature || op.signingStarted || (!snapshot.cancelled && (snapshot.preparation || op.preparation)))) throw Error('checkout_release_mismatch');
  const execution = snapshot.execution;
  if(order.kind==='contribution'&&execution!==null)throw Error('checkout_execution_mismatch');
  if (execution) {
    if(order.kind!=='preservation'||op.policy.schema!=='sejire/checkout-policy/v1')throw Error('checkout_execution_mismatch');
    if (execution.kind !== 'arweave-direct' || !['queued', 'signed', 'submitted', 'confirming', 'completed', 'requires-reconciliation'].includes(execution.status) ||
        (execution.txId !== null && !/^[A-Za-z0-9_-]{43}$/.test(execution.txId))) throw Error('checkout_execution_mismatch');
    if (execution.reason !== undefined && !/^[a-z0-9_-]{1,100}$/.test(execution.reason)) throw Error('checkout_execution_mismatch');
    const proof = execution.verification;
    if (proof && (typeof proof.transactionConfirmed !== 'boolean' || typeof proof.archiveVerified !== 'boolean' ||
        proof.owner !== order.storage.treasuryAddress || canonical(proof.archive) !== canonical(op.archive) ||
        !/^[1-9][0-9]*$/.test(proof.rewardWinston) || BigInt(proof.rewardWinston) > BigInt(op.policy.storage.maxRewardWinston))) throw Error('checkout_execution_mismatch');
    if (execution.receipt) {
      const receipt = validatePaidReceipt(execution.receipt, order);
      if (receipt.txId !== execution.txId || receipt.paymentSignature !== snapshot.record.payment?.signature ||
          receipt.rewardWinston !== proof?.rewardWinston) throw Error('checkout_receipt_mismatch');
    }
    if (execution.status === 'completed' && (states.preservation !== 'completed' || states.payment !== 'verified' ||
        !proof?.transactionConfirmed || !proof.archiveVerified || !execution.receipt)) throw Error('checkout_completion_mismatch');
  }
  if (states.preservation === 'completed' && execution?.status !== 'completed') throw Error('checkout_completion_mismatch');
  return structuredClone(snapshot);
}

async function accept(op: PaidOperation, raw: unknown): Promise<PaidOperation> {
  const cancellation = raw as PaidCreationCancellation;
  if (cancellation?.schema === 'sejire/paid-request-cancellation/v1') {
    if (Object.keys(cancellation).sort().join(',') !== 'key,schema,status' || cancellation.status !== 'cancelled' || cancellation.key !== op.id ||
        op.order || op.preparation || op.signature || op.signingStarted || op.snapshot) throw Error('checkout_release_mismatch');
    return writePaidOperation({ ...op, creationCancelled: true, cancellationRequested: true });
  }
  if (op.creationCancelled) throw Error('checkout_release_mismatch');
  const snapshot = await validatePaidSnapshot(op, raw);
  const signature = snapshot.record.payment?.signature ?? snapshot.record.pendingSignature;
  return writePaidOperation({ ...op, order: snapshot.record.order, snapshot,
    ...(snapshot.preparation ? { preparation: snapshot.preparation } : {}),
    ...(signature ? { signature, signingStarted: true } : {}) });
}

async function requireOperation(id: string): Promise<PaidOperation> {
  const op = await readPaidOperation(id);
  if (!op) throw Error('paid_attempt_missing');
  return op;
}

async function refresh(op: PaidOperation, signal?: AbortSignal): Promise<PaidOperation> {
  const path = op.order ? `/orders/${op.order.id}` : `/orders/by-key/${op.id}`;
  return accept(op, await api<PaidSnapshot>(path, op.token, undefined, undefined, signal));
}

/** A first explicit create reserves the exact request before POST /orders.
 * Later creation retries require a separate user action and the same stored key. */
export async function beginPaidOperation(input: Extract<PaidInput, { mode: 'create'|'contribution' }>, payer: string, contribution: string, offered: PaidPolicyResponse): Promise<PaidOperation> {
  const contributionOnly = input.mode === 'contribution';
  const offeredPolicy = contributionOnly ? offered.contributionPolicy : offered.policy;
  const policyHash = contributionOnly ? offered.contributionPolicyHash : offered.policyHash;
  if (!(contributionOnly ? offered.contributionReady : offered.ready) || !offeredPolicy || !policyHash) throw Error('paid_unavailable');
  const policy = contributionOnly ? validateContributionPolicy(offeredPolicy) : validatePaidPolicy(offeredPolicy);
  if (await paidPolicyHash(policy) !== policyHash) throw Error('paid_policy_mismatch');
  assertBase58(payer, 32); const lamports=parseAmount(contribution,9);
  totalUnits(input.mode==='contribution'?'0':policy.serviceLamports,lamports);
  if(input.mode==='contribution'&&lamports==='0')throw Error('invalid_contribution_order');
  const serialized=input.mode==='create'?serializeEnvelope(input.envelope):null;
  const bytes=serialized?new TextEncoder().encode(serialized).byteLength:0;
  if (input.mode === 'create' && (policy.schema !== 'sejire/checkout-policy/v1' || bytes > policy.storage.maxBytes)) throw Error('envelope_too_large');
  const candidate: PaidOperation = { version: 2, id: crypto.randomUUID().replace(/-/g, ''), revision: 0,
    token: await access(), createdAt: Date.now(), treeId: input.mode==='create'?input.treeId:null, serialized,
    archive: input.mode==='create'?{ digest: await envelopeDigest(serialized!), bytes, vaultId: input.envelope.vault_id, parentTxId: input.parentTxId }:null,
    policy, policyHash, intent: { kind: input.mode==='create'?'preservation':'contribution', payer, contribution },
    createAttempted: false, signingStarted: false, localCompletion: 'pending' };
  const reserved = await reservePaidAttempt(candidate);
  return withPaidOperationLock(reserved.id, async () => {
    let op = await requireOperation(reserved.id);
    // A second tab adopts the original attempt without posting or signing.
    if (reserved.id !== candidate.id || op.createAttempted) return refresh(op);
    op = await writePaidOperation({ ...op, createAttempted: true });
    const snapshot = await api<PaidSnapshot>('/orders', op.token, { ...op.intent, policyHash: op.policyHash,
      ...(op.archive?{archive:op.archive,serialized:op.serialized}:{}) }, op.id);
    return accept(op, snapshot);
  });
}

export const readPaidStatus = (id: string, signal?: AbortSignal) => withPaidOperationLock(id, async () => refresh(await requireOperation(id), signal));

type ActiveContext = () => boolean;
const alwaysActive: ActiveContext = () => true;
function requireActive(isActive: ActiveContext) { if (!isActive()) throw Error('checkout_context_changed'); }

/** Explicit retry only. A lost accepted response is recovered by GET first;
 * only a scoped 404 permits resending the exact same idempotent request. */
export async function retryPaidCreation(id: string, isActive: ActiveContext = alwaysActive): Promise<PaidOperation> {
  return withPaidOperationLock(id, async () => {
    let op = await requireOperation(id); requireActive(isActive);
    if (op.order) return refresh(op);
    if (op.signingStarted || op.signature || op.preparation || op.cancellationRequested || op.creationCancelled || op.localCompletion !== 'pending') throw Error('previous_payment_unresolved');
    try { return await refresh(op); }
    catch (error) { if (!(error instanceof PaidApiError) || error.status !== 404 || error.message !== 'order_not_found') throw error; }
    requireActive(isActive);
    if (!op.createAttempted) op = await writePaidOperation({ ...op, createAttempted: true });
    requireActive(isActive);
    return accept(op, await api<PaidSnapshot>('/orders', op.token, { ...op.intent, policyHash: op.policyHash,
      ...(op.archive?{archive:op.archive,serialized:op.serialized}:{}) }, op.id));
  });
}

/** The server tombstone also forbids a late in-flight create with this key. */
export async function cancelPaidCreation(id: string, isActive: ActiveContext = alwaysActive): Promise<PaidOperation> {
  return withPaidOperationLock(id, async () => {
    let op = await requireOperation(id); requireActive(isActive);
    if (op.order) return refresh(op);
    if (op.preparation || op.signature || op.signingStarted || op.localCompletion !== 'pending') throw Error('previous_payment_unresolved');
    if (op.creationCancelled) return op;
    op = await writePaidOperation({ ...op, cancellationRequested: true }); requireActive(isActive);
    return accept(op, await api<PaidSnapshot | PaidCreationCancellation>(`/orders/by-key/${op.id}/cancel`, op.token, {}));
  });
}

export async function preparePaidOperation(id: string, wallet: SolanaWalletAdapter, isActive: ActiveContext = alwaysActive): Promise<PaidOperation> {
  return withPaidOperationLock(id, async () => {
    requireActive(isActive);
    let op = await refresh(await requireOperation(id));
    if (!op.order || op.signingStarted || op.signature || op.cancellationRequested || op.snapshot?.expired || op.order.expiresAt <= Date.now()) throw Error('previous_payment_unresolved');
    if (wallet.publicKey.toString() !== op.order.payer) throw Error('wallet_changed');
    requireActive(isActive);
    const preparation = await validatePaymentPreparation(op.order, await api<DurablePaymentPreparation>(`/orders/${op.order.id}/prepare`, op.token, {}));
    if (BigInt(preparation.feeLamports) > 100000n) throw Error('network_fee_not_ready');
    op = await writePaidOperation({ ...op, preparation });
    return op;
  });
}

type RpcCall = (method: string, params?: unknown[]) => Promise<unknown>;
class RpcUnavailable extends Error {
  constructor(readonly status: number, readonly retryAfter: string | null = null) { super('solana_unavailable'); }
}
const cooledRpc = new Map<string, number>();
function rpcUrls(op: PaidOperation): string[] {
  return op.policy.network === 'mainnet-beta'
    ? ['https://solana.api.pocket.network', SOLANA_RPCS['mainnet-beta']]
    : [SOLANA_RPCS[op.policy.network]];
}
function pauseRpc(url: string, error: RpcUnavailable): void {
  const seconds = Number(error.retryAfter);
  const retry = Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : Date.parse(error.retryAfter ?? '');
  const delay = error.status === 403 ? 300000 :
    Number.isFinite(retry) ? Math.max(60000, Math.min(300000, retry > 1000000000000 ? retry - Date.now() : retry)) : 60000;
  cooledRpc.set(url, Date.now() + delay);
}
async function rpcAt(url: string, method: string, params: unknown[] = []): Promise<unknown> {
  const id = crypto.randomUUID();
  let response: Awaited<ReturnType<typeof jsonRequest>>;
  try {
    response = await jsonRequest(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) }, undefined,
    source => { try { return parseRpcJson(source); } catch { return null; } });
  } catch { throw new RpcUnavailable(0); }
  const value = response.value as { jsonrpc?: string; id?: string; error?: unknown; result?: unknown };
  if (response.status !== 200) throw new RpcUnavailable(response.status, response.retryAfter);
  if (value?.jsonrpc !== '2.0' || value.id !== id || value.error || !Object.hasOwn(value, 'result'))
    throw Error('solana_rpc_malformed');
  return value.result;
}

async function withPublicRpc<T>(op: PaidOperation, action: (call: RpcCall) => Promise<T>): Promise<T> {
  let last: RpcUnavailable | null = null;
  for (const url of rpcUrls(op)) {
    if ((cooledRpc.get(url) ?? 0) > Date.now()) continue;
    const call: RpcCall = async (method, params) => {
      try { return await rpcAt(url, method, params); }
      catch (error) { if (error instanceof RpcUnavailable) pauseRpc(url, error); throw error; }
    };
    try {
      if (await call('getGenesisHash') !== SOLANA_GENESIS[op.policy.network]) throw Error('wrong_solana_network');
      return await action(call);
    } catch (error) {
      if (!(error instanceof RpcUnavailable)) throw error;
      last = error;
    }
  }
  throw last ?? new RpcUnavailable(0);
}

async function validateSignedTransaction(op: PaidOperation): Promise<void> {
  if (!op.order || !op.preparation || !op.signature || !op.signedTransaction) throw Error('no_pending_payment');
  const preparation = await validatePaymentPreparation(op.order, op.preparation);
  try {
    const bytes = Buffer.from(op.signedTransaction, 'base64');
    if (bytes.length > 1232 || bytes.toString('base64') !== op.signedTransaction) throw Error();
    const signed = Transaction.from(bytes);
    if (signed.serializeMessage().toString('base64') !== preparation.messageBase64 ||
        signed.feePayer?.toBase58() !== op.order.payer || signed.signatures.length !== 1 ||
        !signed.verifySignatures() || !signed.signatures[0]?.signature ||
        bs58.encode(signed.signatures[0].signature) !== op.signature || signed.serialize().toString('base64') !== op.signedTransaction) throw Error();
  } catch { throw Error('checkout_signed_transaction_mismatch'); }
}

async function broadcast(op: PaidOperation, isActive: ActiveContext): Promise<void> {
  if (!op.signature || !op.signedTransaction || !op.order || !op.preparation) throw Error('no_pending_payment');
  await validateSignedTransaction(op);
  if (op.order.expiresAt <= Date.now()) return;
  requireActive(isActive);
  const selected = await withPublicRpc(op, async call => ({ call,
    height: await call('getBlockHeight', [{ commitment: 'finalized' }]) }));
  requireActive(isActive);
  if (!Number.isSafeInteger(selected.height) || (selected.height as number) > op.preparation.lastValidBlockHeight) return;
  // A lost send response is uncertain. This invocation never broadcasts to a second RPC.
  const signature = await selected.call('sendTransaction', [op.signedTransaction, { encoding: 'base64', skipPreflight: false, maxRetries: 2 }]);
  if (signature !== op.signature) throw Error('checkout_signature_mismatch');
}

export async function payPaidOperation(id: string, preparationId: string, wallet: SolanaWalletAdapter, isActive: ActiveContext = alwaysActive): Promise<PaidOperation> {
  return withPaidOperationLock(id, async () => {
    requireActive(isActive);
    let op = await refresh(await requireOperation(id));
    if (!op.order || !op.preparation || op.preparation.preparationId !== preparationId || op.signingStarted || op.signature || op.cancellationRequested || op.snapshot?.expired ||
        op.order.expiresAt <= Date.now()) throw Error('previous_payment_unresolved');
    await validatePaidOrderPolicy(op.order, op.policy);
    const preparation = await validatePaymentPreparation(op.order, op.preparation);
    if (wallet.publicKey.toString() !== op.order.payer) throw Error('wallet_changed');
    requireActive(isActive);
    await withPublicRpc(op, async call => {
      const fee = await call('getFeeForMessage', [preparation.messageBase64, { commitment: 'finalized' }]) as { value?: unknown };
      if (rpcU64(fee?.value) !== preparation.feeLamports || BigInt(preparation.feeLamports) > 100000n) throw Error('network_fee_changed');
      const balance = await call('getBalance', [op.order!.payer, { commitment: 'finalized' }]) as { value?: unknown };
      if (BigInt(rpcU64(balance?.value)) < BigInt(op.order!.total) + BigInt(preparation.feeLamports)) throw Error('insufficient_wallet_balance');
    });
    requireActive(isActive);
    op = await writePaidOperation({ ...op, signingStarted: true });
    if (!isActive()) {
      await writePaidOperation({ ...op, signingStarted: false }); // The wallet was never invoked.
      throw Error('checkout_context_changed');
    }
    let signed: Transaction;
    try { signed = await wallet.signTransaction(Transaction.populate(Message.from(Buffer.from(preparation.messageBase64, 'base64')))); }
    catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 4001) await writePaidOperation({ ...op, signingStarted: false });
      throw error;
    }
    if (wallet.publicKey.toString() !== op.order!.payer || signed.serializeMessage().toString('base64') !== preparation.messageBase64 ||
        !signed.verifySignatures() || !signed.signatures[0]?.signature) throw Error('wallet_changed');
    op = await writePaidOperation({ ...op, signature: bs58.encode(signed.signatures[0].signature), signedTransaction: signed.serialize().toString('base64') });
    requireActive(isActive);
    await api(`/orders/${op.order!.id}/reserve`, op.token, { signature: op.signature, preparationId });
    requireActive(isActive);
    try { await broadcast(op, isActive); } catch { requireActive(isActive); return refresh(op); }
    requireActive(isActive);
    return accept(op, await api<PaidSnapshot>(`/orders/${op.order!.id}/verify`, op.token, { signature: op.signature }));
  });
}

/** Resume only this ID. It never creates an order or asks a wallet to sign. */
export async function checkPaidOperation(id: string, isActive: ActiveContext = alwaysActive): Promise<PaidOperation> {
  return withPaidOperationLock(id, async () => {
    requireActive(isActive);
    let op = await refresh(await requireOperation(id));
    if (!op.order || op.localCompletion !== 'pending' || op.snapshot?.expired) return op;
    if (op.signedTransaction && op.snapshot?.record.states.payment !== 'verified') await validateSignedTransaction(op);
    if ((op.signingStarted || op.signature) && op.snapshot?.record.states.payment !== 'verified') {
      // A lost reserve response is retried with the same signature/preparation;
      // bytes are never broadcast until the server accepted that reservation.
      if (op.signature && op.preparation && !op.snapshot?.record.pendingSignature) {
        requireActive(isActive);
        await api(`/orders/${op.order.id}/reserve`, op.token, { signature: op.signature, preparationId: op.preparation.preparationId });
      }
      requireActive(isActive);
      op = await accept(op, await api<PaidSnapshot>(`/orders/${op.order.id}/reconcile`, op.token, {}));
      if (op.snapshot?.record.states.payment !== 'verified' && op.signedTransaction && op.snapshot?.verification?.reason === 'not-found') {
        try { await broadcast(op, isActive); } catch { requireActive(isActive); /* Keep the original uncertainty and bytes. */ }
      }
    }
    if (op.snapshot?.record.states.payment === 'verified' && op.snapshot.execution?.status === 'queued') {
      requireActive(isActive);
      op = await accept(op, await api<PaidSnapshot>(`/orders/${op.order!.id}/execute`, op.token, {}));
    }
    return op;
  });
}

/** Only a never-started wallet action or explicit 4001 can reach this branch. */
export async function cancelPaidOperation(id: string): Promise<PaidOperation> {
  return withPaidOperationLock(id, async () => {
    let op = await refresh(await requireOperation(id));
    if (!op.order || op.signingStarted || op.signature || op.snapshot?.record.pendingSignature || op.snapshot?.record.payment || op.snapshot?.execution) throw Error('previous_payment_unresolved');
    if (op.snapshot?.expired) return op;
    op = await writePaidOperation({ ...op, cancellationRequested: true });
    return accept(op, await api<PaidSnapshot>(`/orders/${op.order!.id}/cancel`, op.token, { preparationId: op.preparation?.preparationId ?? null }));
  });
}

/** Explicit acknowledgement of a server-proven release; never starts a successor. */
export async function resolveReleasedPaidOperation(id: string): Promise<void> {
  await withPaidOperationLock(id, async () => {
    const op = await refresh(await requireOperation(id));
    if ((!op.creationCancelled && !op.snapshot?.expired) || op.signingStarted || op.signature || op.snapshot?.record.pendingSignature || op.snapshot?.record.payment || op.snapshot?.execution) throw Error('previous_payment_unresolved');
    if (op.localCompletion === 'pending') await writePaidOperation({ ...op, localCompletion: 'released' });
    announcePreservationChange();
  });
}

export async function paidCompletion(op: PaidOperation): Promise<PaidCompletion | null> {
  if(op.intent.kind==='contribution')return null;
  if (!op.snapshot || op.snapshot.record.states.preservation !== 'completed') return null;
  const snapshot = await validatePaidSnapshot(op, op.snapshot), execution = snapshot.execution;
  if (snapshot.record.order.kind!=='preservation'||!execution?.receipt || !execution.txId || !snapshot.record.payment) throw Error('checkout_completion_mismatch');
  return { operationId: op.id, order: snapshot.record.order, serialized: op.serialized!,
    envelope: parseEnvelope(JSON.parse(op.serialized!)), treeId: op.treeId, txId: execution.txId,
    paymentSignature: snapshot.record.payment.signature, receipt: execution.receipt };
}

export {findContributionAttempt};
export async function contributionReceipt(op: PaidOperation): Promise<ContributionReceipt> {
  if (op.intent.kind !== 'contribution' || !op.snapshot) throw Error('checkout_completion_mismatch');
  const snapshot = await validatePaidSnapshot(op, op.snapshot);
  const { order, payment, states } = snapshot.record;
  if (order.kind !== 'contribution' || !payment || states.payment !== 'verified' || states.contribution !== 'received') throw Error('checkout_completion_mismatch');
  return { schema: 'sejire/contribution-receipt/v1', status: 'verified', orderId: order.id, network: order.network,
    policyHash: order.policyHash, paymentSignature: payment.signature, payer: order.payer, fundRecipient: order.fundContribution.recipient,
    contributionLamports: order.fundContribution.amount, serviceLamports: '0', feeLamports: payment.feeLamports };
}
export async function completeContributionLocally(id:string):Promise<void>{
  await withPaidOperationLock(id,async()=>{
    const op=await requireOperation(id);
    await contributionReceipt(op);
    if(op.localCompletion!=='done')await writePaidOperation({...op,localCompletion:'done'});
    announcePreservationChange();
  });
}

/** Invoke only after exact local archive and session writes have been read back. */
export async function completePaidLocally(id: string): Promise<void> {
  await withPaidOperationLock(id, async () => {
    const op = await requireOperation(id);
    if (!await paidCompletion(op)) throw Error('checkout_completion_mismatch');
    if (op.localCompletion !== 'done') await writePaidOperation({ ...op, localCompletion: 'done' });
    announcePreservationChange();
  });
}
