import { clearFundAttempt, findFundAttempt, saveFundAttempt, type FundAttempt } from '../fund/journal';
import { findPaidAttempt, findContributionAttempt, writePaidOperation, type AttemptLookup } from './paidJournal';
import type { PaidOperation } from './paidTypes';

export type PreservationAttempt = { method: 'promo'; attempt: FundAttempt } | { method: 'paid'; attempt: PaidOperation };
const LOCK = 'sejire.preservation-attempts.v1';
const EVENT = 'sejire-preservation-change';

async function lock<T>(name: string, required: boolean, action: () => Promise<T>): Promise<T> {
  const locks = typeof navigator === 'undefined' ? undefined : navigator.locks;
  if (!locks) {
    if (required) throw Error('storage_unavailable');
    return action();
  }
  return locks.request(name, { mode: 'exclusive' }, action);
}

async function find(lookup: AttemptLookup): Promise<PreservationAttempt | null> {
  const [fund, paid] = await Promise.all([findFundAttempt(lookup), findPaidAttempt(lookup)]);
  if (fund && paid) throw Error('preservation_attempt_in_progress');
  return fund ? { method: 'promo', attempt: fund } : paid ? { method: 'paid', attempt: paid } : null;
}

export const findPreservationAttempt = (lookup: AttemptLookup) => lock(LOCK, false, () => find(lookup));

export async function findGuardedFundAttempt(lookup: AttemptLookup): Promise<FundAttempt | null> {
  const found = await findPreservationAttempt(lookup);
  if (found?.method === 'paid') throw Error('preservation_attempt_in_progress');
  return found?.attempt ?? null;
}

export function announcePreservationChange() {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new Event(EVENT));
  if (typeof BroadcastChannel !== 'undefined') {
    const channel = new BroadcastChannel(EVENT); channel.postMessage('changed'); channel.close();
  }
}

export function subscribePreservationChanges(listener: () => void): () => void {
  window.addEventListener(EVENT, listener); window.addEventListener('storage', listener);
  const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(EVENT);
  if (channel) channel.onmessage = listener;
  return () => { window.removeEventListener(EVENT, listener); window.removeEventListener('storage', listener); channel?.close(); };
}

export async function saveGuardedFundAttempt(input: Parameters<typeof saveFundAttempt>[0]): Promise<FundAttempt> {
  return lock(LOCK, true, async () => {
    // saveFundAttempt validates fund conflicts itself, including migration from
    // a digest-only legacy marker using the exact newly imported ciphertext.
    if (await findPaidAttempt({ vaultId: input.envelope.vault_id, treeId: input.treeId })) throw Error('preservation_attempt_in_progress');
    const saved = await saveFundAttempt(input);
    announcePreservationChange();
    return saved;
  });
}

export async function clearGuardedFundAttempt(orderId: string, vaultId: string): Promise<void> {
  await clearFundAttempt(orderId, vaultId);
  announcePreservationChange();
}

/** Only the local reservation is locked; no HTTP request or wallet UI runs here. */
export async function reservePaidAttempt(candidate: PaidOperation): Promise<PaidOperation> {
  return lock(LOCK, true, async () => {
    if(candidate.intent.kind==='contribution'){
      const previous=await findContributionAttempt();if(previous)return previous;
      const saved=await writePaidOperation(candidate);announcePreservationChange();return saved;
    }
    const pending = await find({ vaultId: candidate.archive!.vaultId, treeId: candidate.treeId });
    if (pending?.method === 'promo') throw Error('preservation_attempt_in_progress');
    if (pending?.method === 'paid') return pending.attempt;
    const saved = await writePaidOperation(candidate);
    announcePreservationChange();
    return saved;
  });
}

/** Wallet signing is single-flight across tabs, including after async hydration. */
export const withPaidOperationLock = <T>(id: string, action: () => Promise<T>) =>
  lock('sejire.paid-operation.' + id, true, action);

/** A legacy checkout may continue, but must not replace a modern/promo attempt. */
export const reserveLegacyPreservation = <T>(vaultId: string, write: () => Promise<T>) =>
  lock(LOCK, true, async () => {
    if (await find({ vaultId })) throw Error('preservation_attempt_in_progress');
    return write();
  });
