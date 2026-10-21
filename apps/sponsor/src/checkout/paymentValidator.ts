import { assertUnits } from '../../../../packages/checkout/amounts';
import { assertBase58, assertOrder, type Order, type Network, type Asset } from '../../../../packages/checkout/order';
import { SOLANA_GENESIS, validatePaymentPreparation, type DurablePaymentPreparation } from '../../../../packages/checkout/paid';
import type { PaidOrder } from '../../../../packages/checkout/order';
/** Normalized evidence from a TRUSTED server RPC decoder, NEVER an HTTP request body.
 * SolanaRpcReader/decoder inspect raw instructions in A2.1. They must inspect
 * loaded addresses, token-account owners, authority/signers, genesis, fees and block time.
 * Balance changes or client paid=true cannot be normalized into this evidence.
 */
export type Transfer = Readonly<{
  instruction: string; sender: string; recipient: string; amount: string;
  asset: Asset; references: readonly string[];
}>;
export type TransactionEvidence = Readonly<{
  signature: string; network: Network; genesisHash: string; commitment: 'processed' | 'confirmed' | 'finalized';
  error: unknown | null; slot: number; blockTimeMs: number | null; feeLamports: string;
  feePayer: string; signers: readonly string[]; transfers: readonly Transfer[];
  /** Exact legacy message reconstructed by the trusted RPC decoder; required only for v2. */
  recentBlockhash?: string; messageBase64?: string;
}>;
export type Credit = Readonly<{ purpose: 'servicePayment' | 'fundContribution'; amount: string; recipient: string; instruction: string }>;
export type ValidatedPayment = Readonly<{ orderId: string; network: Network; signature: string; slot: number; feeLamports: string; credits: readonly Credit[] }>;
// Genesis must be independently obtained/pinned by the future trusted transport. No live network operation here.
export type ChainPolicy = Readonly<{ network: Network; genesisHash: string }>;
function validatePaymentEvidence(order: Order, tx: TransactionEvidence, chain: ChainPolicy): ValidatedPayment {
  assertOrder(order);
  assertBase58(tx.signature, 64);
  if (chain.network !== order.network || tx.network !== order.network || !chain.genesisHash || tx.genesisHash !== chain.genesisHash) throw new Error('wrong_network');
  if (tx.error !== null) throw new Error('transaction_failed');
  if (tx.commitment !== 'finalized') throw new Error('payment_not_finalized');
  if (!Number.isSafeInteger(tx.slot) || tx.slot < 0) throw new Error('invalid_slot');
  // Solana's block timestamp has second precision. A v2 message includes a new
  // server reference and its exact durable preparation, so inclusion in the
  // creation second is valid even when createdAt retained milliseconds.
  const startsAt = order.schema === 'sejire/order/v2' ? Math.floor(order.createdAt / 1000) * 1000 : order.createdAt;
  if (!Number.isSafeInteger(tx.blockTimeMs) || tx.blockTimeMs === null || tx.blockTimeMs < startsAt || tx.blockTimeMs > order.expiresAt) throw new Error('payment_outside_order_window');
  assertUnits(tx.feeLamports);
  if (tx.feePayer !== order.payer || !tx.signers.includes(order.payer)) throw new Error('wrong_payer');
  const expected = (['servicePayment', 'fundContribution'] as const).filter(purpose => assertUnits(order[purpose].amount) > 0n);
  // A1 accepts only the bounded checkout template. Arbitrary additional transfers are rejected.
  if (tx.transfers.length !== expected.length) throw new Error('unexpected_transfer_count');
  const used = new Set<string>();
  const credits = expected.map(purpose => {
    const part = order[purpose];
    const matches = tx.transfers.filter(t => t.recipient === part.recipient);
    if (matches.length !== 1) throw new Error('wrong_recipient');
    const transfer = matches[0];
    if (!/^(0|[1-9]\d{0,5})(?:\/(0|[1-9]\d{0,5}))?$/.test(transfer.instruction) || used.has(transfer.instruction)) throw new Error('duplicate_instruction');
    used.add(transfer.instruction);
    if (transfer.sender !== order.payer) throw new Error('wrong_sender');
    if (transfer.asset.symbol !== order.asset.symbol || transfer.asset.mint !== order.asset.mint || transfer.asset.program !== order.asset.program || transfer.asset.decimals !== order.asset.decimals) throw new Error('wrong_asset');
    if (assertUnits(transfer.amount) !== assertUnits(part.amount)) throw new Error('wrong_amount');
    if (!transfer.references.includes(order.reference)) throw new Error('wrong_reference');
    return Object.freeze({ purpose, amount: part.amount, recipient: part.recipient, instruction: transfer.instruction });
  });
  return Object.freeze({ orderId: order.id, network: order.network, signature: tx.signature, slot: tx.slot, feeLamports: tx.feeLamports, credits: Object.freeze(credits) });
}
/** Legacy validation deliberately cannot credit a v2 payment without its durable preparation. */
export function validatePayment(order: Order, tx: TransactionEvidence, chain: ChainPolicy): ValidatedPayment {
  if (order.schema === 'sejire/order/v2') throw new Error('payment_preparation_required');
  return validatePaymentEvidence(order, tx, chain);
}
export async function validatePreparedPayment(order: PaidOrder, tx: TransactionEvidence, chain: ChainPolicy, preparation: DurablePaymentPreparation): Promise<ValidatedPayment> {
  const checked = await validatePaymentPreparation(order, preparation);
  if (chain.genesisHash !== SOLANA_GENESIS[order.network] || chain.network !== order.network) throw new Error('wrong_network');
  if (tx.recentBlockhash !== checked.blockhash || tx.messageBase64 !== checked.messageBase64 || tx.feeLamports !== checked.feeLamports) throw new Error('payment_preparation_mismatch');
  // RPC block time has whole-second resolution. The original order window is still checked below.
  if (tx.blockTimeMs === null || tx.blockTimeMs < Math.floor(checked.createdAt / 1000) * 1000) throw new Error('payment_predates_preparation');
  return validatePaymentEvidence(order, tx, chain);
}
