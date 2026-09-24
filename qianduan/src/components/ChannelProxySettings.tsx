"use client";

import { useEffect, useState } from "react";
import { useI18n } from "./I18nProvider";
import StatusMessage from "./StatusMessage";
import type { ProxyChannelId, ProxyMode } from "@/lib/channels/proxy";

const INPUT_CLASS =
  "w-full min-w-0 px-3.5 py-2.5 bg-[var(--bg-deep)] border border-gray-600 rounded-lg text-sm text-gray-200 outline-none focus:border-[var(--coral-bright)] transition-colors placeholder-gray-500";
const BUTTON_CLASS =
  "inline-flex min-h-10 items-center justify-center gap-2 rounded-lg btn-gradient px-4 py-2.5 text-center text-sm font-semibold text-white cursor-pointer disabled:cursor-not-allowed disabled:opacity-50";
const LABEL_CLASS = "mb-1.5 block text-xs font-semibold text-[var(--text-secondary)]";

interface ChannelView {
  mode: ProxyMode;
  url: string;
  effectiveMode: ProxyMode;
  effectiveProxy: string | null;
  globalEnabled: boolean;
  globalProxy: string | null;
}

interface ProxyConfigView {
  global?: { enabled?: boolean; url?: string };
}

interface Props {
  channelId?: ProxyChannelId;
  globalOnly?: boolean;
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, cache: "no-store" });
  const data = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

export default function ChannelProxySettings({ channelId, globalOnly = false }: Props) {
  const { t, translateText } = useI18n();
  const [view, setView] = useState<ChannelView | null>(null);
  const [mode, setMode] = useState<ProxyMode>("direct");
  const [channelUrl, setChannelUrl] = useState("");
  const [globalEnabled, setGlobalEnabled] = useState(false);
  const [globalUrl, setGlobalUrl] = useState("");
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<{ type: "success" | "error"; message: string } | null>(null);

  useEffect(() => {
    let active = true;
    const query = channelId ? `?channel=${encodeURIComponent(channelId)}` : "";
    void requestJson<{ config?: ProxyConfigView; channel: ChannelView | null }>(`/setup-api/proxy${query}`)
      .then((data) => {
        if (!active) return;
        setGlobalEnabled(data.config?.global?.enabled === true);
        setGlobalUrl(data.config?.global?.url || "");
        const next = data.channel;
        if (next) {
          setView(next);
          setMode(next.mode);
          setChannelUrl(next.url || "");
          setGlobalEnabled(next.globalEnabled);
          setGlobalUrl(next.globalProxy || "");
        }
      })
      .catch((error) => {
        if (active) setNotice({ type: "error", message: error instanceof Error ? translateText(error.message) : t("Failed to load proxy settings") });
      });
    return () => { active = false; };
  }, [channelId, t, translateText]);

  const save = async () => {
    setSaving(true);
    setNotice(null);
    try {
      const body = globalOnly
        ? { globalEnabled, globalUrl: globalEnabled ? globalUrl.trim() : "" }
        : { channelId, mode, channelUrl: mode === "channel" ? channelUrl.trim() : "" };
      const data = await requestJson<{ config?: ProxyConfigView; channel: ChannelView | null }>("/setup-api/proxy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (data.channel) {
        setView(data.channel);
        setMode(data.channel.mode);
        setChannelUrl(data.channel.url || "");
        setGlobalEnabled(data.channel.globalEnabled);
        setGlobalUrl(data.channel.globalProxy || "");
      }
      setGlobalEnabled(data.config?.global?.enabled === true);
      setGlobalUrl(data.config?.global?.url || "");
      setNotice({ type: "success", message: t("Proxy settings saved") });
    } catch (error) {
      setNotice({ type: "error", message: error instanceof Error ? translateText(error.message) : t("Failed to save proxy settings") });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-3 rounded-lg border border-gray-700 bg-[var(--bg-deep)] p-3">
      <div>
        <p className="text-xs font-semibold text-[var(--text-primary)]">{globalOnly ? t("Global proxy") : t("Channel proxy")}</p>
        <p className="mt-1 text-[11px] leading-relaxed text-[var(--text-muted)]">
          {globalOnly ? t("Global proxy is off by default and only applies to channels set to use it") : t("This setting affects only this channel")}
        </p>
      </div>

      {globalOnly ? (
        <>
          <label className="flex min-w-0 items-start gap-2 text-xs text-[var(--text-secondary)]">
            <input type="checkbox" checked={globalEnabled} onChange={(event) => setGlobalEnabled(event.target.checked)} className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{t("Enable global proxy")}</span>
          </label>
          {globalEnabled && (
            <div>
              <label htmlFor="global-proxy-url" className={LABEL_CLASS}>{t("Global proxy address")}</label>
              <input id="global-proxy-url" type="url" value={globalUrl} onChange={(event) => setGlobalUrl(event.target.value)} placeholder={t("Example: http://your-computer-lan-ip:7890")} className={INPUT_CLASS} autoComplete="off" spellCheck={false} />
            </div>
          )}
        </>
      ) : (
        <>
          <div>
            <label htmlFor={`${channelId}-proxy-mode`} className={LABEL_CLASS}>{t("Proxy mode")}</label>
            <select id={`${channelId}-proxy-mode`} value={mode} onChange={(event) => setMode(event.target.value as ProxyMode)} className={INPUT_CLASS}>
              <option value="direct">{t("Direct connection")}</option>
              <option value="channel">{t("Use this channel proxy")}</option>
              <option value="global">{t("Use global proxy")}</option>
            </select>
          </div>
          {mode === "channel" && (
            <div>
              <label htmlFor={`${channelId}-proxy-url`} className={LABEL_CLASS}>{t("Proxy address")}</label>
              <input id={`${channelId}-proxy-url`} type="url" value={channelUrl} onChange={(event) => setChannelUrl(event.target.value)} placeholder={t("Example: http://your-computer-lan-ip:7890")} className={INPUT_CLASS} autoComplete="off" spellCheck={false} />
              <p className="mt-1 text-[11px] leading-relaxed text-[var(--text-muted)]">{t("HTTP or HTTPS proxy URL")}</p>
            </div>
          )}
          <p className="text-[11px] leading-relaxed text-[var(--text-muted)]">
            {t("Effective proxy mode")}: {t(view?.effectiveMode === "channel" ? "Channel proxy" : view?.effectiveMode === "global" ? "Global proxy" : "Direct connection")}
          </p>
        </>
      )}

      {notice && <StatusMessage type={notice.type} message={notice.message} />}
      <button type="button" onClick={() => void save()} disabled={saving || (!globalOnly && !channelId)} className={BUTTON_CLASS}>
        {saving ? t("Saving...") : t("Save proxy settings")}
      </button>
    </div>
  );
}
