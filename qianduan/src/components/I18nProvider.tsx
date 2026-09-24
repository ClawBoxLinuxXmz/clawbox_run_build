"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  DEFAULT_LOCALE,
  LOCALE_STORAGE_KEY,
  resolveLocale,
  translate,
  translateRuntime,
  type Locale,
  type MessageKey,
  type MessageValues,
} from "@/lib/i18n";

interface I18nContextValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (key: MessageKey, values?: MessageValues) => string;
  translateText: (message: string) => string;
}

const I18nContext = createContext<I18nContextValue | null>(null);

let clientLocale: Locale | undefined;
const localeListeners = new Set<() => void>();

function getClientLocale(): Locale {
  if (clientLocale) return clientLocale;
  let storedLocale: string | null = null;
  try {
    storedLocale = window.localStorage.getItem(LOCALE_STORAGE_KEY);
  } catch {
    // Storage can be unavailable in restricted browser contexts.
  }
  clientLocale = resolveLocale(storedLocale, navigator.languages);
  return clientLocale;
}

function subscribeToLocale(listener: () => void): () => void {
  localeListeners.add(listener);
  return () => localeListeners.delete(listener);
}

export default function I18nProvider({ children }: { children: ReactNode }) {
  const locale = useSyncExternalStore(
    subscribeToLocale,
    getClientLocale,
    () => DEFAULT_LOCALE,
  );

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  useEffect(() => {
    // 语言变化(含首次加载解析出的语言)同步给守护进程; 失败静默, 不影响网页
    fetch("/setup-api/locale", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ locale }),
    }).catch(() => {});
  }, [locale]);

  const setLocale = useCallback((nextLocale: Locale) => {
    clientLocale = nextLocale;
    try {
      window.localStorage.setItem(LOCALE_STORAGE_KEY, nextLocale);
    } catch {
      // The in-memory selection still works when storage is unavailable.
    }
    localeListeners.forEach((listener) => listener());
  }, []);

  const t = useCallback(
    (key: MessageKey, values?: MessageValues) => translate(locale, key, values),
    [locale],
  );
  const translateText = useCallback(
    (message: string) => translateRuntime(locale, message),
    [locale],
  );

  const value = useMemo(
    () => ({ locale, setLocale, t, translateText }),
    [locale, setLocale, t, translateText],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const context = useContext(I18nContext);
  if (!context) throw new Error("useI18n must be used inside I18nProvider");
  return context;
}
