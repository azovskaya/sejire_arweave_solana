export type UiLocale = "ru" | "kk" | "en";

export const UI_LOCALES: readonly UiLocale[] = ["kk", "ru", "en"];

export const LOCALE_STORAGE_KEY = "sejire.locale";

export const LOCALE_HTML: Record<UiLocale, string> = {
  ru: "ru",
  kk: "kk",
  en: "en",
};

export const LOCALE_BCP47: Record<UiLocale, string> = {
  ru: "ru-RU",
  kk: "kk-KZ",
  en: "en-GB",
};

export function parseUiLocale(raw: string | null | undefined): UiLocale | null {
  if (!raw) return null;
  const s = raw.trim().toLowerCase();
  if (s === "kk" || s === "kz" || s === "kaz" || s.startsWith("kk-") || s.startsWith("kaz")) {
    return "kk";
  }
  if (s === "en" || s.startsWith("en-")) return "en";
  if (s === "ru" || s.startsWith("ru-")) return "ru";
  return null;
}

/** Browser language → UI locale. International visitors default to English. */
export function detectUiLocale(languages: readonly string[] = []): UiLocale {
  for (const lang of languages) {
    const hit = parseUiLocale(lang);
    if (hit) return hit;
  }
  return "en";
}

export function readStoredLocale(): UiLocale | null {
  try {
    return parseUiLocale(localStorage.getItem(LOCALE_STORAGE_KEY));
  } catch {
    return null;
  }
}

export function writeStoredLocale(locale: UiLocale) {
  try {
    localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    /* quota / private mode */
  }
}

export function resolveUiLocale(): UiLocale {
  return (
    readStoredLocale() ??
    detectUiLocale(
      typeof navigator === "undefined"
        ? []
        : navigator.languages?.length
          ? [...navigator.languages]
          : navigator.language
            ? [navigator.language]
            : []
    )
  );
}

export function applyDocumentLocale(
  locale: UiLocale,
  meta: { title: string; description: string }
) {
  if (typeof document === "undefined") return;
  document.documentElement.lang = LOCALE_HTML[locale];
  document.title = meta.title;
  const desc = document.querySelector('meta[name="description"]');
  if (desc) desc.setAttribute("content", meta.description);
}
