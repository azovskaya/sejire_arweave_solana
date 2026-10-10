/** SYNTHETIC fixtures constructed from official encoding=json RPC structure and instruction layouts.
 * No wallet/signature generation, transaction broadcast or captured real payment. Base58 signature
 * strings encode repeated public fixture bytes; they are NOT cryptographic signatures.
 * Sources/provenance: docs/verification/2026-09-30-a2-1.md.
 */
import { createOrder, type OrderInput } from '../../../../packages/checkout/order';
import { COMPUTE_BUDGET } from './rpcDecoder';
import { DEVNET_GENESIS } from './rpcReader';
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function encode58(bytes: Uint8Array): string {
  let n = 0n; for (const byte of bytes) n = (n << 8n) + BigInt(byte);
  let out = ''; for (; n > 0n; n /= 58n) out = ALPHABET[Number(n % 58n)] + out;
  return '1'.repeat(bytes.findIndex(b => b !== 0) < 0 ? bytes.length : bytes.findIndex(b => b !== 0)) + out;
}
export const addr = (fill: number) => encode58(new Uint8Array(32).fill(fill));
export const sig = (fill: number) => encode58(new Uint8Array(64).fill(fill));
export const fixtureChain = { network: 'devnet' as const, genesisHash: DEVNET_GENESIS };
export function fixtureOrder(patch: Partial<OrderInput> = {}) {
  return createOrder({ id: 'a'.repeat(32), kind: 'preservation', network: 'devnet', asset: 'USDC',
    payer: addr(1), reference: addr(4), createdAt: 1000000, expiresAt: 1100000, policyVersion: 'synthetic-v1',
    servicePayment: { amount: '3000000', recipient: addr(2) }, fundContribution: { amount: '97000000', recipient: addr(3) },
    archive: { digest: 'b'.repeat(64), bytes: 800000 }, ...patch });
}
export function instructionData(op: number, amount: string, token = false) {
  const bytes = new Uint8Array(token ? 10 : 12), start = token ? 1 : 4;
  bytes[0] = op; let n = BigInt(amount);
  for (let i = start; i < start + 8; i++) { bytes[i] = Number(n & 255n); n >>= 8n; }
  if (token) bytes[9] = 6;
  return encode58(bytes);
}
export function fixtureTransaction(order = fixtureOrder(), signature = sig(5), version: 'legacy' | 0 = 'legacy') {
  const isToken = order.asset.symbol === 'USDC';
  const keys = isToken ? [order.payer, addr(11), addr(12), addr(13), order.asset.mint!, order.asset.program, order.reference, COMPUTE_BUDGET] :
    [order.payer, order.servicePayment.recipient, order.fundContribution.recipient, order.asset.program, order.reference, COMPUTE_BUDGET];
  const readonly = isToken ? 4 : 3;
  const parts = (['servicePayment', 'fundContribution'] as const).filter(p => order[p].amount !== '0');
  const instructions = parts.map(p => ({ programIdIndex: isToken ? 5 : 3, accounts: isToken ? [1, 4, p === 'servicePayment' ? 2 : 3, 0, 6] : [0, p === 'servicePayment' ? 1 : 2, 4],
    data: instructionData(isToken ? 12 : 2, order[p].amount, isToken), stackHeight: 1 }));
  const balances = isToken ? [1, 2, 3].map((index, i) => ({ accountIndex: index, mint: order.asset.mint!, owner: [order.payer, order.servicePayment.recipient, order.fundContribution.recipient][i],
    programId: order.asset.program, uiTokenAmount: { amount: i === 0 ? order.total : '0', decimals: 6, uiAmount: null, uiAmountString: '0' } })) : [];
  const post = structuredClone(balances);
  if (post.length) {
    post[0].uiTokenAmount.amount = '0'; post[1].uiTokenAmount.amount = order.servicePayment.amount; post[2].uiTokenAmount.amount = order.fundContribution.amount;
  }
  return { slot: 100, blockTime: 1050, version,
    transaction: { signatures: [signature], message: { accountKeys: keys, header: { numRequiredSignatures: 1, numReadonlySignedAccounts: 0, numReadonlyUnsignedAccounts: readonly },
      recentBlockhash: addr(8), instructions, ...(version === 0 ? { addressTableLookups: [] as { accountKey: string; writableIndexes: number[]; readonlyIndexes: number[] }[] } : {}) } },
    meta: { err: null as unknown, fee: 5000, innerInstructions: [] as unknown[], preBalances: keys.map(() => 1000000), postBalances: keys.map(() => 1000000),
      preTokenBalances: balances, postTokenBalances: post, loadedAddresses: { writable: [] as string[], readonly: [] as string[] } } };
}
export type FixtureTransaction = ReturnType<typeof fixtureTransaction>;
export function fixtureStatus() { return { context: { slot: 100 }, value: [{ slot: 100, confirmations: null, err: null, confirmationStatus: 'finalized' }] }; }
