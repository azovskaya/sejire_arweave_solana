/**
 * PDF / export copy. Keep keyed messages so UI can switch locales later.
 *
 * Terminology (Kazakh tradition):
 * - Шежіре — the genealogy document / lineage record (correct wall-poster title).
 * - Жеті ата — the duty to know seven paternal ancestors (concept, not the document title).
 * Generation names from self upward follow common printed шежіре usage.
 */
export type PdfLocale = "ru" | "kk" | "en";

type PdfMessages = {
  classicTitle: string;
  peopleShown: (shown: number, total: number) => string;
  detailsKey: string;
  parentRefs: string;
  /** Main poster title — always «Шежіре» for male-line charts */
  shezhireTitle: string;
  /** Optional quiet line under title; empty = omit */
  shezhireSubtitle: string;
  /** Labels by distance from focus: 0 = self, 1 = father, … (supports 13+) */
  jetiAtaLabel: (distanceFromFocus: number) => string;
  clanLabel: string;
  zhuzLabel: string;
  colNumber: string;
  colGeneration: string;
  colName: string;
  colDates: string;
  noPeople: string;
  noMaleLine: string;
  exportedWith: string;
  ancestorsOf: (name: string) => string;
  pageOf: (page: number, total: number) => string;
  posterOf: (page: number, total: number) => string;
  fullEntries: string;
  kneeRange: (from: number, to: number) => string;
};

/**
 * From the living person upward (өзі → … → түп ата).
 * Beyond the seventh: numbered ата (8-ші ата …).
 */
const FROM_SELF = [
  "Өзі",
  "Әке",
  "Ата",
  "Арғы ата",
  "Баба",
  "Тек ата",
  "Түп ата",
] as const;

const ru: PdfMessages = {
  classicTitle: "Генеалогическое древо",
  peopleShown: (shown, total) => shown === total ? `На схеме: ${shown}` : `На схеме: ${shown} из ${total}`,
  detailsKey: "Номера в скобках — записи на следующих листах",
  parentRefs: "Родители",
  shezhireTitle: "Шежіре",
  shezhireSubtitle: "",
  jetiAtaLabel: (d) => {
    const i = Math.max(0, d);
    if (i < FROM_SELF.length) return FROM_SELF[i];
    return `${i + 1}-ші ата`;
  },
  clanLabel: "Ру",
  zhuzLabel: "Жүз",
  colNumber: "№",
  colGeneration: "Ата",
  colName: "Есімі",
  colDates: "Жылдары",
  noPeople: "В древе нет людей для экспорта",
  noMaleLine: "Нет мужской линии для шежіре (нужен отец или выбран мужчина)",
  exportedWith: "SEJIRE",
  ancestorsOf: (name) => `Предки: ${name}`,
  posterOf: (page, total) => `Плакат ${page} / ${total}`,
  fullEntries: "Полные записи",
  pageOf: (page, total) => `лист ${page} / ${total}`,
  kneeRange: (from, to) => (from === to ? `колено ${from}` : `колена ${from}–${to}`),
};

const kk: PdfMessages = {
  ...ru,
  classicTitle: "Шежіре",
  peopleShown: (shown, total) => shown === total ? `Сызбада: ${shown}` : `Сызбада: ${shown} / ${total}`,
  detailsKey: "Жақшадағы нөмірлер — келесі беттердегі жазбалар",
  parentRefs: "Ата-анасы",
  noPeople: "Шежіреде экспортқа адам жоқ",
  noMaleLine: "Шежіре үшін ер жолы жоқ (әке керек немесе ер адамды таңдаңыз)",
  ancestorsOf: (name) => `Ата-баба: ${name}`,
  posterOf: (page, total) => `Плакат ${page} / ${total}`,
  fullEntries: "Толық жазбалар",
  pageOf: (page, total) => `бет ${page} / ${total}`,
  kneeRange: (from, to) => (from === to ? `${from}-ата` : `${from}–${to}-ата`),
};

const en: PdfMessages = {
  ...ru,
  classicTitle: "Family tree",
  peopleShown: (shown, total) => shown === total ? `On poster: ${shown}` : `On poster: ${shown} of ${total}`,
  detailsKey: "Bracketed numbers refer to entries on the following pages",
  parentRefs: "Parents",
  noPeople: "No people in the tree to export",
  noMaleLine: "No male line for shezhire (need a father, or select a man)",
  ancestorsOf: (name) => `Ancestors: ${name}`,
  posterOf: (page, total) => `Poster ${page} / ${total}`,
  fullEntries: "Full entries",
  pageOf: (page, total) => `sheet ${page} / ${total}`,
  kneeRange: (from, to) => (from === to ? `generation ${from}` : `generations ${from}–${to}`),
};

const catalogs: Record<PdfLocale, PdfMessages> = { ru, kk, en };

export function pdfT(locale: PdfLocale = "ru"): PdfMessages {
  return catalogs[locale] ?? catalogs.ru;
}

/** Up to 13 paternal generations per printed poster sheet. */
export const SHEZHIRE_MAX_GENERATIONS = 13;
