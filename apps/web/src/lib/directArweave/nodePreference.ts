import { DirectError, requireDirect } from './errors';

export const DIRECT_NODE_PREFERENCE_KEY = 'sejire.directArweave.node.v1';
let preferenceWriteUncertain = false;

/** Credential-free origin only; used by both transport and the optional setting. */
export function directNode(value: string): string {
  requireDirect(typeof value === 'string' && value.length > 0 && value.length <= 2048, 'invalid_node');
  let url: URL;
  try { url = new URL(value); } catch { throw new DirectError('invalid_node'); }
  requireDirect(url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash &&
    url.pathname === '/' && Boolean(url.hostname), 'invalid_node');
  return url.origin;
}

function preferenceStorage(): Storage | null {
  try {
    if (typeof sessionStorage === 'undefined') {
      // CLI verification has no browser session or preference. A browser with
      // unavailable session storage must instead fail visibly.
      if (typeof window === 'undefined') return null;
      throw new DirectError('storage_unavailable');
    }
    return sessionStorage;
  } catch { throw new DirectError('storage_unavailable'); }
}

/** Invalid/unreadable saved settings never silently select the public defaults. */
export function readDirectNodePreference(): string | null {
  requireDirect(!preferenceWriteUncertain, 'storage_unavailable');
  let value: string | null;
  try { value = preferenceStorage()?.getItem(DIRECT_NODE_PREFERENCE_KEY) ?? null; }
  catch { throw new DirectError('storage_unavailable'); }
  return value === null ? null : directNode(value);
}

/** Called only by an explicit network action. Empty input selects defaults.
 * It never edits a vault, journal, wallet, or other browser setting. */
export function saveDirectNodePreference(input: string): string | null {
  requireDirect(typeof input === 'string', 'invalid_node');
  const value = input.trim() ? directNode(input.trim()) : null;
  const storage = preferenceStorage();
  requireDirect(storage, 'storage_unavailable');
  let previous: string | null;
  try { previous = storage.getItem(DIRECT_NODE_PREFERENCE_KEY); }
  catch { throw new DirectError('storage_unavailable'); }
  try {
    if (value === null) storage.removeItem(DIRECT_NODE_PREFERENCE_KEY);
    else storage.setItem(DIRECT_NODE_PREFERENCE_KEY, value);
    requireDirect(storage.getItem(DIRECT_NODE_PREFERENCE_KEY) === value, 'storage_unavailable');
    preferenceWriteUncertain = false;
    return value;
  } catch {
    try {
      if (previous === null) storage.removeItem(DIRECT_NODE_PREFERENCE_KEY);
      else storage.setItem(DIRECT_NODE_PREFERENCE_KEY, previous);
      preferenceWriteUncertain = storage.getItem(DIRECT_NODE_PREFERENCE_KEY) !== previous;
    } catch { preferenceWriteUncertain = true; }
    throw new DirectError('storage_unavailable');
  }
}
