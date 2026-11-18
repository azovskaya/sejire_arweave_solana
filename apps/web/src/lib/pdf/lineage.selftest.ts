/**
 * Lineage helpers self-test
 */
import {
  ancestorGenerations,
  ancestorSlotLayout,
  choosePedigreePoster,
  computePedigreeLayout,
  maleLineUp,
  slotCenterFraction,
} from "./lineage";
import type { Person, Snapshot } from "../types";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const snapshot: Snapshot = {
  persons: {
    me: { id: "me", name: "Me", sex: "M", parents: ["fa", "mo"], media: [] },
    fa: { id: "fa", name: "Father", sex: "M", parents: ["gf", "gm"], media: [] },
    mo: { id: "mo", name: "Mother", sex: "F", parents: ["mgf", "mgm"], media: [] },
    gf: { id: "gf", name: "GF", sex: "M", parents: [], media: [] },
    gm: { id: "gm", name: "GM", sex: "F", parents: [], media: [] },
    mgf: { id: "mgf", name: "MGF", sex: "M", parents: [], media: [] },
    mgm: { id: "mgm", name: "MGM", sex: "F", parents: [], media: [] },
  },
};

const male = maleLineUp(snapshot, "me");
assert(male.map((p) => p.id).join(",") === "me,fa,gf", `male line ${male.map((p) => p.id)}`);

const gens = ancestorGenerations(snapshot, "me", 4);
assert(gens[0][0].id === "me", "focus bottom gen");
assert(gens[1][0].id === "fa" && gens[1][1].id === "mo", "father left of mother");
assert(gens[2].map((p) => p.id).join(",") === "gf,gm,mgf,mgm", "grandparents slot order");

const slots = ancestorSlotLayout(snapshot, "me", 4);
const byId = Object.fromEntries(slots.map((s) => [s.person.id, s]));
assert(byId.fa.slot === 0 && byId.mo.slot === 1, "parent slots");
assert(byId.gf.slot === 0 && byId.gm.slot === 1, "paternal gp slots");
assert(byId.mgf.slot === 2 && byId.mgm.slot === 3, "maternal gp slots");

// Father center left of mother for same depth
const depth = 3;
assert(
  slotCenterFraction(1, 0, depth) < slotCenterFraction(1, 1, depth),
  "father fraction left of mother"
);
assert(
  slotCenterFraction(0, 0, depth) > slotCenterFraction(1, 0, depth) &&
    slotCenterFraction(0, 0, depth) < slotCenterFraction(1, 1, depth),
  "child centered between parents"
);

const deep: Snapshot = { persons: {} };
let prevId: string | null = null;
for (let i = 12; i >= 0; i -= 1) {
  const id = `g${String(i).padStart(2, "0")}`;
  deep.persons[id] = {
    id,
    name: `Gen ${i}`,
    sex: "M",
    parents: prevId ? [prevId] : [],
    media: [],
  };
  prevId = id;
}
const deepMale = maleLineUp(deep, "g00");
assert(deepMale.length === 13, `13-knee male line ${deepMale.length}`);
assert(ancestorSlotLayout(deep, "g00", 5).length === 5, "classic PDF used to silently drop gens 6–13");
assert(ancestorSlotLayout(deep, "g00", 13).length === 13, "13-knee layout keeps the full line");

function completeAncestry(gens: number): Snapshot {
  const count = 2 ** gens - 1;
  const persons: Record<string, Person> = {};
  for (let n = 1; n <= count; n += 1) {
    const father = 2 * n <= count ? `a${2 * n}` : null;
    const mother = 2 * n + 1 <= count ? `a${2 * n + 1}` : null;
    persons[`a${n}`] = {
      id: `a${n}`,
      name: `P${n}`,
      sex: n === 1 || n % 2 === 0 ? "M" : "F",
      parents: [father, mother].filter((id): id is string => Boolean(id)),
      media: [],
    };
  }
  return { persons };
}

const trioLayout = computePedigreeLayout(slots, { x: 12, y: 28, w: 273, h: 168 });
assert(trioLayout.roomy, "3-person chart stays compact");
assert(trioLayout.rowPitch <= 40, `3-person row pitch ${trioLayout.rowPitch} must not fill A4`);
const faPos = trioLayout.positions.get("fa");
const moPos = trioLayout.positions.get("mo");
assert(faPos && moPos, "parents have cards");
assert(
  Math.abs(faPos.cx - moPos.cx) < 100,
  `parents should sit together, gap ${Math.abs(faPos.cx - moPos.cx)}`
);
assert(trioLayout.cardW >= 28 && trioLayout.cardH >= 16, "compact cards stay large enough for names");

const sixGen = completeAncestry(6);
assert(Object.keys(sixGen.persons).length === 63, "6-knee complete tree");
const sixPoster = choosePedigreePoster(sixGen, "a1", 6);
assert(sixPoster.format === "a3", `6-knee poster is A3, got ${sixPoster.format}`);
assert(sixPoster.generations === 6 && !sixPoster.truncated, "6-knee fits on one A3 sheet");
assert(sixPoster.orientation === "landscape", "6-knee A3 is landscape");

const fiveGen = completeAncestry(5);
const fivePoster = choosePedigreePoster(fiveGen, "a1", 5);
assert(fivePoster.format === "a4", `5-knee stays A4, got ${fivePoster.format}`);
assert(!fivePoster.truncated, "5-knee is not truncated");

const sevenGen = completeAncestry(7);
const sevenPoster = choosePedigreePoster(sevenGen, "a1", 7);
assert(sevenPoster.format === "a2", `7-knee poster is A2, got ${sevenPoster.format}`);
assert(sevenPoster.generations === 7 && !sevenPoster.truncated, "7-knee fits on one A2 sheet");

console.log("lineage.selftest: OK", {
  male: male.length,
  gens: gens.length,
  slots: slots.length,
  deep: deepMale.length,
  six: sixPoster.format,
  seven: sevenPoster.format,
});

// A family can be widest in the middle, then continue as one parent to generation 13.
const uneven = completeAncestry(7);
let previous = "a64";
for (let g = 8; g <= 13; g += 1) {
  const id = `extra${g}`;
  uneven.persons[previous].parents = [id];
  uneven.persons[id] = { id, name: id, parents: [], media: [], sex: "M" };
  previous = id;
}
const unevenPlan = choosePedigreePoster(uneven, "a1");
assert(unevenPlan.format === "a2" && unevenPlan.generations === 13, "size for all rows, including the widest");
const unevenSlots = ancestorSlotLayout(uneven, "a1", 13);
const box = { x: 12, y: 28, w: unevenPlan.pageW - 24, h: unevenPlan.pageH - 42 };
const layout = computePedigreeLayout(unevenSlots, box);
assert(layout.positions.size === 133, "all uneven ancestors have a card");
assert(layout.positions.get("a1")!.w > 40, "use the space in sparse rows for readable names");
const rightByGeneration = new Map<number, number>();
for (const pos of layout.positions.values()) {
  const previousRight = rightByGeneration.get(pos.generation) ?? box.x;
  assert(pos.x >= previousRight - 1e-7, `overlapping cards or left overflow: ${pos.id}`);
  assert(pos.x + pos.w <= box.x + box.w + 1e-7, `right overflow: ${pos.id}`);
  assert(pos.y >= box.y - 1e-7 && pos.y + layout.cardH <= box.y + box.h + 1e-7, `vertical overflow: ${pos.id}`);
  rightByGeneration.set(pos.generation, pos.x + pos.w);
}
