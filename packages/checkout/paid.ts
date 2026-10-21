import {
  assertBase58, assertOrder, createPaidOrder, DEVNET_ONLY_RECIPIENTS, MAX_PAID_ARCHIVE_BYTES,
  PAID_SERVICE_LAMPORTS, SYSTEM_PROGRAM, validatePaidArchive, validatePaidStorage,
  type Network, type PaidArchiveBinding, type PaidOrder, type PaidStorageTarget,
} from './order';
import { assertUnits } from './amounts';
import { canonical } from '../protocol/wire';

export { PAID_SERVICE_LAMPORTS } from './order';
export const SOLANA_GENESIS = Object.freeze({
  devnet: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
  'mainnet-beta': '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
});
export const SOLANA_RPCS = Object.freeze({
  devnet: 'https://api.devnet.solana.com',
  'mainnet-beta': 'https://api.mainnet-beta.solana.com',
});

/** Public, immutable terms. Admission/executor switches and budget allocation live on the server.
 * No role, reward limit or budget is inferred from a promo fund or a pilot configuration. */
export type PaidPolicy = Readonly<{
  schema: 'sejire/checkout-policy/v1'; version: string; network: Network; genesisHash: string;
  serviceLamports: typeof PAID_SERVICE_LAMPORTS; serviceRecipient: string; fundRecipient: string;
  storage: Readonly<PaidStorageTarget & { budgetId: string; maxBytes: number; maxRewardWinston: string }>;
}>;
function exact(value: unknown, keys: readonly string[], code: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) throw new Error(code);
}
function positiveWinston(value: unknown): value is string {
  return typeof value === 'string' && /^[1-9][0-9]{0,29}$/.test(value);
}
export function validatePaidPolicy(value: unknown): PaidPolicy {
  exact(value, ['schema', 'version', 'network', 'genesisHash', 'serviceLamports', 'serviceRecipient', 'fundRecipient', 'storage'], 'invalid_paid_policy');
  if (value.schema !== 'sejire/checkout-policy/v1' || typeof value.version !== 'string' || !/^[a-zA-Z0-9._-]{1,64}$/.test(value.version) ||
      (value.network !== 'devnet' && value.network !== 'mainnet-beta') || value.genesisHash !== SOLANA_GENESIS[value.network] ||
      value.serviceLamports !== PAID_SERVICE_LAMPORTS || typeof value.serviceRecipient !== 'string' || typeof value.fundRecipient !== 'string') throw new Error('invalid_paid_policy');
  assertBase58(value.serviceRecipient, 32); assertBase58(value.fundRecipient, 32);
  if (value.serviceRecipient === value.fundRecipient || [value.serviceRecipient, value.fundRecipient].includes(SYSTEM_PROGRAM)) throw new Error('recipient_roles_overlap');
  if (value.network === 'mainnet-beta' && [value.serviceRecipient, value.fundRecipient].some(address => DEVNET_ONLY_RECIPIENTS.includes(address))) throw new Error('devnet_wallet_cannot_be_mainnet_treasury');
  exact(value.storage, ['kind', 'network', 'treasuryAddress', 'budgetId', 'maxBytes', 'maxRewardWinston'], 'invalid_paid_policy');
  const storage = value.storage;
  const target = validatePaidStorage({ kind: storage.kind, network: storage.network, treasuryAddress: storage.treasuryAddress });
  if (typeof storage.budgetId !== 'string' || !/^[a-zA-Z0-9._-]{1,64}$/.test(storage.budgetId) ||
      typeof storage.maxBytes !== 'number' || !Number.isSafeInteger(storage.maxBytes) || storage.maxBytes < 1 || storage.maxBytes > MAX_PAID_ARCHIVE_BYTES ||
      !positiveWinston(storage.maxRewardWinston)) throw new Error('invalid_paid_policy');
  return Object.freeze({ schema: value.schema, version: value.version, network: value.network, genesisHash: SOLANA_GENESIS[value.network],
    serviceLamports: value.serviceLamports, serviceRecipient: value.serviceRecipient, fundRecipient: value.fundRecipient,
    storage: Object.freeze({ ...target, budgetId: storage.budgetId, maxBytes: storage.maxBytes, maxRewardWinston: storage.maxRewardWinston }) });
}
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}
export async function paidPolicyHash(policy: PaidPolicy): Promise<string> {
  return sha256Hex(new TextEncoder().encode(canonical(validatePaidPolicy(policy))));
}
export async function createPaidOrderFromPolicy(policy: PaidPolicy, input: {
  id: string; payer: string; reference: string; createdAt: number; expiresAt: number;
  archive: PaidArchiveBinding;
  /** Integer lamports, not a decimal SOL string. Omission means no contribution. */
  contribution?: string;
}): Promise<PaidOrder> {
  const checked = validatePaidPolicy(policy), archive = validatePaidArchive(input.archive);
  if (archive.bytes > checked.storage.maxBytes) throw new Error('envelope_too_large');
  return createPaidOrder({ id: input.id, payer: input.payer, reference: input.reference, createdAt: input.createdAt, expiresAt: input.expiresAt,
    kind: 'preservation', network: checked.network, asset: 'SOL', policyVersion: checked.version, policyHash: await paidPolicyHash(checked),
    servicePayment: { amount: PAID_SERVICE_LAMPORTS, recipient: checked.serviceRecipient },
    fundContribution: { amount: input.contribution ?? '0', recipient: checked.fundRecipient }, archive,
    storage: { kind: checked.storage.kind, network: checked.storage.network, treasuryAddress: checked.storage.treasuryAddress } });
}
export async function validatePaidOrderPolicy(order: PaidOrder, policy: PaidPolicy): Promise<void> {
  assertOrder(order); const checked = validatePaidPolicy(policy);
  if (order.schema !== 'sejire/order/v2' || order.policyHash !== await paidPolicyHash(checked) || order.policyVersion !== checked.version ||
      order.network !== checked.network || order.servicePayment.amount !== checked.serviceLamports || order.servicePayment.recipient !== checked.serviceRecipient ||
      order.fundContribution.recipient !== checked.fundRecipient || order.archive.bytes > checked.storage.maxBytes ||
      order.storage.kind !== checked.storage.kind || order.storage.network !== checked.storage.network || order.storage.treasuryAddress !== checked.storage.treasuryAddress) throw new Error('paid_policy_mismatch');
}

export type DurablePaymentPreparation = Readonly<{
  schema: 'sejire/payment-preparation/v1'; preparationId: string; orderId: string; policyHash: string;
  network: Network; genesisHash: string; payer: string; reference: string;
  blockhash: string; lastValidBlockHeight: number; messageBase64: string; messageSha256: string;
  feeLamports: string; createdAt: number;
}>;

// Small native SOL templates only. No Buffer, Node SDK, arbitrary program or caller URL is needed.
const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function decode58(value: string, maxBytes: number): Uint8Array {
  if (typeof value !== 'string' || value.length > Math.ceil(maxBytes * 1.38)) throw new Error('invalid_payment_message');
  let n = 0n;
  for (const char of value) { const digit = BASE58.indexOf(char); if (digit < 0) throw new Error('invalid_payment_message'); n = n * 58n + BigInt(digit); }
  const bytes: number[] = []; for (; n > 0n; n >>= 8n) bytes.unshift(Number(n & 255n));
  const result = new Uint8Array([...Array.from({ length: value.match(/^1*/)?.[0].length ?? 0 }, () => 0), ...bytes]);
  if (result.length > maxBytes) throw new Error('invalid_payment_message');
  return result;
}
function short(value: number): number[] {
  if (!Number.isSafeInteger(value) || value < 0 || value > 65535) throw new Error('invalid_payment_message');
  const bytes: number[] = [];
  do { const byte = value & 127; value >>>= 7; bytes.push(byte | (value ? 128 : 0)); } while (value);
  return bytes;
}
function base64(bytes: Uint8Array): string {
  let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
export function paymentMessageBytes(value: string): Uint8Array {
  if (typeof value !== 'string' || !value || value.length > 1644 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new Error('invalid_payment_message');
  const binary = atob(value), bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
  if (bytes.length > 1232 || base64(bytes) !== value) throw new Error('invalid_payment_message');
  return bytes;
}
export type LegacyCompiledMessage = {
  header: { numRequiredSignatures: number; numReadonlySignedAccounts: number; numReadonlyUnsignedAccounts: number };
  accountKeys: readonly string[]; recentBlockhash: string;
  instructions: readonly { programIdIndex: number; accounts: readonly number[]; data: string | Uint8Array }[];
};
/** Reconstruct exactly the legacy wire message returned by encoding=json, preserving account order. */
export function serializeLegacyPaymentMessage(message: LegacyCompiledMessage): string {
  const keys = message.accountKeys, header = message.header;
  if (!Array.isArray(keys) || keys.length < 1 || keys.length > 256 || new Set(keys).size !== keys.length ||
      !Array.isArray(message.instructions) || message.instructions.length < 1 || message.instructions.length > 4) throw new Error('invalid_payment_message');
  const byte = (value: number) => { if (!Number.isSafeInteger(value) || value < 0 || value > 255) throw new Error('invalid_payment_message'); return value; };
  const key = (value: string) => { assertBase58(value, 32); return [...decode58(value, 32)]; };
  const out = [byte(header.numRequiredSignatures), byte(header.numReadonlySignedAccounts), byte(header.numReadonlyUnsignedAccounts),
    ...short(keys.length), ...keys.flatMap(key), ...key(message.recentBlockhash), ...short(message.instructions.length)];
  for (const instruction of message.instructions) {
    const data = typeof instruction.data === 'string' ? decode58(instruction.data, 32) : instruction.data;
    if (!(data instanceof Uint8Array) || data.length > 32 || instruction.programIdIndex >= keys.length || !Array.isArray(instruction.accounts) ||
        instruction.accounts.length > 5 || instruction.accounts.some((index: number) => index >= keys.length)) throw new Error('invalid_payment_message');
    out.push(byte(instruction.programIdIndex), ...short(instruction.accounts.length), ...instruction.accounts.map(byte), ...short(data.length), ...data);
  }
  if (out.length > 1232) throw new Error('invalid_payment_message');
  return base64(new Uint8Array(out));
}
export function buildPaidPaymentMessage(order: PaidOrder, blockhash: string): string {
  assertOrder(order);
  if (order.schema !== 'sejire/order/v2') throw new Error('invalid_paid_order');
  assertBase58(blockhash, 32);
  const parts = [order.servicePayment, order.fundContribution].filter(part => part.amount !== '0');
  const keys = [order.payer, ...parts.map(part => part.recipient), SYSTEM_PROGRAM, order.reference];
  return serializeLegacyPaymentMessage({ accountKeys: keys, recentBlockhash: blockhash,
    header: { numRequiredSignatures: 1, numReadonlySignedAccounts: 0, numReadonlyUnsignedAccounts: 2 },
    instructions: parts.map((part, index) => {
      const bytes = new Uint8Array(12); bytes[0] = 2; let amount = assertUnits(part.amount);
      for (let offset = 4; offset < 12; offset++) { bytes[offset] = Number(amount & 255n); amount >>= 8n; }
      return { programIdIndex: keys.length - 2, accounts: [0, index + 1, keys.length - 1], data: bytes };
    }) });
}
export async function createPaymentPreparation(order: PaidOrder, input: {
  blockhash: string; lastValidBlockHeight: number; feeLamports: string; createdAt: number;
}): Promise<DurablePaymentPreparation> {
  const messageBase64 = buildPaidPaymentMessage(order, input.blockhash), messageSha256 = await sha256Hex(paymentMessageBytes(messageBase64));
  return validatePaymentPreparation(order, { schema: 'sejire/payment-preparation/v1', preparationId: messageSha256,
    orderId: order.id, policyHash: order.policyHash, network: order.network, genesisHash: SOLANA_GENESIS[order.network], payer: order.payer,
    reference: order.reference, blockhash: input.blockhash, lastValidBlockHeight: input.lastValidBlockHeight,
    messageBase64, messageSha256, feeLamports: input.feeLamports, createdAt: input.createdAt });
}
export async function validatePaymentPreparation(order: PaidOrder, value: unknown): Promise<DurablePaymentPreparation> {
  assertOrder(order);
  exact(value, ['schema', 'preparationId', 'orderId', 'policyHash', 'network', 'genesisHash', 'payer', 'reference', 'blockhash', 'lastValidBlockHeight', 'messageBase64', 'messageSha256', 'feeLamports', 'createdAt'], 'invalid_payment_preparation');
  if (order.schema !== 'sejire/order/v2' || value.schema !== 'sejire/payment-preparation/v1' || value.orderId !== order.id || value.policyHash !== order.policyHash ||
      value.network !== order.network || value.genesisHash !== SOLANA_GENESIS[order.network] || value.payer !== order.payer || value.reference !== order.reference ||
      typeof value.blockhash !== 'string' || typeof value.lastValidBlockHeight !== 'number' || !Number.isSafeInteger(value.lastValidBlockHeight) || value.lastValidBlockHeight < 0 ||
      typeof value.messageBase64 !== 'string' || typeof value.messageSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.messageSha256) || value.preparationId !== value.messageSha256 ||
      typeof value.createdAt !== 'number' || !Number.isSafeInteger(value.createdAt) || value.createdAt < order.createdAt || value.createdAt >= order.expiresAt ||
      typeof value.feeLamports !== 'string' || assertUnits(value.feeLamports) < 1n) throw new Error('invalid_payment_preparation');
  if (buildPaidPaymentMessage(order, value.blockhash) !== value.messageBase64 || await sha256Hex(paymentMessageBytes(value.messageBase64)) !== value.messageSha256) throw new Error('payment_preparation_mismatch');
  return Object.freeze({ ...value }) as DurablePaymentPreparation;
}
/** Public-key check before reserving a client-supplied signature. No signing or broadcast occurs.
 * Chain inclusion/finality still requires validatePreparedPayment on trusted RPC evidence. */
export async function verifyPreparedPaymentSignature(order: PaidOrder, preparation: DurablePaymentPreparation, signature: string): Promise<void> {
  const checked = await validatePaymentPreparation(order, preparation);
  assertBase58(signature, 64);
  const publicKey = await crypto.subtle.importKey('raw', new Uint8Array(decode58(order.payer, 32)), { name: 'Ed25519' }, false, ['verify']);
  if (!await crypto.subtle.verify({ name: 'Ed25519' }, publicKey, new Uint8Array(decode58(signature, 64)), new Uint8Array(paymentMessageBytes(checked.messageBase64)))) throw new Error('invalid_payment_signature');
}

export type PaidReceipt = Readonly<{
  schema: 'sejire/preservation-receipt/v2'; status: 'confirmed-and-verified';
  orderId: string; policyHash: string; paymentNetwork: Network; paymentSignature: string;
  arweaveNetwork: 'arweave.N.1'; txId: string; archive: PaidArchiveBinding;
  treasuryAddress: string; rewardWinston: string; verifiedAt: number;
}>;
export function validatePaidReceipt(value: unknown, expectedOrder?: PaidOrder): PaidReceipt {
  exact(value, ['schema', 'status', 'orderId', 'policyHash', 'paymentNetwork', 'paymentSignature', 'arweaveNetwork', 'txId', 'archive', 'treasuryAddress', 'rewardWinston', 'verifiedAt'], 'invalid_paid_receipt');
  if (value.schema !== 'sejire/preservation-receipt/v2' || value.status !== 'confirmed-and-verified' || typeof value.orderId !== 'string' || !/^[a-f0-9]{32}$/.test(value.orderId) ||
      typeof value.policyHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.policyHash) || (value.paymentNetwork !== 'devnet' && value.paymentNetwork !== 'mainnet-beta') ||
      typeof value.paymentSignature !== 'string' || value.arweaveNetwork !== 'arweave.N.1' || typeof value.txId !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value.txId) ||
      typeof value.treasuryAddress !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value.treasuryAddress) || !positiveWinston(value.rewardWinston) ||
      typeof value.verifiedAt !== 'number' || !Number.isSafeInteger(value.verifiedAt) || value.verifiedAt < 0) throw new Error('invalid_paid_receipt');
  assertBase58(value.paymentSignature, 64);
  const archive = validatePaidArchive(value.archive);
  if (expectedOrder) {
    assertOrder(expectedOrder);
    if (expectedOrder.schema !== 'sejire/order/v2' || value.orderId !== expectedOrder.id || value.policyHash !== expectedOrder.policyHash ||
        value.paymentNetwork !== expectedOrder.network || value.arweaveNetwork !== expectedOrder.storage.network || value.treasuryAddress !== expectedOrder.storage.treasuryAddress ||
        canonical(archive) !== canonical(expectedOrder.archive)) throw new Error('paid_receipt_mismatch');
  }
  return Object.freeze({ ...value, archive }) as PaidReceipt;
}
