import type { AdminPaidOrder, AdminPaidOverview, AdminPaidTotal, TreasurySnapshot, TreasuryTopup, TreasuryTopups } from '../../../../sponsor/src/checkout/adminTypes';
import { fundAdminCall } from './client';
import { checkedTransferWire, type TransferWire } from './treasuryTransferStore';
export type { AdminPaidOrder, AdminPaidOverview, AdminPaidTotal, TreasurySnapshot, TreasuryTopup, TreasuryTopups };

const amount = (v: unknown): v is string => typeof v === 'string' && /^(0|[1-9][0-9]{0,29})$/.test(v);
const count = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0;
const object = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const network = (v: unknown): v is 'devnet' | 'mainnet-beta' => v === 'devnet' || v === 'mainnet-beta';
const arId = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{43}$/.test(v);
const solId = (v: unknown): v is string => typeof v === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v);
const orderId = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{32}$/.test(v);
const status = (v: unknown): v is string => typeof v === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(v);
function invalid(): never { throw Error('admin_response_invalid'); }

/** Validate and project only display fields; never retain an unexpected server payload. */
export function checkedPaidOverview(value: unknown): AdminPaidOverview {
  if (!object(value) || value.schema !== 'sejire/admin-paid-orders/v1' || !count(value.checkedAt) ||
      !(value.configuredNetwork === null || network(value.configuredNetwork)) || !object(value.policy) ||
      !Array.isArray(value.totals) || !Array.isArray(value.orders) || typeof value.hasMore !== 'boolean' ||
      !(value.cursor === null || typeof value.cursor === 'string' && /^[1-9][0-9]{0,14}$/.test(value.cursor)) ||
      value.hasMore !== (value.cursor !== null)) invalid();
  const policy = value.policy;
  if (!amount(policy.serviceLamports) || !(policy.serviceRecipient === null || solId(policy.serviceRecipient)) ||
      !(policy.fundRecipient === null || solId(policy.fundRecipient)) || typeof policy.paymentEnabled !== 'boolean' ||
      typeof policy.executionEnabled !== 'boolean' || !(policy.maxArchiveBytes === null || count(policy.maxArchiveBytes))) invalid();
  const seen = new Set<string>();
  const totals = value.totals.map((row): AdminPaidTotal => {
    if (!object(row) || !network(row.network) || seen.has(row.network) ||
        !['totalOrders', 'paymentConfirmed', 'storageCompleted', 'pending', 'failed'].every(key => count(row[key])) ||
        !amount(row.serviceLamports) || !amount(row.contributionLamports)) invalid();
    seen.add(row.network);
    return { network: row.network, totalOrders: Number(row.totalOrders), paymentConfirmed: Number(row.paymentConfirmed),
      storageCompleted: Number(row.storageCompleted), pending: Number(row.pending), failed: Number(row.failed),
      serviceLamports: row.serviceLamports, contributionLamports: row.contributionLamports };
  });
  const ids = new Set<string>();
  const orders = value.orders.map((row): AdminPaidOrder => {
    if (!object(row) || !orderId(row.id) || ids.has(row.id) || !['preservation', 'contribution'].includes(String(row.kind)) ||
        !network(row.network) || !count(row.createdAt) || !count(row.updatedAt) || !status(row.paymentStatus) ||
        !status(row.storageStatus) || !amount(row.serviceLamports) || !amount(row.contributionLamports) ||
        !(row.signature === undefined || typeof row.signature === 'string' && /^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(row.signature)) ||
        !(row.arweaveTxId === undefined || arId(row.arweaveTxId)) ||
        !(row.archiveBytes === undefined || count(row.archiveBytes)) ||
        !(row.rewardWinston === undefined || amount(row.rewardWinston))) invalid();
    ids.add(row.id);
    return { id: row.id, kind: row.kind as AdminPaidOrder['kind'], network: row.network,
      createdAt: row.createdAt, updatedAt: row.updatedAt, paymentStatus: row.paymentStatus, storageStatus: row.storageStatus,
      serviceLamports: row.serviceLamports, contributionLamports: row.contributionLamports,
      ...(row.signature === undefined ? {} : { signature: row.signature as string }),
      ...(row.arweaveTxId === undefined ? {} : { arweaveTxId: row.arweaveTxId as string }),
      ...(row.archiveBytes === undefined ? {} : { archiveBytes: row.archiveBytes as number }),
      ...(row.rewardWinston === undefined ? {} : { rewardWinston: row.rewardWinston as string }) };
  });
  return { schema: value.schema, checkedAt: value.checkedAt, configuredNetwork: value.configuredNetwork,
    policy: { serviceLamports: policy.serviceLamports, serviceRecipient: policy.serviceRecipient, fundRecipient: policy.fundRecipient,
      paymentEnabled: policy.paymentEnabled, executionEnabled: policy.executionEnabled, maxArchiveBytes: policy.maxArchiveBytes },
    totals, orders, hasMore: value.hasMore, cursor: value.cursor };
}
export function checkedTreasury(value: unknown): TreasurySnapshot {
  if (!object(value) || !arId(value.address) || !count(value.revision) ||
      !(value.ceilingWinston === null || amount(value.ceilingWinston)) || !amount(value.heldWinston) || !amount(value.unobservedDebitWinston)) invalid();
  return { address: value.address, revision: value.revision, ceilingWinston: value.ceilingWinston,
    heldWinston: value.heldWinston, unobservedDebitWinston: value.unobservedDebitWinston };
}
export function checkedTopup(value: unknown): TreasuryTopup {
  if (!object(value) || !orderId(value.id) || !arId(value.address) || !amount(value.amountWinston) || value.amountWinston === '0' ||
      !['prepared', 'credited'].includes(String(value.status)) || !count(value.baselineHeight) || !amount(value.priorCeilingWinston) ||
      !count(value.preparedRevision) || !count(value.createdAt) || !(value.txId === null || arId(value.txId)) ||
      !(value.transferTag === null || object(value.transferTag) && value.transferTag.name === 'SEJIRE-Topup-Intent' &&
        typeof value.transferTag.value === 'string' && /^[a-f0-9]{64}$/.test(value.transferTag.value)) ||
      !(value.creditedWinston === null || amount(value.creditedWinston)) || !(value.creditedRevision === null || count(value.creditedRevision)) ||
      !(value.confirmedAt === null || count(value.confirmedAt)) ||
      (value.status === 'credited' && (!arId(value.txId) || value.creditedWinston !== value.amountWinston ||
        !count(value.creditedRevision) || !count(value.confirmedAt)))) invalid();
  return { id: value.id, address: value.address, amountWinston: value.amountWinston, status: value.status as TreasuryTopup['status'],
    baselineHeight: value.baselineHeight, priorCeilingWinston: value.priorCeilingWinston, preparedRevision: value.preparedRevision,
    transferTag: value.transferTag === null ? null : { name: 'SEJIRE-Topup-Intent', value: (value.transferTag as Record<string, string>).value },
    createdAt: value.createdAt, txId: value.txId, creditedWinston: value.creditedWinston,
    creditedRevision: value.creditedRevision, confirmedAt: value.confirmedAt };
}
export function checkedTopups(value: unknown): TreasuryTopups {
  if (!object(value) || value.schema !== 'sejire/treasury-topups/v1' || !count(value.checkedAt) ||
      !count(value.minimumConfirmations) || value.minimumConfirmations < 1 ||
      !Array.isArray(value.treasuries) || !Array.isArray(value.intents) || typeof value.hasMore !== 'boolean' ||
      !(value.cursor === null || typeof value.cursor === 'string' && /^[1-9][0-9]{0,14}$/.test(value.cursor)) ||
      value.hasMore !== (value.cursor !== null)) invalid();
  const treasuries = value.treasuries.map(checkedTreasury), intents = value.intents.map(checkedTopup);
  if (new Set(treasuries.map(row => row.address)).size !== treasuries.length || new Set(intents.map(row => row.id)).size !== intents.length) invalid();
  return { schema: value.schema, checkedAt: value.checkedAt, minimumConfirmations: value.minimumConfirmations,
    treasuries, intents, hasMore: value.hasMore, cursor: value.cursor };
}
export const readPaidOverview = async (credential: string, signal?: AbortSignal, cursor: string | null = null) =>
  checkedPaidOverview(await fundAdminCall('/admin/paid-orders', credential, 'GET', undefined, signal, { limit: 50, cursor }));
export const readTreasuryTopups = async (credential: string, signal?: AbortSignal, cursor: string | null = null) =>
  checkedTopups(await fundAdminCall('/admin/treasury-topups', credential, 'GET', undefined, signal, { limit: 100, cursor }));
export async function prepareTreasuryTopup(credential: string,
  input: { requestId: string; address: string; amountWinston: string; expectedRevision: number }, signal?: AbortSignal) {
  if (!orderId(input.requestId) || !arId(input.address) || !amount(input.amountWinston) || input.amountWinston === '0' || !count(input.expectedRevision)) throw Error('invalid_topup_request');
  const value = await fundAdminCall<unknown>('/admin/treasury-topups/prepare', credential, 'POST', input, signal);
  if (!object(value)) invalid();
  return { intent: checkedTopup(value.intent), treasury: checkedTreasury(value.treasury) };
}
export async function confirmTreasuryTopup(credential: string, id: string, input: { txId: string; expectedRevision: number }, signal?: AbortSignal) {
  if (!orderId(id) || !arId(input.txId) || !count(input.expectedRevision)) throw Error('invalid_topup_request');
  const value = await fundAdminCall<unknown>(`/admin/treasury-topups/${id}/confirm`, credential, 'POST', input, signal);
  if (!object(value) || typeof value.reused !== 'boolean') invalid();
  return { intent: checkedTopup(value.intent), treasury: checkedTreasury(value.treasury), reused: value.reused };
}
export const formatSol = (lamports: string) => {
  if (!amount(lamports)) invalid();
  const n = BigInt(lamports);
  return `${n / 1_000_000_000n}.${(n % 1_000_000_000n).toString().padStart(9, '0')}`;
};
export const networkLabel = (value: 'devnet' | 'mainnet-beta' | null) => value === 'mainnet-beta' ? 'Solana Mainnet' : value === 'devnet' ? 'Solana Devnet (тестовая)' : 'Сеть не настроена';
export function solanaTransactionUrl(row: Pick<AdminPaidOrder, 'network' | 'signature'>): string | null {
  if (!row.signature || !/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(row.signature) || !network(row.network)) return null;
  return `https://explorer.solana.com/tx/${row.signature}${row.network === 'devnet' ? '?cluster=devnet' : ''}`;
}
function transferPath(id: string) { if (!orderId(id)) throw Error('invalid_topup_request'); return `/admin/treasury-topups/${id}/transfer`; }
export async function readTopupTransfer(credential: string, id: string, signal?: AbortSignal): Promise<TransferWire | null> {
  const value = await fundAdminCall<unknown>(transferPath(id), credential, 'GET', undefined, signal);
  if (!object(value)) invalid();
  return value.transfer === null ? null : checkedTransferWire(value.transfer);
}
export async function claimTopupTransfer(credential: string, id: string, input: { claimId: string; unsignedTx: string }, signal?: AbortSignal) {
  if (!orderId(input.claimId) || typeof input.unsignedTx !== 'string' || input.unsignedTx.length > 65536) throw Error('invalid_topup_request');
  const value = await fundAdminCall<unknown>(`${transferPath(id)}/claim`, credential, 'POST', input, signal);
  if (!object(value) || typeof value.reused !== 'boolean') invalid();
  return { transfer: checkedTransferWire(value.transfer), reused: value.reused };
}
export async function commitTopupTransfer(credential: string, id: string, input: { claimId: string; signedTx: string }, signal?: AbortSignal) {
  if (!orderId(input.claimId) || typeof input.signedTx !== 'string' || input.signedTx.length > 65536) throw Error('invalid_topup_request');
  const value = await fundAdminCall<unknown>(`${transferPath(id)}/signed`, credential, 'POST', input, signal);
  if (!object(value) || typeof value.reused !== 'boolean') invalid();
  return { transfer: checkedTransferWire(value.transfer), reused: value.reused };
}
