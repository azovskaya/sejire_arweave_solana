/**
 * Shared poster framing for wall-ready PDF exports.
 */
import type { jsPDF } from "jspdf";
import { safeFilename } from "./filename";

export { safeFilename };

export function drawPosterFrame(
  doc: jsPDF,
  pageW: number,
  pageH: number,
  ink: [number, number, number] = [90, 55, 25]
) {
  const m = 7;
  doc.setDrawColor(...ink);
  doc.setLineWidth(1.15);
  doc.rect(m, m, pageW - m * 2, pageH - m * 2);
  doc.setLineWidth(0.28);
  doc.rect(m + 2.4, m + 2.4, pageW - (m + 2.4) * 2, pageH - (m + 2.4) * 2);
}

/** Corner motifs only — never crosses the title band. */
export function drawCornerOrnaments(
  doc: jsPDF,
  pageW: number,
  pageH: number,
  ink: [number, number, number] = [160, 100, 45]
) {
  const inset = 12;
  doc.setFillColor(...ink);
  const corners: [number, number][] = [
    [inset, inset],
    [pageW - inset, inset],
    [inset, pageH - inset],
    [pageW - inset, pageH - inset],
  ];
  for (const [cx, cy] of corners) {
    doc.triangle(cx, cy - 2.4, cx + 2.4, cy, cx, cy + 2.4, "F");
    doc.triangle(cx, cy - 2.4, cx - 2.4, cy, cx, cy + 2.4, "F");
  }
}

/** Short decorative rule under a title, with a gap in the center for breathing room. */
export function drawTitleRule(doc: jsPDF, pageW: number, y: number, ink: [number, number, number]) {
  const gap = 18;
  const left = 22;
  const right = pageW - 22;
  const mid = pageW / 2;
  doc.setDrawColor(...ink);
  doc.setLineWidth(0.35);
  doc.line(left, y, mid - gap / 2, y);
  doc.line(mid + gap / 2, y, right, y);
  doc.setFillColor(...ink);
  doc.circle(mid, y, 0.9, "F");
}

/** Soft truncate — only for secondary meta (places), never for full names. */
export function fitText(doc: jsPDF, text: string, maxWidth: number, fontSize: number) {
  doc.setFontSize(fontSize);
  let t = text;
  while (t.length > 1 && doc.getTextWidth(t) > maxWidth) {
    t = `${t.slice(0, -2)}…`;
  }
  return t;
}

/**
 * Quiet brand mark outside the poster frame, bottom-right corner.
 * Frame inset is 7mm — mark sits in the page margin below/right of the border.
 */
export function drawBrandMark(
  doc: jsPDF,
  pageW: number,
  pageH: number,
  label: string,
  ink: [number, number, number] = [150, 130, 100]
) {
  const right = pageW - 3.2;
  const y = pageH - 2.6;
  doc.setFontSize(6);
  doc.setTextColor(...ink);
  const chars = label.split("");
  const tracking = 0.75;
  let total = 0;
  for (const ch of chars) total += doc.getTextWidth(ch) + tracking;
  total -= tracking;
  let x = right - total;
  for (const ch of chars) {
    doc.text(ch, x, y);
    x += doc.getTextWidth(ch) + tracking;
  }
}
