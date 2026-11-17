import { deriveKeysFromMnemonic, type SejireKeys } from '../crypto/keys';
import { MAX_BACKUP_BYTES } from '../crypto/envelope';
import { DirectError, requireDirect } from '../directArweave/errors';
import { active, directNodes, nodeRequest, scoped } from '../directArweave/network';
import { directCrypto } from '../directArweave/transaction';
import type { DirectOptions, DirectRawTransaction } from '../directArweave/types';
import { sha256 } from '../directArweave/format';
import manifest from './legacy-locators.v1.json';
import { tagValue, validateMetadata, type TxMetadata } from './retrieve';
import { verifyCandidate } from './verify';
import type { HeadCandidate } from './types';

const ID = /^[A-Za-z0-9_-]{43}$/;
const HEADER_FIELDS = ['format', 'id', 'last_tx', 'owner', 'tags', 'target', 'quantity', 'data_size', 'data_root', 'reward', 'signature'] as const;

/** Missing Vault-Id is allowed only for an exact public, pinned historical locator. */
export function historicalNativeCandidate(txId: string, vaultId: string): HeadCandidate {
  const legacy = manifest.entries.find(entry => entry.vaultId === vaultId && entry.txIds.includes(txId));
  return { txId, source: 'native-known-id', ...(legacy ? { legacy: true,
    archiveBytes: legacy.archiveBytes, archiveSha256: legacy.archiveSha256 } : {}) };
}

/**
 * Recover old native Sejire transactions without assigning the new Save-Id receipt
 * contract to them. RSA/ID and data_root authenticate the exact retrieved bytes;
 * existing metadata, pinned legacy exceptions and AES/vault validation still apply.
 * This performs only bounded public GETs. It makes no confirmation, payment or
 * latest-version claim, and cannot validate an ANS-104 item as a native transaction.
 */
export async function retrieveHistoricalNative(transactionId: string, words: string, options: DirectOptions = {}) {
  requireDirect(ID.test(transactionId), 'receipt_invalid');
  const keys = deriveKeysFromMnemonic(words);
  try {
    return await retrieveNativeVault(transactionId, keys, options);
  } finally {
    keys.seed.fill(0); keys.master.fill(0); keys.encKey.fill(0);
  }
}

/** Shared native reader for restore, version selection and save preparation.
 * The caller owns the supplied keys; this function never changes or stores them.
 * Discovery metadata is only a locator. Native signature, transaction ID and
 * Merkle binding must pass before any returned vault is associated with that ID. */
export async function retrieveNativeVault(transactionId: string, keys: SejireKeys, options: DirectOptions = {}) {
  requireDirect(ID.test(transactionId), 'receipt_invalid');
  return scoped(options, async readOptions => {
      const nodes = directNodes(readOptions), ar = directCrypto();
      const candidate = historicalNativeCandidate(transactionId, keys.vaultId);
      let last = new DirectError('archive_unavailable');
      for (const node of nodes) {
        active(readOptions.signal);
        try {
          const response = await nodeRequest(node, `/tx/${transactionId}`, { signal: readOptions.signal,
            maxBytes: 32_768 + Math.ceil(MAX_BACKUP_BYTES * 4 / 3) });
          requireDirect(response.status === 200, 'archive_unavailable');
          const source: unknown = JSON.parse(response.text);
          requireDirect(source && typeof source === 'object' && !Array.isArray(source), 'receipt_invalid');
          const header = source as Record<string, unknown>;
          // Historical seed-derived wallets used RSA-2048. Do not silently impose
          // the new uploader's RSA-4096-only signing policy on read-only recovery.
          requireDirect(header.format === 2 && header.id === transactionId &&
            typeof header.last_tx === 'string' && /^[A-Za-z0-9_-]{43,64}$/.test(header.last_tx) &&
            typeof header.owner === 'string' && /^[A-Za-z0-9_-]+$/.test(header.owner) &&
            header.owner.length >= 342 && header.owner.length <= 1366 &&
            typeof header.signature === 'string' && /^[A-Za-z0-9_-]+$/.test(header.signature) &&
            header.signature.length === header.owner.length &&
            typeof header.target === 'string' && (header.target === '' || ID.test(header.target)) &&
            typeof header.quantity === 'string' && /^(0|[1-9][0-9]*)$/.test(header.quantity) &&
            typeof header.reward === 'string' && /^(0|[1-9][0-9]*)$/.test(header.reward) &&
            typeof header.data_size === 'string' && /^[1-9][0-9]*$/.test(header.data_size) &&
            Number.isSafeInteger(Number(header.data_size)) && Number(header.data_size) <= MAX_BACKUP_BYTES &&
            typeof header.data_root === 'string' && ID.test(header.data_root) &&
            Array.isArray(header.tags) && header.tags.length <= 40 && header.tags.every(tag =>
              tag && typeof tag === 'object' && typeof tag.name === 'string' && typeof tag.value === 'string'), 'receipt_invalid');
          const raw = { ...Object.fromEntries(HEADER_FIELDS.map(key => [key, header[key]])), data: '' } as DirectRawTransaction;
          const tx = ar.transactions.fromRaw(raw);
          requireDirect(await ar.transactions.verify(tx), 'receipt_invalid');
          const meta: TxMetadata = { id: transactionId, blockHeight: null, blockTimestamp: null,
            tags: tx.tags.map(tag => ({ name: tag.get('name', { decode: true, string: true }),
              value: tag.get('value', { decode: true, string: true }) })) };
          validateMetadata(meta, candidate, keys.vaultId);
          const expectedBytes = Number(tx.data_size);
          const taggedBytes = tagValue(meta, 'Archive-Bytes');
          requireDirect((taggedBytes === null || Number(taggedBytes) === expectedBytes) &&
            (candidate.archiveBytes === undefined || candidate.archiveBytes === expectedBytes), 'receipt_invalid');
          const expectedHash = tagValue(meta, 'Archive-SHA256') ?? candidate.archiveSha256;
          const orderedNodes = [node, ...nodes.filter(other => other !== node)];
          for (const dataNode of orderedNodes) {
            const routes: [string, boolean][] = [[`/raw/${transactionId}`, false], [`/${transactionId}`, false], [`/tx/${transactionId}/data`, true]];
            for (const [path, encoded] of routes) {
              active(readOptions.signal);
              try {
                const data = await nodeRequest(dataNode, path, { signal: readOptions.signal,
                  maxBytes: encoded ? Math.ceil(expectedBytes * 4 / 3) + 4 : expectedBytes });
                requireDirect(data.status === 200 && data.bytes.length > 0, 'archive_unavailable');
                let bytes: Uint8Array = data.bytes;
                if (encoded) {
                  const value = data.text.trim();
                  requireDirect(/^[A-Za-z0-9_-]+$/.test(value), 'archive_integrity_failed');
                  bytes = ar.utils.b64UrlToBuffer(value);
                  requireDirect(ar.utils.bufferTob64Url(bytes) === value, 'archive_integrity_failed');
                }
                requireDirect(bytes.length === expectedBytes && (!expectedHash || await sha256(bytes) === expectedHash), 'archive_integrity_failed');
                const fresh = ar.transactions.fromRaw({ ...raw, data: ar.utils.bufferTob64Url(bytes), data_root: '' });
                await fresh.prepareChunks(bytes);
                requireDirect(fresh.data_root === tx.data_root, 'archive_integrity_failed');
                const verified = await verifyCandidate(bytes, meta, candidate, keys);
                active(readOptions.signal);
                return { envelope: verified.envelope, vault: verified.vault, parentTxId: verified.parentTxId };
              } catch (error) {
                active(readOptions.signal);
                last = error instanceof DirectError ? error : new DirectError('archive_integrity_failed');
              }
            }
          }
        } catch (error) {
          active(readOptions.signal);
          last = error instanceof DirectError ? error : new DirectError('receipt_invalid');
        }
      }
      active(readOptions.signal); throw last;
  });
}
