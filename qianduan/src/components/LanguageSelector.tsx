"use client";

import { useI18n } from "./I18nProvider";
import { i18n } from "@/i18n.config";
import { isLocale } from "@/lib/i18n";

export default function LanguageSelector() {
  const { locale, setLocale, t } = useI18n();

  return (
    <label className="relative block h-9 w-28 shrink-0 sm:w-36" htmlFor="language-selector">
      <span className="sr-only">{t("Change language")}</span>
      <select
        id="language-selector"
        value={locale}
        aria-label={t("Change language")}
        onChange={(event) => {
          if (isLocale(event.target.value)) setLocale(event.target.value);
        }}
        className="h-9 w-full rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-2 text-xs font-semibold text-[var(--text-primary)] outline-none transition-colors focus:border-[var(--coral-bright)] sm:px-3"
      >
        {i18n.locales.map((option) => (
          <option key={option.code} value={option.code}>
            {option.name}
          </option>
        ))}
      </select>
    </label>
  );
}
