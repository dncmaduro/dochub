import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import en from "./locales/en";
import vi from "./locales/vi";

export const LANGUAGE_STORAGE_KEY = "dochub.language";
export type Locale = "en" | "vi";

export function resolveLocale(value: string | null | undefined): Locale {
  const normalized = value?.toLowerCase() ?? "";
  if (normalized.startsWith("vi")) return "vi";
  return "en";
}

function getInitialLocale(): Locale {
  if (typeof window === "undefined") return "en";
  const persisted = window.localStorage.getItem(LANGUAGE_STORAGE_KEY);
  return resolveLocale(persisted || window.navigator.language);
}

void i18n.use(initReactI18next).init({
  resources: { en: { translation: en }, vi: { translation: vi } },
  lng: getInitialLocale(),
  fallbackLng: "en",
  interpolation: { escapeValue: false },
  initAsync: false,
});

function syncDocumentLanguage(locale: string) {
  if (typeof document !== "undefined") document.documentElement.lang = resolveLocale(locale);
}

syncDocumentLanguage(i18n.language);
i18n.on("languageChanged", (locale) => {
  const resolved = resolveLocale(locale);
  if (typeof window !== "undefined") window.localStorage.setItem(LANGUAGE_STORAGE_KEY, resolved);
  syncDocumentLanguage(resolved);
});

export function changeLocale(locale: Locale) {
  return i18n.changeLanguage(locale);
}

export function translate(key: string, options?: Record<string, unknown>) {
  return i18n.t(key, options);
}

export function getLocale(): Locale {
  return resolveLocale(i18n.language);
}

export default i18n;
