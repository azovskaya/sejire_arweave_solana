import { MAX_BACKUP_BYTES, parseEnvelope, serializeEnvelope } from '../crypto/envelope';
import { DirectError, requireDirect } from './errors';
import type { DirectArchiveInput, DirectOperation, DirectQuote, DirectRawTransaction } from './types';

export const ID = /^[A-Za-z0-9_-]{43}$/;
export const HASH = /^[a-f0-9]{64}$/;
export const VAULT = /^[a-f0-9]{32}$/;
export const states = ['prepared', 'signing', 'signed', 'uploading', 'confirming', 'complete', 'blocked', 'cancelled'] as const;
export { MAX_BACKUP_BYTES };
export function winston(value: unknown): bigint {
  requireDirect(typeof value === 'string' && /^(0|[1-9][0-9]{0,29})$/.test(value), 'invalid_reward');
  return BigInt(value);
}
export async function sha256(bytes: Uint8Array): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource))].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
export function exactKeys(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  requireDirect(value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === [...keys].sort().join(','), 'invalid_operation');
}
export async function archiveInput(input: DirectArchiveInput) {
  let archiveText: string;
  try { archiveText = serializeEnvelope(input.envelope); } catch { throw new DirectError('invalid_archive'); }
  const bytes = new TextEncoder().encode(archiveText);
  requireDirect(bytes.length > 0 && bytes.length <= MAX_BACKUP_BYTES, 'archive_too_large');
  const treeId = input.treeId ?? null, parentTxId = input.parentTxId ?? null;
  requireDirect(treeId === null || typeof treeId === 'string' && treeId.length > 0 && treeId.length <= 256, 'invalid_archive');
  requireDirect(parentTxId === null || typeof parentTxId === 'string' && ID.test(parentTxId), 'invalid_archive');
  return { vaultId: input.envelope.vault_id, treeId, parentTxId, archiveText,
    archiveBytes: bytes.length, archiveDigest: await sha256(bytes) };
}
export function directTags(operation: Pick<DirectOperation, 'id' | 'vaultId' | 'parentTxId' | 'archiveDigest' | 'archiveBytes'>) {
  return [
    { name: 'Content-Type', value: 'application/json' }, { name: 'App-Name', value: 'SEJIRE' },
    { name: 'Type', value: 'vault-envelope' }, { name: 'Vault-Id', value: operation.vaultId },
    { name: 'Archive-SHA256', value: operation.archiveDigest }, { name: 'Archive-Bytes', value: String(operation.archiveBytes) },
    { name: 'Schema', value: 'sejire/envelope/v1' }, { name: 'Protocol-Version', value: 'sejire/v0.3' },
    { name: 'Save-Id', value: operation.id },
    ...(operation.parentTxId ? [{ name: 'Parent-Tx', value: operation.parentTxId }] : []),
  ];
}
export function validateQuote(quote: DirectQuote) {
  exactKeys(quote, ['ownerAddress', 'rewardWinston', 'balanceWinston', 'bytes', 'node', 'quotedAt']);
  requireDirect(ID.test(quote.ownerAddress) && winston(quote.rewardWinston) > 0n && winston(quote.balanceWinston) >= 0n &&
    Number.isSafeInteger(quote.bytes) && quote.bytes > 0 && quote.bytes <= MAX_BACKUP_BYTES &&
    Number.isSafeInteger(quote.quotedAt) && quote.quotedAt > 0 && typeof quote.node === 'string', 'invalid_operation');
}
export function validateRawShape(raw: DirectRawTransaction) {
  const fields = ['format', 'id', 'last_tx', 'owner', 'tags', 'target', 'quantity', 'data', 'data_size', 'data_root', 'reward', 'signature'];
  exactKeys(raw, raw && 'data_tree' in raw ? [...fields, 'data_tree'] : fields);
  requireDirect(raw.format === 2 && typeof raw.id === 'string' && typeof raw.last_tx === 'string' &&
    /^[A-Za-z0-9_-]{43,64}$/.test(raw.last_tx) && typeof raw.owner === 'string' && /^[A-Za-z0-9_-]{683}$/.test(raw.owner) &&
    raw.target === '' && raw.quantity === '0' && typeof raw.data === 'string' && raw.data.length <= Math.ceil(MAX_BACKUP_BYTES * 4 / 3) + 4 &&
    typeof raw.data_size === 'string' && /^[1-9][0-9]*$/.test(raw.data_size) && Number(raw.data_size) <= MAX_BACKUP_BYTES &&
    typeof raw.data_root === 'string' && ID.test(raw.data_root) && typeof raw.signature === 'string' &&
    Array.isArray(raw.tags) && raw.tags.length <= 24 && raw.tags.every(tag => tag && typeof tag.name === 'string' &&
      typeof tag.value === 'string' && tag.name.length <= 128 && tag.value.length <= 512), 'invalid_operation');
  requireDirect(winston(raw.reward) > 0n, 'invalid_reward');
  if ('data_tree' in raw) requireDirect(raw.data_tree === undefined || Array.isArray(raw.data_tree) && raw.data_tree.length === 0, 'invalid_operation');
}
export function validateOperation(operation: DirectOperation): DirectOperation {
  exactKeys(operation, ['schema', 'id', 'vaultId', 'treeId', 'parentTxId', 'archiveText', 'archiveDigest', 'archiveBytes', 'state',
    'ownerAddress', 'quote', 'signingIntent', 'signedTx', 'txId', 'uploadProgress', 'verification', 'lastError', 'createdAt', 'updatedAt', 'revision']);
  requireDirect(operation.schema === 'sejire/direct-arweave-operation/v1' && HASH.test(operation.id) && VAULT.test(operation.vaultId) &&
    HASH.test(operation.archiveDigest) && typeof operation.archiveText === 'string' &&
    Number.isSafeInteger(operation.archiveBytes) && operation.archiveBytes > 0 && operation.archiveBytes <= MAX_BACKUP_BYTES &&
    new TextEncoder().encode(operation.archiveText).length === operation.archiveBytes &&
    states.includes(operation.state) && (operation.treeId === null || typeof operation.treeId === 'string' && operation.treeId.length > 0 && operation.treeId.length <= 256) &&
    (operation.parentTxId === null || ID.test(operation.parentTxId)) && (operation.ownerAddress === null || ID.test(operation.ownerAddress)) &&
    (operation.txId === null || ID.test(operation.txId)) && Number.isSafeInteger(operation.revision) && operation.revision >= 0 &&
    Number.isSafeInteger(operation.createdAt) && Number.isSafeInteger(operation.updatedAt), 'invalid_operation');
  try { requireDirect(parseEnvelope(JSON.parse(operation.archiveText)).vault_id === operation.vaultId, 'invalid_operation'); }
  catch { requireDirect(false, 'invalid_operation'); }
  if (operation.quote) {
    validateQuote(operation.quote);
    requireDirect(operation.quote.bytes === operation.archiveBytes && operation.quote.ownerAddress === operation.ownerAddress, 'invalid_operation');
  }
  if (operation.signingIntent) {
    exactKeys(operation.signingIntent, ['id', 'startedAt', 'unsignedTx']);
    requireDirect(HASH.test(operation.signingIntent.id) && Number.isSafeInteger(operation.signingIntent.startedAt), 'invalid_operation');
    validateRawShape(operation.signingIntent.unsignedTx);
    requireDirect(operation.signingIntent.unsignedTx.id === '' && operation.signingIntent.unsignedTx.signature === '', 'invalid_operation');
  }
  if (operation.signedTx) { validateRawShape(operation.signedTx); requireDirect(operation.signedTx.id === operation.txId && ID.test(operation.signedTx.id), 'invalid_operation'); }
  if (['signing', 'signed', 'uploading', 'confirming', 'complete'].includes(operation.state)) requireDirect(operation.signingIntent && operation.quote && operation.ownerAddress, 'invalid_operation');
  if (['signed', 'uploading', 'confirming', 'complete'].includes(operation.state)) requireDirect(operation.signedTx && operation.txId, 'invalid_operation');
  exactKeys(operation.uploadProgress, ['node', 'headerAccepted', 'uploadedChunks', 'totalChunks']);
  requireDirect(typeof operation.uploadProgress.headerAccepted === 'boolean' && Number.isSafeInteger(operation.uploadProgress.uploadedChunks) &&
    Number.isSafeInteger(operation.uploadProgress.totalChunks) && operation.uploadProgress.uploadedChunks >= 0 &&
    operation.uploadProgress.uploadedChunks <= operation.uploadProgress.totalChunks && operation.uploadProgress.totalChunks <= 41 &&
    (operation.uploadProgress.node === null || typeof operation.uploadProgress.node === 'string'), 'invalid_operation');
  if (operation.verification) {
    exactKeys(operation.verification, ['checkedAt', 'confirmed', 'confirmations', 'bytesVerified', 'node']);
    requireDirect(Number.isSafeInteger(operation.verification.checkedAt) && typeof operation.verification.confirmed === 'boolean' &&
      typeof operation.verification.bytesVerified === 'boolean' && (operation.verification.confirmations === null ||
        Number.isSafeInteger(operation.verification.confirmations) && operation.verification.confirmations >= 0) &&
      (operation.verification.node === null || typeof operation.verification.node === 'string'), 'invalid_operation');
  }
  if (operation.state === 'complete') requireDirect(operation.verification?.confirmed && operation.verification.bytesVerified, 'invalid_operation');
  if (operation.state === 'cancelled') requireDirect(!operation.signingIntent && !operation.signedTx && !operation.txId, 'invalid_operation');
  return operation;
}
export async function verifyArchiveBinding(operation: DirectOperation) {
  validateOperation(operation);
  requireDirect(await sha256(new TextEncoder().encode(operation.archiveText)) === operation.archiveDigest, 'archive_integrity_failed');
}
