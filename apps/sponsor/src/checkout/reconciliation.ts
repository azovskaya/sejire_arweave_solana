import type { AtomicOrderStore, CommitResult } from './store';
import { validatePayment, type TransactionEvidence, type ChainPolicy, type ValidatedPayment } from './paymentValidator';
import { RpcEvidenceError, type RpcFailure } from './rpcErrors';
import type { PaidOrder } from '../../../../packages/checkout/order';
import type { DurablePaymentPreparation } from '../../../../packages/checkout/paid';
export type ReferencePaymentResult = Readonly<{ status: 'found'; signature: string; evidence: TransactionEvidence; payment: ValidatedPayment }> |
  Readonly<{ status: 'requires-reconciliation'; reason: RpcFailure | 'not-found' | 'reference-ambiguous' | 'reference-scan-incomplete' | 'validation-rejected' }>;
/** Server-only port. SolanaRpcReader supplies raw-RPC evidence; browser JSON never does. */
export interface TrustedTransactionReader {
  readonly chain: ChainPolicy;
  read(signature: string): Promise<TransactionEvidence | null>;
  /** Discovery is read-only. The owner-scoped/internal ledger must bind the found signature before commit. */
  findByReference?(order: PaidOrder, preparation: DurablePaymentPreparation): Promise<ReferencePaymentResult>;
}
export type ReconciliationResult = CommitResult | Readonly<{ status: 'requires-reconciliation'; reason: RpcFailure | 'not-found' | 'missing-block-time' | 'validation-rejected' | 'credit-conflict' }>;
export async function reconcilePayment(store: AtomicOrderStore, reader: TrustedTransactionReader, orderId: string, signature: string): Promise<ReconciliationResult> {
  const record = await store.beginReconciliation(orderId, signature);
  if (record.payment) return { status: 'already-credited', record };
  let tx: TransactionEvidence | null;
  try { tx = await reader.read(signature); }
  catch (error) { return { status: 'requires-reconciliation', reason: error instanceof RpcEvidenceError ? error.reason : 'rpc-unavailable' }; }
  if (!tx) return { status: 'requires-reconciliation', reason: 'not-found' };
  if (tx.signature !== signature) return { status: 'requires-reconciliation', reason: 'validation-rejected' };
  // Avoid accepting evidence from a wrong chain merely because it is still pending.
  if (tx.network !== reader.chain.network || tx.genesisHash !== reader.chain.genesisHash || tx.network !== record.order.network) return { status: 'requires-reconciliation', reason: 'validation-rejected' };
  if (tx.commitment !== 'finalized') return { status: 'requires-reconciliation', reason: 'not-finalized' };
  if (tx.blockTimeMs === null) return { status: 'requires-reconciliation', reason: 'missing-block-time' };
  let payment;
  try { payment = validatePayment(record.order, tx, reader.chain); }
  catch { return { status: 'requires-reconciliation', reason: 'validation-rejected' }; }
  // A store failure must propagate: unknown durable commit is not labelled unpaid.
  try { return await store.commitPayment(payment); }
  catch (error) {
    if (error instanceof Error && error.message === 'payment_already_used') return { status: 'requires-reconciliation', reason: 'credit-conflict' };
    throw error;
  }
}
