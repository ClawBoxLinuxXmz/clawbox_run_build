export const i18n = {
  defaultLocale: "en",
  locales: [
    { code: "en", name: "English", flag: "US" },
    { code: "zh-CN", name: "简体中文", flag: "CN" },
    { code: "zh-TW", name: "繁體中文", flag: "CN" },
    { code: "ja", name: "日本語", flag: "JP" },
    { code: "es", name: "Español", flag: "ES" },
    { code: "pt-BR", name: "Português (BR)", flag: "BR" },
    { code: "ko", name: "한국어", flag: "KR" },
    { code: "de", name: "Deutsch", flag: "DE" },
    { code: "fr", name: "Français", flag: "FR" },
    { code: "hi", name: "हिन्दी", flag: "IN" },
    { code: "ar", name: "العربية", flag: "SA" },
    { code: "it", name: "Italiano", flag: "IT" },
    { code: "vi", name: "Tiếng Việt", flag: "VN" },
    { code: "nl", name: "Nederlands", flag: "NL" },
    { code: "tr", name: "Türkçe", flag: "TR" },
    { code: "uk", name: "Українська", flag: "UA" },
    { code: "id", name: "Bahasa Indonesia", flag: "ID" },
    { code: "pl", name: "Polski", flag: "PL" },
    { code: "ru", name: "Русский", flag: "RU" },
    { code: "fa", name: "فارسی", flag: "IR" },
    { code: "th", name: "ไทย", flag: "TH" },
  ],
} as const;

export type LocaleCode = (typeof i18n)["locales"][number]["code"];
