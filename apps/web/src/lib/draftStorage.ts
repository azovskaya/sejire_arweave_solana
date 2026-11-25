import type { TreeStore } from "./types";
import { coerceTreeStore } from "./treeJson";
import type { GuideState } from './guide';
import { DRAFT_KEY, GUIDE_KEY, captureDraftWriteToken, rollbackDraftValue, writeDraftValue } from './draftOwnership';

export { DRAFT_KEY } from './draftOwnership';

/** Persist the editor draft. Returns false when the browser is out of space. */
export function saveDraftTree(store: TreeStore): boolean {
  return writeDraftValue(DRAFT_KEY, JSON.stringify(store));
}

/** New/imported trees replace draft and guide together, without clearing the
 * previous tree first. A failed write retains the previous recoverable bytes. */
export function replaceDraftTree(store: TreeStore, guide: GuideState): boolean {
  const token = captureDraftWriteToken();
  const previousDraft = localStorage.getItem(DRAFT_KEY), previousGuide = localStorage.getItem(GUIDE_KEY);
  const draft = JSON.stringify(store), nextGuide = JSON.stringify(guide);
  try {
    if (!writeDraftValue(DRAFT_KEY, draft) || !writeDraftValue(GUIDE_KEY, nextGuide)) throw Error('storage_unavailable');
    return true;
  } catch (error) {
    for (const restore of [
      () => rollbackDraftValue(GUIDE_KEY, previousGuide, nextGuide, token),
      () => rollbackDraftValue(DRAFT_KEY, previousDraft, draft, token),
    ]) { try { restore(); } catch { /* report failure without claiming a successful replacement */ } }
    if (error instanceof Error && /^draft_/.test(error.message)) throw error;
    return false;
  }
}

export function loadDraftTree(): TreeStore | null {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (!raw) return null;
    return coerceTreeStore(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function clearDraftTree() {
  return writeDraftValue(DRAFT_KEY, null);
}
