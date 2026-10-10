import { assertUnits, totalUnits } from './amounts';
export type Network = 'devnet' | 'mainnet-beta';
export type Asset = Readonly<{ symbol: 'SOL' | 'USDC'; decimals: number; mint: string | null; program: string }>;
export const SYSTEM_PROGRAM = '11111111111111111111111111111111';
export const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export function assetFor(network: Network, symbol: 'SOL' | 'USDC'): Asset {
  if (network !== 'devnet' && network !== 'mainnet-beta') throw new Error('invalid_network');
  if (symbol === 'SOL') return Object.freeze({ symbol, decimals: 9, mint: null, program: SYSTEM_PROGRAM });
  if (symbol !== 'USDC') throw new Error('unsupported_asset');
  return Object.freeze({ symbol, decimals: 6, program: TOKEN_PROGRAM, mint: network === 'devnet'
    ? '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU' : 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' });
}
const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function assertBase58(value: string, bytes: number): void {
  if (typeof value !== 'string' || value.length < bytes || value.length > Math.ceil(bytes * 1.38)) throw new Error('invalid_base58');
  let n = 0n;
  for (const char of value) { const digit = alphabet.indexOf(char); if (digit < 0) throw new Error('invalid_base58'); n = n * 58n + BigInt(digit); }
  let size = 0; for (; n > 0n; n >>= 8n) size++;
  size += value.match(/^1*/)?.[0].length ?? 0;
  if (size !== bytes) throw new Error('invalid_base58');
}
export type ArchiveBinding = Readonly<{ digest: string; bytes: number }>;
export type PaymentPart = Readonly<{ amount: string; recipient: string }>;
export type Order = Readonly<{
  schema: 'sejire/order/v1'; id: string; kind: 'preservation' | 'contribution'; network: Network;
  asset: Asset; payer: string; reference: string; createdAt: number; expiresAt: number; policyVersion: string;
  servicePayment: PaymentPart; fundContribution: PaymentPart; total: string;
  networkFee: Readonly<{ asset: 'SOL'; includedInTotal: false }>;
  archive?: ArchiveBinding;
}>;
export type OrderInput = Omit<Order, 'schema' | 'asset' | 'total' | 'networkFee'> & { asset: 'SOL' | 'USDC' };
/** Trusted order creation only, not a price supplied by a browser. No default archive size policy. */
export function createOrder(input: OrderInput): Order {
  const asset = assetFor(input.network, input.asset);
  if (!/^[a-f0-9]{32}$/.test(input.id) || !/^[a-zA-Z0-9._-]{1,64}$/.test(input.policyVersion)) throw new Error('invalid_order_id_or_policy');
  for (const address of [input.payer, input.reference, input.servicePayment.recipient, input.fundContribution.recipient]) assertBase58(address, 32);
  if (input.servicePayment.recipient === input.fundContribution.recipient ||
      input.payer === input.servicePayment.recipient || input.payer === input.fundContribution.recipient) throw new Error('recipient_roles_overlap');
  const service = assertUnits(input.servicePayment.amount), contribution = assertUnits(input.fundContribution.amount);
  if (!Number.isSafeInteger(input.createdAt) || input.createdAt < 0 || !Number.isSafeInteger(input.expiresAt) || input.expiresAt <= input.createdAt) throw new Error('invalid_order_window');
  if (input.kind === 'preservation') {
    if (!input.archive || !/^[a-f0-9]{64}$/.test(input.archive.digest) || !Number.isSafeInteger(input.archive.bytes) || input.archive.bytes <= 0 || service === 0n) throw new Error('invalid_archive_or_service');
  } else if (input.kind === 'contribution') {
    if (input.archive !== undefined || service !== 0n || contribution === 0n) throw new Error('invalid_contribution_order');
  } else throw new Error('invalid_order_kind');
  const order: Order = {
    schema: 'sejire/order/v1', id: input.id, kind: input.kind, network: input.network, asset,
    payer: input.payer, reference: input.reference, createdAt: input.createdAt, expiresAt: input.expiresAt, policyVersion: input.policyVersion,
    servicePayment: Object.freeze({ amount: input.servicePayment.amount, recipient: input.servicePayment.recipient }), fundContribution: Object.freeze({ amount: input.fundContribution.amount, recipient: input.fundContribution.recipient }),
    total: totalUnits(input.servicePayment.amount, input.fundContribution.amount),
    networkFee: Object.freeze({ asset: 'SOL', includedInTotal: false }),
    ...(input.archive ? { archive: Object.freeze({ digest: input.archive.digest, bytes: input.archive.bytes }) } : {}),
  };
  return Object.freeze(order);
}
/** Validate deserialized orders again; do not accept a forged asset/total/metadata. */
export function assertOrder(order: Order): void {
  const rebuilt = createOrder({ ...order, asset: order.asset.symbol });
  if (order.schema !== rebuilt.schema || order.asset.symbol !== rebuilt.asset.symbol || order.asset.mint !== rebuilt.asset.mint || order.asset.program !== rebuilt.asset.program || order.asset.decimals !== rebuilt.asset.decimals ||
      order.total !== rebuilt.total || order.networkFee.asset !== 'SOL' || order.networkFee.includedInTotal !== false) throw new Error('invalid_order');
}
export type TreasuryControls = Readonly<{ operationalBudgetUnits: string; allowedDestinations: readonly string[]; paused: boolean }>;
export type TurboFundingCap = Readonly<{ asset: 'SOL'; maxLamports: string }>;
// TreasuryControls and TurboFundingCap never enter createOrder's contribution acceptance rules.
