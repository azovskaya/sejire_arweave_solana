import { jsPDF } from "jspdf";
import type { Person, Snapshot, TreeMeta } from "../types";
import { pdfT, SHEZHIRE_MAX_GENERATIONS, type PdfLocale } from "../i18n/pdf";
import { maleLineUp, lifeDatesLine } from "./lineage";
import { ensurePdfFont, setPdfFont } from "./font";
import { drawBrandMark, fitText, safeFilename } from "./poster";
import { formatShezhireAffiliation, zhuzFullLabel } from "../zhuzRu";
import {
  drawAncientLabelBox,
  drawAncientRule,
  drawAncientTizimFrame,
  drawDiamondKnot,
  drawGeometricHornCell,
  drawLabelPlaque,
  drawNameCartouche,
  drawOrnamentBorder,
  drawTitleOrnament,
  type Rgb,
} from "./ornaments";
import { appendPdfDetails, fitBoxText, type PdfDetail } from "./textLayout";
import type { ShezhireTemplateId } from "./shezhireTemplates";

export type { ShezhireTemplateId, ShezhireTemplateInfo } from "./shezhireTemplates";
export { SHEZHIRE_TEMPLATES } from "./shezhireTemplates";

type RenderCtx = {
  doc: jsPDF;
  pageW: number;
  pageH: number;
  line: Person[];
  meta: TreeMeta;
  locale: PdfLocale;
  youngestDistance: number;
  sheetLabel: string;
  details: PdfDetail[];
  detailNumbers: Map<string, number>;
};

/** Measure and paint in the same font. Oversized fields retain their full text in a numbered entry. */
function fitEntry(
  ctx: RenderCtx, label: string, text: string, w: number, h: number,
  prefer: number, min: number, maxLines = Infinity
) {
  const key = JSON.stringify([label, text]);
  const existing = ctx.detailNumbers.get(key);
  const number = existing ?? ctx.details.length + 1;
  const layout = fitBoxText(ctx.doc, text, w, h, prefer, min, maxLines, `… [${number}]`);
  if (layout.overflow && existing === undefined) {
    ctx.details.push({ label, text });
    ctx.detailNumbers.set(key, number);
  }
  return layout;
}

function drawAffiliationBlock(ctx: RenderCtx, y: number, ink: Rgb, mute: Rgb, maxTextW = ctx.pageW - 56) {
  const { doc, pageW, meta, locale } = ctx;
  const affiliation = formatShezhireAffiliation(meta.zhuz, meta.clanName);
  if (!affiliation) return y;

  const t = pdfT(locale);
  const zhuz = zhuzFullLabel(meta.zhuz);
  const clan = (meta.clanName || "").trim();
  const label = zhuz && clan ? `${t.zhuzLabel} · ${t.clanLabel}` : zhuz ? t.zhuzLabel : t.clanLabel;
  setPdfFont(doc, "normal");
  doc.setFontSize(7);
  doc.setTextColor(...mute);
  doc.text(label, pageW / 2, y, { align: "center" });
  setPdfFont(doc, "bold");
  doc.setTextColor(...ink);
  const block = fitEntry(ctx, label, affiliation, maxTextW, 12, 11, 8, 2);
  for (const [i, line] of block.lines.entries()) {
    doc.text(line, pageW / 2, y + 1 + block.baseline + i * block.lineHeight, { align: "center" });
  }
  return y + 3 + block.lines.length * block.lineHeight;
}

/** Center the name and its dates together inside the actual inner bounds of each template. */
function drawPersonText(
  ctx: RenderCtx, person: Person, label: string, x: number, y: number, w: number, h: number,
  preferred: number, align: "center" | "left", ink: Rgb, mute: Rgb
) {
  const { doc } = ctx;
  const life = lifeDatesLine(person);
  setPdfFont(doc, "normal");
  const dateSize = Math.max(6, Math.min(7.5, preferred * 0.78));
  const dates = life && fitEntry(ctx, label, life, w, Math.min(h * 0.48, 15), dateSize, 5.5);
  const dateH = dates ? dates.lines.length * dates.lineHeight + 0.8 : 0;
  setPdfFont(doc, "bold");
  const name = fitEntry(ctx, label, person.name || "—", w, h - dateH, preferred, 6);
  const nameH = name.lines.length * name.lineHeight;
  const top = y + (h - nameH - dateH) / 2;
  const anchor = align === "center" ? x + w / 2 : x;
  doc.setTextColor(...ink);
  for (const [i, line] of name.lines.entries()) {
    doc.text(line, anchor, top + name.baseline + i * name.lineHeight, { align });
  }
  if (dates) {
    setPdfFont(doc, "normal");
    doc.setFontSize(dates.fontSize);
    doc.setTextColor(...mute);
    for (const [i, line] of dates.lines.entries()) {
      doc.text(line, anchor, top + nameH + 0.8 + dates.baseline + i * dates.lineHeight, { align });
    }
  }
}

function drawSheetLabel(ctx: RenderCtx, x: number, y: number) {
  if (!ctx.sheetLabel) return;
  setPdfFont(ctx.doc, "normal");
  ctx.doc.setFontSize(6.5);
  ctx.doc.setTextColor(95, 70, 45);
  ctx.doc.text(ctx.sheetLabel, x, y);
}

function renderManuscript(ctx: RenderCtx) {
  const { doc, pageW, pageH, line, locale } = ctx;
  const t = pdfT(locale);
  const parchment: Rgb = [242, 228, 198];
  const parchmentDeep: Rgb = [232, 212, 172];
  const ink: Rgb = [72, 38, 18];
  const gold: Rgb = [148, 98, 42];
  const goldSoft: Rgb = [176, 132, 68];
  const plaque: Rgb = [252, 243, 220];
  const mute: Rgb = [110, 78, 42];

  doc.setFillColor(...parchment);
  doc.rect(0, 0, pageW, pageH, "F");
  doc.setFillColor(...parchmentDeep);
  doc.rect(0, 0, 14, pageH, "F");
  doc.rect(pageW - 14, 0, 14, pageH, "F");
  drawOrnamentBorder(doc, pageW, pageH, 8, ink);
  drawSheetLabel(ctx, 24, pageH - 15);

  setPdfFont(doc, "bold");
  doc.setTextColor(...ink);
  doc.setFontSize(line.length > 9 ? 20 : 24);
  doc.text(t.shezhireTitle, pageW / 2, 22, { align: "center" });
  if (t.shezhireSubtitle) {
    setPdfFont(doc, "normal");
    doc.setFontSize(9);
    doc.setTextColor(...mute);
    doc.text(t.shezhireSubtitle, pageW / 2, 27.5, { align: "center" });
    drawTitleOrnament(doc, pageW / 2, 31, pageW / 2 - 28, gold);
  } else {
    drawTitleOrnament(doc, pageW / 2, 27, pageW / 2 - 28, gold);
  }

  let contentTop = drawAffiliationBlock(ctx, 34, ink, mute);
  contentTop += 3;

  const n = line.length;
  const bottomY = pageH - 22;
  const topY = contentTop + 1;
  const available = Math.max(36, bottomY - topY);
  const gap = n > 1 ? Math.min(3.2, available * 0.015) : 0;
  const cartoucheH = Math.min(22, Math.max(9.5, (available - gap * Math.max(0, n - 1)) / n));
  const block = cartoucheH + gap;
  const stackH = n * cartoucheH + Math.max(0, n - 1) * gap;
  const stackTop = topY + Math.max(0, (available - stackH) / 2);
  const spineX = n > 10 ? 42 : 48;
  const cartoucheX = n > 10 ? 52 : 58;
  const cartoucheW = pageW - cartoucheX - 16;
  const nameMaxW = cartoucheW - 11;

  if (n > 1) {
    doc.setDrawColor(...gold);
    doc.setLineWidth(0.85);
    const y0 = stackTop + cartoucheH / 2;
    const y1 = stackTop + (n - 1) * block + cartoucheH / 2;
    doc.line(spineX, y0, spineX, y1);
    doc.setLineWidth(0.25);
    doc.setDrawColor(...goldSoft);
    doc.line(spineX - 1.1, y0, spineX - 1.1, y1);
    doc.line(spineX + 1.1, y0, spineX + 1.1, y1);
  }

  for (let i = 0; i < n; i += 1) {
    const person = line[i];
    const distanceFromFocus = ctx.youngestDistance + n - 1 - i;
    const y = stackTop + i * block;
    const cy = y + cartoucheH / 2;
    const label = t.jetiAtaLabel(distanceFromFocus);

    drawDiamondKnot(doc, spineX, cy, Math.min(2.8, cartoucheH * 0.22), ink, parchment);
    doc.setDrawColor(...goldSoft);
    doc.setLineWidth(0.35);
    doc.line(spineX + 3, cy, cartoucheX - 4, cy);
    drawLabelPlaque(doc, spineX - 4.5, cy, label, ink, plaque, (bold) =>
      setPdfFont(doc, bold ? "bold" : "normal")
    );
    drawNameCartouche(doc, cartoucheX, y, cartoucheW, cartoucheH, ink, plaque, gold);

    drawPersonText(ctx, person, label, cartoucheX + (cartoucheW - nameMaxW) / 2, y + 2.3,
      nameMaxW, cartoucheH - 4.6, cartoucheH >= 18 ? 11 : 9, "center", ink, mute);
  }

  setPdfFont(doc, "bold");
  drawBrandMark(doc, pageW, pageH, t.exportedWith, [140, 105, 60]);
}

/**
 * Тізім — archaic shezhire list in dense Kazakh өрнек (киіз / сырмақ).
 * Wide geometric қосқар мүйіз belts, sharp frames, hand-ruled generations.
 * No modern cards or rounded UI.
 */
function renderRegistry(ctx: RenderCtx) {
  const { doc, pageW, pageH, line, locale } = ctx;
  const t = pdfT(locale);
  // Traditional dye palette: soot ink, ochre felt, aged hide
  const hide: Rgb = [214, 196, 160];
  const parchment: Rgb = [232, 214, 178];
  const dye: Rgb = [186, 148, 88];
  const dyeDeep: Rgb = [158, 112, 52];
  const ink: Rgb = [42, 22, 8];
  const mute: Rgb = [88, 58, 28];

  doc.setFillColor(...hide);
  doc.rect(0, 0, pageW, pageH, "F");

  const frame = drawAncientTizimFrame(doc, pageW, pageH, ink, dye, parchment);
  const { contentX, contentY, contentW, contentH } = frame;
  const cx = contentX + contentW / 2;
  drawSheetLabel(ctx, contentX + 3, contentY + contentH - 1.5);

  // Large geometric қосқар мүйіз above title
  drawGeometricHornCell(doc, cx, contentY + 6, 9, ink);
  drawGeometricHornCell(doc, cx - 22, contentY + 7.5, 5.5, dyeDeep);
  drawGeometricHornCell(doc, cx + 22, contentY + 7.5, 5.5, dyeDeep);

  setPdfFont(doc, "bold");
  doc.setTextColor(...ink);
  doc.setFontSize(line.length > 10 ? 17 : 20);
  doc.text(t.shezhireTitle, cx, contentY + 20, { align: "center" });

  // Ornamental title rule (not a thin modern underline)
  drawAncientRule(doc, contentX + 8, contentX + contentW - 8, contentY + 24, ink);

  let y = drawAffiliationBlock(ctx, contentY + 30, ink, mute, contentW - 12);
  y += 4;

  // Inner list field — sharp double rect (manuscript tablet)
  const listBottom = contentY + contentH - 8;
  const listTop = y;
  const listH = Math.max(36, listBottom - listTop);
  const listX = contentX + 2;
  const listW = contentW - 4;

  doc.setDrawColor(...ink);
  doc.setLineWidth(0.7);
  doc.rect(listX, listTop, listW, listH);
  doc.setLineWidth(0.25);
  doc.rect(listX + 1.6, listTop + 1.6, listW - 3.2, listH - 3.2);

  // Faint vertical column rule (generation | name)
  const labelColW = Math.min(36, listW * 0.3);
  const colRuleX = listX + 4 + labelColW;
  const n = line.length;
  const pad = 3.5;
  const usable = listH - pad * 2;
  const rowH = Math.min(15.5, Math.max(6.8, usable / Math.max(1, n)));
  const stackH = n * rowH;
  const stackTop = listTop + pad + Math.max(0, (usable - stackH) / 2);

  for (let i = 0; i < n; i += 1) {
    const person = line[i];
    const distanceFromFocus = ctx.youngestDistance + n - 1 - i;
    const isSelf = distanceFromFocus === 0;
    const label = t.jetiAtaLabel(distanceFromFocus);
    const ry = stackTop + i * rowH;
    const cy = ry + rowH / 2;

    // Alternating ochre wash (felt strip rhythm) — sharp, no radius
    if (i % 2 === 1) {
      doc.setFillColor(222, 200, 158);
      doc.rect(listX + 2.2, ry, listW - 4.4, rowH, "F");
    }
    if (isSelf) {
      doc.setFillColor(210, 178, 120);
      doc.rect(listX + 2.2, ry, listW - 4.4, rowH, "F");
    }

    doc.setDrawColor(...dyeDeep);
    doc.setLineWidth(0.3);
    doc.line(colRuleX, ry, colRuleX, ry + rowH);
    doc.setLineWidth(0.12);
    doc.line(colRuleX + 1.1, ry, colRuleX + 1.1, ry + rowH);

    // Horizontal rule between generations
    if (i > 0) {
      doc.setDrawColor(...ink);
      doc.setLineWidth(0.22);
      doc.line(listX + 3, ry, listX + listW - 3, ry);
      // Small horn knot on the rule
      drawGeometricHornCell(doc, colRuleX + 0.5, ry, 2.4, dyeDeep);
    }

    // Angular generation label box
    const boxH = Math.min(rowH - 1.4, 8.5);
    const boxY = cy - boxH / 2;
    drawAncientLabelBox(doc, listX + 4, boxY, labelColW - 2, boxH, ink, isSelf ? dyeDeep : dye);

    const fontMeta = Math.max(5.6, Math.min(7.5, boxH * 0.72));
    setPdfFont(doc, "bold");
    doc.setFontSize(fontMeta);
    doc.setTextColor(...(isSelf ? ([250, 240, 220] as Rgb) : ink));
    doc.text(fitText(doc, label, labelColW - 6, fontMeta), listX + 4 + (labelColW - 2) / 2, cy + fontMeta * 0.28, {
      align: "center",
    });

    // Name on the manuscript line
    const nameX = colRuleX + 5;
    drawPersonText(ctx, person, label, nameX, ry + 1, listX + listW - 9 - nameX,
      rowH - 2, rowH >= 13 ? 11 : 9.4, "left", ink, mute);

    // End-of-row diamond knot (traditional)
    doc.setFillColor(...ink);
    const knx = listX + listW - 5;
    const kr = isSelf ? 1.6 : 1.1;
    doc.triangle(knx, cy - kr, knx + kr, cy, knx, cy + kr, "F");
    doc.triangle(knx, cy - kr, knx - kr, cy, knx, cy + kr, "F");
  }

  // Footer: miniature horn strip, no modern seal line
  const fy = contentY + contentH - 2;
  drawGeometricHornCell(doc, cx, fy, 4, ink);
  drawGeometricHornCell(doc, cx - 14, fy + 0.5, 3, dyeDeep);
  drawGeometricHornCell(doc, cx + 14, fy + 0.5, 3, dyeDeep);

  setPdfFont(doc, "bold");
  drawBrandMark(doc, pageW, pageH, t.exportedWith, [100, 70, 35]);
}

/**
 * Баспалдақ — A4 landscape wall chart (album). Unmistakably wide format.
 * Oldest left → self right on a horizontal spine.
 */
function renderCascade(ctx: RenderCtx) {
  const { doc, pageW, pageH, line, locale } = ctx;
  const t = pdfT(locale);
  const bg: Rgb = [236, 228, 214];
  const ink: Rgb = [40, 28, 18];
  const mute: Rgb = [100, 82, 62];
  const accent: Rgb = [110, 62, 28];
  const goldSoft: Rgb = [168, 128, 72];
  const fill: Rgb = [255, 250, 242];
  const fillSelf: Rgb = [248, 228, 196];

  doc.setFillColor(...bg);
  doc.rect(0, 0, pageW, pageH, "F");

  // Landscape frame — thicker, clearly a wall plaque
  doc.setDrawColor(...ink);
  doc.setLineWidth(1.6);
  doc.rect(6, 6, pageW - 12, pageH - 12);
  doc.setLineWidth(0.3);
  doc.setDrawColor(...goldSoft);
  doc.rect(9, 9, pageW - 18, pageH - 18);
  drawSheetLabel(ctx, 15, pageH - 13);

  setPdfFont(doc, "bold");
  doc.setTextColor(...ink);
  doc.setFontSize(22);
  doc.text(t.shezhireTitle, pageW / 2, 20, { align: "center" });

  doc.setFillColor(...accent);
  doc.rect(pageW / 2 - 40, 23.5, 80, 0.7, "F");

  let headerBottom = drawAffiliationBlock(ctx, 30, ink, mute, pageW - 36);
  headerBottom += 4;

  const n = line.length;
  const marginX = 12;
  const bottom = pageH - 11;
  const top = headerBottom;
  const areaH = Math.max(36, bottom - top);
  const areaW = pageW - marginX * 2;

  const gap = n > 10 ? 1.8 : n > 7 ? 2.8 : 4;
  const cardW = Math.min(46, Math.max(15, (areaW - gap * Math.max(0, n - 1)) / n));
  const cardH = Math.min(areaH * 0.78, Math.max(32, areaH * 0.88));
  const totalW = n * cardW + Math.max(0, n - 1) * gap;
  const startX = marginX + Math.max(0, (areaW - totalW) / 2);
  const cardY = top + Math.max(0, (areaH - cardH) / 2);
  const spineY = cardY - 4;

  // Spine above cards
  if (n > 1) {
    doc.setDrawColor(...accent);
    doc.setLineWidth(1.4);
    doc.line(startX + cardW / 2, spineY, startX + totalW - cardW / 2, spineY);
  }

  for (let i = 0; i < n; i += 1) {
    const person = line[i];
    const distanceFromFocus = ctx.youngestDistance + n - 1 - i;
    const isSelf = distanceFromFocus === 0;
    const label = t.jetiAtaLabel(distanceFromFocus);
    const x = startX + i * (cardW + gap);

    doc.setFillColor(...accent);
    doc.circle(x + cardW / 2, spineY, 2.1, "F");
    doc.setDrawColor(...ink);
    doc.setLineWidth(0.35);
    doc.line(x + cardW / 2, spineY + 2.1, x + cardW / 2, cardY);

    doc.setFillColor(...(isSelf ? fillSelf : fill));
    doc.setDrawColor(...ink);
    doc.setLineWidth(isSelf ? 0.85 : 0.45);
    doc.roundedRect(x, cardY, cardW, cardH, 1.5, 1.5, "FD");

    doc.setFillColor(...accent);
    doc.roundedRect(x, cardY, cardW, 8.5, 1.5, 1.5, "F");
    doc.rect(x, cardY + 6, cardW, 2.5, "F");

    setPdfFont(doc, "bold");
    doc.setFontSize(cardW < 18 ? 5.2 : 6.2);
    doc.setTextColor(255, 250, 242);
    doc.text(fitText(doc, label, cardW - 3, cardW < 18 ? 5.2 : 6.2), x + cardW / 2, cardY + 5.5, {
      align: "center",
    });

    const prefer = cardW >= 34 ? 10.5 : cardW >= 26 ? 9 : 8;
    drawPersonText(ctx, person, label, x + 2, cardY + 10.5, cardW - 4, cardH - 13,
      prefer, "center", ink, mute);
  }

  setPdfFont(doc, "bold");
  drawBrandMark(doc, pageW, pageH, t.exportedWith, [120, 95, 70]);
}

/**
 * Wall / print «Жеті ата» PDF with selectable layout template.
 * All paternal generations are printed, in reading order, on A4 sheets.
 */
export async function renderShezhirePdf(opts: {
  snapshot: Snapshot;
  startId: string;
  meta: TreeMeta;
  locale?: PdfLocale;
  maxGenerations?: number;
  template?: ShezhireTemplateId;
}): Promise<jsPDF> {
  const locale = opts.locale ?? "ru";
  const t = pdfT(locale);
  const template = opts.template ?? "manuscript";
  const limit = Math.max(1, Math.floor(opts.maxGenerations ?? Infinity));
  const line = maleLineUp(opts.snapshot, opts.startId).slice(0, limit).reverse();
  if (!line.length) throw new Error(t.noMaleLine);

  const landscape = template === "cascade";
  const doc = new jsPDF({
    orientation: landscape ? "landscape" : "portrait",
    unit: "mm",
    compress: true,
    format: "a4",
  });
  await ensurePdfFont(doc);
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const details: PdfDetail[] = [];
  const detailNumbers = new Map<string, number>();
  const pages = Math.ceil(line.length / SHEZHIRE_MAX_GENERATIONS);
  for (let page = 0; page < pages; page++) {
    if (page) doc.addPage("a4", landscape ? "landscape" : "portrait");
    // Balance the sheets so a fourteenth ancestor does not sit alone on a second poster.
    const start = Math.floor(page * line.length / pages);
    const end = Math.floor((page + 1) * line.length / pages);
    const youngestDistance = line.length - end;
    const sheetLabel = pages === 1 ? "" :
      `${t.posterOf(page + 1, pages)} · ${t.kneeRange(youngestDistance + 1, line.length - start)}`;
    const ctx: RenderCtx = {
      doc, pageW, pageH, line: line.slice(start, end), youngestDistance, sheetLabel,
      meta: opts.meta, locale, details, detailNumbers,
    };
    if (template === "registry") renderRegistry(ctx);
    else if (template === "cascade") renderCascade(ctx);
    else renderManuscript(ctx);
  }
  appendPdfDetails(doc, locale, details);
  return doc;
}

export async function downloadShezhirePdf(opts: {
  snapshot: Snapshot;
  startId: string;
  meta: TreeMeta;
  locale?: PdfLocale;
  maxGenerations?: number;
  template?: ShezhireTemplateId;
}) {
  const doc = await renderShezhirePdf(opts);
  const safe = safeFilename(opts.meta.title || "jeti-ata", "jeti-ata");
  doc.save(`sejire-jeti-ata-${opts.template ?? "manuscript"}-${safe}.pdf`);
}
