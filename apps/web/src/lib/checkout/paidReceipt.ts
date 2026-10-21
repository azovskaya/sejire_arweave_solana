import { validatePaidReceipt, type PaidReceipt } from '../../../../../packages/checkout/paid';
import { parseEnvelope } from '../crypto/envelope';
import type { EnvelopeV1 } from '../crypto/encrypt';
import { newDiagnostics } from '../recovery/diagnostics';
import { WayfinderGatewayPool } from '../recovery/gateways';
import { fetchMetadata, fetchRaw, tagValue } from '../recovery/retrieve';
import type { GatewayPool, RecoveryContext } from '../recovery/types';

/** Payment network never selects storage gateways: every v2 receipt binds Arweave Mainnet. */
export async function retrievePaidReceipt(receipt: PaidReceipt, options: {
  vaultId: string; signal?: AbortSignal; fetcher?: typeof fetch; pool?: GatewayPool;
}): Promise<EnvelopeV1> {
  const checked = validatePaidReceipt(receipt);
  if (checked.archive.vaultId !== options.vaultId) throw Error('Vault-Id mismatch');
  const controller = new AbortController(), abort = () => controller.abort();
  if (options.signal?.aborted) abort(); else options.signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, 45000);
  try {
    const ctx: RecoveryContext = { vaultId: options.vaultId, signal: controller.signal, fetcher: options.fetcher ?? fetch };
    const pool = options.pool ?? new WayfinderGatewayPool(), diagnostics = newDiagnostics();
    const candidate = { txId: checked.txId, source: 'paid-receipt', parentTxId: checked.archive.parentTxId,
      archiveSha256: checked.archive.digest, archiveBytes: checked.archive.bytes };
    const metadata = await fetchMetadata(ctx, pool, candidate, diagnostics);
    // A receipt is portable data, not authority to relax the signed metadata.
    if (tagValue(metadata, 'Archive-SHA256') !== checked.archive.digest ||
        tagValue(metadata, 'Archive-Bytes') !== String(checked.archive.bytes) ||
        tagValue(metadata, 'Protocol-Version') !== 'sejire/v0.3' ||
        tagValue(metadata, 'Parent-Tx') !== checked.archive.parentTxId ||
        tagValue(metadata, 'Preservation-Id') !== checked.orderId) throw Error('paid_receipt_metadata_mismatch');
    if (!metadata.owner || metadata.owner.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(metadata.owner) ||
        metadata.rewardWinston !== checked.rewardWinston) throw Error('paid_receipt_metadata_mismatch');
    const encoded = metadata.owner.replace(/-/g, '+').replace(/_/g, '/');
    const owner = atob(encoded.padEnd(Math.ceil(encoded.length / 4) * 4, '='));
    if (btoa(owner).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') !== metadata.owner) throw Error('paid_receipt_metadata_mismatch');
    const ownerHash = new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(owner, byte => byte.charCodeAt(0))));
    const address = btoa(String.fromCharCode(...ownerHash)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    if (address !== checked.treasuryAddress) throw Error('paid_receipt_metadata_mismatch');
    const bytes = await fetchRaw(ctx, pool, candidate, metadata, diagnostics);
    const envelope = parseEnvelope(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
    if (envelope.vault_id !== options.vaultId) throw Error('Vault-Id mismatch');
    return envelope;
  } finally { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); }
}
