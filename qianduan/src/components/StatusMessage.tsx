"use client";

import { useI18n } from "./I18nProvider";
import type { LocalizedMessage } from "@/lib/i18n";

interface StatusMessageProps {
  type: "success" | "error";
  message: LocalizedMessage;
}

export default function StatusMessage({ type, message }: StatusMessageProps) {
  const { t, translateText } = useI18n();
  const renderedMessage = typeof message === "string"
    ? translateText(message)
    : t(message.key, message.values);

  return (
    <output
      aria-live={type === "error" ? "assertive" : "polite"}
      aria-atomic="true"
      className={`mt-3 px-3.5 py-2.5 rounded-lg text-xs leading-relaxed block ${
        type === "success"
          ? "bg-[#00e5cc]/10 text-[#00e5cc] border border-green-500/20"
          : "bg-red-500/10 text-red-400 border border-red-500/20"
      }`}
    >
      {renderedMessage}
    </output>
  );
}
