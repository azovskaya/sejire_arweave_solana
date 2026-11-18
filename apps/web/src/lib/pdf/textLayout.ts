import type { jsPDF } from "jspdf";
import { pdfT, type PdfLocale } from "../i18n/pdf";
import { setPdfFont } from "./font";

export type PdfDetail = { label: string; text: string };
const PT_TO_MM = 25.4 / 72;

// With the embedded Noto Sans faces these bounds cover ascenders, accents and descenders.
function metrics(size: number) {
  return { lineHeight: size * PT_TO_MM * 1.42, baseline: size * PT_TO_MM * 1.08 };
}

/** Preserve word boundaries when possible, with hard breaks only inside oversized words. */
function* wrapLines(doc: jsPDF, text: string, width: number): Generator<string> {
  let line = "";
  for (const [word] of text.matchAll(/\S+/gu)) {
    const next = line ? line + " " + word : word;
    if (doc.getTextWidth(next) <= width) {
      line = next;
      continue;
    }
    if (line) yield line;
    if (doc.getTextWidth(word) <= width) {
      line = word;
      continue;
    }
    line = "";
    for (const ch of word) {
      if (line && doc.getTextWidth(line + ch) > width) {
        yield line;
        line = "";
      }
      line += ch;
    }
  }
  if (line) yield line;
}

/** Fit using the current font face in an actual mm rectangle, with a traceable overflow marker. */
export function fitBoxText(
  doc: jsPDF, text: string, width: number, height: number,
  preferredSize: number, minSize: number, maxLines = Infinity, suffix = "…"
) {
  const raw = text.trim() || "—";
  for (let size = Math.max(minSize, preferredSize); ; size = Math.max(minSize, size - 0.5)) {
    doc.setFontSize(size);
    const { lineHeight, baseline } = metrics(size);
    const capacity = Math.min(maxLines, Math.floor((height + 0.000001) / lineHeight));
    const lines: string[] = [];
    let overflow = false;
    for (const line of wrapLines(doc, raw, width)) {
      if (lines.length >= capacity || doc.getTextWidth(line) > width) {
        overflow = true;
        break;
      }
      lines.push(line);
    }
    if (!overflow || size === minSize) {
      if (overflow && capacity > 0) {
        // A dense card can hold the reference alone even if the ellipsis would not fit.
        const marker = doc.getTextWidth(suffix) <= width ? suffix : suffix.replace(/^…\s*/u, "");
        const tail = Array.from(lines.pop() || "");
        while (tail.length && doc.getTextWidth(tail.join("") + marker) > width) tail.pop();
        if (doc.getTextWidth(marker) <= width) lines.push(tail.join("").trimEnd() + marker);
      }
      return { lines, fontSize: size, lineHeight, baseline, overflow };
    }
  }
}

/** Print complete overflow entries after the posters, splitting even a single long value across pages. */
export function appendPdfDetails(doc: jsPDF, locale: PdfLocale, details: PdfDetail[]) {
  if (!details.length) return;
  const t = pdfT(locale);
  const margin = 18;
  let y = 0;
  let width = 0;
  let bottom = 0;
  let entry = 1;
  const ranges: Array<{ page: number; first: number; last: number }> = [];
  function addPage() {
    doc.addPage("a4", "portrait");
    width = doc.internal.pageSize.getWidth() - 2 * margin;
    bottom = doc.internal.pageSize.getHeight() - margin;
    y = margin;
    ranges.push({ page: doc.getNumberOfPages(), first: entry, last: entry });
    setPdfFont(doc, "bold");
    doc.setTextColor(72, 45, 27);
    doc.setFontSize(15);
    doc.text(t.fullEntries, margin, y + 5);
    y += 14;
  }
  function writeLine(line: string, bold: boolean, size: number) {
    const { lineHeight, baseline } = metrics(size);
    if (y + lineHeight > bottom) addPage();
    setPdfFont(doc, bold ? "bold" : "normal");
    doc.setFontSize(size);
    const ink: [number, number, number] = bold ? [100, 62, 34] : [45, 40, 36];
    doc.setTextColor(...ink);
    ranges[ranges.length - 1].last = entry;
    doc.text(line, margin, y + baseline);
    y += lineHeight;
  }
  addPage();
  details.forEach((detail, i) => {
    entry = i + 1;
    if (y + 2 * metrics(10).lineHeight > bottom) addPage();
    setPdfFont(doc, "bold");
    doc.setFontSize(10);
    for (const line of wrapLines(doc, `[${i + 1}] ${detail.label}`, width)) writeLine(line, true, 10);
    setPdfFont(doc, "normal");
    doc.setFontSize(10);
    for (const paragraph of detail.text.split(/\r?\n/u)) {
      for (const line of wrapLines(doc, paragraph, width)) writeLine(line, false, 10);
    }
    y += 4;
  });
  const total = doc.getNumberOfPages();
  for (const { page, first, last } of ranges) {
    doc.setPage(page);
    setPdfFont(doc, "normal");
    doc.setFontSize(8);
    doc.setTextColor(95, 74, 54);
    const entries = first === last ? `[${first}]` : `[${first}]–[${last}]`;
    doc.text(entries, margin, bottom + 8);
    doc.text(t.pageOf(page, total), margin + width, bottom + 8, { align: "right" });
  }
}
