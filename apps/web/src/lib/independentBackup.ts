import { MAX_BACKUP_BYTES, parseEnvelope } from './crypto/envelope';
import type { EnvelopeV1 } from './crypto/encrypt';
import { parseSeedBackup } from './crypto/seedBackup';
import { parseDirectReceipt } from './directArweave';
import type { DirectReceipt } from './directArweave/types';

export type RecoveryKit = {
  schema: 'sejire/recovery-kit/v1';
  format: 'sejire/envelope/v1';
  archiveText: string;
  archiveDigest: string;
  archiveBytes: number;
  receipt: DirectReceipt | null;
};
export type IndependentBackup =
  | { kind: 'words'; mnemonic: string }
  | { kind: 'vault'; envelope: EnvelopeV1; archiveText: string; receipt: DirectReceipt | null }
  | { kind: 'receipt'; receipt: DirectReceipt }
  | { kind: 'legacyLocator'; txId: string };

export async function archiveHash(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2, '0')).join('');
}

export async function buildRecoveryKit(archiveText: string, receipt: DirectReceipt | null = null): Promise<RecoveryKit> {
  const archiveBytes = new TextEncoder().encode(archiveText).length;
  if (!archiveBytes || archiveBytes > MAX_BACKUP_BYTES) throw Error('invalid_backup');
  const envelope = parseEnvelope(JSON.parse(archiveText));
  const archiveDigest = await archiveHash(archiveText);
  if (receipt) {
    parseDirectReceipt(receipt);
    if (receipt.archiveDigest !== archiveDigest || receipt.archiveBytes !== archiveBytes || receipt.vaultId !== envelope.vault_id) throw Error('invalid_backup');
  }
  return { schema: 'sejire/recovery-kit/v1', format: 'sejire/envelope/v1', archiveText, archiveDigest, archiveBytes, receipt };
}

export async function parseIndependentBackup(text: string): Promise<IndependentBackup> {
  // Escaped JSON strings add bounded overhead to a portable kit.
  if (new TextEncoder().encode(text).length > MAX_BACKUP_BYTES * 2 + 16_384) throw Error('invalid_backup');
  const raw = JSON.parse(text) as Record<string, unknown>;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw Error('invalid_backup');
  const mnemonic = parseSeedBackup(raw);
  if (mnemonic) return { kind: 'words', mnemonic };
  if (raw.schema === 'sejire/recovery-kit/v1') {
    const allowed = ['schema', 'format', 'archiveText', 'archiveDigest', 'archiveBytes', 'receipt'];
    if (Object.keys(raw).length !== allowed.length || Object.keys(raw).some(k => !allowed.includes(k)) ||
      raw.format !== 'sejire/envelope/v1' || typeof raw.archiveText !== 'string' ||
      (raw.receipt !== null && (!raw.receipt || typeof raw.receipt !== 'object'))) throw Error('invalid_backup');
    const receipt = raw.receipt === null ? null : parseDirectReceipt(raw.receipt);
    const checked = await buildRecoveryKit(raw.archiveText, receipt);
    if (checked.archiveBytes !== raw.archiveBytes || checked.archiveDigest !== raw.archiveDigest) throw Error('archive_integrity_failed');
    return { kind: 'vault', envelope: parseEnvelope(JSON.parse(checked.archiveText)), archiveText: checked.archiveText, receipt };
  }
  if (raw.schema === 'sejire/direct-arweave-receipt/v1') return { kind: 'receipt', receipt: parseDirectReceipt(raw) };
  // Legacy receipts are only discovery hints. Their claims of payment or
  // completion are never imported into the new journal or trusted as proof.
  const legacyId = raw.schema === 'sejire/preservation-receipt/v2' ? raw.txId :
    raw.schema === 'sejire/native-receipt/v1' ? raw.transactionId :
    raw.schema === 'sejire/preservation-receipt/v1' && raw.network === 'mainnet-beta' && raw.receipt && typeof raw.receipt === 'object'
      ? (raw.receipt as Record<string, unknown>).id : null;
  if (typeof legacyId === 'string' && /^[A-Za-z0-9_-]{43}$/.test(legacyId)) return { kind: 'legacyLocator', txId: legacyId };
  return { kind: 'vault', envelope: parseEnvelope(raw), archiveText: text, receipt: null };
}
