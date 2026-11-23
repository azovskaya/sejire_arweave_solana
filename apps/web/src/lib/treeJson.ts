import type { GuideState } from "./guide";
import { defaultGuide } from "./guide";
import type { Person, Snapshot, TreeMeta, TreeStore } from "./types";
import { safeFilename } from "./pdf/filename";
import { isZhuzId } from "./zhuzRu";

export const TREE_JSON_SCHEMA = "sejire/tree-export/v1" as const;

/** Full portable backup of everything the editor knows about this tree. */
export type TreeExportV1 = {
  schema: typeof TREE_JSON_SCHEMA;
  exported_at: string;
  app: "SEJIRE";
  protocol: "sejire/v0.3";
  store: TreeStore;
  guide: GuideState;
};

export function buildTreeExport(store: TreeStore, guide: GuideState): TreeExportV1 {
  return {
    schema: TREE_JSON_SCHEMA,
    exported_at: new Date().toISOString(),
    app: "SEJIRE",
    protocol: "sejire/v0.3",
    store: structuredClone(store),
    guide: structuredClone(guide),
  };
}

export function downloadTreeJson(store: TreeStore, guide: GuideState) {
  const payload = buildTreeExport(store, guide);
  const json = JSON.stringify(payload, null, 2);
  const blob = new Blob([json], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const title = safeFilename(store.meta.title || "tree", "tree");
  a.href = url;
  a.download = `sejire-${title}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

/** Reject keys that would pollute Object.prototype if assigned onto a plain object. */
function isSafeRecordKey(id: string): boolean {
  return id !== "__proto__" && id !== "constructor" && id !== "prototype";
}

function normalizePerson(raw: unknown, id: string): Person | null {
  if (!isRecord(raw)) return null;
  // These fields are read as text by the editor and both PDF exporters.
  // Refuse an invalid record instead of turning an imported family into a
  // partially empty tree or letting a number/object reach String.trim().
  const textFields = ["name", "born", "died", "birthPlace", "deathPlace", "burialDate", "burialPlace", "occupation", "maidenName", "notes"];
  if (textFields.some(key => raw[key] != null && typeof raw[key] !== "string")) return null;
  if (raw.place != null && (!isRecord(raw.place) ||
      raw.place.label != null && typeof raw.place.label !== "string" ||
      [raw.place.lat, raw.place.lon].some(value => value != null && (typeof value !== "number" || !Number.isFinite(value))))) return null;
  const pid = typeof raw.id === "string" ? raw.id : id;
  if (!isSafeRecordKey(pid) || !isSafeRecordKey(id)) return null;
  const name = typeof raw.name === "string" ? raw.name : "";
  const parents = Array.isArray(raw.parents)
    ? raw.parents.filter((p): p is string => typeof p === "string" && isSafeRecordKey(p))
    : [];
  const media: Person["media"] = [];
  if (Array.isArray(raw.media)) {
    for (const item of raw.media) {
      if (!isRecord(item) || typeof item.tx !== "string") continue;
      if (item.kind !== "image" && item.kind !== "document" && item.kind !== "audio" && item.kind !== "other") {
        continue;
      }
      media.push({
        tx: item.tx,
        kind: item.kind,
        caption: typeof item.caption === "string" ? item.caption : undefined,
      });
    }
  }
  return {
    id: pid,
    name,
    sex: raw.sex === "M" || raw.sex === "F" || raw.sex === "U" ? raw.sex : "U",
    born: (raw.born as string | null | undefined) ?? null,
    died: (raw.died as string | null | undefined) ?? null,
    place: (raw.place as Person["place"]) ?? null,
    birthPlace: (raw.birthPlace as string | null | undefined) ?? null,
    deathPlace: (raw.deathPlace as string | null | undefined) ?? null,
    burialDate: (raw.burialDate as string | null | undefined) ?? null,
    burialPlace: (raw.burialPlace as string | null | undefined) ?? null,
    occupation: (raw.occupation as string | null | undefined) ?? null,
    maidenName: (raw.maidenName as string | null | undefined) ?? null,
    parents,
    media,
    notes: typeof raw.notes === "string" ? raw.notes : "",
    tombstone: Boolean(raw.tombstone),
  };
}

function normalizeSnapshot(raw: unknown): Snapshot | null {
  if (!isRecord(raw) || !isRecord(raw.persons)) return null;
  const persons: Record<string, Person> = {};
  for (const [id, value] of Object.entries(raw.persons)) {
    if (!isSafeRecordKey(id)) continue;
    if (isRecord(value) && typeof value.id === "string" && !isSafeRecordKey(value.id)) continue;
    const person = normalizePerson(value, id);
    if (!person || Object.hasOwn(persons, person.id)) return null;
    persons[person.id] = person;
  }
  return { persons };
}

function pickString(raw: Record<string, unknown>, key: string): string | null {
  const v = raw[key];
  return typeof v === "string" && v.trim() ? v : null;
}

function metaFrom(raw: unknown, fallbacks: Record<string, unknown> = {}): TreeMeta {
  const m = isRecord(raw) ? raw : {};
  return {
    id: pickString(m, "id") ?? pickString(fallbacks, "id") ?? `tree_${Date.now().toString(36)}`,
    title: pickString(m, "title") ?? pickString(fallbacks, "title") ?? "Мой род",
    head: typeof m.head === "string" || m.head === null ? (m.head as string | null) : null,
    next_version: typeof m.next_version === "number" ? m.next_version : 1,
    created_at: typeof m.created_at === "string" ? m.created_at : new Date().toISOString(),
    author: typeof m.author === "string" ? m.author : "local",
    zhuz: isZhuzId(m.zhuz) ? m.zhuz : null,
    clanName: typeof m.clanName === "string" ? m.clanName : null,
    tamgaUrl: typeof m.tamgaUrl === "string" ? m.tamgaUrl : null,
  };
}

/**
 * Repair whatever localStorage / a vault / a JSON file actually contains.
 * Missing `meta` used to crash the workspace: `undefined is not an object (evaluating '….meta.zhuz')`.
 */
export function coerceTreeStore(raw: unknown): TreeStore | null {
  if (!isRecord(raw)) return null;

  if (
    raw.schema === TREE_JSON_SCHEMA ||
    raw.app === "SEJIRE" ||
    (isRecord(raw.store) && (raw.guide !== undefined || raw.exported_at !== undefined))
  ) {
    return coerceTreeStore(raw.store);
  }

  if (raw.schema === "sejire/vault/v1" && isRecord(raw.trees)) {
    const trees = raw.trees;
    const active = typeof raw.active_tree_id === "string" ? raw.active_tree_id : null;
    const picked =
      (active && Object.prototype.hasOwnProperty.call(trees, active) ? trees[active] : null) ??
      Object.values(trees)[0];
    return coerceTreeStore(picked);
  }

  const snapshotSource = isRecord(raw.draft)
    ? raw.draft
    : isRecord(raw.persons)
      ? raw
      : null;
  const draft = normalizeSnapshot(snapshotSource);
  if (!draft) return null;

  // Validate historical snapshots without rewriting immutable commits. Missing
  // history remains compatible with older bare snapshots and tree exports.
  if (raw.commits !== undefined && !isRecord(raw.commits) || raw.versions !== undefined && !isRecord(raw.versions)) return null;
  const commits = isRecord(raw.commits) ? raw.commits : {};
  const versions = isRecord(raw.versions) ? raw.versions : {};
  for (const [id, commit] of Object.entries(commits)) {
    if (!isSafeRecordKey(id) || !isRecord(commit) || !normalizeSnapshot(commit.snapshot)) return null;
    if (["tree_id", "commit_id", "parent_commit_id", "author", "created_at", "message"].some(key =>
      commit[key] != null && typeof commit[key] !== "string")) return null;
    if (commit.version !== undefined && (!Number.isSafeInteger(commit.version) || (commit.version as number) < 1)) return null;
  }
  if (Object.values(versions).some(id => typeof id !== "string" || !isSafeRecordKey(id))) return null;
  if (isRecord(raw.meta) && raw.meta.next_version !== undefined &&
      (!Number.isSafeInteger(raw.meta.next_version) || (raw.meta.next_version as number) < 1)) return null;
  return {
    meta: metaFrom(raw.meta, raw),
    commits: commits as TreeStore["commits"],
    versions: versions as TreeStore["versions"],
    draft,
    dirty: Boolean(raw.dirty),
  };
}

function normalizeGuide(raw: unknown): GuideState {
  const base = defaultGuide();
  if (!isRecord(raw)) return { ...base, step: "done" };
  return {
    step: typeof raw.step === "string" ? (raw.step as GuideState["step"]) : "done",
    selfId: typeof raw.selfId === "string" ? raw.selfId : null,
    motherId: typeof raw.motherId === "string" ? raw.motherId : null,
    fatherId: typeof raw.fatherId === "string" ? raw.fatherId : null,
    maternalGrandmotherId:
      typeof raw.maternalGrandmotherId === "string" ? raw.maternalGrandmotherId : null,
    maternalGrandfatherId:
      typeof raw.maternalGrandfatherId === "string" ? raw.maternalGrandfatherId : null,
    paternalGrandmotherId:
      typeof raw.paternalGrandmotherId === "string" ? raw.paternalGrandmotherId : null,
    paternalGrandfatherId:
      typeof raw.paternalGrandfatherId === "string" ? raw.paternalGrandfatherId : null,
  };
}

export type ParseTreeJsonResult =
  | { ok: true; store: TreeStore; guide: GuideState }
  | { ok: false; error: string };

/**
 * Accepts sejire/tree-export/v1 or a bare TreeStore JSON for flexibility.
 */
export function parseTreeJson(text: string): ParseTreeJsonResult {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, error: "Файл не является JSON" };
  }
  if (!isRecord(data)) return { ok: false, error: "Неверный формат файла" };

  let storeRaw: unknown = data;
  let guideRaw: unknown = null;

  if (data.schema === TREE_JSON_SCHEMA || data.app === "SEJIRE") {
    storeRaw = data.store;
    guideRaw = data.guide;
  }

  if (isRecord(storeRaw) && storeRaw.schema === "sejire/vault/v1") {
    return { ok: false, error: "Файл содержит полный сейф. Для восстановления всех деревьев откройте зашифрованный архив через «Открыть по 12 словам»." };
  }

  const store = coerceTreeStore(storeRaw);
  if (!store) return { ok: false, error: "Неверные данные древа или истории. Текущий черновик не заменён." };

  return { ok: true, store: { ...store, dirty: true }, guide: normalizeGuide(guideRaw) };
}

export async function readTreeJsonFile(file: File): Promise<ParseTreeJsonResult> {
  try {
    return parseTreeJson(await file.text());
  } catch {
    return { ok: false, error: "Не удалось прочитать файл. Текущий черновик не заменён." };
  }
}
