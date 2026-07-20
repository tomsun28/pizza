import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import en from "./locales/en.json";
import zhCN from "./locales/zh-CN.json";

export type AppLanguage = "en" | "zh-CN";

export const SUPPORTED_LANGUAGES: AppLanguage[] = ["en", "zh-CN"];

export const DEFAULT_LANGUAGE: AppLanguage = "en";

const STORAGE_KEY = "pizza-language";

export function getStoredLanguage(): AppLanguage {
	if (typeof localStorage === "undefined") return DEFAULT_LANGUAGE;
	const stored = localStorage.getItem(STORAGE_KEY);
	if (stored && SUPPORTED_LANGUAGES.includes(stored as AppLanguage)) {
		return stored as AppLanguage;
	}
	return DEFAULT_LANGUAGE;
}

export function setStoredLanguage(language: AppLanguage): void {
	try {
		localStorage.setItem(STORAGE_KEY, language);
	} catch {
		/* ignore */
	}
}

void i18n.use(initReactI18next).init({
	resources: {
		en: { translation: en },
		"zh-CN": { translation: zhCN },
	},
	lng: getStoredLanguage(),
	fallbackLng: DEFAULT_LANGUAGE,
	interpolation: {
		escapeValue: false,
	},
});

// Keep <html lang="..."> in sync with the active language for accessibility.
function updateHtmlLang(lang: string): void {
	if (typeof document !== "undefined") {
		document.documentElement.lang = lang;
	}
}
updateHtmlLang(i18n.language);
i18n.on("languageChanged", updateHtmlLang);

export default i18n;
