import { completePaidLocally, paidCompletion } from './paidClient';
import { readPaidOperation } from './paidJournal';
import type { PaidCompletion } from './paidTypes';
import { archiveLocalVaultVersion, getLocalVaultVersion } from '../vaultSession/localArchive';
import { getSessionMnemonic, getVaultSession, setVaultSession } from '../vaultSession/session';
import { deriveKeysFromMnemonic } from '../crypto/keys';
import { serializeEnvelope } from '../crypto/envelope';

/** A standalone file save has no editor callback, but still needs verified local
 * history before its active guard can be released. A newer/unrelated HEAD wins. */
export async function finalizeStandalonePaid(result: PaidCompletion, isActive: () => boolean): Promise<void> {
  const op = await readPaidOperation(result.operationId), checked = op && await paidCompletion(op);
  if (!checked || checked.order.id !== result.order.id || checked.serialized !== result.serialized || checked.txId !== result.txId) throw Error('paid_completion_mismatch');
  if (!isActive()) throw Error('checkout_context_changed');
  const { envelope, txId } = checked, parentId = checked.order.archive.parentTxId;
  archiveLocalVaultVersion({ id: txId, vaultId: envelope.vault_id, parentId, source: 'network', envelope });
  const saved = getLocalVaultVersion(envelope.vault_id, txId);
  if (!saved || saved.source !== 'network' || saved.parentId !== parentId || serializeEnvelope(saved.envelope) !== checked.serialized) throw Error('paid_history_unavailable');
  const current = getVaultSession();
  const advance = !current || current.vaultId === envelope.vault_id && (!current.headTxId || current.headTxId === parentId || current.headTxId === txId);
  const expected = advance ? { vaultId: envelope.vault_id, headTxId: txId, source: 'publish' as const } : current;
  const phrase = getSessionMnemonic();
  setVaultSession(expected, phrase && deriveKeysFromMnemonic(phrase).vaultId === expected.vaultId ? phrase : null);
  const session = getVaultSession();
  if (!session || session.vaultId !== expected.vaultId || session.headTxId !== expected.headTxId || session.source !== expected.source) throw Error('paid_history_unavailable');
  if (!isActive()) throw Error('checkout_context_changed');
  await completePaidLocally(checked.operationId);
}
