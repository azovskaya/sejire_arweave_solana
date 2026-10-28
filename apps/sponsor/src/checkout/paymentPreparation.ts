import { assertBase58, assertOrder, SYSTEM_PROGRAM, type Order, type PaidOrder } from '../../../../packages/checkout/order';
import { SolanaRpcReader, DEVNET_GENESIS } from './rpcReader';
import { object } from './rpcDecoder';
import { buildPaidPaymentMessage, createPaymentPreparation, SOLANA_GENESIS, type DurablePaymentPreparation } from '../../../../packages/checkout/paid';
import { rpcU64 } from '../../../../packages/checkout/rpcJson';
export type PaymentPreparation = { source: string; serviceDestination?: string; fundDestination?: string; blockhash: string; lastValidBlockHeight: number; feeLamports: string };
export interface PaymentPreparer { prepare(order: Order): Promise<PaymentPreparation> }
function requireBalance(value: unknown, total: string, fee: bigint): void {
  let available: bigint;
  try { available = BigInt(rpcU64(value)); }
  catch { throw new Error('payment_balance_not_ready'); }
  if (available < BigInt(total) + fee) throw new Error('payment_balance_not_ready');
}
/** Native SOL, one payer signer, exact System transfers; no ATA or CPI. */
export class RpcPaymentPreparer implements PaymentPreparer {
  constructor(private readonly reader = new SolanaRpcReader({ network: 'devnet' })) {}
  async prepare(order: Order): Promise<PaymentPreparation> {
    if (order.schema !== 'sejire/order/v1' || order.network !== 'devnet' || order.asset.symbol !== 'SOL' || order.asset.program !== SYSTEM_PROGRAM || await this.reader.rpc('getGenesisHash') !== DEVNET_GENESIS) throw new Error('payment_network_not_ready');
    for (const part of [order.servicePayment, order.fundContribution]) {
      if (part.amount === '0') continue;
      const response = object(await this.reader.rpc('getAccountInfo', [part.recipient, { encoding: 'base64', commitment: 'finalized' }]));
      if (response.value !== null) { const account = object(response.value); if (account.owner !== SYSTEM_PROGRAM || account.executable !== false) throw new Error('recipient_not_ready'); }
    }
    const latest = object(await this.reader.rpc('getLatestBlockhash', [{ commitment: 'finalized' }])), value = object(latest.value);
    assertBase58(value.blockhash as string, 32);
    if (!Number.isSafeInteger(value.lastValidBlockHeight)) throw new Error('invalid_block_height');
    const balance = object(await this.reader.rpc('getBalance', [order.payer, { commitment: 'finalized' }]));
    requireBalance(balance.value, order.total, 5000n);
    return { source: order.payer, serviceDestination: order.servicePayment.recipient, fundDestination: order.fundContribution.recipient, blockhash: value.blockhash as string, lastValidBlockHeight: value.lastValidBlockHeight as number, feeLamports: '5000' };
  }
  /** The caller must durably store this exact preparation before returning it to a wallet.
   * An already-issued preparation is resumed from the ledger, never regenerated here. */
  async preparePaid(order: PaidOrder, operationDeadline = Date.now() + 22000): Promise<DurablePaymentPreparation> {
    assertOrder(order);
    if (order.schema !== 'sejire/order/v2' || this.reader.chain.network !== order.network || this.reader.chain.genesisHash !== SOLANA_GENESIS[order.network]) throw new Error('payment_network_not_ready');
    if (Date.now() < order.createdAt || Date.now() >= order.expiresAt) throw new Error('order_expired');
    const deadline = operationDeadline;
    if (await this.reader.rpc('getGenesisHash', [], deadline) !== SOLANA_GENESIS[order.network]) throw new Error('payment_network_not_ready');
    for (const part of [order.servicePayment, order.fundContribution]) {
      if (part.amount === '0') continue;
      const response = object(await this.reader.rpc('getAccountInfo', [part.recipient, { encoding: 'base64', commitment: 'finalized' }], deadline));
      if (response.value !== null) {
        const account = object(response.value);
        if (account.owner !== SYSTEM_PROGRAM || account.executable !== false) throw new Error('recipient_not_ready');
      }
    }
    const latest = object(await this.reader.rpc('getLatestBlockhash', [{ commitment: 'finalized' }], deadline)), value = object(latest.value);
    assertBase58(value.blockhash as string, 32);
    if (typeof value.lastValidBlockHeight !== 'number' || !Number.isSafeInteger(value.lastValidBlockHeight) || value.lastValidBlockHeight < 0) throw new Error('invalid_block_height');
    const messageBase64 = buildPaidPaymentMessage(order, value.blockhash as string);
    const fee = object(await this.reader.rpc('getFeeForMessage', [messageBase64, { commitment: 'finalized' }], deadline));
    if (typeof fee.value !== 'number' || !Number.isSafeInteger(fee.value) || fee.value <= 0 || fee.value > 100000) throw new Error('network_fee_not_ready');
    const balance = object(await this.reader.rpc('getBalance', [order.payer, { commitment: 'finalized' }], deadline));
    requireBalance(balance.value, order.total, BigInt(fee.value));
    return createPaymentPreparation(order, { blockhash: value.blockhash as string, lastValidBlockHeight: value.lastValidBlockHeight, feeLamports: String(fee.value), createdAt: Date.now() });
  }
}
