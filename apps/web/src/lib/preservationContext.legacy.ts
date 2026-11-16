import { findPreservationAttempt, subscribePreservationChanges } from './checkout/vaultGuard';
import { listPendingPaidAttempts } from './checkout/paidJournal';
export { getFundedPromo } from './fund/preference';
export { subscribePreservationChanges };
export async function hasPendingPreservation(lookup: { treeId?: string; vaultId?: string }) {
  return Boolean(await findPreservationAttempt(lookup) || (await listPendingPaidAttempts()).length);
}
