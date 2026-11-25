import { completePaidLocally, paidCompletion } from './paidClient';
import { readPaidOperation } from './paidJournal';
import type { PaidCompletion } from './paidTypes';
import { archiveLocalVaultVersion, getLocalVaultVersion } from '../vaultSession/localArchive';
import { canAdvanceVaultHead, getSessionMnemonic, getVaultSession, setVaultSessionChecked } from '../vaultSession/session';
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
  if (canAdvanceVaultHead(current, envelope, parentId, txId)) {
    const phrase = getSessionMnemonic();
    setVaultSessionChecked({ vaultId: envelope.vault_id, headTxId: txId, source: 'publish' },
      phrase && deriveKeysFromMnemonic(phrase).vaultId === envelope.vault_id ? phrase : null);
  }
  if (!isActive()) throw Error('checkout_context_changed');
  await completePaidLocally(checked.operationId);
}
