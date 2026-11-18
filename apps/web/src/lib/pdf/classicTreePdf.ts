import { jsPDF } from "jspdf";
import type { Person, Snapshot, TreeMeta } from "../types";
import { pdfT, SHEZHIRE_MAX_GENERATIONS, type PdfLocale } from "../i18n/pdf";
import { splitParents } from "../pedigree";
import {
  ancestorSlotLayout,
  choosePedigreePoster,
  computePedigreeLayout,
  lifeDatesLine,
  type AncestorSlot,
  type PedigreeCardPos,
  type PedigreeLayoutBox,
} from "./lineage";
import { ensurePdfFont, setPdfFont } from "./font";
import {
  drawBrandMark,
  drawCornerOrnaments,
  drawPosterFrame,
  drawTitleRule,
  safeFilename,
} from "./poster";
import { appendPdfDetails, fitBoxText, type PdfDetail } from "./textLayout";

const INK: [number, number, number] = [95, 70, 40];

type Messages = ReturnType<typeof pdfT>;

function personFields(p: Person): string[] {
  return [p.name || "—", lifeDatesLine(p), (p.birthPlace || p.place?.label || "").trim()].filter(Boolean);
}

function drawPersonCard(
  doc: jsPDF, slot: AncestorSlot, pos: PedigreeCardPos, h: number,
  roomy: boolean, details: PdfDetail[], reference: number | undefined, t: Messages
) {
  const { person } = slot;
  const { x, y, w } = pos;
  const accent: [number, number, number] = person.sex === "F" ? [150, 105, 115]
    : person.sex === "M" ? [85, 115, 140] : [150, 145, 135];
  const scale = Math.min(1, w / 40);
  const radius = Math.max(0.4, 1.2 * scale);
  const strip = Math.max(0.8, 1.5 * scale);
  doc.setDrawColor(120, 110, 95);
  doc.setFillColor(255, 253, 248);
  doc.setLineWidth(Math.max(0.15, 0.3 * scale));
  doc.roundedRect(x, y, w, h, radius, radius, "FD");
  doc.setFillColor(...accent);
  doc.rect(x, y, strip, h, "F");

  const inset = Math.max(0.65, 1.5 * scale);
  const left = x + strip + inset;
  const width = w - strip - 2 * inset;
  const bottom = y + h - inset;
  const gap = Math.min(0.7, inset);
  const life = lifeDatesLine(person, w < 26);
  const place = (person.birthPlace || person.place?.label || "").trim();
  const showPlace = place.length > 0 && w >= 26 && h >= 17;
  const metaSize = Math.max(4, Math.min(7, w * 0.18));
  const band = metaSize * 0.55;
  let nameBottom = bottom;
  let needsEntry = Boolean(place && !showPlace);
  setPdfFont(doc, "normal");
  doc.setTextColor(80, 70, 59);
  for (const text of [showPlace ? place : "", life]) {
    if (!text) continue;
    const field = fitBoxText(doc, text, width, band, metaSize, 4, 1);
    needsEntry ||= field.overflow;
    doc.setFontSize(field.fontSize);
    if (field.lines.length) doc.text(field.lines[0], left, nameBottom - band + field.baseline);
    nameBottom -= band + gap;
  }

  const nameTop = y + inset;
  const height = nameBottom - nameTop;
  const preferred = roomy ? 12 : Math.max(6, Math.min(10, w * 0.30));
  setPdfFont(doc, "bold");
  doc.setTextColor(34, 35, 38);
  const name = person.name.trim() || "—";
  let fitted = fitBoxText(doc, name, width, height, preferred, 4.5);
  if (reference === undefined && (needsEntry || fitted.overflow)) {
    reference = details.push({
      label: t.kneeRange(slot.generation + 1, slot.generation + 1),
      text: personFields(person).join(" · "),
    });
  }
  if (reference !== undefined) {
    fitted = fitBoxText(doc, `[${reference}] ${name}`, width, height, preferred, 4.5);
  }
  doc.setFontSize(fitted.fontSize);
  const firstBaseline = nameTop + (height - fitted.lines.length * fitted.lineHeight) / 2 + fitted.baseline;
  fitted.lines.forEach((line, i) => doc.text(line, left, firstBaseline + i * fitted.lineHeight));
}

function paintChart(
  doc: jsPDF, snapshot: Snapshot, slots: AncestorSlot[], box: PedigreeLayoutBox,
  details: PdfDetail[], references: Map<string, number>, t: Messages
) {
  const layout = computePedigreeLayout(slots, box);
  doc.setDrawColor(150, 130, 100);
  doc.setLineWidth(0.28);
  type Family = { child: PedigreeCardPos; parents: PedigreeCardPos[]; left: number; right: number };
  const connectors: Family[][] = [];
  for (const { person, generation } of slots) {
    const child = layout.positions.get(person.id)!;
    const { fatherId, motherId } = splitParents(snapshot, person.id);
    // For a shared ancestor on a different level, its register entry records
    // the relationship without drawing a line through intervening cards.
    const parents = [fatherId, motherId]
      .map(id => id ? layout.positions.get(id) : undefined)
      .filter((p): p is PedigreeCardPos => p?.generation === generation + 1);
    if (!parents.length) continue;
    const centers = [child.cx, ...parents.map(p => p.cx)];
    (connectors[generation] ??= []).push({
      child, parents, left: Math.min(...centers), right: Math.max(...centers),
    });
  }
  for (const families of connectors) {
    if (!families?.length) continue;
    // Elbows preserve the familiar layout except where two horizontal bars
    // would touch and make different families look like a single junction.
    const sharedBar = families.some((f, i) => i > 0 && f.left <= families[i - 1].right + 0.3);
    for (const { child, parents, left, right } of families) {
      const parentY = parents[0].y + layout.cardH;
      const middle = (parentY + child.y) / 2;
      if (sharedBar) {
        for (const parent of parents) doc.line(child.cx, child.y, parent.cx, parentY);
      } else {
        doc.line(child.cx, child.y, child.cx, middle);
        if (right > left) doc.line(left, middle, right, middle);
        for (const parent of parents) doc.line(parent.cx, middle, parent.cx, parentY);
      }
    }
  }
  for (const slot of slots) {
    const pos = layout.positions.get(slot.person.id)!;
    drawPersonCard(doc, slot, pos, layout.cardH,
      layout.roomy, details, references.get(slot.person.id), t);
  }
}

function paintPageChrome(
  doc: jsPDF,
  title: string,
  subtitle: string
): PedigreeLayoutBox {
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();

  setPdfFont(doc, "bold");
  doc.setFillColor(250, 246, 238);
  doc.rect(0, 0, pageW, pageH, "F");
  drawPosterFrame(doc, pageW, pageH, INK);
  drawCornerOrnaments(doc, pageW, pageH, [170, 120, 60]);

  doc.setTextColor(...INK);
  doc.setFontSize(12.5);
  doc.text(title, pageW / 2, 14.2, { align: "center" });
  setPdfFont(doc, "normal");
  doc.setFontSize(8);
  doc.setTextColor(120, 100, 80);
  doc.text(subtitle, pageW / 2, 19.2, { align: "center" });
  drawTitleRule(doc, pageW, 22.2, [175, 140, 90]);
  setPdfFont(doc, "bold");
  drawBrandMark(doc, pageW, pageH, pdfT().exportedWith, [155, 135, 105]);

  const marginX = 12;
  const topY = 28;
  const bottomY = pageH - 14;
  return { x: marginX, y: topY, w: pageW - marginX * 2, h: bottomY - topY };
}

/** Keep the first sheet printable as a wall poster. Its numbered register
 * retains full names and relationships that exceed the available paper. */
export async function renderClassicTreePdf(opts: {
  snapshot: Snapshot;
  focusId: string;
  meta: TreeMeta;
  locale?: PdfLocale;
}): Promise<jsPDF> {
  const locale = opts.locale ?? "ru";
  const t = pdfT(locale);
  const allSlots = ancestorSlotLayout(opts.snapshot, opts.focusId, Infinity);
  if (!allSlots.length) throw new Error(t.noPeople);

  const plan = choosePedigreePoster(opts.snapshot, opts.focusId, SHEZHIRE_MAX_GENERATIONS);
  const doc = new jsPDF({
    orientation: plan.orientation, unit: "mm", format: [plan.pageW, plan.pageH], compress: true,
  });
  await ensurePdfFont(doc);

  const slots = allSlots.filter(s => s.generation < plan.generations);
  const generations = new Map(allSlots.map(s => [s.person.id, s.generation]));
  const completeRegister = slots.length < allSlots.length || slots.some(({ person, generation }) => {
    const { fatherId, motherId } = splitParents(opts.snapshot, person.id);
    return [fatherId, motherId].some(id => id !== null && generations.get(id) !== generation + 1);
  });
  const references = new Map<string, number>();
  const details: PdfDetail[] = [];
  if (completeRegister) {
    allSlots.forEach(({ person }, i) => references.set(person.id, i + 1));
    for (const { person, generation } of allSlots) {
      const fields = personFields(person);
      const { fatherId, motherId } = splitParents(opts.snapshot, person.id);
      const parents = [fatherId, motherId].filter((id): id is string => id !== null);
      if (parents.length) fields.push(`${t.parentRefs}: ${parents.map(id => `[${references.get(id)}]`).join(", ")}`);
      details.push({ label: t.kneeRange(generation + 1, generation + 1), text: fields.join(" · ") });
    }
  }
  const subtitle = [t.peopleShown(slots.length, allSlots.length), t.kneeRange(1, plan.generations), plan.format.toUpperCase()].join(" · ");
  const box = paintPageChrome(doc, t.classicTitle, subtitle);
  paintChart(doc, opts.snapshot, slots, box, details, references, t);
  if (details.length) {
    setPdfFont(doc, "normal");
    doc.setFontSize(7);
    doc.setTextColor(95, 70, 40);
    doc.text(t.detailsKey, plan.pageW / 2, plan.pageH - 11, { align: "center" });
    appendPdfDetails(doc, locale, details);
    // The download filename and toast report the poster size, even if the
    // final register page is A4 portrait.
    doc.setPage(1);
  }
  return doc;
}

function paperFromDoc(doc: jsPDF): string {
  const w = Math.max(doc.internal.pageSize.getWidth(), doc.internal.pageSize.getHeight());
  if (w >= 580) return "A2";
  if (w >= 400) return "A3";
  return "A4";
}

export async function downloadClassicTreePdf(opts: {
  snapshot: Snapshot;
  focusId: string;
  meta: TreeMeta;
  locale?: PdfLocale;
}): Promise<string> {
  const t = pdfT(opts.locale ?? "ru");
  const doc = await renderClassicTreePdf(opts);
  const paper = paperFromDoc(doc);
  doc.save(`sejire-tree-${safeFilename(opts.meta.title || t.classicTitle, "tree")}-${paper}.pdf`);
  return paper;
}
