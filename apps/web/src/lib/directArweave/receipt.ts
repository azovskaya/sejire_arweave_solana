import { parseEnvelope } from '../crypto/envelope';
import { DirectError, requireDirect } from './errors';
import { exactKeys, HASH, ID, MAX_BACKUP_BYTES, VAULT, validateOperation, winston } from './format';
import { active, directNodes, fetchArchiveBytes, nodeRequest, scoped } from './network';
import { directCrypto, verifyReceiptTransaction } from './transaction';
import type { DirectOperation, DirectOptions, DirectReceipt } from './types';

export function parseDirectReceipt(value: unknown): DirectReceipt {
  try {
    exactKeys(value, ['schema', 'protocol', 'encryption', 'network', 'transactionId', 'vaultId', 'parentTxId',
      'archiveDigest', 'archiveBytes', 'ownerAddress', 'rewardWinston', 'createdAt']);
    const receipt = value as unknown as DirectReceipt;
    requireDirect(receipt.schema === 'sejire/direct-arweave-receipt/v1' && receipt.protocol === 'sejire/v0.3' &&
      receipt.encryption === 'sejire/envelope/v1' && receipt.network === 'arweave.N.1' && ID.test(receipt.transactionId) &&
      VAULT.test(receipt.vaultId) && (receipt.parentTxId === null || ID.test(receipt.parentTxId)) && HASH.test(receipt.archiveDigest) &&
      Number.isSafeInteger(receipt.archiveBytes) && receipt.archiveBytes > 0 && receipt.archiveBytes <= MAX_BACKUP_BYTES &&
      ID.test(receipt.ownerAddress) && winston(receipt.rewardWinston) > 0n && typeof receipt.createdAt === 'string' &&
      Number.isFinite(Date.parse(receipt.createdAt)), 'receipt_invalid');
    return structuredClone(receipt);
  } catch { throw new DirectError('receipt_invalid'); }
}
/** Available as soon as signing is durable. It deliberately does not claim confirmation/delivery. */
export function directReceipt(operation: DirectOperation): DirectReceipt {
  validateOperation(operation);
  requireDirect(operation.signedTx && operation.txId && operation.ownerAddress && operation.quote, 'signature_pending');
  return parseDirectReceipt({ schema: 'sejire/direct-arweave-receipt/v1', protocol: 'sejire/v0.3', encryption: 'sejire/envelope/v1',
    network: 'arweave.N.1', transactionId: operation.txId, vaultId: operation.vaultId, parentTxId: operation.parentTxId,
    archiveDigest: operation.archiveDigest, archiveBytes: operation.archiveBytes, ownerAddress: operation.ownerAddress,
    rewardWinston: operation.quote.rewardWinston, createdAt: new Date(operation.createdAt).toISOString() });
}
export async function retrieveDirectReceipt(value: DirectReceipt, options: DirectOptions = {}) {
  const receipt = parseDirectReceipt(value);
  return scoped(options, async scopedOptions => {
    const result = await fetchArchiveBytes(receipt.transactionId, { bytes: receipt.archiveBytes, sha256: receipt.archiveDigest }, scopedOptions);
    let valid = false;
    for (const node of directNodes(scopedOptions)) {
      active(scopedOptions.signal);
      try {
        const metadata = await nodeRequest(node, `/tx/${receipt.transactionId}`, { signal: scopedOptions.signal,
          maxBytes: 32_768 + Math.ceil(receipt.archiveBytes * 4 / 3) });
        if (metadata.status !== 200) continue;
        await verifyReceiptTransaction(receipt, JSON.parse(metadata.text), result.bytes); valid = true; break;
      } catch { active(scopedOptions.signal); }
    }
    requireDirect(valid, 'receipt_invalid');
    const envelope = parseEnvelope(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(result.bytes)));
    requireDirect(envelope.vault_id === receipt.vaultId, 'archive_integrity_failed');
    return envelope;
  });
}

/** Known-ID recovery does not require a search index, service order, wallet or receipt file. */
export async function retrieveDirectTransaction(transactionId: string, options: DirectOptions = {}) {
  requireDirect(ID.test(transactionId), 'receipt_invalid');
  return scoped(options, async scopedOptions => {
    let last: unknown = new DirectError('archive_unavailable');
    for (const node of directNodes(scopedOptions)) {
      active(scopedOptions.signal);
      try {
        const response = await nodeRequest(node, `/tx/${transactionId}`, { signal: scopedOptions.signal,
          maxBytes: 32_768 + Math.ceil(MAX_BACKUP_BYTES * 4 / 3) });
        requireDirect(response.status === 200, 'archive_unavailable');
        const metadata = JSON.parse(response.text), ar = directCrypto(), tx = ar.transactions.fromRaw(metadata);
        requireDirect(tx.id === transactionId && await ar.transactions.verify(tx), 'receipt_invalid');
        const tags = tx.tags.map(tag => ({ name: tag.get('name', { decode: true, string: true }), value: tag.get('value', { decode: true, string: true }) }));
        const tag = (name: string) => {
          const values = tags.filter(value => value.name === name); requireDirect(values.length <= 1, 'receipt_invalid'); return values[0]?.value;
        };
        const receipt = parseDirectReceipt({ schema: 'sejire/direct-arweave-receipt/v1', protocol: 'sejire/v0.3',
          encryption: 'sejire/envelope/v1', network: 'arweave.N.1', transactionId, vaultId: tag('Vault-Id'),
          parentTxId: tag('Parent-Tx') ?? null, archiveDigest: tag('Archive-SHA256'), archiveBytes: Number(tag('Archive-Bytes')),
          ownerAddress: await ar.wallets.ownerToAddress(tx.owner), rewardWinston: tx.reward, createdAt: new Date().toISOString() });
        const result = await fetchArchiveBytes(transactionId, { bytes: receipt.archiveBytes, sha256: receipt.archiveDigest }, scopedOptions);
        await verifyReceiptTransaction(receipt, metadata, result.bytes);
        const envelope = parseEnvelope(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(result.bytes)));
        requireDirect(envelope.vault_id === receipt.vaultId, 'archive_integrity_failed');
        return { envelope, receipt };
      } catch (error) { last = error; }
    }
    active(scopedOptions.signal); throw last instanceof DirectError ? last : new DirectError('receipt_invalid');
  });
}
