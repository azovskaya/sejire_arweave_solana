import assert from "node:assert/strict";
import { test } from "node:test";
import { loadDraftTree, saveDraftTree } from "./draftStorage";
import { buildPersonDraft } from "./personDraft";
import { commitDraft, createTree, setDraftPerson } from "./treeEngine";
import type { Person, TreeStore } from "./types";

const storage = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => { storage.set(key, String(value)); },
  removeItem: (key: string) => { storage.delete(key); },
} });

function reload(store: TreeStore): TreeStore {
  assert.equal(saveDraftTree(store), true);
  const loaded = loadDraftTree();
  assert.ok(loaded, "the real draft loader accepts the saved tree");
  return loaded;
}

function fixture() {
  let store = createTree("Synthetic raw profile preservation");
  store = setDraftPerson(store, { id: "parent", name: "Synthetic parent", sex: "F", parents: [], media: [], notes: "Parent note" });
  store = setDraftPerson(store, { id: "child", name: "Regression Child", sex: "M", parents: ["parent"], media: [], notes: "Original child note" });
  store = commitDraft(store, "Synthetic immutable baseline");
  return store;
}

test("reload, pristine profile flush and another field edit keep the exact last notes and immutable history", () => {
  const baseline = fixture();
  const commits = JSON.stringify(baseline.commits), versions = JSON.stringify(baseline.versions);
  const parent = reload(baseline).draft.persons.parent;
  const notes = "Последняя буква: Ә — не терять пробел ";
  let store = reload(setDraftPerson(baseline, { ...baseline.draft.persons.child, notes }));
  assert.equal(store.draft.persons.child.notes, notes, "first reload preserves the raw input");

  // Opening a reloaded profile calls Workspace.captureEditorStore and flushes
  // the mounted panel before any new input. This is the CI failure boundary.
  const untouched = store.draft.persons.child;
  store = reload(setDraftPerson(store, buildPersonDraft(untouched, untouched)));
  assert.equal(store.draft.persons.child.notes, notes, "opening a pristine profile must not trim saved notes");

  const name = "Алия Мария ";
  const reopened = store.draft.persons.child;
  store = reload(setDraftPerson(store, buildPersonDraft(reopened, { ...reopened, name })));
  assert.equal(store.draft.persons.child.name, name);
  assert.equal(store.draft.persons.child.notes, notes);
  assert.deepEqual(store.draft.persons.parent, parent);
  assert.equal(JSON.stringify(store.commits), commits, "existing commit bytes remain unchanged");
  assert.equal(JSON.stringify(baseline.commits), commits, "profile changes cannot mutate the original history object");
  assert.equal(JSON.stringify(store.versions), versions, "history indices remain unchanged");
  assert.equal(store.meta.head, baseline.meta.head);
});

test("flushing reloaded raw names, dates and optional facts does not normalize untouched fields", () => {
  const baseline = fixture();
  const commits = JSON.stringify(baseline.commits), versions = JSON.stringify(baseline.versions);
  const raw: Person = {
    ...baseline.draft.persons.child,
    name: "  Алия Мария ",
    maidenName: " Әбілова ",
    born: " 19 ",
    died: " 5.03.20 ",
    burialDate: " 1.2.2003 ",
    birthPlace: "  Астана ",
    deathPlace: " Алматы ",
    burialPlace: "  ",
    occupation: " исследователь ",
    notes: " Первая строка\nПоследняя строка \n",
    media: [{ tx: "synthetic-media", kind: "image", caption: " Historical caption " }],
  };
  let store = reload(setDraftPerson(baseline, raw));
  const loaded = store.draft.persons.child;
  const captured = buildPersonDraft(loaded, loaded);
  assert.deepEqual(captured, loaded, "a pristine flush is an exact no-op, including partial dates");

  // A profile edit must still retain relationships/media from the live tree,
  // even if the panel's draft object has stale structural fields.
  const stale = { ...loaded, occupation: "New occupation ", parents: [], media: [], tombstone: true };
  store = reload(setDraftPerson(store, buildPersonDraft(loaded, stale)));
  assert.deepEqual(store.draft.persons.child, { ...loaded, occupation: "New occupation " });
  assert.equal(JSON.stringify(store.commits), commits);
  assert.equal(JSON.stringify(store.versions), versions);
});
