import {
  detectUiLocale,
  parseUiLocale,
  resolveUiLocale,
  type UiLocale,
} from "./locale";
import { uiT } from "./messages";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

assert(parseUiLocale("kk-KZ") === "kk", "kk-KZ");
assert(parseUiLocale("kaz") === "kk", "kaz");
assert(parseUiLocale("en-US") === "en", "en-US");
assert(parseUiLocale("ru") === "ru", "ru");
assert(parseUiLocale("de") === null, "unknown");
assert(detectUiLocale(["de-DE", "en-GB"]) === "en", "first known in list");
assert(detectUiLocale(["fr-FR"]) === "en", "international fallback en");

const locales: UiLocale[] = ["ru", "kk", "en"];
for (const loc of locales) {
  const t = uiT(loc);
  assert(t.welcome.start.length > 0, `${loc} start`);
  assert(t.workspace.save.length > 0, `${loc} save`);
  assert(t.kinship.parent.length > 0, `${loc} kinship`);
  assert(t.localeShort.kk.length > 0, `${loc} shorts`);
}

assert(uiT("kk").welcome.start === "Бастау", "kk start");
assert(uiT("en").welcome.start === "Start", "en start");
assert(uiT("ru").welcome.start === "Начать", "ru start");
assert(uiT("kk").relation.father === "Әке", "kk father");
assert(uiT("en").publish.title === "Save", "en save title");
assert(uiT("en").localeShort.kk === "ҚАЗ", "shorts stay stable");
assert(uiT("kk").localeShort.en === "ENG", "kk shorts eng");
assert(uiT("ru").restore.fileReady.length > 0, "fileReady");
assert(uiT("ru").welcome.cashier === "Касса", "cashier link");
assert(uiT("en").admin.title === "Cashier", "en admin");
assert(uiT("kk").admin.tabKeys.length > 0, "kk keys tab");

const before = typeof localStorage !== "undefined" ? localStorage.getItem("sejire.locale") : null;
try {
  if (typeof localStorage !== "undefined") localStorage.removeItem("sejire.locale");
  assert(resolveUiLocale() === "ru" || resolveUiLocale() === "kk" || resolveUiLocale() === "en", "resolve");
} finally {
  if (typeof localStorage !== "undefined") {
    if (before == null) localStorage.removeItem("sejire.locale");
    else localStorage.setItem("sejire.locale", before);
  }
}

console.log("i18n.selftest: OK");
