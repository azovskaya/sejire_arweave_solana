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
export type LegacyOrder = Readonly<{
  schema: 'sejire/order/v1'; id: string; kind: 'preservation' | 'contribution'; network: Network;
  asset: Asset; payer: string; reference: string; createdAt: number; expiresAt: number; policyVersion: string;
  servicePayment: PaymentPart; fundContribution: PaymentPart; total: string;
  networkFee: Readonly<{ asset: 'SOL'; includedInTotal: false }>;
  archive?: ArchiveBinding;
}>;
export const PAID_SERVICE_LAMPORTS = '30000000' as const;
export const MAX_PAID_ARCHIVE_BYTES = 10 * 1024 * 1024;
/** Public disposable recipients from the devnet pilot are never production roles. */
export const DEVNET_ONLY_RECIPIENTS = Object.freeze([
  'Hn9ELgjKXrb7svZM9XtDYozGTirxo5e1tWRy1J1v4vwF',
  'ETWcxNPF3Qcwvo4NHYw6JhMiKnGwrvH1U9YEAQ3rZSWd',
  'Gy3SSxP7spgDcserSfMckPd73LeSoxdrvXeNap7huLQN',
  'Fp6ZxyVLfXhpxbcvmiL5hPsr2uqDozuLaQ1jA3avrVPF',
]);
export type PaidArchiveBinding = Readonly<ArchiveBinding & { vaultId: string; parentTxId: string | null }>;
export type PaidStorageTarget = Readonly<{ kind: 'arweave-direct'; network: 'arweave.N.1'; treasuryAddress: string }>;
export type PaidOrder = Readonly<Omit<LegacyOrder, 'schema' | 'kind' | 'archive'> & {
  schema: 'sejire/order/v2'; kind: 'preservation'; policyHash: string;
  archive: PaidArchiveBinding; storage: PaidStorageTarget;
}>;
export type Order = LegacyOrder | PaidOrder;
export type OrderInput = Omit<LegacyOrder, 'schema' | 'asset' | 'total' | 'networkFee'> & { asset: 'SOL' | 'USDC' };
export type PaidOrderInput = Omit<PaidOrder, 'schema' | 'asset' | 'total' | 'networkFee'> & { asset: 'SOL' };
/** Trusted order creation only, not a price supplied by a browser. No default archive size policy. */
export function createOrder(input: OrderInput): LegacyOrder {
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
  const order: LegacyOrder = {
    schema: 'sejire/order/v1', id: input.id, kind: input.kind, network: input.network, asset,
    payer: input.payer, reference: input.reference, createdAt: input.createdAt, expiresAt: input.expiresAt, policyVersion: input.policyVersion,
    servicePayment: Object.freeze({ amount: input.servicePayment.amount, recipient: input.servicePayment.recipient }), fundContribution: Object.freeze({ amount: input.fundContribution.amount, recipient: input.fundContribution.recipient }),
    total: totalUnits(input.servicePayment.amount, input.fundContribution.amount),
    networkFee: Object.freeze({ asset: 'SOL', includedInTotal: false }),
    ...(input.archive ? { archive: Object.freeze({ digest: input.archive.digest, bytes: input.archive.bytes }) } : {}),
  };
  return Object.freeze(order);
}
function exactFields(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) throw new Error('invalid_paid_order');
}
export function validatePaidArchive(value: unknown): PaidArchiveBinding {
  exactFields(value, ['digest', 'bytes', 'vaultId', 'parentTxId']);
  if (typeof value.digest !== 'string' || !/^[a-f0-9]{64}$/.test(value.digest) ||
      typeof value.bytes !== 'number' || !Number.isSafeInteger(value.bytes) || value.bytes < 1 || value.bytes > MAX_PAID_ARCHIVE_BYTES ||
      typeof value.vaultId !== 'string' || !/^[a-f0-9]{32}$/.test(value.vaultId) ||
      !(value.parentTxId === null || (typeof value.parentTxId === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value.parentTxId)))) throw new Error('invalid_paid_archive');
  return Object.freeze({ digest: value.digest, bytes: value.bytes, vaultId: value.vaultId, parentTxId: value.parentTxId });
}
export function validatePaidStorage(value: unknown): PaidStorageTarget {
  exactFields(value, ['kind', 'network', 'treasuryAddress']);
  if (value.kind !== 'arweave-direct' || value.network !== 'arweave.N.1' ||
      typeof value.treasuryAddress !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value.treasuryAddress)) throw new Error('invalid_paid_storage');
  return Object.freeze({ kind: value.kind, network: value.network, treasuryAddress: value.treasuryAddress });
}
/** V2 is deliberately a new schema: old executors must reject it rather than select Turbo. */
export function createPaidOrder(input: PaidOrderInput): PaidOrder {
  if (input.kind !== 'preservation' || input.asset !== 'SOL' || input.servicePayment.amount !== PAID_SERVICE_LAMPORTS ||
      typeof input.policyHash !== 'string' || !/^[a-f0-9]{64}$/.test(input.policyHash)) throw new Error('invalid_paid_order');
  if (input.network === 'mainnet-beta' && [input.servicePayment.recipient, input.fundContribution.recipient].some(address => DEVNET_ONLY_RECIPIENTS.includes(address))) throw new Error('devnet_wallet_cannot_be_mainnet_treasury');
  const archive = validatePaidArchive(input.archive), storage = validatePaidStorage(input.storage);
  const legacy = createOrder(input);
  if ([input.payer, input.servicePayment.recipient, input.fundContribution.recipient, SYSTEM_PROGRAM].includes(input.reference) ||
      [input.payer, input.servicePayment.recipient, input.fundContribution.recipient].includes(SYSTEM_PROGRAM)) throw new Error('recipient_roles_overlap');
  return Object.freeze({ ...legacy, schema: 'sejire/order/v2', kind: 'preservation', policyHash: input.policyHash, archive, storage });
}
/** Validate deserialized orders again; do not accept a forged asset/total/metadata. */
export function assertOrder(order: Order): void {
  if (!order || typeof order !== 'object') throw new Error('invalid_order');
  const rebuilt = order.schema === 'sejire/order/v2'
    ? createPaidOrder({ ...order, asset: order.asset.symbol as 'SOL' })
    : createOrder({ ...order, asset: order.asset.symbol });
  if (order.schema !== rebuilt.schema || order.asset.symbol !== rebuilt.asset.symbol || order.asset.mint !== rebuilt.asset.mint || order.asset.program !== rebuilt.asset.program || order.asset.decimals !== rebuilt.asset.decimals ||
      order.total !== rebuilt.total || order.networkFee.asset !== 'SOL' || order.networkFee.includedInTotal !== false) throw new Error('invalid_order');
  if (order.schema === 'sejire/order/v2') {
    exactFields(order, Object.keys(rebuilt));
    exactFields(order.asset, ['symbol', 'decimals', 'mint', 'program']);
    exactFields(order.servicePayment, ['amount', 'recipient']);
    exactFields(order.fundContribution, ['amount', 'recipient']);
    exactFields(order.networkFee, ['asset', 'includedInTotal']);
  }
}
export type TreasuryControls = Readonly<{ operationalBudgetUnits: string; allowedDestinations: readonly string[]; paused: boolean }>;
export type TurboFundingCap = Readonly<{ asset: 'SOL'; maxLamports: string }>;
// TreasuryControls and TurboFundingCap never enter createOrder's contribution acceptance rules.
