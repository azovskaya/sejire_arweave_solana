import { buildTreeExport, coerceTreeStore, parseTreeJson, readTreeJsonFile, TREE_JSON_SCHEMA } from "./treeJson";
import { commitDraft, createTree, listHistory, loadDraftFromCommit, setDraftPerson } from "./treeEngine";
import { formatPersonDate } from "./dates";
import { defaultGuide } from "./guide";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

let store = createTree("Тест");
store = setDraftPerson(store, {
  id: "me",
  name: "Иван",
  sex: "M",
  born: "1990-01-02",
  died: null,
  birthPlace: "Астана",
  deathPlace: null,
  burialDate: null,
  burialPlace: null,
  occupation: "инженер",
  maidenName: null,
  parents: ["fa"],
  media: [],
  notes: "заметка",
  tombstone: false,
});
store = setDraftPerson(store, {
  id: "fa",
  name: "Пётр",
  sex: "M",
  born: "1960",
  died: null,
  parents: [],
  media: [],
  notes: "",
  tombstone: false,
});

const guide = {
  ...defaultGuide(),
  step: "done" as const,
  selfId: "me",
  fatherId: "fa",
};

const exported = buildTreeExport(store, guide);
assert(exported.schema === TREE_JSON_SCHEMA, "schema");
assert(exported.store.draft.persons.me.birthPlace === "Астана", "birthPlace");
assert(exported.store.draft.persons.me.occupation === "инженер", "occupation");
assert(exported.guide.selfId === "me", "guide self");

const round = parseTreeJson(JSON.stringify(exported));
assert(round.ok, "parse ok");
if (round.ok) {
  assert(round.store.draft.persons.me.name === "Иван", "name");
  assert(round.store.draft.persons.fa.name === "Пётр", "father");
  assert(round.guide.fatherId === "fa", "guide father");
  assert(round.store.meta.title === "Тест", "title");
}

const bareSnap = parseTreeJson(JSON.stringify({ persons: { a: { id: "a", name: "A", parents: [] } } }));
assert(bareSnap.ok, "bare snapshot");

const noMeta = coerceTreeStore({
  draft: { persons: { me: { id: "me", name: "Пётр", parents: [], media: [] } } },
  dirty: true,
});
assert(noMeta?.draft.persons.me.name === "Пётр", "people survive missing meta");
assert(noMeta?.meta && noMeta.meta.zhuz === null, "missing meta gets zhuz: null");

let threw = false;
try {
  const broken = { draft: { persons: {} } } as { meta?: { zhuz?: string } };
  void broken.meta!.zhuz;
} catch {
  threw = true;
}
assert(threw, "reading .meta.zhuz on a draft without meta throws (Safari crash)");

const wrapped = coerceTreeStore({
  schema: TREE_JSON_SCHEMA,
  app: "SEJIRE",
  store: exported.store,
  guide,
});
assert(wrapped?.meta.title === "Тест", "unwrap export");
assert(wrapped?.draft.persons.me.name === "Иван", "unwrap people");

const oldMeta = coerceTreeStore({
  ...store,
  meta: { id: store.meta.id, title: store.meta.title, head: null, next_version: 1, created_at: store.meta.created_at, author: "local" },
});
assert(oldMeta?.meta.zhuz === null, "pre-zhuz meta is filled");
assert(oldMeta?.meta.title === "Тест", "pre-zhuz title kept");

const polluted = parseTreeJson(
  JSON.stringify({
    persons: {
      me: { id: "me", name: "Safe", parents: ["__proto__"], media: [{ tx: "x", kind: "nope" }] },
      __proto__: { id: "__proto__", name: "pollute", parents: [] },
    },
  })
);
assert(polluted.ok, "pollution parse ok");
if (polluted.ok) {
  assert(!Object.hasOwn(polluted.store.draft.persons, "__proto__"), "skip proto person id");
  assert(polluted.store.draft.persons.me.parents.length === 0, "drop proto parent id");
  assert(polluted.store.draft.persons.me.media.length === 0, "drop bad media kind");
  assert(!Object.hasOwn(Object.prototype, "name"), "Object.prototype not polluted");
}

// These used to pass the importer and then throw in the normal date/place
// renderer. Invalid fields must reject the file, never silently omit a person.
for (const field of ["name", "born", "died", "birthPlace", "deathPlace", "burialDate", "burialPlace", "occupation", "maidenName", "notes"]) {
  for (const value of [1990, { text: "Synthetic date" }]) {
    const bad = parseTreeJson(JSON.stringify({ persons: { a: { id: "a", name: "A", parents: [], [field]: value } } }));
    assert(!bad.ok, `invalid ${field} is rejected before editor replacement`);
  }
}
for (const place of [1990, [], { label: 1990 }, { label: { text: "Synthetic place" } }, { lat: "51.1" }]) {
  assert(!parseTreeJson(JSON.stringify({ persons: { a: { id: "a", name: "A", parents: [], place } } })).ok,
    "invalid nested place is rejected");
}
assert(!parseTreeJson(JSON.stringify({ persons: { broken: null } })).ok, "invalid person is not silently dropped");
assert(!parseTreeJson(JSON.stringify({ persons: {
  first: { id: "duplicate", name: "Synthetic first person", parents: [] },
  second: { id: "duplicate", name: "Synthetic second person", parents: [] },
} })).ok, "two people with the same normalized ID cannot silently replace each other");
const missingIds = parseTreeJson(JSON.stringify({ persons: { first: { name: "First" }, second: { name: "Second" } } }));
assert(missingIds.ok && Object.keys(missingIds.store.draft.persons).length === 2, "legacy people without explicit IDs retain distinct map keys");

const historical = commitDraft(commitDraft(store, "Synthetic first snapshot"), "Synthetic second snapshot");
const historicalText = JSON.stringify(buildTreeExport(historical, guide));
const historyRound = parseTreeJson(historicalText);
assert(historyRound.ok, "valid historical export imports");
assert(JSON.stringify(historyRound.store.commits) === JSON.stringify(historical.commits), "every immutable commit is retained exactly");
assert(JSON.stringify(historyRound.store.versions) === JSON.stringify(historical.versions), "every historical version is retained exactly");
assert(listHistory(historyRound.store).length === 2, "normal history reader can inspect imported snapshots");
const restoredHistory = loadDraftFromCommit(historyRound.store, historical.meta.head!);
assert(formatPersonDate(restoredHistory.draft.persons.me.born) === formatPersonDate("1990-01-02"), "normal renderer can show imported historical dates");
const commitId = historical.meta.head!, commit = historical.commits[commitId];
for (const broken of [
  { ...historical, commits: null }, { ...historical, commits: [] }, { ...historical, versions: null },
  { ...historical, versions: { 1: { id: commitId } } },
  { ...historical, commits: { [commitId]: { ...commit, snapshot: null } } },
  { ...historical, commits: { [commitId]: { ...commit, snapshot: { persons: null } } } },
  { ...historical, commits: { [commitId]: { ...commit, snapshot: { persons: { a: { id: "a", name: "A", born: 1990 } } } } } },
  { ...historical, meta: { ...historical.meta, next_version: -1 } },
]) assert(!parseTreeJson(JSON.stringify(broken)).ok, "invalid history is rejected without discarding commits");
assert(JSON.stringify(buildTreeExport(historical, guide).store) === JSON.stringify(historical), "validation leaves original history unchanged");

const fullVault = { schema: "sejire/vault/v1", active_tree_id: store.meta.id,
  trees: { [store.meta.id]: historical, other: createTree("Second family") } };
assert(!parseTreeJson(JSON.stringify(fullVault)).ok, "tree import refuses silently choosing one tree from a complete vault");
assert(coerceTreeStore(fullVault)?.meta.id === store.meta.id, "internal legacy vault coercion remains compatible");
const unreadable = await readTreeJsonFile({ text: async () => { throw Error("Synthetic file read failure"); } } as unknown as File);
assert(!unreadable.ok && unreadable.error.includes("прочитать"), "file read failure becomes a visible import error");

console.log("treeJson.selftest: OK");
