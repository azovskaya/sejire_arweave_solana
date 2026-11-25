import type { Person, TreeStore } from "./types";
import { createTree, upsertPersonFields, setDraftPerson } from "./treeEngine";
import { GUIDE_KEY, writeDraftValue } from './draftOwnership';

export type GuideStepId =
  | "self"
  | "mother"
  | "father"
  | "maternal_grandmother"
  | "maternal_grandfather"
  | "paternal_grandmother"
  | "paternal_grandfather"
  | "done";

export type GuideState = {
  step: GuideStepId;
  selfId: string | null;
  motherId: string | null;
  fatherId: string | null;
  maternalGrandmotherId: string | null;
  maternalGrandfatherId: string | null;
  paternalGrandmotherId: string | null;
  paternalGrandfatherId: string | null;
};

export const GUIDE_ORDER: GuideStepId[] = [
  "self",
  "mother",
  "father",
  "maternal_grandmother",
  "maternal_grandfather",
  "paternal_grandmother",
  "paternal_grandfather",
  "done",
];

export const GUIDE_COPY: Record<
  Exclude<GuideStepId, "done">,
  { title: string; hint: string; relation: string }
> = {
  self: {
    title: "Начните с себя",
    hint: "Запишите себя — корень дерева. Дальше добавим маму, папу и старшие поколения.",
    relation: "Я",
  },
  mother: {
    title: "Мама",
    hint: "Добавьте маму. Она станет родителем в вашей записи.",
    relation: "Мама",
  },
  father: {
    title: "Папа",
    hint: "Добавьте папу.",
    relation: "Папа",
  },
  maternal_grandmother: {
    title: "Бабушка по маме",
    hint: "Мать вашей мамы.",
    relation: "Бабушка (мамина мама)",
  },
  maternal_grandfather: {
    title: "Дедушка по маме",
    hint: "Отец вашей мамы.",
    relation: "Дедушка (мамин папа)",
  },
  paternal_grandmother: {
    title: "Бабушка по папе",
    hint: "Мать вашего папы.",
    relation: "Бабушка (папина мама)",
  },
  paternal_grandfather: {
    title: "Дедушка по папе",
    hint: "Отец вашего папы. После этого можно свободно дополнять род.",
    relation: "Дедушка (папин папа)",
  },
};

export function defaultGuide(): GuideState {
  return {
    step: "self",
    selfId: null,
    motherId: null,
    fatherId: null,
    maternalGrandmotherId: null,
    maternalGrandfatherId: null,
    paternalGrandmotherId: null,
    paternalGrandfatherId: null,
  };
}

export function saveGuide(guide: GuideState) {
  return writeDraftValue(GUIDE_KEY, JSON.stringify(guide));
}

export function loadGuide(): GuideState | null {
  try {
    const raw = localStorage.getItem(GUIDE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as GuideState;
  } catch {
    return null;
  }
}

export function clearGuide() {
  return writeDraftValue(GUIDE_KEY, null);
}

export function nextStep(step: GuideStepId): GuideStepId {
  const i = GUIDE_ORDER.indexOf(step);
  return GUIDE_ORDER[Math.min(i + 1, GUIDE_ORDER.length - 1)];
}

function uid() {
  return `p_${Math.random().toString(36).slice(2, 9)}`;
}

export function startGuidedTree(title: string): { store: TreeStore; guide: GuideState } {
  return { store: createTree(title), guide: defaultGuide() };
}

/**
 * Add a person for the current guided step and wire parent links.
 */
export function applyGuidePerson(
  store: TreeStore,
  guide: GuideState,
  data: { name: string; born?: string; died?: string; notes?: string }
): { store: TreeStore; guide: GuideState } {
  const id = uid();
  const person: Person = {
    id,
    name: data.name.trim(),
    sex: "U",
    born: data.born || null,
    died: data.died || null,
    parents: [],
    media: [],
    notes: data.notes || "",
    tombstone: false,
  };

  let nextGuide = { ...guide };
  let nextStore = store;

  switch (guide.step) {
    case "self": {
      nextGuide.selfId = id;
      nextStore = setDraftPerson(store, person);
      break;
    }
    case "mother": {
      nextGuide.motherId = id;
      nextStore = setDraftPerson(store, person);
      if (guide.selfId) {
        const self = nextStore.draft.persons[guide.selfId];
        if (self) {
          nextStore = setDraftPerson(nextStore, {
            ...self,
            parents: unique([id, ...self.parents.filter((p) => p !== guide.fatherId)]),
          });
        }
      }
      break;
    }
    case "father": {
      nextGuide.fatherId = id;
      nextStore = setDraftPerson(store, person);
      if (guide.selfId) {
        const self = nextStore.draft.persons[guide.selfId];
        if (self) {
          const parents = [...self.parents];
          if (guide.motherId && !parents.includes(guide.motherId)) parents.unshift(guide.motherId);
          if (!parents.includes(id)) parents.push(id);
          nextStore = setDraftPerson(nextStore, { ...self, parents: unique(parents) });
        }
      }
      break;
    }
    case "maternal_grandmother": {
      nextGuide.maternalGrandmotherId = id;
      nextStore = setDraftPerson(store, person);
      if (guide.motherId) {
        const mother = nextStore.draft.persons[guide.motherId];
        if (mother) {
          nextStore = setDraftPerson(nextStore, {
            ...mother,
            parents: unique([id, ...mother.parents]),
          });
        }
      }
      break;
    }
    case "maternal_grandfather": {
      nextGuide.maternalGrandfatherId = id;
      nextStore = setDraftPerson(store, person);
      if (guide.motherId) {
        const mother = nextStore.draft.persons[guide.motherId];
        if (mother) {
          nextStore = setDraftPerson(nextStore, {
            ...mother,
            parents: unique([...mother.parents, id]),
          });
        }
      }
      break;
    }
    case "paternal_grandmother": {
      nextGuide.paternalGrandmotherId = id;
      nextStore = setDraftPerson(store, person);
      if (guide.fatherId) {
        const father = nextStore.draft.persons[guide.fatherId];
        if (father) {
          nextStore = setDraftPerson(nextStore, {
            ...father,
            parents: unique([id, ...father.parents]),
          });
        }
      }
      break;
    }
    case "paternal_grandfather": {
      nextGuide.paternalGrandfatherId = id;
      nextStore = setDraftPerson(store, person);
      if (guide.fatherId) {
        const father = nextStore.draft.persons[guide.fatherId];
        if (father) {
          nextStore = setDraftPerson(nextStore, {
            ...father,
            parents: unique([...father.parents, id]),
          });
        }
      }
      break;
    }
    default:
      nextStore = upsertPersonFields(store, person);
  }

  nextGuide.step = nextStep(guide.step);
  return { store: nextStore, guide: nextGuide };
}

function unique(ids: string[]) {
  return [...new Set(ids.filter(Boolean))];
}

export function skipGuideStep(guide: GuideState): GuideState {
  return { ...guide, step: nextStep(guide.step) };
}
