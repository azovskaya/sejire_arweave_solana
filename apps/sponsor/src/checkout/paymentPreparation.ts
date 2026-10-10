import { assertBase58, SYSTEM_PROGRAM, type Order } from '../../../../packages/checkout/order';
import { SolanaRpcReader, DEVNET_GENESIS } from './rpcReader';
import { object } from './rpcDecoder';
export type PaymentPreparation = { source: string; serviceDestination?: string; fundDestination?: string; blockhash: string; lastValidBlockHeight: number; feeLamports: string };
export interface PaymentPreparer { prepare(order: Order): Promise<PaymentPreparation> }
/** Native SOL, one payer signer, exact System transfers; no ATA or CPI. */
export class RpcPaymentPreparer implements PaymentPreparer {
  constructor(private readonly reader = new SolanaRpcReader({ network: 'devnet' })) {}
  async prepare(order: Order): Promise<PaymentPreparation> {
    if (order.network !== 'devnet' || order.asset.symbol !== 'SOL' || order.asset.program !== SYSTEM_PROGRAM || await this.reader.rpc('getGenesisHash') !== DEVNET_GENESIS) throw new Error('payment_network_not_ready');
    for (const part of [order.servicePayment, order.fundContribution]) {
      if (part.amount === '0') continue;
      const response = object(await this.reader.rpc('getAccountInfo', [part.recipient, { encoding: 'base64', commitment: 'finalized' }]));
      if (response.value !== null) { const account = object(response.value); if (account.owner !== SYSTEM_PROGRAM || account.executable !== false) throw new Error('recipient_not_ready'); }
    }
    const latest = object(await this.reader.rpc('getLatestBlockhash', [{ commitment: 'finalized' }])), value = object(latest.value);
    assertBase58(value.blockhash as string, 32);
    if (!Number.isSafeInteger(value.lastValidBlockHeight)) throw new Error('invalid_block_height');
    const balance = object(await this.reader.rpc('getBalance', [order.payer, { commitment: 'finalized' }]));
    if (!Number.isSafeInteger(balance.value) || (balance.value as number) < 0 || BigInt(balance.value as number) < BigInt(order.total) + 5000n) throw new Error('payment_balance_not_ready');
    return { source: order.payer, serviceDestination: order.servicePayment.recipient, fundDestination: order.fundContribution.recipient, blockhash: value.blockhash as string, lastValidBlockHeight: value.lastValidBlockHeight as number, feeLamports: '5000' };
  }
}
