import type { Person, Snapshot } from "../types";
import { splitParents } from "../pedigree";
import { formatPersonDate, yearFromDate } from "../dates";

/** Youngest-first male line: [self, father, grandfather, …]. */
export function maleLineUp(snapshot: Snapshot, startId: string): Person[] {
  const line: Person[] = [];
  const seen = new Set<string>();
  let currentId: string | null = startId;

  while (currentId && !seen.has(currentId)) {
    seen.add(currentId);
    const person = snapshot.persons[currentId];
    if (!person || person.tombstone) break;
    line.push(person);
    const { fatherId } = splitParents(snapshot, currentId);
    currentId = fatherId;
  }

  return line;
}

export type AncestorSlot = {
  person: Person;
  /** 0 = focus (youngest / bottom of poster) */
  generation: number;
  /** Pedigree index: father = 2*childSlot, mother = 2*childSlot+1 */
  slot: number;
};

/**
 * Binary pedigree layout: father left / mother right under each child.
 * Connector edges do not cross when X follows slot spans.
 */
export function ancestorSlotLayout(
  snapshot: Snapshot,
  focusId: string,
  maxGenerations = 5
): AncestorSlot[] {
  const focus = snapshot.persons[focusId];
  if (!focus || focus.tombstone) return [];

  const out: AncestorSlot[] = [];
  const placed = new Set<string>();
  type Q = { id: string; generation: number; slot: number };
  const queue: Q[] = [{ id: focusId, generation: 0, slot: 0 }];

  for (let i = 0; i < queue.length; i += 1) {
    const cur = queue[i];
    if (placed.has(cur.id) || cur.generation >= maxGenerations) continue;
    const person = snapshot.persons[cur.id];
    if (!person || person.tombstone) continue;
    placed.add(cur.id);
    out.push({ person, generation: cur.generation, slot: cur.slot });

    if (cur.generation + 1 >= maxGenerations) continue;
    const { fatherId, motherId } = splitParents(snapshot, cur.id);
    if (fatherId && !placed.has(fatherId)) {
      queue.push({ id: fatherId, generation: cur.generation + 1, slot: cur.slot * 2 });
    }
    if (motherId && !placed.has(motherId)) {
      queue.push({ id: motherId, generation: cur.generation + 1, slot: cur.slot * 2 + 1 });
    }
  }

  return out;
}

/**
 * Ancestor generations for charts.
 * gens[0] = focus, gens[1] = parents, … ordered by pedigree slot.
 */
export function ancestorGenerations(
  snapshot: Snapshot,
  focusId: string,
  maxGenerations = 5
): Person[][] {
  const slots = ancestorSlotLayout(snapshot, focusId, maxGenerations);
  if (!slots.length) return [];
  const depth = Math.max(...slots.map((s) => s.generation)) + 1;
  const gens: Person[][] = Array.from({ length: depth }, () => []);
  for (let g = 0; g < depth; g += 1) {
    gens[g] = slots
      .filter((s) => s.generation === g)
      .sort((a, b) => a.slot - b.slot)
      .map((s) => s.person);
  }
  return gens;
}

/** Center X of a slot as a fraction of usable width (0..1). */
export function slotCenterFraction(generation: number, slot: number, depth: number): number {
  const leafSlots = 2 ** Math.max(0, depth - 1);
  const leafSpan = 2 ** Math.max(0, depth - 1 - generation);
  const leftLeaf = slot * leafSpan;
  return (leftLeaf + leafSpan / 2) / leafSlots;
}

/** Gens per pedigree page. Overlap of 1 gen chains charts (person is top, then bottom of the next). */
export const PEDIGREE_CHART_WINDOW = 5;

/** Leftover 2–3 gen families — used only to keep small charts clustered, not to paginate. */
export const SHALLOW_CHART_MAX_DEPTH = 3;
export const SHALLOW_CHART_MAX_PEOPLE = 7;

export type PedigreeChartRoot = { id: string; startGeneration: number };

export type PedigreeCardPos = {
  id: string;
  x: number;
  y: number;
  cx: number;
  w: number;
  generation: number;
  slot: number;
};

export type PedigreeLayoutBox = { x: number; y: number; w: number; h: number };

export type PedigreeChartLayout = {
  /** Width of cards in the most crowded row. */
  cardW: number;
  cardH: number;
  rowPitch: number;
  roomy: boolean;
  positions: Map<string, PedigreeCardPos>;
};

/** ISO landscape posters. Wider trees step up instead of splitting into mini-charts. */
export const PEDIGREE_POSTER_SIZES = [
  { id: "a4" as const, w: 297, h: 210 },
  { id: "a3" as const, w: 420, h: 297 },
  { id: "a2" as const, w: 594, h: 420 },
];

export type PedigreePosterFormat = (typeof PEDIGREE_POSTER_SIZES)[number]["id"];

export type PedigreePosterPlan = {
  format: PedigreePosterFormat;
  orientation: "landscape" | "portrait";
  pageW: number;
  pageH: number;
  /** Generations painted from the focus (may be < depth if even A2 is too narrow). */
  generations: number;
  truncated: boolean;
  depth: number;
};

const POSTER_MARGIN_X = 24;
/** Smallest card that still matches the readable A4 5-knee overview. A2 may go slightly under. */
const MIN_READABLE_CARD_W = 8;

/**
 * Roots for chained 5-generation pedigree pages covering `maxGenerations`.
 * Complete 13-knee binary tree → 1 + 16 + 256 = 273 charts.
 * Kept as a helper; the classic PDF is one poster, not this booklet.
 */
export function pedigreeChartRoots(
  snapshot: Snapshot,
  focusId: string,
  maxGenerations = 13,
  window = PEDIGREE_CHART_WINDOW
): PedigreeChartRoot[] {
  const slots = ancestorSlotLayout(snapshot, focusId, maxGenerations);
  if (!slots.length) return [];
  const depth = Math.max(...slots.map((s) => s.generation)) + 1;
  const step = Math.max(1, window - 1);
  const out: PedigreeChartRoot[] = [];
  const lastStart = Math.max(0, depth - 2);
  for (let g = 0; g <= lastStart; g += step) {
    const row = slots.filter((s) => s.generation === g).sort((a, b) => a.slot - b.slot);
    for (const s of row) out.push({ id: s.person.id, startGeneration: g });
  }
  return out;
}

export function isShallowPedigreeChart(slots: AncestorSlot[]): boolean {
  if (!slots.length) return true;
  const depth = Math.max(...slots.map((s) => s.generation)) + 1;
  return depth <= SHALLOW_CHART_MAX_DEPTH && slots.length <= SHALLOW_CHART_MAX_PEOPLE;
}

/** Fit every occupied row and reserve the same vertical bands used when painting. */
function posterFits(w: number, h: number, widest: number, depth: number): boolean {
  const cardWidth = (w - POSTER_MARGIN_X) / widest - 0.7;
  return cardWidth >= MIN_READABLE_CARD_W && 12 * depth + 4 * (depth - 1) <= h - 42;
}

/** Find a readable overview, keeping the closest generations when even A2 fills up. */
export function choosePedigreePoster(
  snapshot: Snapshot,
  focusId: string,
  maxGenerations = 13
): PedigreePosterPlan {
  const slots = ancestorSlotLayout(snapshot, focusId, maxGenerations);
  const counts: number[] = [];
  for (const { generation } of slots) counts[generation] = (counts[generation] ?? 0) + 1;
  const depth = counts.length;
  for (let generations = depth; generations > 0; generations -= 1) {
    const widest = Math.max(...counts.slice(0, generations));
    const preferPortrait = generations > 8 && widest <= 8;
    const orientations = preferPortrait
      ? (["portrait", "landscape"] as const)
      : (["landscape", "portrait"] as const);
    for (const { id, w, h } of PEDIGREE_POSTER_SIZES) {
      for (const orientation of orientations) {
        const [pageW, pageH] = orientation === "portrait" ? [h, w] : [w, h];
        if (posterFits(pageW, pageH, widest, generations)) {
          return { format: id, orientation, pageW, pageH, generations, truncated: generations < depth, depth };
        }
      }
    }
  }
  return { format: "a4", orientation: "landscape", pageW: 297, pageH: 210, generations: 0, truncated: false, depth };
}

/**
 * Card geometry for one pedigree chart inside `box`.
 * Shallow families stay clustered with a capped row pitch so names are not 8pt in a corner of A4.
 */
export function computePedigreeLayout(
  slots: AncestorSlot[],
  box: PedigreeLayoutBox
): PedigreeChartLayout {
  const byGen = new Map<number, AncestorSlot[]>();
  for (const s of slots) {
    const row = byGen.get(s.generation) ?? [];
    row.push(s);
    byGen.set(s.generation, row);
  }
  for (const row of byGen.values()) row.sort((a, b) => a.slot - b.slot);

  const depth = Math.max(1, ...slots.map((s) => s.generation + 1));
  const maxInRow = Math.max(1, ...[...byGen.values()].map((row) => row.length));
  const roomy = isShallowPedigreeChart(slots);

  let gap = 0;
  let cardW: number;
  if (roomy) {
    gap = Math.min(16, Math.max(6, box.w * 0.05));
    cardW = (box.w - (maxInRow - 1) * gap) / maxInRow;
    if (cardW > 52) cardW = 52;
    else if (cardW < 24 && maxInRow > 1) {
      gap = 4;
      cardW = (box.w - (maxInRow - 1) * gap) / maxInRow;
    }
    cardW = Math.max(18, Math.min(52, cardW));
  } else {
    const gapX = maxInRow >= 4 ? 0.7 : 2.4;
    cardW = Math.min(maxInRow >= 4 ? 40 : 46, box.w / maxInRow - gapX);
  }

  const minGapY = roomy ? 10 : 4;
  const heightBudget = (box.h - (depth - 1) * minGapY) / depth;
  const preferredH = roomy
    ? Math.min(22, Math.max(16, cardW * 0.48))
    : depth > 8 ? 17.2 : 22;
  const cardH = Math.min(preferredH, heightBudget);
  const rowPitch = depth > 1 ? Math.min(roomy ? 36 : 48, (box.h - cardH) / (depth - 1)) : 0;
  const totalH = (depth - 1) * rowPitch + cardH;
  const originY = box.y + Math.max(0, (box.h - totalH) / 2);

  const positions = new Map<string, PedigreeCardPos>();
  for (const [g, row] of byGen) {
    const visualRow = depth - 1 - g;
    const y = originY + visualRow * rowPitch;
    const n = row.length;
    const width = roomy ? cardW : Math.min(n >= 4 ? 40 : 46, box.w / n - (n >= 4 ? 0.7 : 2.4));
    const rowW = roomy ? n * width + (n - 1) * gap : box.w;
    const rowLeft = roomy ? box.x + (box.w - rowW) / 2 : box.x;
    row.forEach((s, i) => {
      let x: number;
      if (roomy) {
        x = rowLeft + i * (width + gap);
      } else {
        // Only occupied slots consume space. Sorting by pedigree slot keeps
        // paternal and maternal branches in the same order on adjacent rows.
        const frac = (i + 0.5) / n;
        const cx = box.x + frac * box.w;
        x = cx - width / 2;
      }
      positions.set(s.person.id, {
        id: s.person.id,
        x,
        y,
        cx: x + width / 2,
        w: width,
        generation: s.generation,
        slot: s.slot,
      });
    });
  }

  return { cardW, cardH, rowPitch, roomy, positions };
}

export function yearSpan(p: Person): string {
  const by = yearFromDate(p.born) ?? "";
  const dy = yearFromDate(p.died) ?? "";
  if (by && dy) return `${by}–${dy}`;
  if (by) return `род. ${by}`;
  if (dy) return `ум. ${dy}`;
  return "";
}

/** Birth/death line for PDF — full dates when known, years otherwise. */
export function lifeDatesLine(p: Person, compact = false): string {
  if (compact) return yearSpan(p);
  const b = formatPersonDate(p.born);
  const d = formatPersonDate(p.died);
  if (b && d) return `${b} — ${d}`;
  if (b) return `род. ${b}`;
  if (d) return `ум. ${d}`;
  return "";
}
