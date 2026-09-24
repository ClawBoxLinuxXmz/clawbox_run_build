"use client";

import Image from "next/image";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { QRCodeSVG } from "qrcode.react";
import type { MessageKey } from "@/lib/i18n";
import CredentialGuide from "./CredentialGuide";
import ChannelProxySettings from "./ChannelProxySettings";
import { useI18n } from "./I18nProvider";
import StatusMessage from "./StatusMessage";

const INPUT_CLASS =
  "w-full min-w-0 px-3.5 py-2.5 bg-[var(--bg-deep)] border border-gray-600 rounded-lg text-sm text-gray-200 outline-none focus:border-[var(--coral-bright)] transition-colors placeholder-gray-500";
const BUTTON_CLASS =
  "inline-flex min-h-10 items-center justify-center gap-2 rounded-lg btn-gradient px-4 py-2.5 text-center text-sm font-semibold text-white cursor-pointer disabled:cursor-not-allowed disabled:opacity-50";
const SECONDARY_BUTTON_CLASS =
  "inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border border-gray-600 px-4 py-2.5 text-center text-sm font-semibold text-[var(--text-secondary)] hover:border-[var(--coral-bright)] hover:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-50";
const LABEL_CLASS = "mb-1.5 block text-xs font-semibold text-[var(--text-secondary)]";

type Translate = (key: MessageKey) => string;

interface ChannelSetupExtrasProps {
  canConfigure: boolean;
  activeChannel: AdditionalChannelId | null;
  initialZaloMode?: ZaloMode;
  statusRefreshToken?: number;
  onStatusesChange?: (statuses: Partial<Record<AdditionalChannelId, AdditionalChannelStatus>>) => void;
}

export type AdditionalChannelId = "discord" | "zalo" | "zalo-clawbot" | "zalouser" | "signal";
export type ZaloMode = "bot" | "clawbot" | "personal";

export interface AdditionalChannelStatus {
  state?: string;
  configured?: boolean;
  enabled?: boolean;
  connected?: boolean;
  lastError?: string | null;
}

interface QrSession {
  sessionId: string;
  ownerToken: string;
  state: "starting" | "waiting" | "connected" | "expired" | "error" | "cancelled" | string;
  qrData: string | null;
  message: string;
  expiresAt: number;
}

interface StatusResponse {
  state?: string;
  configured?: boolean;
  enabled?: boolean;
  connected?: boolean;
  running?: boolean;
  lastError?: string | null;
  account?: string | null;
  cliPath?: string;
  proxy?: string | null;
  proxyConfigured?: boolean;
}

interface PersonalConfig extends StatusResponse {
  riskAccepted?: boolean;
}

interface ClawBotConfig extends StatusResponse {
  accountIds?: string[];
}

interface Notice {
  type: "success" | "error";
  message: string;
}

function statusText(status: StatusResponse | null, t: Translate, translateText: (message: string) => string): string {
  if (!status) return t("Not checked yet");
  if (status.state === "not_configured" || status.configured === false) {
    return t("Not configured yet");
  }
  if (status.connected === true || status.state === "connected") return t("Connected");
  if (status.state === "error") return status.lastError ? translateText(status.lastError) : t("Connection check failed");
  if (status.state === "disabled") return t("Disabled");
  if (status.configured) return t("Saved; waiting for the gateway");
  return t("Not checked yet");
}

function isTerminal(state: string): boolean {
  return ["connected", "expired", "error", "cancelled"].includes(state);
}

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, cache: "no-store" });
  const data = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

function ChannelSection({
  id,
  title,
  description,
  open,
  children,
}: {
  id: string;
  title: string;
  description: string;
  open: boolean;
  children: ReactNode;
}) {
  if (!open) return null;

  return (
    <section id={`${id}-channel-details`} aria-label={title} className="min-w-0 space-y-4">
      <p className="text-xs leading-relaxed text-[var(--text-muted)]">{description}</p>
      {children}
    </section>
  );
}

function useQrSession(startPath: string, statusPath: string, cancelPath: string) {
  const [session, setSession] = useState<QrSession | null>(null);
  const [busy, setBusy] = useState(false);
  const [starting, setStarting] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const sessionRef = useRef<QrSession | null>(null);
  const generationRef = useRef(0);

  const stopPolling = useCallback(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
  }, []);

  const updateSession = useCallback((next: QrSession | null) => {
    sessionRef.current = next;
    setSession(next);
  }, []);

  const cancel = useCallback(async () => {
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    stopPolling();
    const current = sessionRef.current;
    if (!current?.sessionId || !current.ownerToken) {
      setBusy(false);
      setStarting(false);
      return;
    }
    try {
      await requestJson<{ success: boolean }>(cancelPath, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: current.sessionId, ownerToken: current.ownerToken }),
      });
      if (generation !== generationRef.current) return;
      updateSession({
        ...current,
        state: "cancelled",
        qrData: null,
        message: "QR login cancelled.",
      });
    } catch {
      if (generation !== generationRef.current) return;
      updateSession({ ...current, state: "cancelled", qrData: null, message: "QR login cancelled." });
    } finally {
      if (generation === generationRef.current) {
        setBusy(false);
        setStarting(false);
      }
    }
  }, [cancelPath, stopPolling, updateSession]);

  const start = useCallback(async (body?: Record<string, unknown>) => {
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    stopPolling();
    const previous = sessionRef.current;
    if (previous?.sessionId && previous.ownerToken && !isTerminal(previous.state)) {
      void fetch(cancelPath, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: previous.sessionId, ownerToken: previous.ownerToken }),
        keepalive: true,
      }).catch(() => {});
    }
    if (previous) {
      updateSession({
        ...previous,
        state: "starting",
        qrData: null,
        expiresAt: 0,
        message: "Starting QR login...",
      });
    }
    setBusy(true);
    setStarting(true);
    try {
      const next = await requestJson<QrSession>(startPath, {
        method: "POST",
        ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
      });
      if (generation !== generationRef.current) return;
      setStarting(false);
      updateSession(next);
      timerRef.current = setInterval(async () => {
        try {
          const polled = await requestJson<QrSession>(statusPath, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ sessionId: next.sessionId, ownerToken: next.ownerToken }),
          });
          if (generation !== generationRef.current) return;
          updateSession(polled);
          if (isTerminal(polled.state)) {
            stopPolling();
            setBusy(false);
          }
        } catch (error) {
          if (generation !== generationRef.current) return;
          stopPolling();
          updateSession({ ...next, state: "error", message: errorText(error, "QR status check failed.") });
          setBusy(false);
        }
      }, 1_500);
    } catch (error) {
      if (generation !== generationRef.current) return;
      setStarting(false);
      updateSession({ sessionId: "", ownerToken: "", state: "error", qrData: null, expiresAt: 0, message: errorText(error, "Failed to start QR login.") });
      setBusy(false);
    }
  }, [cancelPath, startPath, statusPath, stopPolling, updateSession]);

  useEffect(() => () => {
    generationRef.current += 1;
    stopPolling();
  }, [stopPolling]);
  return { session, busy, starting, start, cancel };
}

function QrPanel({
  session,
  image,
  t,
  translateText,
  onCancel,
  onRefresh,
  refreshing = false,
}: {
  session: QrSession | null;
  image: boolean;
  t: Translate;
  translateText: (message: string) => string;
  onCancel: () => void;
  onRefresh?: () => void;
  refreshing?: boolean;
}) {
  if (!session) return null;
  const value = session.qrData;
  const isDataUrl = value?.startsWith("data:image/") === true;
  const isWaiting = session.state === "starting" || session.state === "waiting";
  const canRefresh = session.state !== "connected" && onRefresh !== undefined;
  return (
    <div className="min-w-0 space-y-3 rounded-lg border border-gray-700 bg-[var(--bg-deep)] p-3">
      {value && (
        <div className="flex min-h-[248px] w-full items-center justify-center rounded-lg bg-white p-3">
          {image || isDataUrl ? (
            <Image src={value} alt={t("QR code for channel login")} width={224} height={224} unoptimized className="h-56 w-56 max-w-full object-contain" />
          ) : (
            <QRCodeSVG
              value={value}
              size={224}
              level="M"
              role="img"
              aria-label={t("QR code for channel login")}
              className="h-56 w-56 max-w-full"
            />
          )}
        </div>
      )}
      <p className={`break-words text-xs leading-relaxed ${session.state === "error" ? "text-red-300" : session.state === "connected" ? "font-semibold text-[#00e5cc]" : "text-[var(--text-secondary)]"}`}>
        {translateText(session.message)}
      </p>
      {value && !isDataUrl && (
        <a href={value} target="_blank" rel="noopener noreferrer" className="block break-all text-xs text-[#00e5cc] underline">
          {t("Open the login link if your phone cannot scan this QR")}
        </a>
      )}
      {(isWaiting || canRefresh) && (
        <div className="flex flex-wrap gap-2">
          {canRefresh && (
            <button
              type="button"
              onClick={onRefresh}
              disabled={refreshing}
              className={`${SECONDARY_BUTTON_CLASS} w-full sm:w-auto`}
            >
              {refreshing ? t("Refreshing...") : t("Refresh QR")}
            </button>
          )}
          {isWaiting && (
            <button type="button" onClick={onCancel} disabled={refreshing} className={`${SECONDARY_BUTTON_CLASS} w-full sm:w-auto`}>
              {t("Cancel")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export default function ChannelSetupExtras({ canConfigure, activeChannel, initialZaloMode = "bot", statusRefreshToken = 0, onStatusesChange }: ChannelSetupExtrasProps) {
  const { t, locale, translateText } = useI18n();
  const [discordToken, setDiscordToken] = useState("");
  const [discordServerId, setDiscordServerId] = useState("");
  const [discordUserId, setDiscordUserId] = useState("");
  const [discordStatus, setDiscordStatus] = useState<StatusResponse | null>(null);
  const [discordNotice, setDiscordNotice] = useState<Notice | null>(null);
  const [discordBusy, setDiscordBusy] = useState(false);
  const [zaloToken, setZaloToken] = useState("");
  const [zaloStatus, setZaloStatus] = useState<StatusResponse | null>(null);
  const [zaloNotice, setZaloNotice] = useState<Notice | null>(null);
  const [zaloBusy, setZaloBusy] = useState(false);
  const [personalConfig, setPersonalConfig] = useState<PersonalConfig | null>(null);
  const [personalRisk, setPersonalRisk] = useState(false);
  const [personalRiskSaved, setPersonalRiskSaved] = useState(false);
  const [personalNotice, setPersonalNotice] = useState<Notice | null>(null);
  const [personalStatus, setPersonalStatus] = useState<StatusResponse | null>(null);
  const [signalAccount, setSignalAccount] = useState("");
  const [signalCliPath, setSignalCliPath] = useState("signal-cli");
  const [signalStatus, setSignalStatus] = useState<StatusResponse | null>(null);
  const [signalNotice, setSignalNotice] = useState<Notice | null>(null);
  const [signalBusy, setSignalBusy] = useState(false);
  const [clawbotConfig, setClawbotConfig] = useState<ClawBotConfig | null>(null);
  const [clawbotStatus, setClawbotStatus] = useState<StatusResponse | null>(null);
  const [clawbotNotice, setClawbotNotice] = useState<Notice | null>(null);
  const [zaloMode, setZaloMode] = useState<ZaloMode>(initialZaloMode);
  const zaloModeInitializedRef = useRef(initialZaloMode !== "bot");
  const clawbotQr = useQrSession("/setup-api/channels/zalo-clawbot", "/setup-api/channels/zalo-clawbot/login-status", "/setup-api/channels/zalo-clawbot/cancel");
  const personalQr = useQrSession("/setup-api/channels/zalouser/qrcode", "/setup-api/channels/zalouser/login-status", "/setup-api/channels/zalouser/cancel");
  const signalQr = useQrSession("/setup-api/channels/signal/qrcode", "/setup-api/channels/signal/login-status", "/setup-api/channels/signal/cancel");

  const refreshStatus = useCallback(async (path: string, setter: (value: StatusResponse) => void) => {
    try {
      setter(await requestJson<StatusResponse>(path, { method: "GET" }));
    } catch (error) {
      setter({ state: "error", connected: false, lastError: errorText(error, "Status check failed.") });
    }
  }, []);

  const loadPersonal = useCallback(async (force = false) => {
    try {
      const data = await requestJson<PersonalConfig>("/setup-api/channels/zalouser", { method: "GET" });
      setPersonalConfig(data);
      setPersonalRisk(data.riskAccepted === true);
      setPersonalRiskSaved(data.riskAccepted === true);
    } catch {
      // The section remains usable; the API will return an actionable error on save.
    }
    try {
      setPersonalStatus(await requestJson<StatusResponse>(`/setup-api/channels/zalouser/status${force ? "?force=1" : ""}`, { method: "GET" }));
    } catch (error) {
      setPersonalStatus({ state: "error", connected: false, lastError: errorText(error, "Status check failed.") });
    }
  }, []);

  const loadZalo = useCallback(async (force = false) => {
    try {
      const data = await requestJson<StatusResponse>(`/setup-api/channels/zalo/status${force ? "?force=1" : ""}`, { method: "GET" });
      setZaloStatus(data);
    } catch (error) {
      setZaloStatus({ state: "error", connected: false, lastError: errorText(error, "Status check failed.") });
    }
  }, []);

  const loadClawbot = useCallback(async (force = false) => {
    try {
      setClawbotConfig(await requestJson<ClawBotConfig>("/setup-api/channels/zalo-clawbot", { method: "GET" }));
    } catch {
      // The first QR action will surface plugin installation errors inline.
    }
    try {
      setClawbotStatus(await requestJson<StatusResponse>(`/setup-api/channels/zalo-clawbot/status${force ? "?force=1" : ""}`, { method: "GET" }));
    } catch (error) {
      setClawbotStatus({ state: "error", connected: false, lastError: errorText(error, "Status check failed.") });
    }
  }, []);

  const loadSignal = useCallback(async (force = false) => {
    try {
      const data = await requestJson<StatusResponse>(`/setup-api/channels/signal/status${force ? "?force=1" : ""}`, { method: "GET" });
      setSignalStatus(data);
      if (data.account) setSignalAccount(data.account);
      if (data.cliPath) setSignalCliPath(data.cliPath);
    } catch (error) {
      setSignalStatus({ state: "error", connected: false, lastError: errorText(error, "Status check failed.") });
    }
  }, []);

  useEffect(() => {
    if (!canConfigure) return;
    void refreshStatus("/setup-api/channels/discord/status", setDiscordStatus);
    void loadZalo();
    void loadSignal();
    void loadPersonal();
    void loadClawbot();
  }, [canConfigure, loadClawbot, loadPersonal, loadSignal, loadZalo, refreshStatus]);

  useEffect(() => {
    if (!canConfigure || statusRefreshToken === 0) return;
    void refreshStatus("/setup-api/channels/discord/status?force=1", setDiscordStatus);
    void loadZalo(true);
    void loadSignal(true);
    void loadPersonal(true);
    void loadClawbot(true);
  }, [canConfigure, loadClawbot, loadPersonal, loadSignal, loadZalo, refreshStatus, statusRefreshToken]);

  useEffect(() => {
    if (clawbotQr.session?.state === "connected") void loadClawbot(true);
  }, [clawbotQr.session?.state, loadClawbot]);

  useEffect(() => {
    if (personalQr.session?.state === "connected") void loadPersonal(true);
  }, [loadPersonal, personalQr.session?.state]);

  useEffect(() => {
    if (signalQr.session?.state === "connected") void loadSignal(true);
  }, [loadSignal, signalQr.session?.state]);

  useEffect(() => {
    onStatusesChange?.({
      discord: discordStatus || undefined,
      zalo: zaloStatus || undefined,
      "zalo-clawbot": clawbotStatus || undefined,
      zalouser: personalStatus || undefined,
      signal: signalStatus || undefined,
    });
  }, [clawbotStatus, discordStatus, onStatusesChange, personalStatus, signalStatus, zaloStatus]);

  useEffect(() => {
    if (zaloModeInitializedRef.current) return;
    const savedMode: ZaloMode | null = zaloStatus?.configured
      ? "bot"
      : clawbotConfig?.configured
        ? "clawbot"
        : personalConfig?.configured
          ? "personal"
          : null;
    if (!savedMode) return;
    setZaloMode(savedMode);
    zaloModeInitializedRef.current = true;
  }, [clawbotConfig?.configured, personalConfig?.configured, zaloStatus?.configured]);

  const saveDiscord = async () => {
    setDiscordBusy(true);
    setDiscordNotice(null);
    try {
      await requestJson("/setup-api/channels/discord", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: discordToken.trim() || undefined, serverId: discordServerId.trim() || undefined, userId: discordUserId.trim() || undefined, enabled: true }) });
      setDiscordToken("");
      setDiscordNotice({ type: "success", message: t("Discord settings saved. Check status for live gateway evidence") });
      await refreshStatus("/setup-api/channels/discord/status", setDiscordStatus);
    } catch (error) {
      setDiscordNotice({ type: "error", message: errorText(error, "Failed to save Discord config.") });
    } finally {
      setDiscordBusy(false);
    }
  };

  const saveZalo = async () => {
    setZaloBusy(true);
    setZaloNotice(null);
    try {
      await requestJson("/setup-api/channels/zalo", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ botToken: zaloToken.trim() || undefined, enabled: true }) });
      setZaloToken("");
      setZaloNotice({ type: "success", message: t("Zalo Bot settings saved. Check status for live gateway evidence") });
      await loadZalo();
    } catch (error) {
      setZaloNotice({ type: "error", message: errorText(error, "Failed to save Zalo config.") });
    } finally {
      setZaloBusy(false);
    }
  };

  const savePersonal = async () => {
    setPersonalNotice(null);
    try {
      const data = await requestJson<PersonalConfig>("/setup-api/channels/zalouser", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: personalConfig?.configured === true, riskAccepted: personalRisk }) });
      setPersonalConfig(data);
      setPersonalRiskSaved(true);
      setPersonalNotice({ type: "success", message: t("Zalo Personal settings saved. You can now start QR login") });
    } catch (error) {
      setPersonalNotice({ type: "error", message: errorText(error, "Failed to save Zalo Personal settings.") });
    }
  };

  const saveSignal = async () => {
    setSignalBusy(true);
    setSignalNotice(null);
    try {
      const data = await requestJson<StatusResponse>("/setup-api/channels/signal", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ account: signalAccount.trim(), cliPath: signalCliPath.trim() || "signal-cli", enabled: true }) });
      setSignalStatus(data);
      setSignalNotice({ type: "success", message: t("Signal settings saved. Link the device with QR, then check status") });
    } catch (error) {
      setSignalNotice({ type: "error", message: errorText(error, "Failed to save Signal settings.") });
    } finally {
      setSignalBusy(false);
    }
  };

  const disableClawbot = async () => {
    setClawbotNotice(null);
    try {
      await requestJson("/setup-api/channels/zalo-clawbot", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: false }),
      });
      await loadClawbot(true);
      setClawbotNotice({ type: "success", message: "Zalo ClawBot disabled. Saved account credentials were retained." });
    } catch (error) {
      setClawbotNotice({ type: "error", message: errorText(error, "Failed to disable Zalo ClawBot.") });
    }
  };

  const guide = (title: string, steps: readonly ReactNode[]) => (
    <CredentialGuide
      title={title}
      steps={steps}
      securityNote={locale === "zh-CN" ? "Token、二维码链接和本地会话文件都属于敏感凭据。" : "Tokens, QR links, and local session files are sensitive credentials."}
    />
  );

  const isZaloActive = activeChannel === "zalo" || activeChannel === "zalo-clawbot" || activeChannel === "zalouser";

  if (!canConfigure) {
    return <div className="rounded-xl border border-amber-500/20 bg-amber-500/10 px-4 py-3 text-xs leading-relaxed text-amber-300">{t("Configure your AI provider first. These channel setup tools unlock after AI credentials are saved")}</div>;
  }

  return (
    <div className="min-w-0 space-y-3">
      <ChannelSection id="discord" title="Discord" description={t("Discord uses a Bot Token and Developer Mode IDs; it does not use a QR login")} open={activeChannel === "discord"}>
        {guide(t("How to create a Discord bot and find its IDs"), locale === "zh-CN" ? [
          <>打开 <a href="https://discord.com/developers/applications" target="_blank" rel="noreferrer" className="text-[#00e5cc] underline">Discord Developer Portal</a>，点击 New Application → Bot。</>,
          <>在 Bot 页面点击 Reset Token，复制完整 Bot Token。Token 只显示一次，丢失后需要重新生成。</>,
          <>打开 Message Content Intent；需要成员或角色白名单时，再打开 Server Members Intent。</>,
          <>在 OAuth2 → URL Generator 勾选 bot 和 applications.commands，生成邀请链接并把机器人加入服务器。</>,
          <>在 Discord 客户端打开 User Settings → Advanced → Developer Mode，右键服务器复制 Server ID，右键自己的头像复制 User ID。</>,
          <>也可以先阅读 <a href="https://docs.openclaw.ai/channels/discord" target="_blank" rel="noreferrer" className="text-[#00e5cc] underline">OpenClaw Discord 通道文档</a>。</>,
        ] : [
          <>Open the <a href="https://discord.com/developers/applications" target="_blank" rel="noreferrer" className="text-[#00e5cc] underline">Discord Developer Portal</a> and choose New Application → Bot.</>,
          <>On Bot, choose Reset Token and copy the complete Bot Token. Treat it like a password.</>,
          <>Enable Message Content Intent; enable Server Members Intent when you need member or role allowlists.</>,
          <>In OAuth2 → URL Generator, select bot and applications.commands, generate the invite URL, and add the bot to your server.</>,
          <>In Discord, enable Developer Mode, then copy Server ID and your own User ID from the context menus.</>,
          <>See the <a href="https://docs.openclaw.ai/channels/discord" target="_blank" rel="noreferrer" className="text-[#00e5cc] underline">OpenClaw Discord channel docs</a> for the runtime policy.</>,
        ])}
        <div className="space-y-3">
          <div><label htmlFor="extra-discord-token" className={LABEL_CLASS}>{t("Discord Bot Token")}</label><input id="extra-discord-token" aria-label={t("Discord Bot Token")} type="password" value={discordToken} onChange={(event) => setDiscordToken(event.target.value)} placeholder={t("Paste Discord Bot Token")} autoComplete="off" spellCheck={false} className={INPUT_CLASS} /></div>
          <div><label htmlFor="extra-discord-server" className={LABEL_CLASS}>{t("Discord Server ID")}</label><input id="extra-discord-server" aria-label={t("Discord Server ID")} inputMode="numeric" value={discordServerId} onChange={(event) => setDiscordServerId(event.target.value)} placeholder={t("Server ID (optional for DMs)")} className={INPUT_CLASS} /></div>
          <div><label htmlFor="extra-discord-user" className={LABEL_CLASS}>{t("Discord User ID")}</label><input id="extra-discord-user" aria-label={t("Discord User ID")} inputMode="numeric" value={discordUserId} onChange={(event) => setDiscordUserId(event.target.value)} placeholder={t("Your User ID (recommended)")} className={INPUT_CLASS} /></div>
          <ChannelProxySettings channelId="discord" />
          {discordNotice && <StatusMessage type={discordNotice.type} message={discordNotice.message} />}
          <div className="flex flex-wrap gap-2"><button type="button" disabled={discordBusy || (!discordToken.trim() && discordStatus?.configured !== true)} onClick={() => void saveDiscord()} className={BUTTON_CLASS}>{discordBusy ? t("Saving...") : t("Save Discord settings")}</button><button type="button" onClick={() => void refreshStatus("/setup-api/channels/discord/status?force=1", setDiscordStatus)} className={SECONDARY_BUTTON_CLASS}>{t("Check live status")}</button></div>
          <p className="break-words text-xs text-[var(--text-muted)]">{statusText(discordStatus, t, translateText)}</p>
        </div>
      </ChannelSection>

      <ChannelSection id="zalo" title="Zalo" description={t("Use one of three Zalo connection modes: official Bot, official ClawBot, or personal-account QR login")} open={isZaloActive}>
        <div className="space-y-4">
          <div>
            <p className="mb-2 text-xs font-semibold text-[var(--text-secondary)]">{t("Choose a Zalo connection mode")}</p>
            <div role="tablist" aria-label={t("Zalo connection mode")} className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              {([
                { id: "bot" as const, title: "Official Bot", description: "Use a Bot Token from Zalo Bot Platform", status: statusText(zaloStatus, t, translateText) },
                { id: "clawbot" as const, title: "Official ClawBot", description: "Create an owner-bound bot with the official QR flow", status: statusText(clawbotConfig, t, translateText) },
                { id: "personal" as const, title: "Personal account", description: "Link a personal account by QR with an explicit risk acknowledgement", status: statusText(personalConfig, t, translateText) },
              ]).map((mode) => {
                const selected = zaloMode === mode.id;
                return (
                  <button
                    key={mode.id}
                    type="button"
                    role="tab"
                    aria-selected={selected}
                    aria-controls={`zalo-${mode.id}-setup`}
                    onClick={() => setZaloMode(mode.id)}
                    className={`min-w-0 rounded-lg border px-3 py-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--coral-bright)] ${selected ? "border-[var(--coral-bright)] bg-[var(--coral-bright)]/10" : "border-gray-700 bg-[var(--bg-deep)] hover:border-gray-500"}`}
                  >
                    <span className="block text-sm font-semibold text-[var(--text-primary)]">{t(mode.title)}</span>
                    <span className="mt-1 block break-words text-xs leading-relaxed text-[var(--text-muted)]">{t(mode.description)}</span>
                    <span className={`mt-2 block break-words text-[11px] leading-relaxed ${selected ? "text-[var(--coral-bright)]" : "text-[var(--text-muted)]"}`}>{mode.status}</span>
                  </button>
                );
              })}
            </div>
            <p className="mt-2 text-[11px] leading-relaxed text-[var(--text-muted)]">{t("Configure one mode for normal use. Existing configurations for other modes are preserved and can be reviewed from this same Zalo panel")}</p>
          </div>

          {zaloMode === "bot" && (
            <div id="zalo-bot-setup" role="tabpanel" aria-label={t("Official Bot")} className="space-y-3">
        {guide(t("How to create a Zalo Bot and get its token"), locale === "zh-CN" ? [
          <>打开 <a href="https://bot.zaloplatforms.com" target="_blank" rel="noreferrer" className="text-[#00e5cc] underline">Zalo Bot Platform</a> 并登录。</>,
          <>创建 Bot，完成 Bot 设置后复制完整 Bot Token，通常形如 <code>numeric_id:secret</code>。</>,
          <>把 Token 粘贴到这里保存。默认使用长轮询，不需要公网 Webhook；首次私聊会收到配对码。</>,
          <>如果 Token 泄露，请回到 Zalo Bot Platform 重新生成，不要把它发到聊天或提交到 GitHub。</>,
          <>协议和配置字段可对照 <a href="https://docs.openclaw.ai/channels/zalo" target="_blank" rel="noreferrer" className="text-[#00e5cc] underline">OpenClaw Zalo Bot 文档</a>。</>,
        ] : [
          <>Open <a href="https://bot.zaloplatforms.com" target="_blank" rel="noreferrer" className="text-[#00e5cc] underline">Zalo Bot Platform</a> and sign in.</>,
          <>Create a bot, finish its settings, and copy the complete Bot Token, usually shaped like <code>numeric_id:secret</code>.</>,
          <>Paste it here and save. The default is long polling, so no public webhook is required; the first DM uses pairing.</>,
          <>If the token is exposed, rotate it in Zalo Bot Platform instead of sharing it in chat or GitHub.</>,
          <>Use the <a href="https://docs.openclaw.ai/channels/zalo" target="_blank" rel="noreferrer" className="text-[#00e5cc] underline">OpenClaw Zalo Bot docs</a> to verify the account schema.</>,
        ])}
        <div className="space-y-3">
          <div><label htmlFor="extra-zalo-token" className={LABEL_CLASS}>{t("Zalo Bot Token")}</label><input id="extra-zalo-token" aria-label={t("Zalo Bot Token")} type="password" value={zaloToken} onChange={(event) => setZaloToken(event.target.value)} placeholder={t("Paste Zalo Bot Token")} autoComplete="off" spellCheck={false} className={INPUT_CLASS} /></div>
          <ChannelProxySettings channelId="zalo" />
          {zaloNotice && <StatusMessage type={zaloNotice.type} message={zaloNotice.message} />}
          <div className="flex flex-wrap gap-2"><button type="button" disabled={zaloBusy || (!zaloToken.trim() && zaloStatus?.configured !== true)} onClick={() => void saveZalo()} className={BUTTON_CLASS}>{zaloBusy ? t("Saving...") : t("Save Zalo Bot settings")}</button><button type="button" onClick={() => void refreshStatus("/setup-api/channels/zalo/status?force=1", setZaloStatus)} className={SECONDARY_BUTTON_CLASS}>{t("Check live status")}</button></div>
          <p className="break-words text-xs text-[var(--text-muted)]">{statusText(zaloStatus, t, translateText)}</p>
        </div>
            </div>
          )}

          {zaloMode === "clawbot" && (
            <div id="zalo-clawbot-setup" role="tabpanel" aria-label={t("Official ClawBot")} className="space-y-3">
        {guide(t("How Zalo ClawBot QR login works"), locale === "zh-CN" ? [
          <>二维码直接从 Zalo 登录服务获取，扫码确认后 ClawBox 才会准备外部插件 <code>@zalo-platforms/openclaw-zaloclawbot@0.1.4</code>，减少等待时间。</>,
          <>使用手机 Zalo 扫描二维码，在 Mini App 中接受条款并授权；如果二维码无法识别，也可以打开页面给出的登录链接。</>,
          <>登录会话约 5 分钟有效。扫码期间保持此页面打开；过期后点击取消或重新生成。</>,
          <>登录成功后，插件会把 Bot 凭据保存到 OpenClaw 状态目录，并自动启用 owner-bound 通道。</>,
          <>详细流程见 <a href="https://docs.openclaw.ai/zh-CN/channels/zaloclawbot" target="_blank" rel="noreferrer" className="text-[#00e5cc] underline">OpenClaw Zalo ClawBot 文档</a>。</>,
        ] : [
          <>The QR is requested directly from Zalo first. After confirmation, ClawBox prepares the pinned plugin <code>@zalo-platforms/openclaw-zaloclawbot@0.1.4</code> if needed.</>,
          <>Scan the QR with the Zalo mobile app, accept the Mini App terms, and authorize the session. A fallback login URL is shown if the QR cannot be scanned.</>,
          <>The login session lasts about 5 minutes. Keep this page open and generate a new code if it expires.</>,
          <>After confirmation, the plugin stores the Bot credentials in the OpenClaw state directory and enables the owner-bound channel.</>,
          <>See the <a href="https://docs.openclaw.ai/zh-CN/channels/zaloclawbot" target="_blank" rel="noreferrer" className="text-[#00e5cc] underline">OpenClaw Zalo ClawBot docs</a> for the source-backed flow.</>,
        ])}
        <ChannelProxySettings channelId="openclaw-zaloclawbot" />
        {clawbotNotice && <StatusMessage type={clawbotNotice.type} message={clawbotNotice.message} />}
        <QrPanel session={clawbotQr.session} image={false} t={t} translateText={translateText} onCancel={() => void clawbotQr.cancel()} onRefresh={() => void clawbotQr.start()} refreshing={clawbotQr.starting} />
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => { setClawbotNotice(null); void clawbotQr.start(); }} disabled={clawbotQr.busy} className={BUTTON_CLASS}>{clawbotQr.busy ? t("Waiting for QR confirmation...") : t("Generate Zalo ClawBot QR")}</button>
          <button type="button" onClick={() => void loadClawbot(true)} className={SECONDARY_BUTTON_CLASS}>{t("Check live status")}</button>
          {clawbotStatus?.configured === true && clawbotStatus.enabled !== false && <button type="button" onClick={() => void disableClawbot()} className={SECONDARY_BUTTON_CLASS}>{t("Disable Zalo ClawBot")}</button>}
        </div>
        <p className="break-words text-xs text-[var(--text-muted)]">{statusText(clawbotStatus, t, translateText)}</p>
            </div>
          )}

          {zaloMode === "personal" && (
            <div id="zalo-personal-setup" role="tabpanel" aria-label={t("Personal account")} className="space-y-3">
        <p className="text-xs leading-relaxed text-[var(--text-muted)]">{t("Unofficial personal-account automation. It may trigger account restrictions or a ban")}</p>
        {guide(t("Before using Zalo Personal QR login"), locale === "zh-CN" ? [
          <>这是基于 OpenClaw 内置 <code>zca-js</code> 的非官方个人账号自动化，不是 Zalo Bot Platform 官方 Bot API。</>,
          <>使用前请确认你接受账号受限或封禁风险；建议不要使用主工作账号。</>,
          <>勾选风险确认并点击保存后，再生成二维码，在 Zalo 手机 App 中扫码。</>,
          <>二维码登录成功后，OpenClaw 会把会话凭据保存到其状态目录；请备份并限制该目录权限。</>,
          <>官方说明见 <a href="https://docs.openclaw.ai/channels/zalouser" target="_blank" rel="noreferrer" className="text-[#00e5cc] underline">OpenClaw Zalo Personal 文档</a>。</>,
        ] : [
          <>This is unofficial personal-account automation based on OpenClaw&apos;s bundled <code>zca-js</code>, not the official Zalo Bot Platform API.</>,
          <>Accept the possibility of restrictions or a ban first; a disposable or dedicated account is safer than a primary work account.</>,
          <>Save the risk acknowledgement, then generate a QR and scan it in the Zalo mobile app.</>,
          <>After login, OpenClaw stores the session credentials in its state directory. Protect and back up that directory.</>,
          <>Read the <a href="https://docs.openclaw.ai/channels/zalouser" target="_blank" rel="noreferrer" className="text-[#00e5cc] underline">OpenClaw Zalo Personal docs</a> before enabling this experimental channel.</>,
        ])}
        <label className="flex min-w-0 items-start gap-2 text-xs leading-relaxed text-[var(--text-secondary)]">
          <input type="checkbox" checked={personalRisk} onChange={(event) => { setPersonalRisk(event.target.checked); setPersonalRiskSaved(false); }} className="mt-0.5 h-4 w-4 shrink-0" />
          <span className="break-words">{t("I understand the unofficial Zalo Personal account risk")}</span>
        </label>
        <ChannelProxySettings channelId="zalouser" />
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => void savePersonal()} disabled={!personalRisk || personalRiskSaved} className={SECONDARY_BUTTON_CLASS}>{personalRiskSaved ? t("Saved; waiting for the gateway") : t("Save risk acknowledgement")}</button>
          <button type="button" onClick={() => { setPersonalNotice(null); void personalQr.start(); }} disabled={!personalRisk || !personalRiskSaved || personalQr.busy} className={BUTTON_CLASS}>{personalQr.busy ? t("Waiting for QR confirmation...") : t("Generate Zalo Personal QR")}</button>
          <button type="button" onClick={() => void loadPersonal(true)} className={SECONDARY_BUTTON_CLASS}>{t("Check live status")}</button>
        </div>
        {personalNotice && <StatusMessage type={personalNotice.type} message={personalNotice.message} />}
        <QrPanel session={personalQr.session} image={true} t={t} translateText={translateText} onCancel={() => void personalQr.cancel()} onRefresh={() => void personalQr.start()} refreshing={personalQr.starting} />
        <p className="break-words text-xs text-[var(--text-muted)]">{statusText(personalStatus, t, translateText)}</p>
            </div>
          )}
        </div>
      </ChannelSection>

      <ChannelSection id="signal" title="Signal" description={t("Signal uses the external signal-cli daemon. QR login links an existing Signal device")} open={activeChannel === "signal"}>
        {guide(t("How to link Signal with a QR code"), locale === "zh-CN" ? [
          <>在运行 OpenClaw 的设备上安装最新 <code>signal-cli</code>；请按 <a href="https://github.com/AsamK/signal-cli" target="_blank" rel="noreferrer" className="text-[#00e5cc] underline">signal-cli 官方仓库</a> 的架构和 Java 要求安装，不要在页面后台静默安装。</>,
          <>建议使用单独的 Signal 机器人号码。把个人号码作为机器人时，Signal 的回环保护可能忽略你自己的消息。</>,
          <>输入可执行文件路径后直接点击生成二维码。扫码成功时页面会从 signal-cli 的 <code>Associated with: +...</code> 输出自动保存号码。</>,
          <>在手机 Signal 中打开 Settings → Linked devices，扫描页面上的 <code>sgnl://linkdevice</code> 二维码并等待确认。</>,
          <>扫码完成后保持 Gateway 使用相同的服务用户和 HOME；密钥通常位于 <code>~/.local/share/signal-cli/data/</code>。</>,
          <>更多配置说明见 <a href="https://docs.openclaw.ai/channels/signal" target="_blank" rel="noreferrer" className="text-[#00e5cc] underline">OpenClaw Signal 文档</a>。</>,
        ] : [
          <>Install the latest <code>signal-cli</code> on the OpenClaw host. Follow the <a href="https://github.com/AsamK/signal-cli" target="_blank" rel="noreferrer" className="text-[#00e5cc] underline">official signal-cli repository</a> for your architecture and Java runtime; the page does not install it silently.</>,
          <>Use a separate Signal bot number when possible. Signal loop protection can ignore messages you send from the same personal account.</>,
          <>Enter the executable path and click Generate QR. After scanning, the page saves the number reported by signal-cli&apos;s <code>Associated with: +...</code> output.</>,
          <>In Signal mobile, open Settings → Linked devices and scan the <code>sgnl://linkdevice</code> QR code.</>,
          <>Keep the Gateway on the same service user and HOME after linking; keys normally live under <code>~/.local/share/signal-cli/data/</code>.</>,
          <>See the <a href="https://docs.openclaw.ai/channels/signal" target="_blank" rel="noreferrer" className="text-[#00e5cc] underline">OpenClaw Signal docs</a> for daemon and account policy details.</>,
        ])}
        <div className="space-y-3">
          <div><label htmlFor="extra-signal-account" className={LABEL_CLASS}>{t("Signal bot number")}</label><input id="extra-signal-account" aria-label={t("Signal bot number")} value={signalAccount} onChange={(event) => setSignalAccount(event.target.value)} placeholder={t("Signal bot number in E.164 format")} className={INPUT_CLASS} /><p className="mt-1 text-[11px] leading-relaxed text-[var(--text-muted)]">{locale === "zh-CN" ? "扫码关联时可以留空；成功后会自动填入号码。" : "You can leave this blank for QR linking; the linked number is filled in automatically."}</p></div>
          <div><label htmlFor="extra-signal-cli" className={LABEL_CLASS}>{t("signal-cli path")}</label><input id="extra-signal-cli" aria-label={t("signal-cli path")} value={signalCliPath} onChange={(event) => setSignalCliPath(event.target.value)} placeholder="signal-cli" autoComplete="off" spellCheck={false} className={INPUT_CLASS} /></div>
          <ChannelProxySettings channelId="signal" />
          {signalNotice && <StatusMessage type={signalNotice.type} message={signalNotice.message} />}
          <div className="flex flex-wrap gap-2"><button type="button" onClick={() => void saveSignal()} disabled={signalBusy || !signalAccount.trim()} className={SECONDARY_BUTTON_CLASS}>{signalBusy ? t("Saving...") : t("Save Signal settings")}</button><button type="button" onClick={() => { setSignalNotice(null); void signalQr.start({ cliPath: signalCliPath.trim() || "signal-cli" }); }} disabled={signalQr.busy} className={BUTTON_CLASS}>{signalQr.busy ? t("Waiting for QR confirmation...") : t("Generate Signal linking QR")}</button><button type="button" onClick={() => void loadSignal(true)} className={SECONDARY_BUTTON_CLASS}>{t("Check live status")}</button></div>
          <QrPanel session={signalQr.session} image={false} t={t} translateText={translateText} onCancel={() => void signalQr.cancel()} onRefresh={() => void signalQr.start({ cliPath: signalCliPath.trim() || "signal-cli" })} refreshing={signalQr.starting} />
          <p className="break-words text-xs text-[var(--text-muted)]">{statusText(signalStatus, t, translateText)}</p>
        </div>
      </ChannelSection>
    </div>
  );
}
