import type { EnvelopeV1 } from '../crypto/encrypt';
import { parseEnvelope, serializeEnvelope } from '../crypto/envelope';
import { envelopeDigest } from '../solana/policy';
import { rejectedBeforeReservation } from './status';

export type FundAttempt = {
  version: 1;
  orderId: string;
  envelope: EnvelopeV1;
  archiveDigest: string;
  vaultId: string;
  parentTxId: string | null;
  treeId: string | null;
  createdAt: number;
};

const PREFIX = 'sejire.fundAttempt.v1.';
const LEGACY_PREFIX = 'sejire-funded:';
const ENVELOPE_PREFIX = 'sejire.envelope.';
const SESSION_KEY = 'sejire.vaultSession.v1';
const LOCK = 'sejire.fund-attempts.v1';
const MAX_RECORDS = 8;
const MAX_LEGACY_IDS = 128;
const MAX_ARCHIVE_BYTES = 524288;
const ID = /^[a-f0-9]{32}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const TX = /^[A-Za-z0-9_-]{43}$/;
const TREE = /^[A-Za-z0-9_.:-]{1,128}$/;
const FIELDS = ['version', 'orderId', 'envelope', 'archiveDigest', 'vaultId', 'parentTxId', 'treeId', 'createdAt'];

type Lookup = { vaultId?: string | null; treeId?: string | null };
type SaveInput = { orderId: string; envelope: EnvelopeV1; parentTxId?: string | null; treeId?: string | null };
type Stored = { raw: string; attempt: FundAttempt };
type Entry = readonly [string, string];

function storageAction<T>(action: () => T): T {
  try { return action(); } catch { throw Error('storage_unavailable'); }
}

function local(): Storage {
  return storageAction(() => {
    if (!globalThis.localStorage) throw Error();
    return globalThis.localStorage;
  });
}

function session(): Storage {
  return storageAction(() => {
    if (!globalThis.sessionStorage) throw Error();
    return globalThis.sessionStorage;
  });
}

function get(store: Storage, key: string): string | null {
  return storageAction(() => store.getItem(key));
}

/** All journal records are immutable; never evict an unresolved attempt to make room. */
function entries(store: Storage, prefix: string, limit: number, include: (key: string) => boolean = () => true): Entry[] {
  const result: Entry[] = [];
  const count = storageAction(() => store.length);
  const seen = new Set<string>();
  for (let i = 0; i < count; i++) {
    const key = storageAction(() => store.key(i));
    if (key === null || seen.has(key)) throw Error('fund_attempt_in_progress');
    seen.add(key);
    if (!key.startsWith(prefix) || !include(key)) continue;
    const raw = get(store, key);
    if (raw === null) throw Error('fund_attempt_in_progress');
    result.push([key, raw]);
    if (result.length > limit) throw Error('fund_attempt_in_progress');
  }
  if (storageAction(() => store.length) !== count) throw Error('fund_attempt_in_progress');
  return result.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
}

function unchanged(store: Storage, before: Entry[], prefix = PREFIX, limit = MAX_RECORDS, include?: (key: string) => boolean) {
  if (JSON.stringify(entries(store, prefix, limit, include)) !== JSON.stringify(before)) throw Error('fund_attempt_in_progress');
}

function validParent(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && TX.test(value));
}

function validTree(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && TREE.test(value));
}

function archive(envelope: EnvelopeV1): string {
  const raw = serializeEnvelope(envelope);
  if (new TextEncoder().encode(raw).length > MAX_ARCHIVE_BYTES) throw Error('envelope_too_large');
  return raw;
}

async function parseRecord(key: string, raw: string): Promise<FundAttempt> {
  try {
    if (raw.length > MAX_ARCHIVE_BYTES + 2048) throw Error();
    const value = JSON.parse(raw) as FundAttempt;
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        Object.keys(value).length !== FIELDS.length || Object.keys(value).some((field) => !FIELDS.includes(field)) ||
        value.version !== 1 || typeof value.orderId !== 'string' || !ID.test(value.orderId) || key !== PREFIX + value.orderId ||
        typeof value.vaultId !== 'string' || !ID.test(value.vaultId) || value.envelope?.vault_id !== value.vaultId ||
        typeof value.archiveDigest !== 'string' || !DIGEST.test(value.archiveDigest) ||
        !validParent(value.parentTxId) || !validTree(value.treeId) ||
        !Number.isSafeInteger(value.createdAt) || value.createdAt <= 0 ||
        await envelopeDigest(archive(value.envelope)) !== value.archiveDigest) throw Error();
    return value;
  } catch { throw Error('invalid_saved_order'); }
}

async function readRecords(store: Storage): Promise<{ snapshot: Entry[]; records: Stored[] }> {
  const snapshot = entries(store, PREFIX, MAX_RECORDS);
  const records = await Promise.all(snapshot.map(async ([key, raw]) => ({ raw, attempt: await parseRecord(key, raw) })));
  unchanged(store, snapshot);
  return { snapshot, records };
}

async function withLock<T>(action: (locked: boolean) => Promise<T>): Promise<T> {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  if (!locks) return action(false);
  let entered = false;
  try {
    return await locks.request(LOCK, { mode: 'exclusive' }, () => { entered = true; return action(true); });
  } catch (error) {
    if (!entered) throw Error('storage_unavailable');
    throw error;
  }
}

function select(records: Stored[], { vaultId, treeId }: Lookup): FundAttempt | null {
  const matches = records.filter(({ attempt }) => (vaultId && attempt.vaultId === vaultId) || (treeId && attempt.treeId === treeId));
  if (matches.length > 1 || (vaultId && matches.some(({ attempt }) => attempt.vaultId !== vaultId))) throw Error('fund_attempt_in_progress');
  if (!vaultId && !treeId && records.length) throw Error('fund_attempt_in_progress');
  if (!vaultId && !matches.length && records.some(({ attempt }) => attempt.treeId === null)) throw Error('fund_attempt_in_progress');
  return matches[0]?.attempt ?? null;
}

function sameAttempt(existing: FundAttempt, input: SaveInput, digest: string, raw: string): boolean {
  return existing.orderId === input.orderId && existing.vaultId === input.envelope.vault_id &&
    existing.archiveDigest === digest && archive(existing.envelope) === raw &&
    (input.parentTxId === undefined || existing.parentTxId === input.parentTxId) &&
    (input.treeId === undefined || existing.treeId === null || existing.treeId === input.treeId);
}

function writeRecord(store: Storage, before: Entry[], attempt: FundAttempt, locked: boolean): FundAttempt {
  // localStorage has no atomic insert-if-absent across tabs. Read-only recovery still works without Web Locks.
  if (!locked) throw Error('storage_unavailable');
  if (before.length >= MAX_RECORDS) throw Error('fund_attempt_in_progress');
  unchanged(store, before);
  const key = PREFIX + attempt.orderId;
  if (get(store, key) !== null) throw Error('fund_attempt_in_progress');
  const raw = JSON.stringify(attempt);
  storageAction(() => store.setItem(key, raw));
  if (get(store, key) !== raw) throw Error('storage_unavailable');
  const expected = [...before, [key, raw] as Entry].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  unchanged(store, expected);
  return attempt;
}

/** Legacy IDs are useful only with the exact ciphertext they originally identified. */
async function legacyRecords(store: Storage, records: Stored[], supplied?: FundAttempt): Promise<{ matches: FundAttempt[]; unresolved: boolean }> {
  const ss = session();
  const isOrderKey = (key: string) => !key.endsWith(':rejected');
  const snapshot = entries(ss, LEGACY_PREFIX, MAX_LEGACY_IDS, isOrderKey);
  const pending: { orderId: string; digest: string }[] = [];
  for (const [key, id] of snapshot) {
    const digest = key.slice(LEGACY_PREFIX.length);
    if (!DIGEST.test(digest) || !ID.test(id)) throw Error('invalid_saved_order');
    const existing = records.find(({ attempt }) => attempt.orderId === id)?.attempt;
    if (existing) {
      if (existing.archiveDigest !== digest) throw Error('invalid_saved_order');
      continue;
    }
    // A recorded pre-reservation refusal allows an explicit retry of the same ID; it is not an unresolved order.
    const hintRaw = get(ss, key + ':rejected');
    if (hintRaw && hintRaw.length <= 2048) {
      try {
        const hint = JSON.parse(hintRaw) as { version?: unknown; orderId?: unknown; code?: unknown };
        if (hint?.version === 1 && hint.orderId === id && typeof hint.code === 'string' && rejectedBeforeReservation.has(hint.code)) continue;
      } catch { /* unverified hints cannot release a pending attempt */ }
    }
    pending.push({ orderId: id, digest });
  }
  if (!pending.length) return { matches: [], unresolved: false };
  if (pending.length > MAX_RECORDS || new Set(pending.map(({ orderId }) => orderId)).size !== pending.length) throw Error('fund_attempt_in_progress');

  let meta: { vaultId?: unknown; headTxId?: unknown } | null = null;
  const metaRaw = get(ss, SESSION_KEY);
  if (metaRaw) {
    try { if (metaRaw.length <= 2048) meta = JSON.parse(metaRaw); } catch { /* no verified parent metadata */ }
  }
  const matches: FundAttempt[] = [];
  const parentFor = (vaultId: string): string | null => {
    const parent = meta?.vaultId === vaultId ? meta.headTxId ?? null : null;
    if (!validParent(parent)) throw Error('invalid_saved_order');
    return parent;
  };
  // An imported exact file can recover a legacy ID even when the last-envelope cache is absent.
  if (supplied && pending.some((item) => item.orderId === supplied.orderId && item.digest === supplied.archiveDigest)) {
    matches.push({ ...supplied, parentTxId: parentFor(supplied.vaultId), treeId: null });
  }
  // Caches are ciphertext-only. A bounded scan can identify another vault without assigning it to the current tree.
  for (const [key, raw] of entries(store, ENVELOPE_PREFIX, 64)) {
    let envelope: EnvelopeV1;
    let serialized: string;
    try {
      if (raw.length > MAX_ARCHIVE_BYTES + 2048) continue;
      envelope = parseEnvelope(JSON.parse(raw));
      if (key !== ENVELOPE_PREFIX + envelope.vault_id) continue;
      serialized = archive(envelope);
    } catch { continue; }
    const digest = await envelopeDigest(serialized);
    const previous = pending.find((item) => item.digest === digest);
    if (!previous || matches.some((item) => item.orderId === previous.orderId)) continue;
    const parentTxId = parentFor(envelope.vault_id);
    matches.push({ version: 1, orderId: previous.orderId, envelope, archiveDigest: digest,
      vaultId: envelope.vault_id, parentTxId, treeId: null, createdAt: Date.now() });
  }
  unchanged(ss, snapshot, LEGACY_PREFIX, MAX_LEGACY_IDS, isOrderKey);
  return { matches, unresolved: pending.some(({ orderId }) => !matches.some((item) => item.orderId === orderId)) };
}

/** Look up the original ciphertext before resealing an editor snapshot. Never guesses a legacy tree association. */
export async function findFundAttempt(lookup: Lookup): Promise<FundAttempt | null> {
  if ((lookup.vaultId != null && !ID.test(lookup.vaultId)) || !validTree(lookup.treeId ?? null)) throw Error('invalid_saved_order');
  return withLock(async (locked) => {
    const store = local();
    const { snapshot, records } = await readRecords(store);
    const existing = select(records, lookup);
    if (existing) return existing;
    const legacy = await legacyRecords(store, records);
    const candidates = lookup.vaultId ? legacy.matches.filter((item) => item.vaultId === lookup.vaultId) : [];
    if (candidates.length > 1) throw Error('fund_attempt_in_progress');
    if (candidates[0]) {
      if (records.some(({ attempt }) => attempt.orderId === candidates[0].orderId)) throw Error('fund_attempt_in_progress');
      return writeRecord(store, snapshot, candidates[0], locked);
    }
    if (legacy.unresolved || (!lookup.vaultId && legacy.matches.length)) throw Error('fund_attempt_in_progress');
    return null;
  });
}

/** Await this before the first POST. Success means the exact envelope and order ID survived storage readback. */
export async function saveFundAttempt(input: SaveInput): Promise<FundAttempt> {
  if (!ID.test(input.orderId) || !validParent(input.parentTxId ?? null) || !validTree(input.treeId ?? null)) throw Error('invalid_saved_order');
  const serialized = archive(input.envelope);
  const request: SaveInput = { orderId: input.orderId, envelope: JSON.parse(serialized) as EnvelopeV1,
    parentTxId: input.parentTxId, treeId: input.treeId };
  const candidate: FundAttempt = { version: 1, orderId: request.orderId,
    envelope: request.envelope, archiveDigest: await envelopeDigest(serialized),
    vaultId: request.envelope.vault_id, parentTxId: request.parentTxId ?? null, treeId: request.treeId ?? null, createdAt: Date.now() };
  return withLock(async (locked) => {
    const store = local();
    const { snapshot, records } = await readRecords(store);
    const selected = select(records, candidate);
    const sameId = records.find(({ attempt }) => attempt.orderId === candidate.orderId)?.attempt;
    if (sameId && selected && sameId.orderId !== selected.orderId) throw Error('fund_attempt_in_progress');
    const existing = sameId ?? selected;
    if (existing) {
      if (!sameAttempt(existing, request, candidate.archiveDigest, serialized)) throw Error('fund_attempt_in_progress');
      return existing;
    }
    const legacy = await legacyRecords(store, records, candidate);
    if (legacy.unresolved) throw Error('fund_attempt_in_progress');
    const previous = legacy.matches.find((item) => item.orderId === candidate.orderId || item.vaultId === candidate.vaultId);
    if (previous) {
      if (!sameAttempt(previous, request, candidate.archiveDigest, serialized)) throw Error('fund_attempt_in_progress');
      return writeRecord(store, snapshot, previous, locked);
    }
    return writeRecord(store, snapshot, candidate, locked);
  });
}

/** Call only after confirmed completion, or an explicit terminal refusal with no transaction. */
export async function clearFundAttempt(orderId: string, vaultId: string): Promise<void> {
  if (!ID.test(orderId) || !ID.test(vaultId)) throw Error('invalid_saved_order');
  return withLock(async () => {
    const store = local(), key = PREFIX + orderId;
    const raw = get(store, key);
    if (raw === null) return;
    const attempt = await parseRecord(key, raw);
    if (attempt.vaultId !== vaultId) return;
    const ss = session(), legacyKey = LEGACY_PREFIX + attempt.archiveDigest;
    if (get(ss, legacyKey) === orderId) {
      storageAction(() => ss.removeItem(legacyKey));
      if (get(ss, legacyKey) === orderId) throw Error('storage_unavailable');
    }
    const hintKey = legacyKey + ':rejected', hintRaw = get(ss, hintKey);
    if (hintRaw) {
      let hint: { orderId?: unknown } | null = null;
      try { hint = JSON.parse(hintRaw); } catch { /* an unrelated hint is never removed */ }
      if (hint?.orderId === orderId) {
        storageAction(() => ss.removeItem(hintKey));
        if (get(ss, hintKey) === hintRaw) throw Error('storage_unavailable');
      }
    }
    // Keep durable recovery until legacy cleanup succeeded, so a partial failure cannot allow a fresh attempt.
    if (get(store, key) !== raw) throw Error('fund_attempt_in_progress');
    storageAction(() => store.removeItem(key));
    if (get(store, key) !== null) throw Error('storage_unavailable');
  });
}
