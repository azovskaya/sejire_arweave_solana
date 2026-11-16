import { listDirectOperations } from './directArweave';
import { hasLegacyPreservation } from './legacyPreservationGuard';

export async function hasPendingPreservation(_lookup: { treeId?: string; vaultId?: string }) {
  return await hasLegacyPreservation() || (await listDirectOperations()).some(operation => operation.state !== 'complete' && operation.state !== 'cancelled');
}

/** This release has no sponsored checkout or promo preference. */
export function getFundedPromo(_vaultId?: string | null): null { return null; }

export function subscribePreservationChanges(listener: () => void): () => void {
  window.addEventListener('storage', listener);
  window.addEventListener('sejire-direct-change', listener);
  return () => {
    window.removeEventListener('storage', listener);
    window.removeEventListener('sejire-direct-change', listener);
  };
}
