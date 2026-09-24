import type { ReactNode } from "react";
import { useI18n } from "./I18nProvider";

interface CredentialGuideProps {
  title: string;
  steps: readonly ReactNode[];
  securityNote: ReactNode;
}

export default function CredentialGuide({
  title,
  steps,
  securityNote,
}: CredentialGuideProps) {
  const { t } = useI18n();

  return (
    <details className="group min-w-0 max-w-full rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-deep)]/50">
      <summary className="min-w-0 cursor-pointer px-3 py-2.5 text-xs font-semibold leading-relaxed text-[var(--text-secondary)] marker:text-[var(--coral-bright)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--coral-bright)]">
        <span className="ml-1 break-words">{title}</span>
      </summary>
      <div className="min-w-0 border-t border-[var(--border-subtle)] px-3 py-3">
        <ol className="min-w-0 list-decimal space-y-2 pl-5 text-xs leading-relaxed text-[var(--text-muted)] [&_a]:break-all [&_a]:text-[#00e5cc] [&_a]:underline [&_code]:break-all [&_code]:font-mono [&_code]:text-[var(--text-primary)] [&_li]:min-w-0 [&_li]:break-words">
          {steps.map((step, index) => (
            <li key={index}>{step}</li>
          ))}
        </ol>
        <p className="mt-3 min-w-0 break-words border-l-2 border-amber-400/50 pl-2.5 text-xs leading-relaxed text-amber-300">
          <strong>{t("Keep credentials private:")}</strong> {securityNote}
        </p>
      </div>
    </details>
  );
}
