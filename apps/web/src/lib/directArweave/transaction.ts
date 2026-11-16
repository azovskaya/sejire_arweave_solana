import type Transaction from 'arweave/web/lib/transaction';
import { resolveArweaveStatic } from '../arweave/client';
import { DirectError, requireDirect } from './errors';
import { directTags, ID, validateRawShape, verifyArchiveBinding } from './format';
import { nodeRequest } from './network';
import type { DirectOperation, DirectQuote, DirectRawTransaction, DirectReceipt } from './types';

/** Cryptography and Merkle routines only; every network request uses network.ts. */
export function directCrypto() { return resolveArweaveStatic().init({ host: 'arweave.net', port: 443, protocol: 'https' }); }
export async function prepareDirectTransaction(operation: DirectOperation, quote: DirectQuote, owner: string, signal?: AbortSignal) {
  await verifyArchiveBinding(operation);
  const ar = directCrypto();
  requireDirect(typeof owner === 'string' && /^[A-Za-z0-9_-]{683}$/.test(owner) &&
    await ar.wallets.ownerToAddress(owner) === quote.ownerAddress, 'wallet_changed');
  const anchor = await nodeRequest(quote.node, '/tx_anchor', { signal, maxBytes: 128 });
  const lastTx = anchor.text.trim();
  requireDirect(anchor.status === 200 && /^[A-Za-z0-9_-]+$/.test(lastTx) && [43, 64].includes(lastTx.length), 'network_unavailable');
  // Explicit reward/anchor/owner prevent hidden SDK requests to its default host.
  const tx = await ar.createTransaction({ data: new TextEncoder().encode(operation.archiveText), owner,
    reward: quote.rewardWinston, last_tx: lastTx });
  for (const tag of directTags(operation)) tx.addTag(tag.name, tag.value);
  await tx.prepareChunks(tx.data);
  validateRawShape(tx.toJSON());
  return tx;
}
function decodedTags(tx: Transaction) {
  return tx.tags.map(tag => ({ name: tag.get('name', { decode: true, string: true }), value: tag.get('value', { decode: true, string: true }) }));
}
export function requireDirectTags(actual: { name: string; value: string }[], expected: { name: string; value: string }[]) {
  requireDirect(new Set(actual.map(tag => tag.name)).size === actual.length, 'signature_invalid');
  const required = new Map(expected.map(tag => [tag.name, tag.value]));
  requireDirect(expected.every(tag => actual.some(value => value.name === tag.name && value.value === tag.value)), 'signature_invalid');
  requireDirect(actual.every(tag => required.has(tag.name) ||
    ['Signing-Client', 'Signing-Client-Version'].includes(tag.name) && tag.value.length > 0 && tag.value.length <= 64), 'signature_invalid');
}
function rawValue(value: unknown): DirectRawTransaction {
  requireDirect(value !== null && typeof value === 'object', 'signature_invalid');
  const candidate = value as { toJSON?: () => DirectRawTransaction };
  const raw = typeof candidate.toJSON === 'function' ? candidate.toJSON() : value as DirectRawTransaction;
  validateRawShape(raw); return raw;
}
export async function verifyDirectSigned(operation: DirectOperation, candidate: unknown = operation.signedTx): Promise<Transaction> {
  await verifyArchiveBinding(operation);
  requireDirect(operation.quote && operation.ownerAddress && operation.signingIntent, 'signature_invalid');
  try {
    const raw = rawValue(candidate), ar = directCrypto(), tx = ar.transactions.fromRaw(raw);
    requireDirect(ID.test(tx.id) && tx.id === (operation.txId ?? tx.id) && tx.target === '' && tx.quantity === '0' &&
      tx.reward === operation.quote.rewardWinston && tx.last_tx === operation.signingIntent.unsignedTx.last_tx &&
      tx.data_size === String(operation.archiveBytes) && new TextDecoder('utf-8', { fatal: true }).decode(tx.data) === operation.archiveText &&
      await ar.wallets.ownerToAddress(tx.owner) === operation.ownerAddress && await ar.transactions.verify(tx), 'signature_invalid');
    requireDirectTags(decodedTags(tx), directTags(operation));
    const originalRoot = tx.data_root;
    const check = ar.transactions.fromRaw({ ...raw, data_root: '' }); await check.prepareChunks(tx.data);
    requireDirect(originalRoot === check.data_root && originalRoot === operation.signingIntent.unsignedTx.data_root, 'signature_invalid');
    // Rebuild chunks from the validated ciphertext; never trust an imported tree.
    await tx.prepareChunks(tx.data); requireDirect(tx.data_root === originalRoot, 'signature_invalid');
    return tx;
  } catch (error) { throw error instanceof DirectError ? error : new DirectError('signature_invalid'); }
}
export function publicHeader(raw: DirectRawTransaction): Record<string, unknown> {
  const { data: _data, data_tree: _tree, ...metadata } = raw as DirectRawTransaction & { data_tree?: unknown };
  return metadata;
}
export function matchesPublicHeader(actual: unknown, expected: DirectRawTransaction): boolean {
  if (!actual || typeof actual !== 'object' || Array.isArray(actual)) return false;
  const header = actual as Record<string, unknown>;
  return Object.entries(publicHeader(expected)).every(([key, value]) => {
    if (key !== 'tags') return JSON.stringify(header[key]) === JSON.stringify(value);
    const actualTags = header.tags;
    return Array.isArray(actualTags) && actualTags.length === expected.tags.length && actualTags.every((tag, index) =>
      tag && tag.name === expected.tags[index].name && tag.value === expected.tags[index].value);
  });
}
/** A receipt is a locator, not a settlement proof. Verify native signature and byte binding on retrieval. */
export async function verifyReceiptTransaction(receipt: DirectReceipt, metadata: unknown, bytes: Uint8Array) {
  requireDirect(metadata !== null && typeof metadata === 'object' && !Array.isArray(metadata), 'receipt_invalid');
  const source = metadata as Record<string, unknown>, ar = directCrypto();
  const fields = ['format', 'id', 'last_tx', 'owner', 'tags', 'target', 'quantity', 'data_size', 'data_root', 'reward', 'signature'];
  const raw = { ...Object.fromEntries(fields.map(key => [key, source[key]])), data: ar.utils.bufferTob64Url(bytes) } as DirectRawTransaction;
  try {
    validateRawShape(raw); const tx = ar.transactions.fromRaw(raw);
    requireDirect(tx.id === receipt.transactionId && tx.reward === receipt.rewardWinston && tx.data_size === String(receipt.archiveBytes) &&
      await ar.wallets.ownerToAddress(tx.owner) === receipt.ownerAddress && await ar.transactions.verify(tx), 'receipt_invalid');
    const tags = decodedTags(tx), saveId = tags.find(tag => tag.name === 'Save-Id')?.value;
    requireDirect(typeof saveId === 'string' && /^[a-f0-9]{64}$/.test(saveId), 'receipt_invalid');
    requireDirectTags(tags, directTags({ id: saveId, vaultId: receipt.vaultId, parentTxId: receipt.parentTxId,
      archiveDigest: receipt.archiveDigest, archiveBytes: receipt.archiveBytes }));
    const root = tx.data_root; const fresh = ar.transactions.fromRaw({ ...raw, data_root: '' }); await fresh.prepareChunks(bytes);
    requireDirect(root === fresh.data_root, 'receipt_invalid');
  } catch { throw new DirectError('receipt_invalid'); }
}
