"use client";

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import Link from "next/link";
import Image from "next/image";
import { QRCodeSVG } from "qrcode.react";
import type { StepStatus, UpdateState } from "@/lib/updater";
import CredentialGuide from "./CredentialGuide";
import StatusMessage from "./StatusMessage";
import { useI18n } from "./I18nProvider";
import ChannelSetupExtras, { type AdditionalChannelId, type AdditionalChannelStatus, type ZaloMode } from "./ChannelSetupExtras";
import ChannelProxySettings from "./ChannelProxySettings";
import type { LocalizedMessage } from "@/lib/i18n";

import { parseAuthInput, tryCloseOAuthWindow } from "@/lib/oauth-utils";

/* ── Types ── */

interface SystemInfo {
  hostname: string;
  cpus: number;
  memoryTotal: string;
  memoryFree: string;
  memoryUsedPercent: number;
  cpuLoadPercent: number;
  temperature: string;
  temperatureValue: number | null;
  uptime: string;
  diskUsed: string;
  diskFree: string;
  diskTotal: string;
  diskUsedPercent: number;
  gpuLoadPercent: number;
  networkIp: string;
  networkInterface: string;
  networkRxBytes: number;
  networkTxBytes: number;
  mdnsHost: string;
  accessUrl: string;
  localDnsAlias: string | null;
  mdnsReady: boolean;
}

interface SetupStatusResponse {
  setup_complete: boolean;
  password_configured: boolean;
  wifi_configured: boolean;
  ai_model_configured: boolean;
  ai_model_provider?: string;
  wifi_connecting?: boolean;
  wifi_target_ssid?: string | null;
  wifi_last_error?: string | null;
  ai_model_last_error?: string | null;
}

interface StatsSnapshot {
  cpu: number;
  gpu: number;
  memory: number;
  temp: number | null;
  rxBytes: number;
  txBytes: number;
  time: number;
}


interface DoneStepProps {
  setupComplete?: boolean;
}

interface SectionStatusMessage {
  type: "success" | "error";
  message: LocalizedMessage;
}

interface TelegramConfigResponse {
  configured: boolean;
  enabled: boolean;
  hasToken: boolean;
  lastError?: string | null;
}

interface TelegramStatusResponse extends TelegramConfigResponse {
  state: "not_configured" | "disabled" | "configured" | "connected" | "error";
  connected: boolean;
  running: boolean;
  probeOk: boolean | null;
  botId: string | null;
  botUsername: string | null;
  lastError: string | null;
}

interface TelegramPairingRequest {
  code: string;
  senderId: string;
  createdAt: string;
  displayName: string | null;
}

interface FeishuConfigResponse {
  configured: boolean;
  enabled: boolean;
  hasAppSecret: boolean;
  appId: string | null;
  domain: "feishu" | "lark";
  lastError?: string | null;
}

interface FeishuStatusResponse extends FeishuConfigResponse {
  state: "not_configured" | "disabled" | "configured" | "connected" | "error";
  connected: boolean;
  botName: string | null;
  lastError: string | null;
}

interface FeishuPairingRequest {
  code: string;
  senderId: string;
  createdAt: string;
  displayName: string | null;
}

interface QQBotConfigResponse {
  configured: boolean;
  enabled: boolean;
  hasClientSecret: boolean;
  appId: string | null;
  lastError?: string | null;
}

interface QQBotStatusResponse extends QQBotConfigResponse {
  state: "not_configured" | "disabled" | "configured" | "connected" | "error";
  connected: boolean;
  running: boolean;
  lastError: string | null;
}

interface WeComConfigResponse {
  configured: boolean;
  enabled: boolean;
  hasSecret: boolean;
  botId: string | null;
  connectionMode: "websocket";
  lastError?: string | null;
}

interface WeComStatusResponse extends WeComConfigResponse {
  state: "not_configured" | "disabled" | "configured" | "connected" | "error";
  connected: boolean;
  running: boolean;
  probeOk: boolean | null;
  lastError: string | null;
}

type WhatsAppChannelState =
  | "not_configured"
  | "disabled"
  | "not_linked"
  | "linked_offline"
  | "connected"
  | "error";

interface WhatsAppConfigResponse {
  configured: boolean;
  enabled: boolean;
  mode: "dedicated" | "personal";
  ownerNumber: string | null;
  error?: string;
}

interface WhatsAppStatusResponse extends Partial<WhatsAppConfigResponse> {
  state: WhatsAppChannelState;
  linked: boolean;
  connected: boolean;
  running: boolean;
  selfNumber: string | null;
  lastError: string | null;
  error?: string;
}

interface WhatsAppQrResponse {
  connected?: boolean;
  qrDataUrl?: string | null;
  message?: string;
  error?: string;
}

interface WhatsAppPairingRequest {
  code: string;
  senderId: string;
  accountId: string | null;
  createdAt: string;
  displayName: string | null;
}

type LineChannelState =
  | "not_configured"
  | "disabled"
  | "configured"
  | "running"
  | "ready"
  | "active"
  | "error";

interface LineConfigResponse {
  configured: boolean;
  enabled: boolean;
  hasChannelAccessToken: boolean;
  hasChannelSecret: boolean;
  publicBaseUrl: string | null;
  publicWebhookUrl: string | null;
  lastError?: string | null;
}

interface LineStatusResponse extends Partial<LineConfigResponse> {
  state: LineChannelState;
  running: boolean;
  probe: {
    ok: boolean;
    bot: {
      displayName: string;
      userId: string;
      basicId: string | null;
      pictureUrl: string | null;
    } | null;
    error: string | null;
  } | null;
  lastInboundAt: number | null;
  lastError: string | null;
  error?: string;
}

interface LinePairingRequest {
  code: string;
  senderId: string;
  createdAt: string;
  displayName: string | null;
}

interface WechatConfigResponse {
  enabled?: boolean;
  connected?: boolean;
  accountIds?: string[];
  botToken?: string;
  error?: string;
}

interface WechatQrResponse {
  pending?: boolean;
  state?: "starting" | "ready" | "connected" | "expired" | "failed";
  sessionId?: string;
  expiresAt?: number;
  connected?: boolean;
  message?: string;
  qrUrl?: string;
  error?: string;
}

type AutoQrChannelId = "feishu" | "qqbot";
type ChannelQrStatus =
  | "pending"
  | "saving"
  | "connected"
  | "expired"
  | "error"
  | "cancelled";

interface ChannelQrSession {
  sessionId: string;
  status: ChannelQrStatus;
  qrUrl: string | null;
  expiresAt: number | null;
  domain: "feishu" | "lark" | null;
  errorCode: string | null;
  error: string | null;
}

/* ── Constants ── */

const MAX_HISTORY = 30;

const RESET_STEPS = [
  "Clearing configuration...",
  "Removing credentials...",
  "Restoring setup hotspot...",
  "Restarting device...",
];

const INPUT_CLASS =
  "w-full px-3.5 py-2.5 bg-[var(--bg-deep)] border border-gray-600 rounded-lg text-sm text-gray-200 outline-none focus:border-[var(--coral-bright)] transition-colors placeholder-gray-500";

const INPUT_WITH_TOGGLE_CLASS = `${INPUT_CLASS} pr-10`;

const SAVE_BUTTON_CLASS =
  "px-6 py-2.5 btn-gradient text-white rounded-lg text-sm font-semibold cursor-pointer disabled:opacity-50";

const TOGGLE_BUTTON_CLASS =
  "absolute right-2.5 top-1/2 -translate-y-1/2 text-[var(--text-muted)] hover:text-[var(--text-primary)] bg-transparent border-none cursor-pointer p-0.5";

const SECTION_HEADER_CLASS =
  "flex items-center gap-2.5 w-full py-3.5 px-5 text-sm font-medium text-[var(--text-primary)] hover:text-gray-100 hover:bg-[var(--bg-surface)]/30 bg-transparent border-none cursor-pointer text-left transition-colors";

const SECTION_BODY_CLASS =
  "px-5 pb-5 border-t border-[var(--border-subtle)]/30 pt-4 space-y-4";

const LABEL_CLASS =
  "block text-xs font-semibold text-[var(--text-secondary)] mb-1.5";

const WIDGET_LABEL_CLASS =
  "text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-wider";

const AI_PROVIDERS = [
  { id: "anthropic", name: "Anthropic Claude", hasSubscription: true, placeholder: "sk-ant-api03-...", hint: "Get your API key from console.anthropic.com", tokenUrl: "https://console.anthropic.com/settings/keys" },
  { id: "openai", name: "OpenAI GPT", hasSubscription: true, placeholder: "sk-...", hint: "Get your API key from platform.openai.com", tokenUrl: "https://platform.openai.com/api-keys" },
  { id: "google", name: "Google Gemini", hasSubscription: true, placeholder: "AIza...", hint: "Get your API key from Google AI Studio.", tokenUrl: "https://aistudio.google.com/apikey" },
  { id: "openrouter", name: "OpenRouter", hasSubscription: false, placeholder: "sk-or-v1-...", hint: "Get your API key from OpenRouter.", tokenUrl: "https://openrouter.ai/keys" },
  { id: "deepseek", name: "DeepSeek", hasSubscription: false, placeholder: "sk-...", hint: "Get your API key from platform.deepseek.com", tokenUrl: "https://platform.deepseek.com/api_keys" },
] as const;

type ChatChannelId = "telegram" | "feishu" | "qqbot" | "whatsapp" | "line" | "wecom" | "wechat" | AdditionalChannelId;

const CHAT_CHANNELS: readonly { id: ChatChannelId; label: string }[] = [
  { id: "telegram", label: "Telegram" },
  { id: "feishu", label: "Feishu / Lark" },
  { id: "qqbot", label: "QQ Official Bot" },
  { id: "whatsapp", label: "WhatsApp" },
  { id: "line", label: "LINE" },
  { id: "wechat", label: "WeChat Bot" },
  { id: "wecom", label: "WeCom" },
  { id: "discord", label: "Discord" },
  { id: "zalo", label: "Zalo Bot" },
  { id: "zalo-clawbot", label: "Zalo ClawBot" },
  { id: "zalouser", label: "Zalo Personal" },
  { id: "signal", label: "Signal" },
];

const CHAT_CHANNEL_META: readonly { id: ChatChannelId; tag: string; name: string; description: string }[] = [
  { id: "wechat", tag: "WX", name: "WeChat Bot", description: "Sign in to a Tencent iLink bot with a QR code; direct messages only." },
  { id: "wecom", tag: "WC", name: "WeCom", description: "Connect an Enterprise WeChat smart bot over WebSocket with Bot ID and Secret." },
  { id: "telegram", tag: "TG", name: "Telegram", description: "Create a bot with BotFather, then paste its complete Bot Token." },
  { id: "whatsapp", tag: "WA", name: "WhatsApp", description: "Link a WhatsApp account by scanning a QR code. No Bot Token is needed." },
  { id: "feishu", tag: "FS", name: "Feishu / Lark", description: "Create or connect a Feishu / Lark bot through its official authorization flow." },
  { id: "line", tag: "LN", name: "LINE", description: "Connect a LINE Messaging API bot through a public HTTPS webhook." },
  { id: "qqbot", tag: "QQ", name: "QQ Official Bot", description: "Connect an official QQ bot through its official authorization flow." },
  { id: "discord", tag: "DC", name: "Discord", description: "Connect a Discord bot with a Bot Token and optional server allowlist." },
  { id: "zalo", tag: "ZL", name: "Zalo", description: "Use one of three Zalo connection modes: official Bot, official ClawBot, or personal-account QR login" },
  { id: "signal", tag: "SG", name: "Signal", description: "Link Signal through signal-cli and a device-linking QR code." },
];

function isAdditionalChatChannel(id: ChatChannelId): id is AdditionalChannelId {
  return id === "discord" || id === "zalo" || id === "zalo-clawbot" || id === "zalouser" || id === "signal";
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseChannelQrSession(payload: unknown): ChannelQrSession | null {
  if (!isRecordValue(payload)) return null;
  const value = isRecordValue(payload.session) ? payload.session : payload;
  const statuses: readonly ChannelQrStatus[] = [
    "pending",
    "saving",
    "connected",
    "expired",
    "error",
    "cancelled",
  ];
  if (
    typeof value.sessionId !== "string" ||
    typeof value.status !== "string" ||
    !statuses.includes(value.status as ChannelQrStatus)
  ) {
    return null;
  }

  let qrUrl: string | null = null;
  if (typeof value.qrUrl === "string") {
    try {
      const url = new URL(value.qrUrl);
      if (url.protocol === "https:") qrUrl = url.toString();
    } catch {
      // Never render an unvalidated URL returned by the setup API.
    }
  }

  return {
    sessionId: value.sessionId,
    status: value.status as ChannelQrStatus,
    qrUrl,
    expiresAt: typeof value.expiresAt === "number" && Number.isFinite(value.expiresAt)
      ? value.expiresAt
      : null,
    domain: value.domain === "feishu" || value.domain === "lark" ? value.domain : null,
    errorCode: typeof value.errorCode === "string" ? value.errorCode : null,
    error: typeof value.error === "string" ? value.error : null,
  };
}

/* ── Helper functions ── */

function thresholdColor(value: number, low: number, high: number): string {
  if (value > high) return "#ef4444";
  if (value > low) return "#f59e0b";
  return "#00e5cc";
}

/* ── Shared SVG icons ── */

const EyeOpen = (
  <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
);
const EyeClosed = (
  <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
);

const ButtonSpinner = (
  <span className="inline-block w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
);

/* ── Reusable components ── */

function UsageBar({ percent, color = "var(--coral-bright)" }: { percent: number; color?: string }) {
  return (
    <div className="w-full h-1.5 rounded-full bg-[var(--bg-deep)] mt-2 overflow-hidden">
      <div
        className="h-full rounded-full transition-all duration-700 ease-out"
        style={{ width: `${Math.min(100, Math.max(0, percent))}%`, backgroundColor: color }}
      />
    </div>
  );
}

function Sparkline({ data, color = "var(--coral-bright)", height = 32 }: { data: number[]; color?: string; height?: number }) {
  if (data.length < 2) return null;
  const max = Math.max(...data, 1);
  const w = 120;
  const h = height;
  const step = w / (data.length - 1);
  const points = data.map((v, i) => `${i * step},${h - (v / max) * (h - 4) - 2}`).join(" ");
  const fillPoints = `0,${h} ${points} ${(data.length - 1) * step},${h}`;
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="w-full" preserveAspectRatio="none">
      <polygon points={fillPoints} fill={color} opacity="0.1" />
      <polyline points={points} fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      aria-hidden="true"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`transition-transform ${open ? "rotate-90" : ""}`}
    >
      <polyline points="9 18 15 12 9 6" />
    </svg>
  );
}

function SectionBadge({ done }: { done: boolean }) {
  const { t } = useI18n();
  if (done) {
    return (
      <span className="ml-auto flex items-center gap-1.5 text-[10px] font-semibold text-[#00e5cc] uppercase tracking-wide">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5"/></svg>
        {t("Done")}
      </span>
    );
  }
  return (
    <span className="ml-auto flex items-center gap-1.5 text-[10px] font-semibold text-amber-400 uppercase tracking-wide">
      <span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
      {t("Pending")}
    </span>
  );
}

function PasswordInput({
  id,
  value,
  onChange,
  visible,
  onToggle,
  placeholder,
  autoComplete,
  disabled = false,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  visible: boolean;
  onToggle: () => void;
  placeholder?: string;
  autoComplete?: string;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  return (
    <div className="relative">
      <input
        id={id}
        type={visible ? "text" : "password"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoComplete={autoComplete}
        spellCheck={false}
        disabled={disabled}
        className={`${INPUT_WITH_TOGGLE_CLASS} ${disabled ? "opacity-60 cursor-not-allowed" : ""}`}
      />
      <button
        type="button"
        onClick={onToggle}
        aria-label={visible ? t("Hide") : t("Show")}
        disabled={disabled}
        className={`${TOGGLE_BUTTON_CLASS} ${disabled ? "opacity-60 cursor-not-allowed" : ""}`}
      >
        {visible ? EyeClosed : EyeOpen}
      </button>
    </div>
  );
}

function CollapsibleSection({
  id,
  title,
  done,
  open,
  onToggle,
  children,
}: {
  id: string;
  title: string;
  done: boolean;
  open: boolean;
  onToggle: (id: string) => void;
  children: React.ReactNode;
}) {
  return (
    <div id={`section-${id}`} className="card-surface scroll-mt-4 rounded-xl overflow-hidden">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={`${id}-body`}
        onClick={() => onToggle(id)}
        className={SECTION_HEADER_CLASS}
      >
        <Chevron open={open} />
        {title}
        <SectionBadge done={done} />
      </button>
      {open && <div id={`${id}-body`} className={SECTION_BODY_CLASS}>{children}</div>}
    </div>
  );
}

function ChannelContentSection({
  id,
  title,
  active,
  children,
}: {
  id: ChatChannelId;
  title: string;
  active: boolean;
  children: React.ReactNode;
}) {
  if (!active) return null;
  return (
    <section id={`${id}-channel-details`} aria-label={title} className="min-w-0 space-y-4">
      {children}
    </section>
  );
}

function ChannelQrSetupPanel({
  channel,
  session,
  loading,
  onStart,
  onCancel,
}: {
  channel: AutoQrChannelId;
  session?: ChannelQrSession;
  loading: boolean;
  onStart: () => void;
  onCancel: () => void;
}) {
  const { translateText } = useI18n();
  const active = session?.status === "pending" || session?.status === "saving";
  const canCancel = session?.status === "pending" || session?.status === "expired";
  const title = channel === "feishu" ? "Feishu QR setup" : "QQ Bot QR setup";
  const qrLabel = channel === "feishu"
    ? "Feishu authorization QR code"
    : "QQ Bot authorization QR code";

  return (
    <div className="rounded-lg border border-[var(--coral-bright)]/20 bg-[var(--bg-deep)] p-3 space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold text-[var(--text-secondary)]">
            {translateText("QR code setup")}
          </p>
          <p className="mt-1 text-[11px] leading-relaxed text-[var(--text-muted)]">
            {translateText("Scan the QR code with the owner account. Credentials are saved on the device and are never returned to the browser.")}
          </p>
        </div>
        <button
          type="button"
          onClick={onStart}
          disabled={loading || session?.status === "saving"}
          className={`${SAVE_BUTTON_CLASS} flex items-center gap-2`}
          aria-label={translateText(title)}
        >
          {loading && ButtonSpinner}
          {translateText(active ? "Refresh QR code" : "Generate QR code")}
        </button>
      </div>

      {session?.qrUrl && session.status === "pending" && (
        <div className="rounded-lg border border-gray-700/70 bg-[var(--bg-surface)] p-3 space-y-2">
          <div className="flex justify-center rounded-md bg-white p-2">
            <QRCodeSVG value={session.qrUrl} size={190} level="M" aria-label={translateText(qrLabel)} />
          </div>
          <p className="text-center text-[11px] leading-relaxed text-[var(--text-muted)]">
            {translateText("Keep this page open while the QR authorization is completed.")}
          </p>
          {session.expiresAt && (
            <p className="text-center text-[10px] text-amber-300">
              {translateText("The QR code will expire automatically. Generate a new one if it is not scanned in time.")}
            </p>
          )}
        </div>
      )}

      {session?.status === "saving" && (
        <div className="flex items-center gap-2 text-xs text-[var(--text-secondary)]">
          <span className="spinner !h-3.5 !w-3.5" />
          {translateText("Authorization confirmed. Saving credentials and waiting for the channel...")}
        </div>
      )}

      {session?.status === "connected" && (
        <p className="text-xs text-[#00e5cc]">
          {translateText("QR setup completed and the channel is connected.")}
        </p>
      )}

      {session?.status === "expired" && (
        <p className="text-xs text-amber-300">
          {translateText("The QR code expired. Generate a new one to continue.")}
        </p>
      )}

      {session?.status === "error" && session.error && (
        <p className="text-xs leading-relaxed text-red-400">{translateText(session.error)}</p>
      )}

      {canCancel && (
        <button
          type="button"
          onClick={onCancel}
          disabled={loading}
          className="text-xs font-semibold text-[var(--text-muted)] underline hover:text-[var(--text-primary)] disabled:opacity-50"
        >
          {translateText("Cancel QR setup")}
        </button>
      )}
    </div>
  );
}

function SystemInfoWidget({
  label,
  detail,
  value,
  unit,
  bar,
  className,
}: {
  label: string;
  detail?: string;
  value: string;
  unit?: string;
  bar?: { percent: number; color: string };
  className?: string;
}) {
  return (
    <div className={`card-surface rounded-xl p-3.5 ${className ?? ""}`}>
      <div className="flex items-center justify-between mb-1">
        <p className={WIDGET_LABEL_CLASS}>{label}</p>
        {detail && <p className="text-[10px] font-semibold text-[var(--text-muted)]">{detail}</p>}
      </div>
      <p className="text-lg font-bold text-gray-100">
        {value}
        {unit && <span className="text-xs font-normal text-[var(--text-muted)]">{unit}</span>}
      </p>
      {bar && <UsageBar percent={bar.percent} color={bar.color} />}
    </div>
  );
}

function SparklineWidget({
  label,
  currentValue,
  data,
  color,
}: {
  label: string;
  currentValue: string;
  data: number[];
  color: string;
}) {
  return (
    <div className="card-surface rounded-xl p-3.5">
      <div className="flex items-center justify-between mb-2">
        <p className={WIDGET_LABEL_CLASS}>{label}</p>
        <p className="text-[10px] font-bold text-gray-300">{currentValue}</p>
      </div>
      <Sparkline data={data} color={color} height={36} />
    </div>
  );
}

/* ── Update step helpers ── */

function updateStepTextClass(status: StepStatus): string {
  switch (status) {
    case "running": return "text-[var(--coral-bright)] font-medium";
    case "completed": return "text-[var(--text-secondary)]";
    case "failed": return "text-red-400";
    default: return "text-[var(--text-muted)]";
  }
}

function UpdateStepIcon({ status }: { status: StepStatus }) {
  if (status === "running") {
    return <div className="spinner !w-4 !h-4 !border-2" />;
  }
  if (status === "completed") {
    return (
      <div className="w-4 h-4 rounded-full bg-[#00e5cc] flex items-center justify-center text-white text-[10px] font-bold">
        &#10003;
      </div>
    );
  }
  if (status === "failed") {
    return (
      <div className="w-4 h-4 rounded-full bg-red-500 flex items-center justify-center text-white text-[10px] font-bold">
        &#10005;
      </div>
    );
  }
  return <div className="w-4 h-4 rounded-full bg-gray-600" />;
}

function UpdateProgressHeading({ phase }: { phase: UpdateState["phase"] | undefined }) {
  const { t } = useI18n();
  if (phase === "completed") return <span className="text-[#00e5cc]">{t("Update Complete")}</span>;
  if (phase === "failed") return <span className="text-red-400">{t("Update Failed")}</span>;
  return <>{t("System Update")}</>;
}

type UpdateApiState = "updating" | "done" | "failed";

interface UpdateApiResponse {
  state?: UpdateApiState;
  phase?: UpdateState["phase"];
  stage?: string | number;
  status?: string;
  message?: string;
  error?: string;
  progress?: number;
  steps?: unknown;
  currentStepIndex?: unknown;
}

function normalizeUpdateStatus(payload: unknown): UpdateState | null {
  if (!isRecordValue(payload)) return null;
  const data = payload as UpdateApiResponse;

  const phase: UpdateState["phase"] | null =
    data.state === "done"
      ? "completed"
      : data.state === "updating"
        ? "running"
        : data.state === "failed"
          ? "failed"
          : data.phase === "idle" || data.phase === "running" || data.phase === "completed" || data.phase === "failed"
            ? data.phase
            : null;
  if (!phase) return null;

  const validStepStatuses: readonly StepStatus[] = ["pending", "running", "completed", "failed"];
  const steps = Array.isArray(data.steps)
    ? data.steps.filter((step): step is UpdateState["steps"][number] => (
      isRecordValue(step) &&
      typeof step.id === "string" &&
      typeof step.label === "string" &&
      typeof step.status === "string" &&
      validStepStatuses.includes(step.status as StepStatus)
    ))
    : [];
  const currentStepIndex = typeof data.currentStepIndex === "number" && Number.isInteger(data.currentStepIndex)
    ? data.currentStepIndex
    : -1;
  const stageText = typeof data.stage === "string" && data.stage.trim() ? data.stage : undefined;
  const status = typeof data.status === "string" && data.status.trim()
    ? data.status
    : stageText;
  const progress = typeof data.progress === "number" && Number.isFinite(data.progress)
    ? Math.min(100, Math.max(0, data.progress))
    : typeof data.stage === "number" && Number.isFinite(data.stage)
      ? Math.min(100, Math.max(0, data.stage))
      : typeof data.stage === "string" && /^\d+(?:\.\d+)?$/.test(data.stage.trim())
        ? Math.min(100, Math.max(0, Number(data.stage)))
      : phase === "completed"
        ? 100
        : undefined;
  const error = typeof data.error === "string" && data.error.trim()
    ? data.error
    : phase === "failed" && typeof data.message === "string" && data.message.trim()
      ? data.message
      : undefined;

  return {
    phase,
    steps,
    currentStepIndex,
    ...(progress === undefined ? {} : { progress }),
    ...(status ? { status } : {}),
    ...(error ? { error } : {}),
  };
}

/* ── Main component ── */

export default function DoneStep({ setupComplete = false }: DoneStepProps) {
  const { locale, t, translateText } = useI18n();
  /* ── System info ── */
  const [info, setInfo] = useState<SystemInfo | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [statsHistory, setStatsHistory] = useState<StatsSnapshot[]>([]);
  const statsPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  /* ── Finish ── */
  const [finishing, setFinishing] = useState(false);
  const [completeError, setCompleteError] = useState<string | null>(null);

  /* ── System update ── */
  const [updateState, setUpdateState] = useState<UpdateState | null>(null);
  const [updateStarted, setUpdateStarted] = useState(false);
  const [updateAcknowledged, setUpdateAcknowledged] = useState(false);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [updateServerRestarting, setUpdateServerRestarting] = useState(false);
  const updatePollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const updatePollControllerRef = useRef<AbortController | null>(null);
  const updateReloadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const oauthWindowRef = useRef<Window | null>(null);
  const aiSaveControllerRef = useRef<AbortController | null>(null);
  const aiExchangeControllerRef = useRef<AbortController | null>(null);
  const aiOauthStartControllerRef = useRef<AbortController | null>(null);
  const aiPollControllerRef = useRef<AbortController | null>(null);

  /* ── Collapsible sections ── */
  const [openSection, setOpenSection] = useState<string | null>("ai");
  const [activeChatChannel, setActiveChatChannel] = useState<ChatChannelId>("wechat");
  const [initialZaloMode, setInitialZaloMode] = useState<ZaloMode>("bot");
  const [channelPickerOpen, setChannelPickerOpen] = useState(true);
  const toggle = (id: string) => setOpenSection((prev) => (prev === id ? null : id));
  const [additionalStatuses, setAdditionalStatuses] = useState<Partial<Record<AdditionalChannelId, AdditionalChannelStatus>>>({});
  const [additionalStatusRefreshToken, setAdditionalStatusRefreshToken] = useState(0);
  const [disconnectingChannel, setDisconnectingChannel] = useState<ChatChannelId | null>(null);
  const [channelDisconnectStatus, setChannelDisconnectStatus] = useState<SectionStatusMessage | null>(null);
  const handleAdditionalStatuses = useCallback((statuses: Partial<Record<AdditionalChannelId, AdditionalChannelStatus>>) => {
    setAdditionalStatuses(statuses);
  }, []);

  useEffect(() => {
    const requested = new URLSearchParams(window.location.search).get("section");
    if (!requested) return;
    const legacyZaloMode: ZaloMode | null = requested === "zalo-clawbot"
      ? "clawbot"
      : requested === "zalouser"
        ? "personal"
        : null;
    const requestedChannel = CHAT_CHANNEL_META.find((channel) => channel.id === requested) ?? (legacyZaloMode ? CHAT_CHANNEL_META.find((channel) => channel.id === "zalo") : undefined);
    const targetSection = requestedChannel ? "channels" : requested;
    if (requestedChannel) {
      setActiveChatChannel(requestedChannel.id);
      if (legacyZaloMode) setInitialZaloMode(legacyZaloMode);
      setChannelPickerOpen(false);
    }
    setOpenSection(targetSection);
    window.setTimeout(() => document.getElementById(`section-${targetSection}`)?.scrollIntoView({ behavior: "smooth", block: "start" }), 100);
  }, []);

  const selectChannel = (id: ChatChannelId) => {
    setActiveChatChannel(id);
    setChannelPickerOpen(false);
    setOpenSection("channels");
    const url = new URL(window.location.href);
    url.searchParams.set("section", id);
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
    window.setTimeout(() => document.getElementById("section-channels")?.scrollIntoView({ behavior: "smooth", block: "start" }), 100);
  };

  /* ── AI Provider ── */
  const [aiProvider, setAiProvider] = useState<string>("anthropic");
  const [aiAuthMode, setAiAuthMode] = useState<"token" | "subscription">("token");
  const [aiApiKey, setAiApiKey] = useState("");
  const [showAiKey, setShowAiKey] = useState(false);
  const [aiSaving, setAiSaving] = useState(false);
  const [aiStatus, setAiStatus] = useState<SectionStatusMessage | null>(null);
  const [aiOauthStarted, setAiOauthStarted] = useState(false);
  const [aiAuthCode, setAiAuthCode] = useState("");
  const [aiExchanging, setAiExchanging] = useState(false);
  const [providerDone, setProviderDone] = useState(false);
  const [providerName, setProviderName] = useState<string | null>(null);
  const [deviceCode, setDeviceCode] = useState<string | null>(null);
  const [deviceUrl, setDeviceUrl] = useState<string | null>(null);
  const [devicePolling, setDevicePolling] = useState(false);
  const [deviceSaving, setDeviceSaving] = useState(false);
  const devicePollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /* ── Security (system password + hotspot) ── */
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [hotspotName, setHotspotName] = useState("ClawBox-Setup");
  const [hotspotPassword, setHotspotPassword] = useState("");
  const [showHotspotPassword, setShowHotspotPassword] = useState(false);
  const [hotspotEnabled, setHotspotEnabled] = useState(true);
  const [secSaving, setSecSaving] = useState(false);
  const [secStatus, setSecStatus] = useState<SectionStatusMessage | null>(null);

  /* ── Confirmations ── */
  const [updateConfirm, setUpdateConfirm] = useState(false);
  const [versionInfo, setVersionInfo] = useState<{ clawbox: { current: string; target: string | null }; openclaw: { current: string | null; target: string | null } } | null>(null);
  const [versionLoading, setVersionLoading] = useState(false);
  const [updateBranch, setUpdateBranch] = useState<string | null>(null);
  const [branchInput, setBranchInput] = useState("");
  const [branchSaving, setBranchSaving] = useState(false);
  const [branchError, setBranchError] = useState<string | null>(null);
  const [betaConfirm, setBetaConfirm] = useState(false);
  const [resetConfirm, setResetConfirm] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [resetStep, setResetStep] = useState(0);
  const [resetProgress, setResetProgress] = useState(0);

  /* ── WeChat Bot ── */
  const [wechatToken, setWechatToken] = useState("");
  const [showWechatToken, setShowWechatToken] = useState(false);
  const [wechatEnabled, setWechatEnabled] = useState(false);
  const [wechatSaving, setWechatSaving] = useState(false);
  const [wechatQrLoading, setWechatQrLoading] = useState(false);
  const [wechatQrUrl, setWechatQrUrl] = useState<string | null>(null);
  const [wechatStatus, setWechatStatus] = useState<SectionStatusMessage | null>(null);
  const [wechatDone, setWechatDone] = useState(false);
  const [wechatLinkCopied, setWechatLinkCopied] = useState(false);

  /* ── Telegram ── */
  const [telegramToken, setTelegramToken] = useState("");
  const [showTelegramToken, setShowTelegramToken] = useState(false);
  const [telegramEnabled, setTelegramEnabled] = useState(true);
  const [telegramConfigured, setTelegramConfigured] = useState(false);
  const [telegramSaving, setTelegramSaving] = useState(false);
  const [telegramChecking, setTelegramChecking] = useState(false);
  const [telegramStatus, setTelegramStatus] = useState<SectionStatusMessage | null>(null);
  const [telegramDone, setTelegramDone] = useState(false);
  const [telegramBotUsername, setTelegramBotUsername] = useState<string | null>(null);
  const [telegramPairingRequests, setTelegramPairingRequests] = useState<TelegramPairingRequest[]>([]);
  const [telegramPairingLoading, setTelegramPairingLoading] = useState(false);
  const [telegramApprovingCode, setTelegramApprovingCode] = useState<string | null>(null);

  /* ── Feishu / Lark ── */
  const [feishuAppId, setFeishuAppId] = useState("");
  const [feishuAppSecret, setFeishuAppSecret] = useState("");
  const [showFeishuSecret, setShowFeishuSecret] = useState(false);
  const [feishuDomain, setFeishuDomain] = useState<"feishu" | "lark">("feishu");
  const [feishuEnabled, setFeishuEnabled] = useState(true);
  const [feishuConfigured, setFeishuConfigured] = useState(false);
  const [feishuSaving, setFeishuSaving] = useState(false);
  const [feishuChecking, setFeishuChecking] = useState(false);
  const [feishuStatus, setFeishuStatus] = useState<SectionStatusMessage | null>(null);
  const [feishuDone, setFeishuDone] = useState(false);
  const [feishuBotName, setFeishuBotName] = useState<string | null>(null);
  const [feishuPairingRequests, setFeishuPairingRequests] = useState<FeishuPairingRequest[]>([]);
  const [feishuPairingLoading, setFeishuPairingLoading] = useState(false);
  const [feishuApprovingCode, setFeishuApprovingCode] = useState<string | null>(null);
  const [channelQrSessions, setChannelQrSessions] = useState<Partial<Record<AutoQrChannelId, ChannelQrSession>>>({});
  const [channelQrLoading, setChannelQrLoading] = useState<Partial<Record<AutoQrChannelId, boolean>>>({});
  const channelQrSessionsRef = useRef<Partial<Record<AutoQrChannelId, ChannelQrSession>>>({});
  const channelQrOwnerRef = useRef<string | null>(null);

  /* ── QQ Official Bot ── */
  const [qqbotAppId, setQQBotAppId] = useState("");
  const [qqbotAppSecret, setQQBotAppSecret] = useState("");
  const [showQQBotSecret, setShowQQBotSecret] = useState(false);
  const [qqbotEnabled, setQQBotEnabled] = useState(true);
  const [qqbotConfigured, setQQBotConfigured] = useState(false);
  const [qqbotSaving, setQQBotSaving] = useState(false);
  const [qqbotChecking, setQQBotChecking] = useState(false);
  const [qqbotStatus, setQQBotStatus] = useState<SectionStatusMessage | null>(null);
  const [qqbotDone, setQQBotDone] = useState(false);

  /* ── WeCom ── */
  const [wecomBotId, setWeComBotId] = useState("");
  const [wecomSecret, setWeComSecret] = useState("");
  const [showWeComSecret, setShowWeComSecret] = useState(false);
  const [wecomEnabled, setWeComEnabled] = useState(true);
  const [wecomConfigured, setWeComConfigured] = useState(false);
  const [wecomSaving, setWeComSaving] = useState(false);
  const [wecomChecking, setWeComChecking] = useState(false);
  const [wecomStatus, setWeComStatus] = useState<SectionStatusMessage | null>(null);
  const [wecomDone, setWeComDone] = useState(false);

  /* ── WhatsApp ── */
  const [whatsappMode, setWhatsAppMode] = useState<"dedicated" | "personal">("dedicated");
  const [whatsappOwnerNumber, setWhatsAppOwnerNumber] = useState("");
  const [whatsappEnabled, setWhatsAppEnabled] = useState(true);
  const [whatsappConfigured, setWhatsAppConfigured] = useState(false);
  const [whatsappPreparing, setWhatsAppPreparing] = useState(false);
  const [whatsappQrLoading, setWhatsAppQrLoading] = useState(false);
  const [whatsappWaiting, setWhatsAppWaiting] = useState(false);
  const [whatsappChecking, setWhatsAppChecking] = useState(false);
  const [whatsappLogoutBusy, setWhatsAppLogoutBusy] = useState(false);
  const [whatsappQrDataUrl, setWhatsAppQrDataUrl] = useState<string | null>(null);
  const [whatsappStatus, setWhatsAppStatus] = useState<SectionStatusMessage | null>(null);
  const [whatsappDone, setWhatsAppDone] = useState(false);
  const [whatsappLinked, setWhatsAppLinked] = useState(false);
  const [whatsappSelfNumber, setWhatsAppSelfNumber] = useState<string | null>(null);
  const [whatsappPairingRequests, setWhatsAppPairingRequests] = useState<WhatsAppPairingRequest[]>([]);
  const [whatsappPairingLoading, setWhatsAppPairingLoading] = useState(false);
  const [whatsappApprovingCode, setWhatsAppApprovingCode] = useState<string | null>(null);
  const whatsappWaitControllerRef = useRef<AbortController | null>(null);

  /* ── LINE ── */
  const [lineAccessToken, setLineAccessToken] = useState("");
  const [lineChannelSecret, setLineChannelSecret] = useState("");
  const [showLineAccessToken, setShowLineAccessToken] = useState(false);
  const [showLineChannelSecret, setShowLineChannelSecret] = useState(false);
  const [linePublicBaseUrl, setLinePublicBaseUrl] = useState("");
  const [linePublicWebhookUrl, setLinePublicWebhookUrl] = useState<string | null>(null);
  const [lineWebhookCopied, setLineWebhookCopied] = useState(false);
  const [lineEnabled, setLineEnabled] = useState(true);
  const [lineConfigured, setLineConfigured] = useState(false);
  const [lineSaving, setLineSaving] = useState(false);
  const [lineChecking, setLineChecking] = useState(false);
  const [lineStatus, setLineStatus] = useState<SectionStatusMessage | null>(null);
  const [lineDone, setLineDone] = useState(false);
  const [lineRunning, setLineRunning] = useState(false);
  const [lineProbeOk, setLineProbeOk] = useState(false);
  const [lineLastInboundAt, setLineLastInboundAt] = useState<number | null>(null);
  const [lineBotName, setLineBotName] = useState<string | null>(null);
  const [lineBotBasicId, setLineBotBasicId] = useState<string | null>(null);
  const [linePairingRequests, setLinePairingRequests] = useState<LinePairingRequest[]>([]);
  const [linePairingLoading, setLinePairingLoading] = useState(false);
  const [lineApprovingCode, setLineApprovingCode] = useState<string | null>(null);

  /* ── WiFi ── */
  const [wifiDone, setWifiDone] = useState(false);
  const [wifiConnectedSSID, setWifiConnectedSSID] = useState<string | null>(null);
  const [wifiSSID, setWifiSSID] = useState("");
  const [wifiPassword, setWifiPassword] = useState("");
  const [showWifiPassword, setShowWifiPassword] = useState(false);
  const [wifiConnecting, setWifiConnecting] = useState(false);
  const [wifiStatus, setWifiStatus] = useState<SectionStatusMessage | null>(null);
  const [wifiTargetSSID, setWifiTargetSSID] = useState<string | null>(null);
  const [wifiNetworks, setWifiNetworks] = useState<
    { ssid: string; signal: number; security: string; freq: string }[]
  >([]);
  const [wifiScanning, setWifiScanning] = useState(false);
  const wifiControllerRef = useRef<AbortController | null>(null);

  /* ── Section completion status ── */
  const [securityDone, setSecurityDone] = useState(false);

  const selectedAiProvider = AI_PROVIDERS.find((p) => p.id === aiProvider);
  const isAiSubscription = aiAuthMode === "subscription" && (selectedAiProvider?.hasSubscription ?? false);
  const useDeviceAuth = isAiSubscription && aiProvider === "openai";
  const canConfigureTelegram = providerDone;
  const canConfigureFeishu = providerDone;
  const canConfigureQQBot = providerDone;
  const canConfigureWeCom = providerDone;
  const canConfigureWhatsApp = providerDone;
  const canConfigureLine = providerDone;
  const canConfigureWechat = providerDone;
  const canFinishSetup = wifiDone && providerDone;
  const finishButtonDisabled = finishing || (!setupComplete && !canFinishSetup);

  const aiOauthLabels: Record<string, { button: string; description: string; success: string; steps: string[]; inputLabel: string; inputPlaceholder: string }> = {
    anthropic: {
      button: "Connect with Claude",
      description: "Connect your Claude Pro or Max subscription via OAuth.",
      success: "Claude subscription connected!",
      steps: ["Authorize in the browser tab.", "Copy the authorization code.", "Paste it below."],
      inputLabel: "Authorization Code",
      inputPlaceholder: "Paste code here...",
    },
    openai: {
      button: "Connect to GPT",
      description: "Connect your ChatGPT Plus or Pro subscription via OAuth.",
      success: "GPT subscription connected!",
      steps: [
        "Sign in and authorize in the browser tab.",
        "After approval, the page will redirect to a URL that won't load - this is expected.",
        "Copy the full URL from the address bar and paste it below.",
      ],
      inputLabel: "Callback URL",
      inputPlaceholder: "Paste the full URL here...",
    },
    google: {
      button: "Connect to Gemini",
      description: "Connect your Google Gemini subscription via OAuth.",
      success: "Gemini subscription connected!",
      steps: ["Sign in with your Google account in the browser tab.", "Copy the authorization code shown after approval.", "Paste it below."],
      inputLabel: "Authorization Code",
      inputPlaceholder: "Paste code here...",
    },
  };
  const currentAiOAuth = aiOauthLabels[aiProvider] ?? aiOauthLabels.anthropic;
  const isUpdateRunning = updateStarted && updateState?.phase !== "completed" && updateState?.phase !== "failed";
  const updateFailureMessage = updateError || updateState?.error || null;

  /* ── Fetch section status on mount ── */
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | null = null;

    const poll = async () => {
      try {
        const response = await fetch("/setup-api/setup/status", {
          signal: controller.signal,
          cache: "no-store",
        });
        const data = response.ok
          ? ((await response.json()) as SetupStatusResponse)
          : null;
        if (!active || !data) {
          return;
        }

        setSecurityDone(!!data.password_configured);
        setProviderDone(!!data.ai_model_configured);
        setWifiDone(!!data.wifi_configured);
        setWifiConnecting(!!data.wifi_connecting);
        setWifiTargetSSID(data.wifi_target_ssid ?? null);

        if (data.wifi_target_ssid) {
          setWifiConnectedSSID(data.wifi_target_ssid);
        }

        if (data.wifi_last_error) {
          setWifiStatus({
            type: "error",
            message: data.wifi_last_error,
          });
        } else if (data.wifi_connecting) {
          setWifiStatus({
            type: "success",
            message: `Connecting to ${data.wifi_target_ssid ?? "the selected WiFi"} and waiting for a DHCP address. Reopen the device in a system browser after your phone rejoins the same network.`,
          });
        } else if (data.wifi_configured) {
          setWifiStatus((prev) =>
            prev?.type === "error"
              ? null
              : {
                  type: "success",
                  message:
                    "WiFi is connected. Open the device's .local address in a system browser, or use the IP shown on the device screen if this client does not resolve .local.",
                },
          );
        }

        if (data.ai_model_provider) {
          setProviderName(data.ai_model_provider);
          setAiProvider(data.ai_model_provider);
        }

        if (data.ai_model_last_error) {
          setAiStatus({
            type: "error",
            message: data.ai_model_last_error,
          });
        }

        if (data.wifi_connecting) {
          timer = setTimeout(poll, 2000);
        }
      } catch {
        // best-effort polling
      }
    };

    void poll();
    return () => {
      active = false;
      controller.abort();
      if (timer) {
        clearTimeout(timer);
      }
    };
  }, []);

  const refreshWechatState = useCallback(async (signal?: AbortSignal) => {
    const r = await fetch("/setup-api/wechat/configure", { signal, cache: "no-store" });
    if (!r.ok) return null;
    const data = (await r.json().catch(() => null)) as WechatConfigResponse | null;
    if (!data) return null;

    if (typeof data.enabled === "boolean") setWechatEnabled(data.enabled);
    // masked token from backend is expected; do not overwrite user input with non-string
    if (typeof data.botToken === "string" && data.botToken) setWechatToken(data.botToken);

    const connected = data.connected === true;
    setWechatDone(connected);
    return data;
  }, []);

  const refreshTelegramConfig = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch("/setup-api/channels/telegram", {
      signal,
      cache: "no-store",
    });
    if (!response.ok) return null;
    const data = (await response.json().catch(() => null)) as TelegramConfigResponse | null;
    if (!data) return null;

    setTelegramConfigured(data.configured === true);
    setTelegramEnabled(data.configured ? data.enabled === true : true);
    if (data.lastError) {
      setTelegramStatus({ type: "error", message: data.lastError });
    }
    return data;
  }, []);

  const refreshTelegramStatus = useCallback(async (
    options: { signal?: AbortSignal; announce?: boolean; force?: boolean } = {},
  ) => {
    const response = await fetch(`/setup-api/channels/telegram/status${options.force ? "?force=1" : ""}`, {
      signal: options.signal,
      cache: "no-store",
    });
    const data = (await response.json().catch(() => null)) as TelegramStatusResponse | null;
    if (!data) {
      if (options.announce) {
        setTelegramStatus({ type: "error", message: "Telegram returned an invalid status response." });
      }
      return null;
    }

    setTelegramConfigured(data.configured === true);
    setTelegramEnabled(data.configured ? data.enabled === true : true);
    setTelegramDone(data.connected === true);
    setTelegramBotUsername(data.botUsername || null);

    if (!response.ok || data.state === "error") {
      setTelegramStatus({
        type: "error",
        message: data.lastError || "Telegram is configured but not online.",
      });
    } else if (options.announce || data.connected) {
      setTelegramStatus({
        type: "success",
        message: data.connected
          ? `Telegram is online${data.botUsername ? ` as @${data.botUsername}` : ""}.`
          : data.state === "disabled"
            ? "Telegram is disabled."
            : "Telegram is not configured yet.",
      });
    }
    return data;
  }, []);

  const refreshFeishuStatus = useCallback(async (options: { signal?: AbortSignal; announce?: boolean; force?: boolean } = {}) => {
    const response = await fetch(`/setup-api/channels/feishu/status${options.force ? "?force=1" : ""}`, { signal: options.signal, cache: "no-store" });
    const data = (await response.json().catch(() => null)) as FeishuStatusResponse | null;
    if (!data) {
      if (options.announce) setFeishuStatus({ type: "error", message: "Feishu returned an invalid status response." });
      return null;
    }
    setFeishuConfigured(data.configured === true);
    setFeishuEnabled(data.configured ? data.enabled === true : true);
    setFeishuDomain(data.domain === "lark" ? "lark" : "feishu");
    if (data.appId) setFeishuAppId(data.appId);
    setFeishuDone(data.connected === true);
    setFeishuBotName(data.botName || null);
    if (!response.ok || data.state === "error") setFeishuStatus({ type: "error", message: data.lastError || "Feishu is configured but not online." });
    else if (options.announce || data.connected) setFeishuStatus({ type: "success", message: data.connected ? `Feishu is online${data.botName ? ` as ${data.botName}` : ""}.` : data.state === "disabled" ? "Feishu is disabled." : "Feishu is not configured yet." });
    return data;
  }, []);

  const refreshQQBotConfig = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch("/setup-api/channels/qqbot", {
      signal,
      cache: "no-store",
    });
    if (!response.ok) return null;
    const data = (await response.json().catch(() => null)) as QQBotConfigResponse | null;
    if (!data) return null;

    setQQBotConfigured(data.configured === true);
    setQQBotEnabled(data.configured ? data.enabled === true : true);
    if (data.appId) setQQBotAppId(data.appId);
    if (data.lastError) {
      setQQBotStatus({ type: "error", message: data.lastError });
    }
    return data;
  }, []);

  const refreshQQBotStatus = useCallback(async (
    options: { signal?: AbortSignal; announce?: boolean; force?: boolean } = {},
  ) => {
    const response = await fetch(`/setup-api/channels/qqbot/status${options.force ? "?force=1" : ""}`, {
      signal: options.signal,
      cache: "no-store",
    });
    const data = (await response.json().catch(() => null)) as QQBotStatusResponse | null;
    if (!data) {
      if (options.announce) {
        setQQBotStatus({ type: "error", message: "QQ Bot returned an invalid status response." });
      }
      return null;
    }

    setQQBotConfigured(data.configured === true);
    setQQBotEnabled(data.configured ? data.enabled === true : true);
    if (data.appId) setQQBotAppId(data.appId);
    setQQBotDone(data.connected === true);

    if (!response.ok || data.state === "error") {
      setQQBotStatus({
        type: "error",
        message: data.lastError || "QQ Bot is configured but not online.",
      });
    } else if (options.announce || data.connected) {
      setQQBotStatus({
        type: "success",
        message: data.connected
          ? `QQ Bot${data.appId ? ` ${data.appId}` : ""} is online. Send it a private message in QQ to test the AI reply.`
          : data.state === "disabled"
            ? "QQ Bot is disabled."
            : "QQ Bot is not configured yet.",
      });
    }
    return data;
  }, []);

  const refreshWeComConfig = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch("/setup-api/channels/wecom", {
      signal,
      cache: "no-store",
    });
    if (!response.ok) return null;
    const data = (await response.json().catch(() => null)) as WeComConfigResponse | null;
    if (!data) return null;

    setWeComConfigured(data.configured === true);
    setWeComEnabled(data.configured ? data.enabled === true : true);
    if (data.botId) setWeComBotId(data.botId);
    if (data.lastError) setWeComStatus({ type: "error", message: data.lastError });
    return data;
  }, []);

  const refreshWeComStatus = useCallback(async (
    options: { signal?: AbortSignal; announce?: boolean; force?: boolean } = {},
  ) => {
    const response = await fetch(`/setup-api/channels/wecom/status${options.force ? "?force=1" : ""}`, {
      signal: options.signal,
      cache: "no-store",
    });
    const data = (await response.json().catch(() => null)) as WeComStatusResponse | null;
    if (!data || typeof data.state !== "string") {
      setWeComDone(false);
      if (options.announce) {
        setWeComStatus({ type: "error", message: "WeCom returned an invalid status response." });
      }
      return null;
    }

    setWeComConfigured(data.configured === true);
    setWeComEnabled(data.configured ? data.enabled === true : true);
    if (data.botId) setWeComBotId(data.botId);
    setWeComDone(data.connected === true);

    if (!response.ok || data.state === "error") {
      setWeComStatus({
        type: "error",
        message: data.lastError || "WeCom is configured but not online.",
      });
    } else if (options.announce || data.connected) {
      setWeComStatus({
        type: "success",
        message: data.connected
          ? "WeCom is online. Send a private message to the bot to test the AI reply."
          : data.state === "disabled"
            ? "WeCom is disabled."
            : "WeCom is not configured yet.",
      });
    }
    return data;
  }, []);

  const getChannelQrOwner = useCallback((): string => {
    if (channelQrOwnerRef.current) return channelQrOwnerRef.current;

    let owner: string | null = null;
    try {
      owner = window.sessionStorage.getItem("clawbox.channelQrOwner")?.trim() || null;
    } catch {
      // Fall back to an in-memory owner when session storage is unavailable.
    }
    const validOwner = owner && (
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(owner) ||
      /^[A-Za-z0-9_-]{32,128}$/.test(owner)
    );
    if (!validOwner) {
      if (typeof window.crypto?.randomUUID === "function") {
        owner = window.crypto.randomUUID();
      } else if (window.crypto?.getRandomValues) {
        const bytes = window.crypto.getRandomValues(new Uint8Array(24));
        owner = Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
      } else {
        throw new Error("Secure random values are unavailable in this browser.");
      }
      try {
        window.sessionStorage.setItem("clawbox.channelQrOwner", owner);
      } catch {
        // The in-memory owner is sufficient for the current page.
      }
    }
    if (!owner) throw new Error("A QR owner token could not be created.");
    channelQrOwnerRef.current = owner;
    return owner;
  }, []);

  const channelQrHeaders = useCallback((channel: AutoQrChannelId): Record<string, string> => {
    const headers: Record<string, string> = {
      "x-clawbox-qr-owner": getChannelQrOwner(),
    };
    const sessionId = channelQrSessionsRef.current[channel]?.sessionId;
    if (sessionId) headers["x-clawbox-qr-session"] = sessionId;
    return headers;
  }, [getChannelQrOwner]);

  const storeChannelQrSession = useCallback((
    channel: AutoQrChannelId,
    payload: unknown,
  ): ChannelQrSession | null => {
    const session = parseChannelQrSession(payload);
    if (!session) return null;
    setChannelQrSessions((current) => {
      const next = { ...current, [channel]: session };
      channelQrSessionsRef.current = next;
      return next;
    });
    if (session.status === "connected") {
      if (channel === "feishu") {
        setFeishuConfigured(true);
        setFeishuEnabled(true);
        setFeishuDone(true);
        setFeishuStatus({ type: "success", message: "Feishu QR setup completed and the channel is connected." });
      } else {
        setQQBotConfigured(true);
        setQQBotEnabled(true);
        setQQBotDone(true);
        setQQBotStatus({ type: "success", message: "QQ Bot QR setup completed and the channel is connected." });
      }
    }
    return session;
  }, []);

  const channelQrError = (payload: unknown, fallback: string): string => {
    if (isRecordValue(payload) && typeof payload.error === "string" && payload.error.trim()) {
      return payload.error;
    }
    return fallback;
  };

  const refreshChannelQrSession = useCallback(async (
    channel: AutoQrChannelId,
    signal?: AbortSignal,
  ): Promise<ChannelQrSession | null> => {
    try {
      const response = await fetch(`/setup-api/channels/${channel}/qrcode`, {
        headers: channelQrHeaders(channel),
        signal,
        cache: "no-store",
      });
      const payload = await response.json().catch(() => ({}));
      const session = storeChannelQrSession(channel, payload);
      if (!response.ok && response.status !== 409) {
        const message = channelQrError(payload, `Failed to check ${channel} QR setup.`);
        if (channel === "feishu") setFeishuStatus({ type: "error", message });
        else setQQBotStatus({ type: "error", message });
      }
      return session;
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return null;
      const message = error instanceof Error ? error.message : `Failed to check ${channel} QR setup.`;
      if (channel === "feishu") setFeishuStatus({ type: "error", message });
      else setQQBotStatus({ type: "error", message });
      return null;
    }
  }, [channelQrHeaders, storeChannelQrSession]);

  const requestChannelQr = async (channel: AutoQrChannelId): Promise<void> => {
    if (channelQrLoading[channel]) return;
    setChannelQrLoading((current) => ({ ...current, [channel]: true }));
    try {
      const response = await fetch(`/setup-api/channels/${channel}/qrcode`, {
        method: "POST",
        headers: channelQrHeaders(channel),
        cache: "no-store",
      });
      const payload = await response.json().catch(() => ({}));
      const session = storeChannelQrSession(channel, payload);
      if (!response.ok || !session) {
        const message = channelQrError(payload, `Failed to generate ${channel} QR code.`);
        if (channel === "feishu") setFeishuStatus({ type: "error", message });
        else setQQBotStatus({ type: "error", message });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : `Failed to generate ${channel} QR code.`;
      if (channel === "feishu") setFeishuStatus({ type: "error", message });
      else setQQBotStatus({ type: "error", message });
    } finally {
      setChannelQrLoading((current) => ({ ...current, [channel]: false }));
    }
  };

  const cancelChannelQr = async (channel: AutoQrChannelId): Promise<void> => {
    if (channelQrLoading[channel]) return;
    setChannelQrLoading((current) => ({ ...current, [channel]: true }));
    try {
      const response = await fetch(`/setup-api/channels/${channel}/qrcode`, {
        method: "DELETE",
        headers: channelQrHeaders(channel),
        cache: "no-store",
      });
      const payload = await response.json().catch(() => ({}));
      const session = storeChannelQrSession(channel, payload);
      if (!response.ok || !session) {
        const message = channelQrError(payload, `Failed to cancel ${channel} QR setup.`);
        if (channel === "feishu") setFeishuStatus({ type: "error", message });
        else setQQBotStatus({ type: "error", message });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : `Failed to cancel ${channel} QR setup.`;
      if (channel === "feishu") setFeishuStatus({ type: "error", message });
      else setQQBotStatus({ type: "error", message });
    } finally {
      setChannelQrLoading((current) => ({ ...current, [channel]: false }));
    }
  };

  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([
      refreshChannelQrSession("feishu", controller.signal),
      refreshChannelQrSession("qqbot", controller.signal),
    ]);
    return () => controller.abort();
  }, [refreshChannelQrSession]);

  useEffect(() => {
    const activeChannels = (Object.keys(channelQrSessionsRef.current) as AutoQrChannelId[])
      .filter((channel) => {
        const status = channelQrSessionsRef.current[channel]?.status;
        return status === "pending" || status === "saving";
      });
    if (activeChannels.length === 0) return;
    const controller = new AbortController();
    const poll = () => {
      activeChannels.forEach((channel) => {
        void refreshChannelQrSession(channel, controller.signal);
      });
    };
    const timer = window.setInterval(poll, 1_500);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [channelQrSessions.feishu?.status, channelQrSessions.qqbot?.status, refreshChannelQrSession]);

  const refreshWhatsAppConfig = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch("/setup-api/channels/whatsapp", {
      signal,
      cache: "no-store",
    });
    const data = (await response.json().catch(() => null)) as WhatsAppConfigResponse | null;
    if (!response.ok || !data) return null;

    setWhatsAppConfigured(data.configured === true);
    setWhatsAppEnabled(data.configured ? data.enabled === true : true);
    setWhatsAppMode(data.mode === "personal" ? "personal" : "dedicated");
    setWhatsAppOwnerNumber(data.ownerNumber || "");
    return data;
  }, []);

  const refreshWhatsAppStatus = useCallback(async (
    options: { signal?: AbortSignal; announce?: boolean; force?: boolean } = {},
  ) => {
    const response = await fetch(`/setup-api/channels/whatsapp/status${options.force ? "?force=1" : ""}`, {
      signal: options.signal,
      cache: "no-store",
    });
    const data = (await response.json().catch(() => null)) as WhatsAppStatusResponse | null;
    if (!data || typeof data.state !== "string") {
      setWhatsAppDone(false);
      if (options.announce) {
        setWhatsAppStatus({ type: "error", message: "WhatsApp status is unavailable." });
      }
      return null;
    }

    if (typeof data.configured === "boolean") setWhatsAppConfigured(data.configured);
    if (typeof data.enabled === "boolean") setWhatsAppEnabled(data.enabled);
    if (data.mode === "personal" || data.mode === "dedicated") setWhatsAppMode(data.mode);
    if (data.ownerNumber !== undefined) {
      setWhatsAppOwnerNumber(data.ownerNumber || "");
    }
    const connected = data.linked === true && data.connected === true;
    setWhatsAppLinked(data.linked === true);
    setWhatsAppDone(connected);
    setWhatsAppSelfNumber(data.selfNumber || null);

    if (!response.ok || data.state === "error") {
      setWhatsAppStatus({
        type: "error",
        message: data.lastError || data.error || "WhatsApp status is unavailable.",
      });
    } else if (options.announce || connected || data.state === "linked_offline") {
      const message = connected
        ? "WhatsApp is linked and connected."
        : data.state === "linked_offline"
          ? "WhatsApp is linked but currently offline."
          : data.state === "disabled"
            ? "WhatsApp is disabled."
            : data.state === "not_linked"
              ? "WhatsApp is ready for QR linking."
              : "WhatsApp is not configured yet.";
      setWhatsAppStatus({
        type: data.state === "linked_offline" ? "error" : "success",
        message,
      });
    }
    return data;
  }, []);

  const refreshLineConfig = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch("/setup-api/channels/line", {
      signal,
      cache: "no-store",
    });
    const data = (await response.json().catch(() => null)) as LineConfigResponse | null;
    if (!response.ok || !data) return null;

    setLineConfigured(data.configured === true);
    setLineEnabled(data.configured ? data.enabled === true : true);
    setLinePublicBaseUrl(data.publicBaseUrl || "");
    setLinePublicWebhookUrl(data.publicWebhookUrl || null);
    if (data.lastError) setLineStatus({ type: "error", message: data.lastError });
    return data;
  }, []);

  const refreshLineStatus = useCallback(async (
    options: { signal?: AbortSignal; announce?: boolean; force?: boolean } = {},
  ) => {
    const response = await fetch(`/setup-api/channels/line/status${options.force ? "?force=1" : ""}`, {
      signal: options.signal,
      cache: "no-store",
    });
    const data = (await response.json().catch(() => null)) as LineStatusResponse | null;
    if (!data || typeof data.state !== "string") {
      setLineDone(false);
      setLineRunning(false);
      setLineProbeOk(false);
      if (options.announce) {
        setLineStatus({ type: "error", message: "LINE status is unavailable." });
      }
      return null;
    }

    if (typeof data.configured === "boolean") setLineConfigured(data.configured);
    if (typeof data.enabled === "boolean") setLineEnabled(data.enabled);
    if (typeof data.publicBaseUrl === "string") setLinePublicBaseUrl(data.publicBaseUrl);
    if (data.publicWebhookUrl !== undefined) {
      setLinePublicWebhookUrl(data.publicWebhookUrl || null);
    }
    const hasInbound = typeof data.lastInboundAt === "number" && data.lastInboundAt > 0;
    const active = data.state === "active" && hasInbound;
    setLineDone(active);
    setLineRunning(data.running === true);
    setLineProbeOk(data.probe?.ok === true);
    setLineLastInboundAt(hasInbound ? data.lastInboundAt : null);
    setLineBotName(data.probe?.bot?.displayName || null);
    setLineBotBasicId(data.probe?.bot?.basicId || null);

    if (!response.ok || data.state === "error") {
      setLineStatus({
        type: "error",
        message: data.lastError || data.error || "LINE status is unavailable.",
      });
    } else if (options.announce || active || data.state === "ready") {
      const message = active
        ? "LINE received a verified inbound webhook; the channel is active."
        : data.state === "ready"
          ? "LINE credentials are valid and the local listener is ready. Complete the public webhook setup and send a message."
          : data.state === "running"
            ? "LINE local listener is running, but the token probe has not succeeded yet."
            : data.state === "disabled"
              ? "LINE is disabled."
              : "LINE is not configured yet.";
      setLineStatus({
        type: data.state === "running" || data.state === "configured" ? "error" : "success",
        message: data.state === "configured"
          ? "LINE is configured, but the local listener is not running."
          : message,
      });
    }
    return data;
  }, []);

  /* ── Fetch WeChat config on mount ── */
  useEffect(() => {
    const controller = new AbortController();
    refreshWechatState(controller.signal).catch(() => {});
    return () => controller.abort();
  }, [refreshWechatState]);

  /* ── Fetch Telegram config and runtime status on mount ── */
  useEffect(() => {
    const controller = new AbortController();
    refreshTelegramConfig(controller.signal).catch(() => {});
    refreshTelegramStatus({ signal: controller.signal }).catch(() => {});
    return () => controller.abort();
  }, [refreshTelegramConfig, refreshTelegramStatus]);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/setup-api/channels/feishu", { signal: controller.signal, cache: "no-store" })
      .then(async (response) => response.ok ? (await response.json()) as FeishuConfigResponse : null)
      .then((data) => {
        if (!data) return;
        setFeishuConfigured(data.configured);
        setFeishuEnabled(data.configured ? data.enabled : true);
        setFeishuDomain(data.domain);
        if (data.appId) setFeishuAppId(data.appId);
        if (data.lastError) setFeishuStatus({ type: "error", message: data.lastError });
      }).catch(() => {});
    refreshFeishuStatus({ signal: controller.signal }).catch(() => {});
    return () => controller.abort();
  }, [refreshFeishuStatus]);

  useEffect(() => {
    const controller = new AbortController();
    refreshQQBotConfig(controller.signal).catch(() => {});
    refreshQQBotStatus({ signal: controller.signal }).catch(() => {});
    return () => controller.abort();
  }, [refreshQQBotConfig, refreshQQBotStatus]);

  useEffect(() => {
    const controller = new AbortController();
    refreshWeComConfig(controller.signal).catch(() => {});
    refreshWeComStatus({ signal: controller.signal }).catch(() => {});
    return () => controller.abort();
  }, [refreshWeComConfig, refreshWeComStatus]);

  useEffect(() => {
    const controller = new AbortController();
    refreshWhatsAppConfig(controller.signal).catch(() => {});
    refreshWhatsAppStatus({ signal: controller.signal }).catch(() => {});
    return () => controller.abort();
  }, [refreshWhatsAppConfig, refreshWhatsAppStatus]);

  useEffect(() => {
    const controller = new AbortController();
    refreshLineConfig(controller.signal).catch(() => {});
    refreshLineStatus({ signal: controller.signal }).catch(() => {});
    return () => controller.abort();
  }, [refreshLineConfig, refreshLineStatus]);

  const refreshAllChannelStatuses = useCallback(async () => {
    setAdditionalStatusRefreshToken((value) => value + 1);
    await Promise.allSettled([
      refreshWechatState(),
      refreshTelegramStatus({ force: true }),
      refreshFeishuStatus({ force: true }),
      refreshQQBotStatus({ force: true }),
      refreshWeComStatus({ force: true }),
      refreshWhatsAppStatus({ force: true }),
      refreshLineStatus({ force: true }),
    ]);
  }, [refreshFeishuStatus, refreshLineStatus, refreshQQBotStatus, refreshTelegramStatus, refreshWeComStatus, refreshWechatState, refreshWhatsAppStatus]);

  useEffect(() => () => whatsappWaitControllerRef.current?.abort(), []);

  useEffect(() => {
    if (providerDone && !telegramDone) {
      setOpenSection((prev) => (prev === "ai" || prev === null ? "telegram" : prev));
    }
  }, [providerDone, telegramDone]);

  /* ── Fetch system info on mount + poll every 5s ── */
  useEffect(() => {
    let alive = true;
    const fetchInfo = async () => {
      try {
        const r = await fetch("/setup-api/system/info");
        if (!r.ok) throw new Error("Failed to load");
        const data: SystemInfo = await r.json();
        if (!alive) return;
        setInfo(data);
        setStatsHistory((prev) => {
          const next = [...prev, { cpu: data.cpuLoadPercent, gpu: data.gpuLoadPercent, memory: data.memoryUsedPercent, temp: data.temperatureValue, rxBytes: data.networkRxBytes, txBytes: data.networkTxBytes, time: Date.now() }];
          return next.length > MAX_HISTORY ? next.slice(-MAX_HISTORY) : next;
        });
      } catch {
        if (!alive) return;
        setLoadError(true);
      }
    };
    fetchInfo();
    statsPollRef.current = setInterval(fetchInfo, 5000);
    return () => {
      alive = false;
      if (statsPollRef.current) clearInterval(statsPollRef.current);
    };
  }, []);

  /* ── Fetch hotspot defaults on mount ── */
  useEffect(() => {
    const controller = new AbortController();
    fetch("/setup-api/system/hotspot", { signal: controller.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data && !controller.signal.aborted) {
          if (data.ssid) setHotspotName(data.ssid);
          if (typeof data.enabled === "boolean") setHotspotEnabled(data.enabled);
        }
      })
      .catch(() => {});
    return () => controller.abort();
  }, []);

  /* ── Fetch current WiFi connection on mount ── */
  useEffect(() => {
    const controller = new AbortController();
    fetch("/setup-api/wifi/status", { signal: controller.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (
          data &&
          !controller.signal.aborted &&
          typeof data.ssid === "string" &&
          data.ssid.trim()
        ) {
          setWifiConnectedSSID(data.ssid);
        }
      })
      .catch(() => {});
    return () => controller.abort();
  }, []);

  /* ── Update polling ── */
  const stopUpdatePolling = useCallback(() => {
    if (updatePollRef.current) {
      clearInterval(updatePollRef.current);
      updatePollRef.current = null;
    }
    updatePollControllerRef.current?.abort();
    updatePollControllerRef.current = null;
  }, []);

  const startUpdatePolling = useCallback(() => {
    if (updatePollRef.current) return;
    const controller = new AbortController();
    updatePollControllerRef.current = controller;
    let failureCount = 0;
    let serverWentDown = false;
    let requestInFlight = false;

    const poll = async () => {
      if (requestInFlight) return;
      requestInFlight = true;
      try {
        const res = await fetch("/setup-api/update/status", {
          signal: controller.signal,
          cache: "no-store",
        });
        if (controller.signal.aborted) return;
        if (!res.ok) {
          failureCount++;
          if (failureCount >= 3) {
            serverWentDown = true;
            setUpdateServerRestarting(true);
          }
          return;
        }
        if (serverWentDown) setUpdateServerRestarting(false);
        failureCount = 0;
        const data = normalizeUpdateStatus(await res.json());
        if (!data) {
          stopUpdatePolling();
          setUpdateError("Update status response was invalid.");
          return;
        }
        if (controller.signal.aborted) return;
        setUpdateState(data);
        if (data.phase === "completed") {
          stopUpdatePolling();
          if (!updateReloadTimerRef.current) {
            updateReloadTimerRef.current = setTimeout(() => {
              window.location.reload();
            }, 800);
          }
        } else if (data.phase === "failed") {
          stopUpdatePolling();
        }
      } catch {
        if (controller.signal.aborted) return;
        failureCount++;
        if (failureCount >= 3) {
          serverWentDown = true;
          setUpdateServerRestarting(true);
        }
      } finally {
        requestInFlight = false;
      }
    };

    updatePollRef.current = setInterval(() => void poll(), 2000);
    void poll();
  }, [stopUpdatePolling]);

  useEffect(() => () => {
    stopUpdatePolling();
    if (updateReloadTimerRef.current) {
      clearTimeout(updateReloadTimerRef.current);
      updateReloadTimerRef.current = null;
    }
  }, [stopUpdatePolling]);

  /* ── Actions ── */

  const openUpdateConfirm = async () => {
    setVersionLoading(true);
    setUpdateConfirm(true);
    try {
      const [statusRes, branchRes] = await Promise.all([
        fetch("/setup-api/update/status"),
        fetch("/setup-api/system/update-branch"),
      ]);
      if (statusRes.ok) {
        const data = await statusRes.json();
        if (data.versions) setVersionInfo(data.versions);
      }
      if (branchRes.ok) {
        const data = await branchRes.json();
        setUpdateBranch(data.branch ?? null);
        setBranchInput(data.branch ?? "");
      }
    } catch {
      // versions are nice-to-have, dialog still works without them
    } finally {
      setVersionLoading(false);
    }
  };

  const saveUpdateBranch = async (branch: string) => {
    setBranchSaving(true);
    setBranchError(null);
    try {
      const res = await fetch("/setup-api/system/update-branch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ branch: branch || null }),
      });
      const data = await res.json();
      if (res.ok) {
        setUpdateBranch(data.branch ?? null);
      } else {
        setBranchError(data.error || "Failed to set branch");
      }
    } catch (err) {
      setBranchError(err instanceof Error ? err.message : "Failed to set branch");
    } finally {
      setBranchSaving(false);
    }
  };

  const triggerUpdate = async (branch?: string) => {
    setUpdateStarted(true);
    setUpdateAcknowledged(false);
    setUpdateError(null);
    setUpdateServerRestarting(false);
    setUpdateState(null);
    try {
      if (branch) {
        const branchRes = await fetch("/setup-api/system/update-branch", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ branch }),
        });
        if (!branchRes.ok) {
          setUpdateError("Failed to set update branch");
          return;
        }
      }
      const res = await fetch("/setup-api/update/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 409) {
        setUpdateError("An update is already in progress.");
        return;
      }
      if (!res.ok) {
        setUpdateError(typeof data.error === "string" ? data.error : "Failed to start update");
        return;
      }
      setUpdateAcknowledged(true);
      startUpdatePolling();
    } catch (err) {
      setUpdateError(err instanceof Error ? err.message : "Failed to start update");
    }
  };

  const completeSetup = async () => {
    if (!canFinishSetup) {
      setCompleteError("Finish setup is available after WiFi and AI are configured.");
      return;
    }

    setFinishing(true);
    setCompleteError(null);
    try {
      const res = await fetch("/setup-api/setup/complete", { method: "POST" });
      if (res.ok) {
        window.location.href = "/";
        return;
      }
      const data = await res.json().catch(() => ({}));
      setCompleteError(data.error || "Failed to complete setup");
    } catch (err) {
      setCompleteError(err instanceof Error ? err.message : "Failed to complete setup");
    } finally {
      setFinishing(false);
    }
  };

  const saveSecurity = async () => {
    if (password || confirmPassword) {
      if (password.length < 8) {
        setSecStatus({ type: "error", message: "Password must be at least 8 characters" });
        return;
      }
      if (password !== confirmPassword) {
        setSecStatus({ type: "error", message: "Passwords do not match" });
        return;
      }
    }
    if (hotspotEnabled && !hotspotName.trim()) {
      setSecStatus({ type: "error", message: "Hotspot name is required" });
      return;
    }
    if (hotspotPassword && hotspotPassword.length < 8) {
      setSecStatus({ type: "error", message: "Hotspot password must be at least 8 characters" });
      return;
    }

    setSecSaving(true);
    setSecStatus(null);
    try {
      if (password) {
        const res = await fetch("/setup-api/system/credentials", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ password }),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          setSecStatus({ type: "error", message: data.error || "Failed to set password" });
          return;
        }
      }
      const hotspotRes = await fetch("/setup-api/system/hotspot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ssid: hotspotName.trim(),
          password: hotspotPassword || undefined,
          enabled: hotspotEnabled,
        }),
      });
      if (!hotspotRes.ok) {
        const data = await hotspotRes.json().catch(() => ({}));
        setSecStatus({ type: "error", message: data.error || "Failed to save hotspot settings" });
        return;
      }
      setSecStatus({ type: "success", message: "Settings saved!" });
      if (password) setSecurityDone(true);
      setPassword("");
      setConfirmPassword("");
    } catch (err) {
      setSecStatus({
        type: "error",
        message: `Failed: ${err instanceof Error ? err.message : err}`,
      });
    } finally {
      setSecSaving(false);
    }
  };

  const saveWechat = async () => {
    if (!canConfigureWechat) {
      setWechatStatus({
        type: "error",
        message: "Configure your AI provider before setting up WeChat.",
      });
      return;
    }

    setWechatSaving(true);
    setWechatStatus(null);
    try {
      const res = await fetch("/setup-api/wechat/configure", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ botToken: wechatToken.trim() || undefined, enabled: wechatEnabled }),
      });
      const data = (await res.json().catch(() => ({}))) as WechatConfigResponse;
      if (!res.ok) {
        setWechatStatus({ type: "error", message: data.error || "Failed to save" });
        return;
      }
      const connected = data.connected === true;
      setWechatDone(connected);
      setWechatStatus({
        type: "success",
        message: connected
          ? "WeChat bot settings saved and channel is connected."
          : "WeChat bot settings saved. Use QR login to complete channel connection.",
      });
    } catch (err) {
      setWechatStatus({
        type: "error",
        message: `Failed: ${err instanceof Error ? err.message : err}`,
      });
    } finally {
      setWechatSaving(false);
    }
  };

  const saveTelegram = async () => {
    if (!canConfigureTelegram) {
      setTelegramStatus({
        type: "error",
        message: "Configure your AI provider before setting up Telegram.",
      });
      return;
    }

    setTelegramSaving(true);
    setTelegramStatus(null);
    try {
      const response = await fetch("/setup-api/channels/telegram", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          botToken: telegramToken.trim() || undefined,
          enabled: telegramEnabled,
        }),
      });
      const data = await response.json().catch(() => ({})) as {
        error?: string;
        saved?: boolean;
        configured?: boolean;
        enabled?: boolean;
        connected?: boolean;
        botUsername?: string | null;
        bot?: { username?: string } | null;
      };

      if (!response.ok) {
        if (data.saved || data.configured) setTelegramConfigured(true);
        setTelegramDone(false);
        setTelegramStatus({
          type: "error",
          message: data.error || "Failed to save Telegram settings.",
        });
        return;
      }

      const connected = data.connected === true;
      const botUsername = data.botUsername || data.bot?.username || null;
      setTelegramConfigured(data.configured === true);
      setTelegramEnabled(data.enabled === true);
      setTelegramDone(connected);
      setTelegramBotUsername(botUsername);
      setTelegramToken("");
      setTelegramStatus({
        type: "success",
        message: data.enabled === false
          ? "Telegram is disabled. Your saved token is retained for re-enabling later."
          : `Telegram is online${botUsername ? ` as @${botUsername}` : ""}. Send /start to the bot, then approve the request below.`,
      });
    } catch (error) {
      setTelegramStatus({
        type: "error",
        message: `Failed: ${error instanceof Error ? error.message : error}`,
      });
    } finally {
      setTelegramSaving(false);
    }
  };

  const checkTelegramStatus = async () => {
    setTelegramChecking(true);
    try {
      await refreshTelegramStatus({ announce: true, force: true });
    } catch (error) {
      setTelegramStatus({
        type: "error",
        message: `Status check failed: ${error instanceof Error ? error.message : error}`,
      });
    } finally {
      setTelegramChecking(false);
    }
  };

  const refreshTelegramPairingRequests = async () => {
    setTelegramPairingLoading(true);
    try {
      const response = await fetch("/setup-api/channels/telegram/pairing", {
        cache: "no-store",
      });
      const data = await response.json().catch(() => ({})) as {
        error?: string;
        requests?: TelegramPairingRequest[];
      };
      if (!response.ok) {
        setTelegramStatus({
          type: "error",
          message: data.error || "Failed to load Telegram pairing requests.",
        });
        return;
      }
      const requests = Array.isArray(data.requests) ? data.requests : [];
      setTelegramPairingRequests(requests);
      setTelegramStatus({
        type: "success",
        message: requests.length
          ? `${requests.length} Telegram pairing request${requests.length === 1 ? "" : "s"} waiting for approval.`
          : "No pending request yet. Send /start to the bot, then refresh this list.",
      });
    } catch (error) {
      setTelegramStatus({
        type: "error",
        message: `Failed: ${error instanceof Error ? error.message : error}`,
      });
    } finally {
      setTelegramPairingLoading(false);
    }
  };

  const approveTelegramRequest = async (code: string) => {
    setTelegramApprovingCode(code);
    try {
      const response = await fetch("/setup-api/channels/telegram/pairing", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      const data = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) {
        setTelegramStatus({
          type: "error",
          message: data.error || "Failed to approve Telegram user.",
        });
        return;
      }
      setTelegramPairingRequests((current) => current.filter((request) => request.code !== code));
      setTelegramStatus({
        type: "success",
        message: "Telegram user approved. Send another message to verify the AI reply.",
      });
    } catch (error) {
      setTelegramStatus({
        type: "error",
        message: `Failed: ${error instanceof Error ? error.message : error}`,
      });
    } finally {
      setTelegramApprovingCode(null);
    }
  };

  const saveFeishu = async () => {
    if (!canConfigureFeishu) return setFeishuStatus({ type: "error", message: "Configure your AI provider before setting up Feishu." });
    setFeishuSaving(true); setFeishuStatus(null);
    try {
      const response = await fetch("/setup-api/channels/feishu", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ appId: feishuAppId.trim() || undefined, appSecret: feishuAppSecret.trim() || undefined, domain: feishuDomain, enabled: feishuEnabled }) });
      const data = await response.json().catch(() => ({})) as { error?: string; saved?: boolean; configured?: boolean; enabled?: boolean; connected?: boolean; botName?: string | null };
      if (!response.ok) {
        if (data.saved || data.configured) setFeishuConfigured(true);
        setFeishuDone(false); setFeishuStatus({ type: "error", message: data.error || "Failed to save Feishu settings." }); return;
      }
      setFeishuConfigured(data.configured === true); setFeishuEnabled(data.enabled === true); setFeishuDone(data.connected === true); setFeishuBotName(data.botName || null); setFeishuAppSecret("");
      setFeishuStatus({ type: "success", message: data.enabled === false ? "Feishu is disabled. Your saved credentials are retained." : `Feishu is online${data.botName ? ` as ${data.botName}` : ""}. Send the bot a private message, then approve the request below.` });
    } catch (error) { setFeishuStatus({ type: "error", message: `Failed: ${error instanceof Error ? error.message : error}` }); }
    finally { setFeishuSaving(false); }
  };

  const refreshFeishuPairingRequests = async () => {
    setFeishuPairingLoading(true);
    try {
      const response = await fetch("/setup-api/channels/feishu/pairing", { cache: "no-store" });
      const data = await response.json().catch(() => ({})) as { error?: string; requests?: FeishuPairingRequest[] };
      if (!response.ok) return setFeishuStatus({ type: "error", message: data.error || "Failed to load Feishu pairing requests." });
      const requests = Array.isArray(data.requests) ? data.requests : []; setFeishuPairingRequests(requests);
      setFeishuStatus({ type: "success", message: requests.length ? `${requests.length} Feishu pairing request${requests.length === 1 ? "" : "s"} waiting for approval.` : "No pending request yet. Send the bot a private message, then refresh this list." });
    } catch (error) { setFeishuStatus({ type: "error", message: `Failed: ${error instanceof Error ? error.message : error}` }); }
    finally { setFeishuPairingLoading(false); }
  };

  const approveFeishuRequest = async (code: string) => {
    setFeishuApprovingCode(code);
    try {
      const response = await fetch("/setup-api/channels/feishu/pairing", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code }) });
      const data = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) return setFeishuStatus({ type: "error", message: data.error || "Failed to approve Feishu user." });
      setFeishuPairingRequests((current) => current.filter((request) => request.code !== code));
      setFeishuStatus({ type: "success", message: "Feishu user approved. Send another message to verify the AI reply." });
    } catch (error) { setFeishuStatus({ type: "error", message: `Failed: ${error instanceof Error ? error.message : error}` }); }
    finally { setFeishuApprovingCode(null); }
  };

  const saveQQBot = async () => {
    if (!canConfigureQQBot) {
      setQQBotStatus({
        type: "error",
        message: "Configure your AI provider before setting up QQ Bot.",
      });
      return;
    }

    setQQBotSaving(true);
    setQQBotStatus(null);
    try {
      const response = await fetch("/setup-api/channels/qqbot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          appId: qqbotAppId.trim() || undefined,
          clientSecret: qqbotAppSecret.trim() || undefined,
          enabled: qqbotEnabled,
        }),
      });
      const data = await response.json().catch(() => ({})) as {
        error?: string;
        saved?: boolean;
        configured?: boolean;
        enabled?: boolean;
        connected?: boolean;
        appId?: string | null;
      };

      if (!response.ok) {
        if (data.saved || data.configured) setQQBotConfigured(true);
        setQQBotDone(false);
        setQQBotStatus({
          type: "error",
          message: data.error || "Failed to save QQ Bot settings.",
        });
        return;
      }

      setQQBotConfigured(data.configured === true);
      setQQBotEnabled(data.enabled === true);
      setQQBotDone(data.connected === true);
      if (data.appId) setQQBotAppId(data.appId);
      setQQBotAppSecret("");
      setQQBotStatus({
        type: "success",
        message: data.enabled === false
          ? "QQ Bot is disabled. Your saved credentials are retained."
          : "QQ Bot is online. Open the bot in QQ and send a private message to test the AI reply; no ClawBox pairing approval is required.",
      });
    } catch (error) {
      setQQBotStatus({
        type: "error",
        message: `Failed: ${error instanceof Error ? error.message : error}`,
      });
    } finally {
      setQQBotSaving(false);
    }
  };

  const checkQQBotStatus = async () => {
    setQQBotChecking(true);
    try {
      await refreshQQBotStatus({ announce: true, force: true });
    } catch (error) {
      setQQBotStatus({
        type: "error",
        message: `Status check failed: ${error instanceof Error ? error.message : error}`,
      });
    } finally {
      setQQBotChecking(false);
    }
  };

  const saveWeCom = async () => {
    if (!canConfigureWeCom) {
      setWeComStatus({
        type: "error",
        message: "Configure your AI provider before setting up WeCom.",
      });
      return;
    }

    setWeComSaving(true);
    setWeComStatus(null);
    try {
      const response = await fetch("/setup-api/channels/wecom", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          botId: wecomBotId.trim() || undefined,
          secret: wecomSecret.trim() || undefined,
          enabled: wecomEnabled,
        }),
      });
      const data = await response.json().catch(() => ({})) as {
        error?: string;
        saved?: boolean;
        configured?: boolean;
        enabled?: boolean;
        connected?: boolean;
        botId?: string | null;
      };

      if (!response.ok) {
        if (data.saved || data.configured) setWeComConfigured(true);
        setWeComDone(false);
        setWeComStatus({
          type: "error",
          message: data.error || "Failed to save WeCom settings.",
        });
        return;
      }

      setWeComConfigured(data.configured === true);
      setWeComEnabled(data.enabled === true);
      setWeComDone(data.connected === true);
      if (data.botId) setWeComBotId(data.botId);
      setWeComSecret("");
      setWeComStatus({
        type: "success",
        message: data.enabled === false
          ? "WeCom is disabled. Your saved credentials are retained."
          : "WeCom settings saved. Check status to confirm the WebSocket channel is online.",
      });
    } catch (error) {
      setWeComStatus({
        type: "error",
        message: `Failed: ${error instanceof Error ? error.message : error}`,
      });
    } finally {
      setWeComSaving(false);
    }
  };

  const checkWeComStatus = async () => {
    setWeComChecking(true);
    try {
      await refreshWeComStatus({ announce: true, force: true });
    } catch (error) {
      setWeComDone(false);
      setWeComStatus({
        type: "error",
        message: `Status check failed: ${error instanceof Error ? error.message : error}`,
      });
    } finally {
      setWeComChecking(false);
    }
  };

  const waitForWhatsAppScan = async (initialQrDataUrl: string) => {
    whatsappWaitControllerRef.current?.abort();
    const controller = new AbortController();
    whatsappWaitControllerRef.current = controller;
    setWhatsAppWaiting(true);
    let currentQrDataUrl = initialQrDataUrl;
    const deadline = Date.now() + 180_000;

    try {
      while (!controller.signal.aborted && Date.now() < deadline) {
        const response = await fetch("/setup-api/channels/whatsapp/login-status", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            timeoutMs: 15_000,
            currentQrDataUrl,
          }),
          cache: "no-store",
          signal: controller.signal,
        });
        const data = (await response.json().catch(() => ({}))) as WhatsAppQrResponse;
        if (!response.ok) {
          setWhatsAppQrDataUrl(null);
          setWhatsAppStatus({
            type: "error",
            message: data.error || "Failed to check WhatsApp QR login status.",
          });
          return;
        }
        if (data.qrDataUrl) {
          currentQrDataUrl = data.qrDataUrl;
          setWhatsAppQrDataUrl(data.qrDataUrl);
        }
        if (data.connected === true) {
          setWhatsAppQrDataUrl(null);
          setWhatsAppLinked(true);
          setWhatsAppDone(false);
          setWhatsAppStatus({
            type: "success",
            message: whatsappMode === "dedicated"
              ? "WhatsApp linked successfully. Send a private message, then approve the sender below."
              : "WhatsApp linked successfully. Send a message in your own chat to test it.",
          });
          await refreshWhatsAppStatus({ announce: true, force: true });
          return;
        }
      }

      if (!controller.signal.aborted) {
        setWhatsAppQrDataUrl(null);
        setWhatsAppStatus({
          type: "error",
          message: "WhatsApp QR linking timed out. Refresh the QR code and try again.",
        });
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setWhatsAppQrDataUrl(null);
      setWhatsAppStatus({
        type: "error",
        message: `Failed: ${error instanceof Error ? error.message : error}`,
      });
    } finally {
      if (whatsappWaitControllerRef.current === controller) {
        whatsappWaitControllerRef.current = null;
        setWhatsAppWaiting(false);
      }
    }
  };

  const requestWhatsAppQr = async (force = false) => {
    whatsappWaitControllerRef.current?.abort();
    setWhatsAppQrLoading(true);
    setWhatsAppStatus(null);
    try {
      const response = await fetch("/setup-api/channels/whatsapp/qrcode", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ force }),
        cache: "no-store",
      });
      const data = (await response.json().catch(() => ({}))) as WhatsAppQrResponse;
      if (!response.ok) {
        setWhatsAppQrDataUrl(null);
        setWhatsAppStatus({
          type: "error",
          message: data.error || "Failed to generate a WhatsApp QR code.",
        });
        return;
      }
      if (data.connected === true) {
        setWhatsAppQrDataUrl(null);
        await refreshWhatsAppStatus({ announce: true, force: true });
        return;
      }
      if (!data.qrDataUrl) {
        setWhatsAppQrDataUrl(null);
        setWhatsAppStatus({
          type: "error",
          message: data.message || "WhatsApp did not return a QR code.",
        });
        return;
      }

      setWhatsAppQrDataUrl(data.qrDataUrl);
      setWhatsAppStatus({
        type: "success",
        message: "WhatsApp QR code is ready. Scan it from Linked devices.",
      });
      void waitForWhatsAppScan(data.qrDataUrl);
    } catch (error) {
      setWhatsAppQrDataUrl(null);
      setWhatsAppStatus({
        type: "error",
        message: `Failed: ${error instanceof Error ? error.message : error}`,
      });
    } finally {
      setWhatsAppQrLoading(false);
    }
  };

  const prepareWhatsApp = async () => {
    if (!canConfigureWhatsApp) {
      setWhatsAppStatus({
        type: "error",
        message: "Configure your AI provider before setting up WhatsApp.",
      });
      return;
    }
    if (whatsappEnabled && whatsappMode === "personal" && !whatsappOwnerNumber.trim()) {
      setWhatsAppStatus({
        type: "error",
        message: "Your WhatsApp number is required in personal-number mode.",
      });
      return;
    }

    setWhatsAppPreparing(true);
    setWhatsAppStatus(null);
    try {
      const endpoint = whatsappEnabled
        ? "/setup-api/channels/whatsapp/prepare"
        : "/setup-api/channels/whatsapp";
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          whatsappEnabled
            ? {
                mode: whatsappMode,
                ownerNumber:
                  whatsappMode === "personal"
                    ? whatsappOwnerNumber.trim()
                    : undefined,
              }
            : { enabled: false },
        ),
      });
      const data = (await response.json().catch(() => ({}))) as {
        error?: string;
        saved?: boolean;
        config?: WhatsAppConfigResponse;
      };
      if (!response.ok) {
        if (data.saved) setWhatsAppConfigured(true);
        setWhatsAppStatus({
          type: "error",
          message: data.error || "Failed to prepare WhatsApp.",
        });
        return;
      }

      setWhatsAppConfigured(data.config?.configured ?? true);
      if (!whatsappEnabled) {
        whatsappWaitControllerRef.current?.abort();
        setWhatsAppDone(false);
        setWhatsAppLinked(false);
        setWhatsAppSelfNumber(null);
        setWhatsAppQrDataUrl(null);
        setWhatsAppPairingRequests([]);
        setWhatsAppStatus({ type: "success", message: "WhatsApp is disabled." });
        return;
      }

      setWhatsAppStatus({
        type: "success",
        message: "WhatsApp was prepared. Generating a QR code now.",
      });
      await requestWhatsAppQr(false);
    } catch (error) {
      setWhatsAppStatus({
        type: "error",
        message: `Failed: ${error instanceof Error ? error.message : error}`,
      });
    } finally {
      setWhatsAppPreparing(false);
    }
  };

  const checkWhatsAppStatus = async () => {
    setWhatsAppChecking(true);
    try {
      await refreshWhatsAppStatus({ announce: true, force: true });
    } catch (error) {
      setWhatsAppDone(false);
      setWhatsAppStatus({
        type: "error",
        message: `Status check failed: ${error instanceof Error ? error.message : error}`,
      });
    } finally {
      setWhatsAppChecking(false);
    }
  };

  const refreshWhatsAppPairingRequests = async () => {
    setWhatsAppPairingLoading(true);
    try {
      const response = await fetch("/setup-api/channels/whatsapp/pairing", {
        cache: "no-store",
      });
      const data = (await response.json().catch(() => ({}))) as {
        error?: string;
        requests?: WhatsAppPairingRequest[];
      };
      if (!response.ok) {
        setWhatsAppStatus({
          type: "error",
          message: data.error || "Failed to load WhatsApp pairing requests.",
        });
        return;
      }
      const requests = Array.isArray(data.requests) ? data.requests : [];
      setWhatsAppPairingRequests(requests);
      setWhatsAppStatus({
        type: "success",
        message: requests.length
          ? "WhatsApp pairing requests refreshed."
          : "No pending WhatsApp pairing requests.",
      });
    } catch (error) {
      setWhatsAppStatus({
        type: "error",
        message: `Failed: ${error instanceof Error ? error.message : error}`,
      });
    } finally {
      setWhatsAppPairingLoading(false);
    }
  };

  const approveWhatsAppRequest = async (code: string) => {
    setWhatsAppApprovingCode(code);
    try {
      const response = await fetch("/setup-api/channels/whatsapp/pairing", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      const data = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) {
        setWhatsAppStatus({
          type: "error",
          message: data.error || "Failed to approve WhatsApp user.",
        });
        return;
      }
      setWhatsAppPairingRequests((current) =>
        current.filter((request) => request.code !== code),
      );
      setWhatsAppStatus({
        type: "success",
        message: "WhatsApp user approved. Send another message to verify the AI reply.",
      });
    } catch (error) {
      setWhatsAppStatus({
        type: "error",
        message: `Failed: ${error instanceof Error ? error.message : error}`,
      });
    } finally {
      setWhatsAppApprovingCode(null);
    }
  };

  const logoutWhatsApp = async () => {
    const confirmation = locale === "zh-CN"
      ? "确定要解除此设备上的 WhatsApp 关联吗？之后需要重新扫码。"
      : "Unlink WhatsApp from this device? You will need to scan a new QR code to reconnect.";
    if (!window.confirm(confirmation)) return;

    setWhatsAppLogoutBusy(true);
    try {
      const response = await fetch("/setup-api/channels/whatsapp/logout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const data = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) {
        setWhatsAppStatus({
          type: "error",
          message: data.error || "Failed to unlink WhatsApp.",
        });
        return;
      }
      whatsappWaitControllerRef.current?.abort();
      setWhatsAppDone(false);
      setWhatsAppLinked(false);
      setWhatsAppSelfNumber(null);
      setWhatsAppQrDataUrl(null);
      setWhatsAppPairingRequests([]);
      setWhatsAppStatus({ type: "success", message: "WhatsApp was unlinked." });
    } catch (error) {
      setWhatsAppStatus({
        type: "error",
        message: `Failed: ${error instanceof Error ? error.message : error}`,
      });
    } finally {
      setWhatsAppLogoutBusy(false);
    }
  };

  const saveLine = async () => {
    if (!canConfigureLine) {
      setLineStatus({
        type: "error",
        message: "Configure your AI provider before setting up LINE.",
      });
      return;
    }

    setLineSaving(true);
    setLineStatus(null);
    try {
      const response = await fetch("/setup-api/channels/line", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          channelAccessToken: lineAccessToken.trim() || undefined,
          channelSecret: lineChannelSecret.trim() || undefined,
          publicBaseUrl: linePublicBaseUrl.trim(),
          enabled: lineEnabled,
        }),
      });
      const data = (await response.json().catch(() => ({}))) as LineStatusResponse & {
        error?: string;
        saved?: boolean;
      };
      if (!response.ok) {
        if (data.saved || data.configured) setLineConfigured(true);
        if (typeof data.enabled === "boolean") setLineEnabled(data.enabled);
        if (data.publicBaseUrl !== undefined) {
          setLinePublicBaseUrl(data.publicBaseUrl || "");
        }
        if (data.publicWebhookUrl !== undefined) {
          setLinePublicWebhookUrl(data.publicWebhookUrl || null);
        }
        setLineWebhookCopied(false);
        const failureMessage = data.error || "Failed to save LINE settings.";
        try {
          await refreshLineStatus({ force: true });
        } catch {
          setLineDone(false);
          setLineRunning(false);
          setLineProbeOk(false);
        }
        setLineStatus({
          type: "error",
          message: failureMessage,
        });
        return;
      }

      setLineConfigured(data.configured === true);
      setLineEnabled(data.enabled === true);
      setLinePublicBaseUrl(data.publicBaseUrl || linePublicBaseUrl.trim());
      setLinePublicWebhookUrl(data.publicWebhookUrl || null);
      setLineWebhookCopied(false);
      setLineRunning(data.running === true);
      setLineProbeOk(data.probe?.ok === true);
      const hasInbound = typeof data.lastInboundAt === "number" && data.lastInboundAt > 0;
      setLineLastInboundAt(hasInbound ? data.lastInboundAt : null);
      setLineBotName(data.probe?.bot?.displayName || null);
      setLineBotBasicId(data.probe?.bot?.basicId || null);
      const active = data.state === "active" && hasInbound;
      setLineDone(active);
      setLineAccessToken("");
      setLineChannelSecret("");
      setLineStatus({
        type: "success",
        message: data.enabled === false
          ? "LINE is disabled."
          : active
            ? "LINE received a verified inbound webhook; the channel is active."
            : "LINE credentials are valid and the local listener is ready. Complete the public webhook setup and send a message.",
      });
    } catch (error) {
      setLineDone(false);
      setLineRunning(false);
      setLineProbeOk(false);
      setLineStatus({
        type: "error",
        message: `Failed: ${error instanceof Error ? error.message : error}`,
      });
    } finally {
      setLineSaving(false);
    }
  };

  const checkLineStatus = async () => {
    setLineChecking(true);
    try {
      await refreshLineStatus({ announce: true, force: true });
    } catch (error) {
      setLineDone(false);
      setLineRunning(false);
      setLineProbeOk(false);
      setLineStatus({
        type: "error",
        message: `Status check failed: ${error instanceof Error ? error.message : error}`,
      });
    } finally {
      setLineChecking(false);
    }
  };

  const copyLineWebhookUrl = async () => {
    if (!linePublicWebhookUrl) return;
    try {
      await navigator.clipboard.writeText(linePublicWebhookUrl);
      setLineWebhookCopied(true);
    } catch (error) {
      setLineStatus({
        type: "error",
        message: `Failed: ${error instanceof Error ? error.message : error}`,
      });
    }
  };

  const refreshLinePairingRequests = async () => {
    setLinePairingLoading(true);
    try {
      const response = await fetch("/setup-api/channels/line/pairing", {
        cache: "no-store",
      });
      const data = (await response.json().catch(() => ({}))) as {
        error?: string;
        requests?: LinePairingRequest[];
      };
      if (!response.ok) {
        setLineStatus({
          type: "error",
          message: data.error || "Failed to load LINE pairing requests.",
        });
        return;
      }
      const requests = Array.isArray(data.requests) ? data.requests : [];
      setLinePairingRequests(requests);
      setLineStatus({
        type: "success",
        message: requests.length
          ? "LINE pairing requests refreshed."
          : "No pending LINE pairing requests.",
      });
    } catch (error) {
      setLineStatus({
        type: "error",
        message: `Failed: ${error instanceof Error ? error.message : error}`,
      });
    } finally {
      setLinePairingLoading(false);
    }
  };

  const approveLineRequest = async (code: string) => {
    setLineApprovingCode(code);
    try {
      const response = await fetch("/setup-api/channels/line/pairing", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      const data = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) {
        setLineStatus({
          type: "error",
          message: data.error || "Failed to approve LINE user.",
        });
        return;
      }
      setLinePairingRequests((current) =>
        current.filter((request) => request.code !== code),
      );
      setLineStatus({
        type: "success",
        message: "LINE user approved. Send another message to verify the AI reply.",
      });
    } catch (error) {
      setLineStatus({
        type: "error",
        message: `Failed: ${error instanceof Error ? error.message : error}`,
      });
    } finally {
      setLineApprovingCode(null);
    }
  };

  const waitWechatConnected = async (maxMs = 90_000) => {
    const started = Date.now();
    while (Date.now() - started < maxMs) {
      try {
        const r = await fetch("/setup-api/wechat/login-status", { cache: "no-store" });
        if (r.ok) {
          const s = (await r.json().catch(() => null)) as WechatConfigResponse | null;
          if (s?.connected) {
            setWechatDone(true);
            await refreshWechatState().catch(() => {});
            setWechatStatus({
              type: "success",
              message: `WeChat connected${s.accountIds?.[0] ? ` (account: ${s.accountIds[0]})` : ""}.`,
            });
            return true;
          }
        }
      } catch {
        // keep waiting
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    return false;
  };

  const waitWechatQr = async (sessionId: string, maxMs = 150_000) => {
    const started = Date.now();
    let lastError = "WeChat QR code is still starting.";

    while (Date.now() - started < maxMs) {
      try {
        const response = await fetch("/setup-api/wechat/qrcode", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId }),
          cache: "no-store",
        });
        const data = (await response.json().catch(() => ({}))) as WechatQrResponse;

        if (data.qrUrl) return data;
        if (!response.ok || data.state === "failed" || data.state === "expired") {
          throw new Error(data.error || data.message || "Failed to generate WeChat QR code");
        }
        if (data.message) lastError = data.message;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        if (Date.now() - started >= maxMs - 1_000) throw new Error(lastError);
      }

      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }

    throw new Error(lastError);
  };

  const requestWechatQrCode = async () => {
    if (!canConfigureWechat) {
      setWechatStatus({
        type: "error",
        message: "Configure your AI provider before setting up WeChat.",
      });
      return;
    }

    setWechatQrLoading(true);
    setWechatStatus(null);
    const refreshingExistingQr = Boolean(wechatQrUrl);
    if (refreshingExistingQr) setWechatQrUrl(null);
    try {
      const res = await fetch("/setup-api/wechat/qrcode", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refresh: refreshingExistingQr }),
        cache: "no-store",
      });
      let data = (await res.json().catch(() => ({}))) as WechatQrResponse;
      if (res.status === 202 && data?.pending) {
        setWechatStatus({
          type: "success",
          message: data.message || "Login is starting. The page will check again shortly.",
        });
        if (!data.sessionId) {
          throw new Error("WeChat QR login did not return a session id.");
        }
        data = await waitWechatQr(data.sessionId);
      }
      if (!res.ok || !data.qrUrl) {
        setWechatStatus({ type: "error", message: data.error || "Failed to refresh QR code" });
        return;
      }
      setWechatQrUrl(data.qrUrl);
      setWechatLinkCopied(false);
      setWechatStatus({
        type: "success",
        message: "QR code refreshed. Please scan now; this page will auto-detect connection status.",
      });

      const connected = await waitWechatConnected();
      if (!connected) {
        setWechatStatus({
          type: "error",
          message: "QR scanned but not confirmed yet. Click Refresh QR and keep this page open until connected.",
        });
      }
    } catch (err) {
      setWechatStatus({
        type: "error",
        message: `Failed: ${err instanceof Error ? err.message : err}`,
      });
    } finally {
      setWechatQrLoading(false);
    }
  };

  const openWechatMcpLink = () => {
    if (!wechatQrUrl) {
      setWechatStatus({ type: "error", message: "Please click Get QR first." });
      return;
    }
    setWechatStatus({
      type: "success",
      message: "Opening WeChat login link. After authorization, return to this page and click 'Check Status'.",
    });
    window.location.href = wechatQrUrl;
  };

  const copyWechatMcpLink = async () => {
    if (!wechatQrUrl) {
      setWechatStatus({ type: "error", message: "Please click Get QR first." });
      return;
    }
    try {
      await navigator.clipboard.writeText(wechatQrUrl);
      setWechatLinkCopied(true);
      setWechatStatus({
        type: "success",
        message: "Link copied. Open WeChat and paste the link in any chat, then tap it to authorize.",
      });
    } catch {
      setWechatStatus({
        type: "error",
        message: "Copy failed. Please use 'Open in WeChat' or open QR link directly.",
      });
    }
  };

  const verifyWechatNow = async () => {
    setWechatStatus({ type: "success", message: "Checking WeChat connection status..." });
    const ok = await waitWechatConnected(12_000);
    if (!ok) {
      setWechatStatus({
        type: "error",
        message: "Not connected yet. Complete authorization in WeChat, then click Check Status again.",
      });
    }
  };

  const stopDevicePolling = useCallback(() => {
    setDevicePolling(false);
    if (devicePollRef.current) {
      clearTimeout(devicePollRef.current);
      devicePollRef.current = null;
    }
    aiPollControllerRef.current?.abort();
  }, []);
  useEffect(() => {
    return () => {
      stopDevicePolling();
      aiSaveControllerRef.current?.abort();
      aiExchangeControllerRef.current?.abort();
      aiOauthStartControllerRef.current?.abort();
      wifiControllerRef.current?.abort();
    };
  }, [stopDevicePolling]);

  const resetAiFields = () => {
    stopDevicePolling();
    setAiApiKey("");
    setShowAiKey(false);
    setAiStatus(null);
    setAiOauthStarted(false);
    setAiAuthCode("");
    setDeviceCode(null);
    setDeviceUrl(null);
    setDeviceSaving(false);
  };

  const saveDeviceToken = async (tokenData: { access_token: string; refresh_token?: string; expires_in?: number }) => {
    aiSaveControllerRef.current?.abort();
    const controller = new AbortController();
    aiSaveControllerRef.current = controller;

    setDeviceSaving(true);
    try {
      const saveRes = await fetch("/setup-api/ai-models/configure", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: aiProvider, apiKey: tokenData.access_token, authMode: "subscription", refreshToken: tokenData.refresh_token, expiresIn: tokenData.expires_in }),
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      if (!saveRes.ok) {
        const data = await saveRes.json().catch(() => ({}));
        setAiStatus({ type: "error", message: data.error || "Failed to save token" });
        return;
      }
      const saveData = await saveRes.json();
      if (controller.signal.aborted) return;
      if (saveData.success) {
        const { closeHint } = tryCloseOAuthWindow(oauthWindowRef);
        setAiStatus({ type: "success", message: "GPT subscription connected!" + closeHint });
        setProviderDone(true);
        setProviderName(aiProvider);
        setDeviceCode(null);
        setDeviceUrl(null);
        setTimeout(() => { setAiStatus(null); }, 1500);
      } else {
        setAiStatus({ type: "error", message: saveData.error || "Failed to save token" });
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      setAiStatus({ type: "error", message: `Failed: ${err instanceof Error ? err.message : err}` });
    } finally {
      if (!controller.signal.aborted) setDeviceSaving(false);
    }
  };

  const pollDeviceAuth = useCallback(async (interval: number) => {
    aiPollControllerRef.current?.abort();
    const controller = new AbortController();
    aiPollControllerRef.current = controller;

    try {
      const res = await fetch("/setup-api/ai-models/oauth/device-poll", {
        method: "POST",
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        stopDevicePolling();
        setAiStatus({ type: "error", message: data.error || "Polling failed" });
        return;
      }
      const data = await res.json();
      if (controller.signal.aborted) return;
      if (data.status === "complete" && data.access_token) {
        stopDevicePolling();
        await saveDeviceToken(data);
        return;
      }
      if (data.status === "pending") {
        devicePollRef.current = setTimeout(() => pollDeviceAuth(interval), interval * 1000);
        return;
      }
      if (data.error) {
        stopDevicePolling();
        setAiStatus({ type: "error", message: data.error });
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      // Network error — retry
      devicePollRef.current = setTimeout(() => pollDeviceAuth(interval), interval * 1000);
    }
  }, [stopDevicePolling, aiProvider]); // eslint-disable-line react-hooks/exhaustive-deps

  const startDeviceAuth = async () => {
    stopDevicePolling();
    aiOauthStartControllerRef.current?.abort();
    const controller = new AbortController();
    aiOauthStartControllerRef.current = controller;

    setAiStatus(null);
    setDeviceCode(null);
    setDeviceUrl(null);
    try {
      const res = await fetch("/setup-api/ai-models/oauth/device-start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: aiProvider }),
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setAiStatus({ type: "error", message: data.error || "Failed to start device auth" });
        return;
      }
      const data = await res.json();
      if (controller.signal.aborted) return;
      if (data.user_code && data.verification_url) {
        setDeviceCode(data.user_code);
        setDeviceUrl(data.verification_url);
        setDevicePolling(true);
        const interval = data.interval || 5;
        devicePollRef.current = setTimeout(() => pollDeviceAuth(interval), interval * 1000);
      } else {
        setAiStatus({ type: "error", message: "Unexpected response from device auth" });
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      setAiStatus({ type: "error", message: `Failed: ${err instanceof Error ? err.message : err}` });
    }
  };

  const saveAiProvider = async () => {
    if (!aiApiKey.trim()) {
      setAiStatus({ type: "error", message: "Please enter your API key" });
      return;
    }

    aiSaveControllerRef.current?.abort();
    const controller = new AbortController();
    aiSaveControllerRef.current = controller;

    setAiSaving(true);
    setAiStatus(null);
    try {
      const res = await fetch("/setup-api/ai-models/configure", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: aiProvider, apiKey: aiApiKey.trim(), authMode: aiAuthMode }),
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setAiStatus({ type: "error", message: data.error || "Failed to configure" });
        return;
      }
      const data = await res.json();
      if (controller.signal.aborted) return;
      if (data.success) {
        setAiStatus({ type: "success", message: "AI provider configured!" });
        setProviderDone(true);
        setProviderName(aiProvider);
        setAiApiKey("");
        setTimeout(() => { setAiStatus(null); }, 1500);
      } else {
        setAiStatus({ type: "error", message: data.error || "Failed to configure" });
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      setAiStatus({ type: "error", message: `Failed: ${err instanceof Error ? err.message : err}` });
    } finally {
      if (!controller.signal.aborted) setAiSaving(false);
    }
  };

  const startAiOAuth = async () => {
    aiOauthStartControllerRef.current?.abort();
    const controller = new AbortController();
    aiOauthStartControllerRef.current = controller;

    setAiStatus(null);
    setAiOauthStarted(false);
    setAiAuthCode("");
    try {
      const res = await fetch("/setup-api/ai-models/oauth/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: aiProvider }),
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setAiStatus({ type: "error", message: data.error || "Failed to start OAuth" });
        return;
      }
      const data = await res.json();
      if (controller.signal.aborted) return;
      if (data.url) {
        oauthWindowRef.current = window.open(data.url, "_blank");
        setAiOauthStarted(true);
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      setAiStatus({ type: "error", message: `Failed: ${err instanceof Error ? err.message : err}` });
    }
  };

  const exchangeAiCode = async () => {
    if (!aiAuthCode.trim()) {
      setAiStatus({ type: "error", message: `Please paste the ${currentAiOAuth.inputLabel.toLowerCase()}` });
      return;
    }
    const parsedCode = parseAuthInput(aiAuthCode);
    if (!parsedCode) {
      setAiStatus({ type: "error", message: "Could not extract authorization code from input" });
      return;
    }

    aiExchangeControllerRef.current?.abort();
    const controller = new AbortController();
    aiExchangeControllerRef.current = controller;

    setAiExchanging(true);
    setAiStatus(null);
    try {
      const exchangeRes = await fetch("/setup-api/ai-models/oauth/exchange", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: parsedCode }),
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      if (!exchangeRes.ok) {
        const data = await exchangeRes.json().catch(() => ({}));
        setAiStatus({ type: "error", message: data.error || "Token exchange failed" });
        return;
      }
      const tokenData = await exchangeRes.json();
      if (controller.signal.aborted) return;
      if (!tokenData.access_token) {
        setAiStatus({ type: "error", message: "No access token received" });
        return;
      }
      const saveRes = await fetch("/setup-api/ai-models/configure", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: aiProvider, apiKey: tokenData.access_token, authMode: "subscription", refreshToken: tokenData.refresh_token, expiresIn: tokenData.expires_in, ...(tokenData.projectId ? { projectId: tokenData.projectId } : {}) }),
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      if (!saveRes.ok) {
        const data = await saveRes.json().catch(() => ({}));
        setAiStatus({ type: "error", message: data.error || "Failed to save token" });
        return;
      }
      const saveData = await saveRes.json();
      if (controller.signal.aborted) return;
      if (saveData.success) {
        const { tabClosed, closeHint } = tryCloseOAuthWindow(oauthWindowRef);
        setAiStatus({ type: "success", message: currentAiOAuth.success + closeHint });
        setProviderDone(true);
        setProviderName(aiProvider);
        setAiOauthStarted(false);
        setAiAuthCode("");
        setTimeout(() => { setAiStatus(null); }, tabClosed ? 1500 : 3000);
      } else {
        setAiStatus({ type: "error", message: saveData.error || "Failed to save token" });
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      setAiStatus({ type: "error", message: `Failed: ${err instanceof Error ? err.message : err}` });
    } finally {
      if (!controller.signal.aborted) setAiExchanging(false);
    }
  };

  const scanWifiNetworks = async () => {
    setWifiScanning(true);
    setWifiStatus(null);
    try {
      const trigger = await fetch("/setup-api/wifi/scan", { method: "POST" });
      if (!trigger.ok) throw new Error(`Scan failed (${trigger.status})`);

      let data: { scanning?: boolean; networks?: typeof wifiNetworks } | null = null;
      for (let attempt = 0; attempt < 20; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, attempt === 0 ? 800 : 1000));
        const poll = await fetch("/setup-api/wifi/scan", { cache: "no-store" });
        if (!poll.ok) throw new Error(`Scan failed (${poll.status})`);
        data = (await poll.json()) as { scanning?: boolean; networks?: typeof wifiNetworks };
        if (!data?.scanning) break;
      }

      if (!data || data.scanning) {
        throw new Error("Scan timed out");
      }

      setWifiNetworks(data.networks || []);
    } catch (err) {
      setWifiStatus({
        type: "error",
        message: `Scan failed: ${err instanceof Error ? err.message : err}`,
      });
    } finally {
      setWifiScanning(false);
    }
  };

  const connectWifi = async () => {
    if (!wifiSSID.trim()) return;

    wifiControllerRef.current?.abort();
    const controller = new AbortController();
    wifiControllerRef.current = controller;

    setWifiConnecting(true);
    setWifiStatus(null);
    try {
      const res = await fetch("/setup-api/wifi/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ssid: wifiSSID.trim(), password: wifiPassword }),
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setWifiStatus({ type: "error", message: data.error || "Connection failed" });
        return;
      }
      const data = await res.json().catch(() => ({}));
      setWifiConnecting(true);
      setWifiTargetSSID(wifiSSID.trim());
      setWifiStatus({
        type: "success",
        message:
          typeof data.message === "string"
            ? data.message
            : "The device is switching WiFi and waiting for a DHCP address. Reconnect to the same network, then open the device's .local address in a system browser, or use the IP shown on the screen.",
      });
      setWifiConnectedSSID(wifiSSID.trim());
      setWifiSSID("");
      setWifiPassword("");
      setTimeout(() => {
        setOpenSection(null);
      }, 1500);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      if (err instanceof TypeError && err.message.includes("fetch")) {
        setWifiStatus({
          type: "error",
          message:
            "Lost connection. If WiFi switched successfully, reconnect to the same WiFi and open the device's .local address in a system browser, or use the IP shown on the screen if this client does not resolve .local.",
        });
        return;
      }
      setWifiStatus({ type: "error", message: `Failed: ${err instanceof Error ? err.message : err}` });
    } finally {
      if (!controller.signal.aborted) setWifiConnecting(false);
    }
  };

  const resetSetup = async () => {
    const steps = RESET_STEPS;
    setResetting(true);
    setResetStep(0);
    setResetProgress(0);
    setCompleteError(null);

    // Single timer: advance step + derive progress from step index
    const stepDuration = 800;
    let currentStep = 0;
    const stepInterval = setInterval(() => {
      currentStep++;
      if (currentStep < steps.length) {
        setResetStep(currentStep);
        setResetProgress(Math.round((currentStep / steps.length) * 100));
      }
    }, stepDuration);

    try {
      const res = await fetch("/setup-api/setup/reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "factory" }),
      });
      clearInterval(stepInterval);

      if (res.ok) {
        // Show final "Restarting device..." step
        setResetStep(steps.length - 1);
        setResetProgress(100);
        // Give the network transition or reboot a moment before reloading.
        await new Promise((r) => setTimeout(r, 3000));
        window.location.href = "/setup";
        return;
      }
      const data = await res.json().catch(() => ({}));
      setCompleteError(
        typeof data.error === "string"
          ? data.error
          : "Reset all configuration failed",
      );
    } catch {
      setCompleteError("Reset all configuration failed");
    } finally {
      clearInterval(stepInterval);
      setResetting(false);
      setResetConfirm(false);
      setResetStep(0);
      setResetProgress(0);
    }
  };

  const statusForChannel = (id: ChatChannelId): AdditionalChannelStatus => {
    if (id === "discord" || id === "zalo" || id === "zalo-clawbot" || id === "zalouser" || id === "signal") {
      return additionalStatuses[id] || {};
    }
    if (id === "telegram") return { connected: telegramDone, configured: telegramConfigured, enabled: telegramEnabled };
    if (id === "feishu") return { connected: feishuDone, configured: feishuConfigured, enabled: feishuEnabled };
    if (id === "qqbot") return { connected: qqbotDone, configured: qqbotConfigured, enabled: qqbotEnabled };
    if (id === "wecom") return { connected: wecomDone, configured: wecomConfigured, enabled: wecomEnabled };
    if (id === "whatsapp") return { connected: whatsappDone, configured: whatsappConfigured, enabled: whatsappEnabled, state: whatsappLinked ? "linked_offline" : undefined };
    if (id === "line") return { connected: lineDone, configured: lineConfigured, enabled: lineEnabled };
    return { connected: wechatDone, configured: wechatEnabled, enabled: wechatEnabled };
  };

  const connectedChannelIds = useMemo(
    () => CHAT_CHANNELS.filter((channel) => {
      const status = statusForChannel(channel.id);
      return status.connected === true || status.state === "connected";
    }).map((channel) => channel.id),
    [additionalStatuses, feishuDone, feishuConfigured, feishuEnabled, lineDone, lineConfigured, lineEnabled, qqbotDone, qqbotConfigured, qqbotEnabled, telegramDone, telegramConfigured, telegramEnabled, wecomDone, wecomConfigured, wecomEnabled, wechatDone, wechatEnabled, whatsappDone, whatsappConfigured, whatsappEnabled, whatsappLinked],
  );
  const activeChatChannelMeta = CHAT_CHANNEL_META.find((channel) => channel.id === activeChatChannel) ?? CHAT_CHANNEL_META[0];

  const disconnectChatChannel = useCallback(async (channel: ChatChannelId) => {
    setDisconnectingChannel(channel);
    setChannelDisconnectStatus(null);
    try {
      const isWechat = channel === "wechat";
      const isPatch = channel === "zalo-clawbot" || channel === "zalouser";
      const response = await fetch(isWechat ? "/setup-api/wechat/configure" : `/setup-api/channels/${channel}`, {
        method: isPatch ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: false }),
        cache: "no-store",
      });
      const data = (await response.json().catch(() => null)) as { error?: unknown } | null;
      if (!response.ok) {
        throw new Error(typeof data?.error === "string" ? data.error : "Failed to disconnect channel.");
      }
      setChannelDisconnectStatus({ type: "success", message: "Channel disconnected." });
      await refreshAllChannelStatuses();
    } catch (error) {
      setChannelDisconnectStatus({
        type: "error",
        message: error instanceof Error ? error.message : "Failed to disconnect channel.",
      });
    } finally {
      setDisconnectingChannel(null);
    }
  }, [refreshAllChannelStatuses]);

  /* ── Render ── */

  return (
    <div className="w-full max-w-2xl mx-auto">
      {completeError && (
        <div className="mb-4 p-3 bg-red-500/10 border border-red-500/20 rounded-lg text-xs text-red-400">{translateText(completeError)}</div>
      )}

      <div className="mb-4 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface)]/70 px-4 py-3 text-xs leading-relaxed text-[var(--text-secondary)]">
        {t("Recommended order: connect WiFi, configure your AI provider, then connect any chat channels you want to use. Finish setup unlocks after WiFi and AI are ready.")}
      </div>

      {/* Primary actions */}
      <div className="grid grid-cols-2 gap-3 mb-6">
          <button
            type="button"
            onClick={setupComplete ? () => (window.location.href = "/setup") : completeSetup}
            disabled={finishButtonDisabled}
            className="py-3 btn-gradient text-white rounded-xl text-sm font-semibold transition transform cursor-pointer hover:scale-105 shadow-lg shadow-[rgba(249,115,22,0.25)] disabled:opacity-50 disabled:hover:scale-100 flex items-center justify-center gap-2"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10 10-4.5 10-10S17.5 2 12 2"/><path d="M8 12c0-2.2 1.8-4 4-4"/><path d="M16 12c0 2.2-1.8 4-4 4"/><circle cx="12" cy="12" r="1.5"/></svg>
            {finishing ? t("Finishing...") : setupComplete ? t("Setup Complete") : t("Finish Setup")}
          </button>
          <button
            type="button"
            onClick={isUpdateRunning ? undefined : openUpdateConfirm}
            disabled={isUpdateRunning}
            className="py-3 bg-emerald-600 text-white rounded-xl text-sm font-semibold hover:bg-emerald-500 hover:scale-105 transition-all cursor-pointer disabled:opacity-50 disabled:hover:scale-100 flex items-center justify-center gap-2 shadow-lg shadow-emerald-600/25"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M16 16h5v5"/></svg>
            {isUpdateRunning ? t("Updating...") : t("System Update")}
          </button>
          <button
            type="button"
            onClick={() => setBetaConfirm(true)}
            disabled={isUpdateRunning}
            className="py-3 bg-purple-600 text-white rounded-xl text-sm font-semibold hover:bg-purple-500 hover:scale-105 transition-all cursor-pointer disabled:opacity-50 disabled:hover:scale-100 flex items-center justify-center gap-2 shadow-lg shadow-purple-600/25"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2v20"/><path d="m17 5-5-3-5 3"/><path d="m17 19-5 3-5-3"/><path d="M2 12h20"/></svg>
            {t("Beta Update")}
          </button>
          <button
            type="button"
            onClick={() => setResetConfirm(true)}
            className="py-3 bg-red-500/10 text-red-400 rounded-xl text-sm font-semibold hover:bg-red-500/20 hover:scale-105 transition-all cursor-pointer flex items-center justify-center gap-2 border border-red-500/20"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
            {t("Reset All")}
          </button>
      </div>

      {/* Update confirmation popup */}
      {updateConfirm && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm px-4">
          <div className="card-surface rounded-2xl p-6 max-w-sm w-full shadow-2xl">
            <h3 className="text-lg font-bold text-gray-100 mb-2">{t("System Update")}</h3>
            <p className="text-sm text-[var(--text-secondary)] mb-4 leading-relaxed">
              {t("This will pull the latest updates and restart the device. The process may take a few minutes.")}
            </p>
            {versionLoading ? (
              <div className="mb-4 text-xs text-[var(--text-muted)]">{t("Checking versions...")}</div>
            ) : versionInfo && (
              <div className="mb-4 space-y-2 text-xs">
                <div className="flex items-center justify-between bg-[var(--bg-deep)] rounded-lg px-3 py-2">
                  <span className="text-[var(--text-secondary)] font-medium">ClawBox</span>
                  <span className="text-[var(--text-primary)]">
                    {versionInfo.clawbox.current}
                    {versionInfo.clawbox.target && versionInfo.clawbox.target !== versionInfo.clawbox.current && (
                      <span className="text-[var(--text-muted)]">{" → "}<span className="text-emerald-400">{versionInfo.clawbox.target}</span></span>
                    )}
                  </span>
                </div>
                <div className="flex items-center justify-between bg-[var(--bg-deep)] rounded-lg px-3 py-2">
                  <span className="text-[var(--text-secondary)] font-medium">OpenClaw</span>
                  <span className="text-[var(--text-primary)]">
                    {versionInfo.openclaw.current ?? t("not installed")}
                    {versionInfo.openclaw.target && versionInfo.openclaw.target !== versionInfo.openclaw.current && (
                      <span className="text-[var(--text-muted)]">{" → "}<span className="text-emerald-400">{versionInfo.openclaw.target}</span></span>
                    )}
                  </span>
                </div>
              </div>
            )}
            {/* Branch selector — only visible in dev (non-tag version) or when a branch is pinned */}
            {!versionLoading && (updateBranch || /^v\d+\.\d+\.\d+-.+/.test(versionInfo?.clawbox.current ?? "")) && (
              <div className="mb-4">
                <label htmlFor="update-branch-input" className="text-xs text-[var(--text-muted)] mb-1 block">{t("Update branch")}</label>
                <div className="flex gap-2">
                  <input
                    id="update-branch-input"
                    type="text"
                    value={branchInput}
                    onChange={(e) => { setBranchInput(e.target.value); setBranchError(null); }}
                    placeholder="main"
                    className="flex-1 bg-[var(--bg-deep)] border border-gray-600 rounded-lg px-3 py-1.5 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] outline-none focus:border-[#00e5cc]"
                  />
                  <button
                    type="button"
                    disabled={branchSaving || branchInput === (updateBranch ?? "")}
                    onClick={() => saveUpdateBranch(branchInput)}
                    className="px-3 py-1.5 text-xs font-semibold text-white btn-gradient rounded-lg cursor-pointer disabled:opacity-40"
                  >
                    {branchSaving ? "..." : t("Set")}
                  </button>
                </div>
                {branchError && (
                  <p className="mt-1 text-xs text-red-400">{translateText(branchError)}</p>
                )}
                {updateBranch && (
                  <div className="mt-1 flex items-center gap-2">
                    <span className="text-xs text-emerald-400">{t("Pinned: {branch}", { branch: updateBranch })}</span>
                    <button
                      type="button"
                      onClick={() => { setBranchInput(""); saveUpdateBranch(""); }}
                      className="text-xs text-red-400 hover:text-red-300 cursor-pointer"
                    >
                      {t("Unpin")}
                    </button>
                  </div>
                )}
              </div>
            )}
            <div className="flex gap-3">
              <button
                type="button"
                onClick={() => setUpdateConfirm(false)}
                className="flex-1 py-2.5 text-sm font-semibold text-[var(--text-secondary)] hover:text-gray-100 transition-colors cursor-pointer"
              >
                {t("Cancel")}
              </button>
              <button
                type="button"
                onClick={() => { triggerUpdate(branchInput || undefined); setUpdateConfirm(false); }}
                disabled={isUpdateRunning}
                className="flex-1 py-2.5 text-sm font-semibold text-white btn-gradient rounded-lg cursor-pointer disabled:opacity-50"
              >
                {t("Update Now")}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Beta update confirmation */}
      {betaConfirm && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm px-4">
          <div className="card-surface rounded-2xl p-6 max-w-sm w-full shadow-2xl">
            <h3 className="text-lg font-bold text-gray-100 mb-2">{t("Switch to Beta")}</h3>
            <p className="text-sm text-[var(--text-secondary)] mb-4 leading-relaxed">
              {t("This will switch to the beta update channel. Beta versions may contain bugs or incomplete features.")}
            </p>
            <div className="flex gap-3">
              <button
                type="button"
                onClick={() => setBetaConfirm(false)}
                className="flex-1 py-2.5 text-sm font-semibold text-[var(--text-secondary)] hover:text-gray-100 transition-colors cursor-pointer"
              >
                {t("Cancel")}
              </button>
              <button
                type="button"
                onClick={() => { triggerUpdate("beta"); setBetaConfirm(false); }}
                disabled={isUpdateRunning}
                className="flex-1 py-2.5 text-sm font-semibold text-white bg-purple-600 hover:bg-purple-500 rounded-lg transition-colors cursor-pointer disabled:opacity-50"
              >
                {t("Switch to Beta")}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Reset confirmation */}
      {resetConfirm && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm px-4">
          <div className="card-surface rounded-2xl p-6 max-w-sm w-full shadow-2xl">
            <h3 className="text-lg font-bold mb-2 text-red-400">{t("Reset All Configuration")}</h3>
            <p className="text-sm text-[var(--text-secondary)] mb-4 leading-relaxed">
              {t("This clears WiFi, AI, WeChat, credentials, and setup state. The device will restart into the ClawBox-Setup hotspot afterward.")}
            </p>
            {resetting && (
              <div className="mb-4">
                <div className="w-full h-2 rounded-full bg-[var(--bg-deep)] overflow-hidden mb-2">
                  <div className="h-full bg-[var(--coral-bright)] rounded-full transition-all" style={{ width: `${resetProgress}%` }} />
                </div>
                <p className="text-xs text-[var(--text-secondary)]">{translateText(RESET_STEPS[resetStep])}</p>
              </div>
            )}
            <div className="flex gap-3">
              <button
                type="button"
                onClick={() => setResetConfirm(false)}
                disabled={resetting}
                className="flex-1 py-2.5 text-sm font-semibold text-[var(--text-secondary)] hover:text-gray-100 transition-colors cursor-pointer disabled:opacity-50"
              >
                {t("Cancel")}
              </button>
              <button
                type="button"
                onClick={resetSetup}
                disabled={resetting}
                className="flex-1 py-2.5 text-sm font-semibold text-white rounded-lg transition-colors cursor-pointer disabled:opacity-50 bg-red-500 hover:bg-red-400"
              >
                {t("Reset All")}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Update progress overlay */}
      {updateStarted && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm px-4">
          <div className="card-surface rounded-2xl p-6 max-w-md w-full shadow-2xl">
            <h3 className="text-lg font-bold text-gray-100 mb-2">
              <UpdateProgressHeading phase={updateState?.phase} />
            </h3>
            {updateFailureMessage ? (
              <p className="text-sm text-red-400 mb-4">{translateText(updateFailureMessage)}</p>
            ) : updateServerRestarting ? (
              <p className="text-sm text-[var(--text-secondary)] mb-4">{t("The update service is restarting. Waiting for it to come back online...")}</p>
            ) : !updateState && updateAcknowledged ? (
              <p className="text-sm text-[var(--text-secondary)] mb-4">{t("Update request received. Waiting for the update service...")}</p>
            ) : null}
            {(updateState?.progress !== undefined || updateState?.status) && (
              <div className="mb-4">
                <div className="w-full h-2 rounded-full bg-[var(--bg-deep)] overflow-hidden mb-2">
                  <div
                    className={`h-full bg-[var(--coral-bright)] rounded-full transition-all ${updateState.progress === undefined ? "w-1/3 animate-pulse" : ""}`}
                    style={updateState.progress === undefined ? undefined : { width: `${updateState.progress}%` }}
                  />
                </div>
                <p className="text-xs text-[var(--text-secondary)]">{translateText(updateState.status || "Updating...")}</p>
              </div>
            )}
            {updateState?.steps && updateState.steps.length > 0 && (
              <div className="space-y-2 mb-4">
                {updateState.steps.map((step, idx) => (
                  <div key={idx} className="flex items-center gap-2 text-xs">
                    <UpdateStepIcon status={step.status} />
                    <span className={updateStepTextClass(step.status)}>{translateText(step.label)}</span>
                  </div>
                ))}
              </div>
            )}
            {updateState?.phase === "completed" && (
              <button
                type="button"
                onClick={() => { window.location.reload(); }}
                className="w-full py-2.5 text-sm font-semibold text-white btn-gradient rounded-lg cursor-pointer"
              >
                {t("Refresh")}
              </button>
            )}
            {(updateState?.phase === "failed" || updateError) && (
              <button
                type="button"
                onClick={() => {
                  stopUpdatePolling();
                  if (updateReloadTimerRef.current) {
                    clearTimeout(updateReloadTimerRef.current);
                    updateReloadTimerRef.current = null;
                  }
                  setUpdateStarted(false);
                  setUpdateAcknowledged(false);
                  setUpdateServerRestarting(false);
                  setUpdateError(null);
                  setUpdateState(null);
                }}
                className="w-full py-2.5 text-sm font-semibold text-white btn-gradient rounded-lg cursor-pointer"
              >
                {t("Close")}
              </button>
            )}
          </div>
        </div>
      )}

      {/* Collapsible sections */}
      <div className="space-y-3">
        {/* AI Model (cloud API only) */}
        <CollapsibleSection
          id="ai"
          title={t("AI Model (Cloud API)")}
          done={providerDone}
          open={openSection === "ai"}
          onToggle={toggle}
        >
          <div>
            <label htmlFor="ai-provider-select" className={LABEL_CLASS}>
              {t("Provider")}
            </label>
            <select
              id="ai-provider-select"
              value={aiProvider}
              onChange={(e) => {
                setAiProvider(e.target.value);
                resetAiFields();
              }}
              className={INPUT_CLASS}
            >
              {AI_PROVIDERS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>

          {selectedAiProvider && (
            <div className="flex flex-wrap gap-4 text-sm text-[var(--text-primary)]">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="ai-auth"
                  checked={aiAuthMode === "subscription"}
                  onChange={() => {
                    setAiAuthMode("subscription");
                    resetAiFields();
                  }}
                  className="accent-[var(--coral-bright)]"
                />
                {t("Subscription (OAuth)")}
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="ai-auth"
                  checked={aiAuthMode === "token"}
                  onChange={() => {
                    setAiAuthMode("token");
                    resetAiFields();
                  }}
                  className="accent-[var(--coral-bright)]"
                />
                {t("API key")}
              </label>
            </div>
          )}

          {isAiSubscription && !useDeviceAuth && (
            <div className="space-y-3">
              <p className="text-xs text-[var(--text-muted)] leading-relaxed">
                {currentAiOAuth.steps.map(translateText).join(" ")}
              </p>
              <button
                type="button"
                onClick={startAiOAuth}
                disabled={aiOauthStarted}
                className={`${SAVE_BUTTON_CLASS} flex items-center gap-2`}
              >
                {translateText(currentAiOAuth.button)}
              </button>
              {aiOauthStarted && (
                <div className="space-y-2">
                  <label htmlFor="ai-auth-code" className={LABEL_CLASS}>
                    {translateText(currentAiOAuth.inputLabel)}
                  </label>
                  <textarea
                    id="ai-auth-code"
                    value={aiAuthCode}
                    onChange={(e) => setAiAuthCode(e.target.value)}
                    placeholder={translateText(currentAiOAuth.inputPlaceholder)}
                    rows={3}
                    className={`${INPUT_CLASS} min-h-[72px] resize-y`}
                  />
                  <button
                    type="button"
                    onClick={exchangeAiCode}
                    disabled={aiExchanging}
                    className={`${SAVE_BUTTON_CLASS} flex items-center gap-2`}
                  >
                    {aiExchanging && ButtonSpinner}
                    {aiExchanging ? t("Connecting...") : t("Complete connection")}
                  </button>
                </div>
              )}
            </div>
          )}

          {isAiSubscription && useDeviceAuth && (
            <div className="space-y-3">
              <p className="text-xs text-[var(--text-muted)] leading-relaxed">
                {t("Sign in on another device with the code below, then keep this page open while we connect.")}
              </p>
              {!deviceCode ? (
                <button type="button" onClick={startDeviceAuth} className={SAVE_BUTTON_CLASS}>
                  {t("Start device login")}
                </button>
              ) : (
                <div className="space-y-3 flex flex-col items-center">
                  <p className="text-sm font-mono tracking-widest text-[var(--coral-bright)]">{deviceCode}</p>
                  {deviceUrl && (
                    <a
                      href={deviceUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs text-[#00e5cc] underline break-all text-center"
                    >
                      {deviceUrl}
                    </a>
                  )}
                  {devicePolling && <p className="text-xs text-[var(--text-muted)]">{t("Waiting for authorization...")}</p>}
                  {deviceUrl && (
                    <div className="p-3 bg-white rounded-lg">
                      <QRCodeSVG value={deviceUrl} size={160} level="M" />
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {!isAiSubscription && (
            <div className="space-y-3">
              <p className="text-xs text-[var(--text-muted)]">{selectedAiProvider ? translateText(selectedAiProvider.hint) : null}</p>
              <label htmlFor="ai-api-key" className={LABEL_CLASS}>
                {t("API key")}
              </label>
              <PasswordInput
                id="ai-api-key"
                value={aiApiKey}
                onChange={setAiApiKey}
                visible={showAiKey}
                onToggle={() => setShowAiKey((v) => !v)}
                placeholder={selectedAiProvider?.placeholder}
                autoComplete="off"
              />
              <a
                href={selectedAiProvider?.tokenUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-[#00e5cc] underline"
              >
                {t("Get API key")}
              </a>
              <button
                type="button"
                onClick={saveAiProvider}
                disabled={aiSaving}
                className={`${SAVE_BUTTON_CLASS} flex items-center gap-2`}
              >
                {aiSaving && ButtonSpinner}
                {aiSaving ? t("Saving...") : t("Save")}
              </button>
            </div>
          )}

          {aiStatus && <StatusMessage type={aiStatus.type} message={aiStatus.message} />}
        </CollapsibleSection>

        {/* Chat channels */}
        <CollapsibleSection
          id="channels"
          title={t("Chat channels")}
          done={connectedChannelIds.length > 0}
          open={openSection === "channels"}
          onToggle={toggle}
        >
          <div className="overflow-hidden rounded-lg border border-gray-700 bg-[var(--bg-deep)]">
            <button
              type="button"
              onClick={() => setChannelPickerOpen((open) => !open)}
              aria-expanded={channelPickerOpen}
              aria-controls="chat-channel-picker"
              className="flex w-full min-w-0 items-center gap-3 px-3 py-3 text-left text-sm font-semibold text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-surface)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--coral-bright)]"
            >
              <span className="inline-flex h-9 w-11 shrink-0 items-center justify-center rounded-md bg-[var(--coral-bright)]/20 text-xs font-bold text-[var(--coral-bright)]">
                {activeChatChannelMeta.tag}
              </span>
              <span className="min-w-0 flex-1 truncate">{translateText(activeChatChannelMeta.name)}</span>
              <Chevron open={channelPickerOpen} />
            </button>

            {channelPickerOpen && (
              <div id="chat-channel-picker" className="border-t border-gray-700/80">
                {CHAT_CHANNEL_META.map((channel, index) => {
                  const selected = channel.id === activeChatChannel;
                  return (
                    <button
                      key={channel.id}
                      type="button"
                      onClick={() => selectChannel(channel.id)}
                      aria-pressed={selected}
                      className={`flex w-full min-w-0 items-start gap-3 px-3 py-4 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--coral-bright)] ${index > 0 ? "border-t border-gray-700/70" : ""} ${selected ? "bg-[var(--coral-bright)]/10" : "hover:bg-[var(--bg-surface)]"}`}
                    >
                      <span className={`inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-md text-xs font-bold ${selected ? "bg-[var(--coral-bright)] text-white" : "bg-slate-900 text-[var(--text-secondary)]"}`}>
                        {channel.tag}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-semibold text-[var(--text-primary)]">{translateText(channel.name)}</span>
                        <span className="mt-1 block break-words text-xs leading-relaxed text-[var(--text-muted)]">{translateText(channel.description)}</span>
                      </span>
                      <span aria-hidden="true" className={`mt-1 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border text-sm font-semibold ${selected ? "border-[var(--coral-bright)] bg-[var(--coral-bright)] text-white" : "border-gray-600 text-transparent"}`}>
                        &#10003;
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          <div className="rounded-lg border border-[var(--coral-bright)]/20 bg-[var(--coral-bright)]/5 px-3 py-2.5" aria-label={t("Connected chat channels")}>
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-semibold text-[var(--text-primary)]">{t("Connected chat channels")}</span>
              <button
                type="button"
                onClick={() => void refreshAllChannelStatuses()}
                className="text-[11px] text-[var(--text-secondary)] transition-colors hover:text-[var(--coral-bright)]"
              >
                {t("Refresh status")}
              </button>
            </div>
            <p className="mt-1 text-[11px] leading-relaxed text-amber-300/90">
              {t("It is recommended to connect only one chat channel at a time. Multiple channels may affect stability and response speed.")}
            </p>
            {connectedChannelIds.length === 0 ? (
              <div className="mt-2 text-xs text-[var(--text-muted)]">{t("No chat channel is connected yet.")}</div>
            ) : (
              <div className="mt-2 space-y-1.5">
                {connectedChannelIds.map((id) => {
                  const channel = CHAT_CHANNELS.find((item) => item.id === id);
                  if (!channel) return null;
                  return (
                    <div key={id} className="flex min-w-0 flex-wrap items-center gap-2 rounded-md bg-[var(--bg-deep)] px-2.5 py-2">
                      <span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-full bg-[#00e5cc]" />
                      <span className="min-w-0 flex-1 break-words text-xs font-medium text-[var(--text-primary)]">{translateText(channel.label)}</span>
                      <span className="shrink-0 text-[10px] font-semibold text-[#00e5cc]">{t("Connected")}</span>
                      <button
                        type="button"
                        onClick={() => void disconnectChatChannel(id)}
                        disabled={disconnectingChannel === id}
                        className="shrink-0 rounded border border-red-500/40 px-2 py-1 text-[11px] font-semibold text-red-400 transition-colors hover:bg-red-500/10 disabled:opacity-50"
                      >
                        {disconnectingChannel === id ? t("Disconnecting...") : t("Disconnect")}
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
            {channelDisconnectStatus && <StatusMessage type={channelDisconnectStatus.type} message={channelDisconnectStatus.message} />}
          </div>

          <ChannelProxySettings globalOnly />

        {/* Telegram */}
        <ChannelContentSection
          id="telegram"
          title="Telegram"
          active={activeChatChannel === "telegram"}
        >
          {!canConfigureTelegram ? (
            <div className="rounded-lg border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-xs leading-relaxed text-amber-300">
              {t("Configure your AI provider first. Telegram setup unlocks after AI credentials are saved.")}
            </div>
          ) : (
            <p className="text-xs text-[var(--text-muted)] leading-relaxed">
              {t("Create a bot with @BotFather, paste its token once, then approve your first private message here. Group chats are disabled in this first version.")}
            </p>
          )}

          <CredentialGuide
            title={t("How to get the complete Bot Token")}
            steps={locale === "zh-CN" ? [
              <>在 Telegram 中打开经过验证的 <a href="https://t.me/BotFather" target="_blank" rel="noopener noreferrer">@BotFather</a> 账号。</>,
              <>新建机器人请发送 <code>/newbot</code>；已有机器人请发送 <code>/mybots</code>，选择机器人后打开 API Token 选项。</>,
              <>按照提示设置显示名称，以及以 <code>bot</code> 结尾的用户名。</>,
              <>复制 BotFather 返回的完整 Token，例如 <code>123456789:AA...</code>。冒号前的数字只是 Bot ID，此处必须填写完整 Token。</>,
              <>将 Token 粘贴到下方并选择“保存并连接”。然后打开机器人，发送 <code>/start</code>，刷新配对请求并批准你的账号。</>,
            ] : [
              <>
                Open the verified{" "}
                <a href="https://t.me/BotFather" target="_blank" rel="noopener noreferrer">
                  @BotFather
                </a>{" "}
                account in Telegram.
              </>,
              <>
                For a new bot, send <code>/newbot</code>. For an existing bot, send{" "}
                <code>/mybots</code>, select the bot, then open its API Token option.
              </>,
              <>
                Follow the prompts to choose a display name and a username that ends in{" "}
                <code>bot</code>.
              </>,
              <>
                Copy the entire token returned by BotFather, for example{" "}
                <code>123456789:AA...</code>. The digits before the colon are only the bot ID;
                this field needs the complete token.
              </>,
              <>
                Paste the token below and select Save &amp; Connect. Then open the bot, send{" "}
                <code>/start</code>, refresh the pairing requests, and approve your account.
              </>,
            ]}
            securityNote={locale === "zh-CN"
              ? "不要将 Bot Token 提交到 GitHub，也不要在截图或聊天消息中泄露。"
              : "Never commit the Bot Token to GitHub or include it in screenshots or chat messages."}
          />

          <div className="flex items-center gap-2">
            <span className="text-xs text-[var(--text-secondary)]">{t("Enable Telegram")}</span>
            <label className={`relative inline-flex items-center ${canConfigureTelegram ? "cursor-pointer" : "cursor-not-allowed opacity-60"}`}>
              <input
                type="checkbox"
                checked={telegramEnabled}
                onChange={(event) => setTelegramEnabled(event.target.checked)}
                disabled={!canConfigureTelegram}
                aria-label={t("Enable Telegram")}
                className="sr-only peer"
              />
              <div className="w-9 h-5 bg-[var(--bg-deep)] peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-[var(--coral-bright)] rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-[var(--coral-bright)]" />
            </label>
          </div>

          <div>
            <label htmlFor="telegram-token" className={LABEL_CLASS}>{t("Bot Token")}</label>
            <PasswordInput
              id="telegram-token"
              value={telegramToken}
              onChange={setTelegramToken}
              visible={showTelegramToken}
              onToggle={() => setShowTelegramToken((visible) => !visible)}
              placeholder={telegramConfigured ? t("Token already saved; leave blank to keep it") : "123456789:AA..."}
              autoComplete="off"
              disabled={!canConfigureTelegram}
            />
          </div>

          <ChannelProxySettings channelId="telegram" />

          {telegramStatus && <StatusMessage type={telegramStatus.type} message={telegramStatus.message} />}

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={saveTelegram}
              disabled={telegramSaving || !canConfigureTelegram}
              className={`${SAVE_BUTTON_CLASS} flex items-center gap-2`}
            >
              {telegramSaving && ButtonSpinner}
              {telegramSaving ? t("Validating and connecting...") : t("Save & Connect")}
            </button>
            <button
              type="button"
              onClick={checkTelegramStatus}
              disabled={telegramChecking || !telegramConfigured}
              className="px-4 py-2.5 rounded-lg border border-gray-600 text-sm font-semibold text-[var(--text-secondary)] hover:border-[var(--coral-bright)] hover:text-[var(--text-primary)] disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {telegramChecking ? t("Checking...") : t("Check status")}
            </button>
          </div>

          {telegramDone && (
            <div className="border-t border-gray-700 pt-3 space-y-3">
              <div>
                <p className="text-xs font-semibold text-[var(--text-secondary)]">{t("Approve the first user")}</p>
                <p className="mt-1 text-xs leading-relaxed text-[var(--text-muted)]">
                  {telegramBotUsername ? (
                    locale === "zh-CN" ? (
                      <>在 Telegram 中打开 <a href={`https://t.me/${telegramBotUsername}`} target="_blank" rel="noopener noreferrer" className="text-[#00e5cc] underline">@{telegramBotUsername}</a> 并发送 <code>/start</code>，然后刷新请求列表并批准你的账号。</>
                    ) : (
                      <>Open <a href={`https://t.me/${telegramBotUsername}`} target="_blank" rel="noopener noreferrer" className="text-[#00e5cc] underline">@{telegramBotUsername}</a> in Telegram and send <code>/start</code>. Then refresh the request list and approve your account.</>
                    )
                  ) : (
                    <>{t("Open your bot in Telegram and send /start. Then refresh the request list and approve your account.")}</>
                  )}
                </p>
              </div>
              <button
                type="button"
                onClick={refreshTelegramPairingRequests}
                disabled={telegramPairingLoading}
                className="px-4 py-2 rounded-lg border border-gray-600 text-xs font-semibold text-[var(--text-secondary)] hover:border-[var(--coral-bright)] hover:text-[var(--text-primary)] disabled:opacity-50"
              >
                {telegramPairingLoading ? t("Refreshing...") : t("Refresh pairing requests")}
              </button>

              {telegramPairingRequests.length > 0 && (
                <div className="space-y-2">
                  {telegramPairingRequests.map((request) => (
                    <div key={request.code} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-gray-700 bg-[var(--bg-deep)] px-3 py-2.5">
                      <div className="min-w-0">
                        <p className="text-xs font-semibold text-[var(--text-primary)]">
                          {request.displayName || t("Telegram user {id}", { id: request.senderId })}
                        </p>
                        <p className="mt-0.5 text-[11px] text-[var(--text-muted)]">ID: {request.senderId}</p>
                      </div>
                      <button
                        type="button"
                        onClick={() => approveTelegramRequest(request.code)}
                        disabled={telegramApprovingCode !== null}
                        className="px-3 py-1.5 btn-gradient text-white rounded-lg text-xs font-semibold disabled:opacity-50"
                      >
                        {telegramApprovingCode === request.code ? t("Approving...") : t("Approve")}
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </ChannelContentSection>

        {/* WhatsApp */}
        <ChannelContentSection
          id="whatsapp"
          title="WhatsApp"
          active={activeChatChannel === "whatsapp"}
        >
          {!canConfigureWhatsApp ? (
            <div className="rounded-lg border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-xs leading-relaxed text-amber-300">
              {t("Configure your AI provider first. WhatsApp setup unlocks after AI credentials are saved.")}
            </div>
          ) : (
            <p className="text-xs leading-relaxed text-[var(--text-muted)]">
              {t("WhatsApp uses its Linked devices flow. No Bot ID, API token, developer app, webhook, or ClawBox account is required.")}
            </p>
          )}

          <CredentialGuide
            title={t("How to link WhatsApp")}
            steps={locale === "zh-CN" ? [
              <>WhatsApp 不需要 Bot ID、API Token 或 Webhook；ClawBox 自身也不需要登录。这里会把设备关联为 WhatsApp 的一个“已关联设备”。</>,
              <>建议使用专门给机器人的手机号，并先在手机 WhatsApp 中完成注册。也可以选择个人号码模式，但只会放行你在下方填写的本人号码。</>,
              <>选择号码模式后点击“准备并显示二维码”。ClawBox 会准备 WhatsApp 插件并重启本地 OpenClaw 网关，通常需要一点时间。</>,
              <>在主手机打开 WhatsApp：iPhone 进入“设置 → 已关联设备 → 关联设备”；Android 打开右上角菜单，进入“已关联设备 → 关联设备”。</>,
              <>扫描页面二维码并保持页面打开。二维码可能刷新，页面会等待最多 3 分钟并自动检查实时连接。</>,
              <>专用号码模式下，用另一个 WhatsApp 账号向机器人发一条私聊消息，然后回到这里刷新并批准首次用户。个人号码模式下，直接在自己的聊天中测试。</>,
            ] : [
              <>WhatsApp needs no Bot ID, API token, or webhook, and ClawBox itself needs no sign-in. This flow links the device as a WhatsApp companion device.</>,
              <>A dedicated bot number is recommended and must already be registered in the WhatsApp mobile app. Personal-number mode is also available, but only the owner number entered below is allowed.</>,
              <>Choose a number mode, then select Prepare &amp; Show QR. ClawBox prepares the WhatsApp plugin and restarts the local OpenClaw gateway, which can take a moment.</>,
              <>On the primary phone, open WhatsApp. On iPhone, go to Settings → Linked devices → Link a device. On Android, open the menu, then Linked devices → Link a device.</>,
              <>Scan the QR code and keep this page open. The QR may refresh while the page waits up to three minutes for a live connection.</>,
              <>For a dedicated number, send the bot a private message from another WhatsApp account, then refresh and approve the first user here. For a personal number, test from your own chat.</>,
            ]}
            securityNote={locale === "zh-CN"
              ? "二维码相当于一次设备授权。不要把二维码截图发给别人；如有泄露，请立即解除关联并重新扫码。"
              : "The QR code authorizes a linked device. Do not share a screenshot of it; unlink and scan again immediately if it is exposed."}
          />

          <div className="flex items-center gap-2">
            <span className="text-xs text-[var(--text-secondary)]">{t("Enable WhatsApp")}</span>
            <label className={`relative inline-flex items-center ${canConfigureWhatsApp ? "cursor-pointer" : "cursor-not-allowed opacity-60"}`}>
              <input
                type="checkbox"
                checked={whatsappEnabled}
                onChange={(event) => setWhatsAppEnabled(event.target.checked)}
                disabled={!canConfigureWhatsApp}
                aria-label={t("Enable WhatsApp")}
                className="sr-only peer"
              />
              <div className="w-9 h-5 bg-[var(--bg-deep)] peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-[var(--coral-bright)] rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-[var(--coral-bright)]" />
            </label>
          </div>

          <fieldset disabled={!canConfigureWhatsApp || !whatsappEnabled}>
            <legend className={LABEL_CLASS}>{t("Number mode")}</legend>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <label className="relative cursor-pointer">
                <input
                  type="radio"
                  name="whatsapp-mode"
                  value="dedicated"
                  checked={whatsappMode === "dedicated"}
                  onChange={() => setWhatsAppMode("dedicated")}
                  className="peer sr-only"
                />
                <span className="block min-h-20 rounded-lg border border-gray-600 bg-[var(--bg-deep)] px-3 py-2.5 text-xs text-[var(--text-secondary)] transition-colors peer-checked:border-[var(--coral-bright)] peer-checked:bg-[var(--coral-bright)]/10 peer-focus-visible:ring-2 peer-focus-visible:ring-[var(--coral-bright)]">
                  <strong className="block text-sm text-[var(--text-primary)]">{t("Dedicated number")}</strong>
                  <span className="mt-1 block leading-relaxed">{t("Recommended for a bot-only WhatsApp account.")}</span>
                </span>
              </label>
              <label className="relative cursor-pointer">
                <input
                  type="radio"
                  name="whatsapp-mode"
                  value="personal"
                  checked={whatsappMode === "personal"}
                  onChange={() => setWhatsAppMode("personal")}
                  className="peer sr-only"
                />
                <span className="block min-h-20 rounded-lg border border-gray-600 bg-[var(--bg-deep)] px-3 py-2.5 text-xs text-[var(--text-secondary)] transition-colors peer-checked:border-[var(--coral-bright)] peer-checked:bg-[var(--coral-bright)]/10 peer-focus-visible:ring-2 peer-focus-visible:ring-[var(--coral-bright)]">
                  <strong className="block text-sm text-[var(--text-primary)]">{t("Personal number")}</strong>
                  <span className="mt-1 block leading-relaxed">{t("Only your own number is allowed; best for private testing.")}</span>
                </span>
              </label>
            </div>
          </fieldset>

          {whatsappMode === "personal" && whatsappEnabled && (
            <div>
              <label htmlFor="whatsapp-owner-number" className={LABEL_CLASS}>{t("Your WhatsApp number")}</label>
              <input
                id="whatsapp-owner-number"
                type="tel"
                inputMode="tel"
                value={whatsappOwnerNumber}
                onChange={(event) => setWhatsAppOwnerNumber(event.target.value)}
                placeholder="+8613800000000"
                autoComplete="tel"
                disabled={!canConfigureWhatsApp}
                className={INPUT_CLASS}
              />
              <p className="mt-1.5 text-[11px] leading-relaxed text-[var(--text-muted)]">
                {t("Use E.164 format: +, country code, and number, with no extension.")}
              </p>
            </div>
          )}

          {whatsappQrDataUrl && (
            <div className="rounded-lg border border-gray-700 bg-[var(--bg-deep)] p-4">
              <div className="mx-auto aspect-square w-full max-w-[220px] overflow-hidden rounded-md bg-white p-2">
                <Image
                  src={whatsappQrDataUrl}
                  alt={t("WhatsApp linking QR code")}
                  width={220}
                  height={220}
                  unoptimized
                  className="h-full w-full object-contain"
                />
              </div>
              <p className="mt-3 text-center text-xs leading-relaxed text-[var(--text-secondary)]" aria-live="polite">
                {whatsappWaiting
                  ? t("Waiting for a live WhatsApp connection. Keep this page open while you scan.")
                  : t("Scan this code from WhatsApp Linked devices.")}
              </p>
              <div className="mt-3 flex justify-center">
                <button
                  type="button"
                  onClick={() => requestWhatsAppQr(true)}
                  disabled={whatsappQrLoading}
                  className="px-4 py-2 rounded-lg border border-gray-600 text-xs font-semibold text-[var(--text-secondary)] hover:border-[var(--coral-bright)] hover:text-[var(--text-primary)] disabled:opacity-50"
                >
                  {whatsappQrLoading ? t("Generating...") : t("Generate a new QR code")}
                </button>
              </div>
            </div>
          )}

          <ChannelProxySettings channelId="whatsapp" />

          {whatsappStatus && <StatusMessage type={whatsappStatus.type} message={whatsappStatus.message} />}

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={prepareWhatsApp}
              disabled={whatsappPreparing || whatsappQrLoading || !canConfigureWhatsApp}
              className={`${SAVE_BUTTON_CLASS} flex items-center gap-2`}
            >
              {(whatsappPreparing || whatsappQrLoading) && ButtonSpinner}
              {whatsappPreparing || whatsappQrLoading
                ? t("Preparing...")
                : !whatsappEnabled
                  ? t("Disable WhatsApp")
                  : whatsappLinked
                    ? t("Save settings")
                    : t("Prepare & Show QR")}
            </button>
            <button
              type="button"
              onClick={checkWhatsAppStatus}
              disabled={whatsappChecking || !whatsappConfigured}
              className="px-4 py-2.5 rounded-lg border border-gray-600 text-sm font-semibold text-[var(--text-secondary)] hover:border-[var(--coral-bright)] hover:text-[var(--text-primary)] disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {whatsappChecking ? t("Checking...") : t("Check status")}
            </button>
            {whatsappLinked && (
              <button
                type="button"
                onClick={logoutWhatsApp}
                disabled={whatsappLogoutBusy}
                className="px-4 py-2.5 rounded-lg border border-red-500/30 text-sm font-semibold text-red-400 hover:bg-red-500/10 disabled:opacity-50"
              >
                {whatsappLogoutBusy ? t("Unlinking...") : t("Unlink WhatsApp")}
              </button>
            )}
          </div>

          <div className="rounded-lg border border-gray-700 bg-[var(--bg-deep)] p-3" aria-label={t("WhatsApp connection evidence")}>
            <p className="mb-2 text-xs font-semibold text-[var(--text-secondary)]">{t("Live connection evidence")}</p>
            <div className="space-y-2 text-xs">
              <div className="flex items-start justify-between gap-3">
                <span className="text-[var(--text-secondary)]">{t("QR device link")}</span>
                <span className={whatsappLinked ? "text-[#00e5cc]" : "text-amber-400"}>
                  {whatsappLinked ? t("Verified") : t("Waiting")}
                </span>
              </div>
              <div className="flex items-start justify-between gap-3">
                <span className="text-[var(--text-secondary)]">{t("Live OpenClaw gateway connection")}</span>
                <span className={whatsappDone ? "text-[#00e5cc]" : "text-amber-400"}>
                  {whatsappDone ? t("Verified") : t("Waiting")}
                </span>
              </div>
              {whatsappSelfNumber && (
                <div className="flex items-start justify-between gap-3 border-t border-gray-700 pt-2">
                  <span className="text-[var(--text-secondary)]">{t("Linked account")}</span>
                  <span className="break-all text-right font-mono text-[var(--text-primary)]">{whatsappSelfNumber}</span>
                </div>
              )}
            </div>
            <p className="mt-2 text-[11px] leading-relaxed text-[var(--text-muted)]">
              {t("WhatsApp is marked done only while both the saved link and the live gateway connection are confirmed.")}
            </p>
          </div>

          {whatsappDone && whatsappMode === "dedicated" && (
            <div className="border-t border-gray-700 pt-3 space-y-3">
              <div>
                <p className="text-xs font-semibold text-[var(--text-secondary)]">{t("Approve the first user")}</p>
                <p className="mt-1 text-xs leading-relaxed text-[var(--text-muted)]">
                  {t("Send a private message to this WhatsApp number from another account. Then refresh the request list and approve that sender.")}
                </p>
              </div>
              <button
                type="button"
                onClick={refreshWhatsAppPairingRequests}
                disabled={whatsappPairingLoading}
                className="px-4 py-2 rounded-lg border border-gray-600 text-xs font-semibold text-[var(--text-secondary)] hover:border-[var(--coral-bright)] hover:text-[var(--text-primary)] disabled:opacity-50"
              >
                {whatsappPairingLoading ? t("Refreshing...") : t("Refresh pairing requests")}
              </button>
              {whatsappPairingRequests.length > 0 && (
                <div className="space-y-2">
                  {whatsappPairingRequests.map((request) => (
                    <div key={request.code} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-gray-700 bg-[var(--bg-deep)] px-3 py-2.5">
                      <div className="min-w-0">
                        <p className="text-xs font-semibold text-[var(--text-primary)]">
                          {request.displayName || t("WhatsApp user {id}", { id: request.senderId })}
                        </p>
                        <p className="mt-0.5 break-all text-[11px] text-[var(--text-muted)]">ID: {request.senderId}</p>
                      </div>
                      <button
                        type="button"
                        onClick={() => approveWhatsAppRequest(request.code)}
                        disabled={whatsappApprovingCode !== null}
                        className="px-3 py-1.5 btn-gradient text-white rounded-lg text-xs font-semibold disabled:opacity-50"
                      >
                        {whatsappApprovingCode === request.code ? t("Approving...") : t("Approve")}
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {whatsappDone && whatsappMode === "personal" && (
            <div className="border-t border-gray-700 pt-3">
              <p className="text-xs font-semibold text-[var(--text-secondary)]">{t("Test your private chat")}</p>
              <p className="mt-1 text-xs leading-relaxed text-[var(--text-muted)]">
                {t("Send a message in your own WhatsApp chat. Personal-number mode uses the owner allowlist, so no pairing approval is expected here.")}
              </p>
            </div>
          )}
        </ChannelContentSection>

        {/* Feishu / Lark */}
        <ChannelContentSection id="feishu" title={t("Feishu / Lark")} active={activeChatChannel === "feishu"}>
          {!canConfigureFeishu ? (
            <div className="rounded-lg border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-xs leading-relaxed text-amber-300">{t("Configure your AI provider first. Feishu setup unlocks after AI credentials are saved.")}</div>
          ) : (
            <p className="text-xs text-[var(--text-muted)] leading-relaxed">{t("Create an enterprise app, enable its bot and long-connection event subscription, then paste the credentials once. Group chats are disabled in this first version.")}</p>
          )}

          {canConfigureFeishu && (
            <ChannelQrSetupPanel
              channel="feishu"
              session={channelQrSessions.feishu}
              loading={channelQrLoading.feishu === true}
              onStart={() => void requestChannelQr("feishu")}
              onCancel={() => void cancelChannelQr("feishu")}
            />
          )}

          <div className="flex items-center gap-2">
            <span className="text-xs text-[var(--text-secondary)]">{t("Enable Feishu")}</span>
            <label className={`relative inline-flex items-center ${canConfigureFeishu ? "cursor-pointer" : "cursor-not-allowed opacity-60"}`}>
              <input type="checkbox" checked={feishuEnabled} onChange={(event) => setFeishuEnabled(event.target.checked)} disabled={!canConfigureFeishu} aria-label={t("Enable Feishu")} className="sr-only peer" />
              <div className="w-9 h-5 bg-[var(--bg-deep)] peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-[var(--coral-bright)] rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-[var(--coral-bright)]" />
            </label>
          </div>

          <div>
            <label htmlFor="feishu-domain" className={LABEL_CLASS}>{t("Platform")}</label>
            <select id="feishu-domain" value={feishuDomain} onChange={(event) => setFeishuDomain(event.target.value === "lark" ? "lark" : "feishu")} disabled={!canConfigureFeishu} className={INPUT_CLASS}>
              <option value="feishu">{t("Feishu (China)")}</option>
              <option value="lark">{t("Lark (International)")}</option>
            </select>
          </div>

          <CredentialGuide
            title={t("How to get {platform} App ID and App Secret", { platform: feishuDomain === "lark" ? "Lark" : "Feishu" })}
            steps={locale === "zh-CN" ? [
              <>打开 <a href={feishuDomain === "lark" ? "https://open.larksuite.com/app" : "https://open.feishu.cn/app"} target="_blank" rel="noopener noreferrer">{feishuDomain === "lark" ? "Lark" : "飞书"}开发者后台</a>，创建企业自建应用（Lark 中称为 Custom App）。</>,
              <>为应用启用机器人能力。</>,
              <>添加所需权限：<code>im:message</code>、<code>im:chat</code> 和 <code>contact:user.base:readonly</code>。</>,
              <>在事件订阅中选择长连接/WebSocket，并订阅 <code>im.message.receive_v1</code>。</>,
              <>创建并发布应用版本，使组织内可以使用该机器人。</>,
              <>打开“凭证与基础信息”，复制 <strong>App ID</strong> 和完整 <strong>App Secret</strong>，然后粘贴到下方。</>,
            ] : [
              <>
                Open the{" "}
                <a
                  href={feishuDomain === "lark" ? "https://open.larksuite.com/app" : "https://open.feishu.cn/app"}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {feishuDomain === "lark" ? "Lark" : "Feishu"} developer console
                </a>{" "}
                and create an enterprise self-built app (called a custom app in Lark).
              </>,
              <>Enable the Bot capability for the app.</>,
              <>
                Add the required permissions: <code>im:message</code>, <code>im:chat</code>, and{" "}
                <code>contact:user.base:readonly</code>.
              </>,
              <>
                In Event Subscriptions, choose long connection/WebSocket and subscribe to{" "}
                <code>im.message.receive_v1</code>.
              </>,
              <>Create and publish an app version so the bot is available in your organization.</>,
              <>
                Open Credentials &amp; Basic Info, copy the <strong>App ID</strong> and the complete{" "}
                <strong>App Secret</strong>, then paste them below.
              </>,
            ]}
            securityNote={locale === "zh-CN"
              ? "不要将 App Secret 提交到 GitHub，也不要在截图或聊天消息中泄露。"
              : "Never commit the App Secret to GitHub or include it in screenshots or chat messages."}
          />

          <div>
            <label htmlFor="feishu-app-id" className={LABEL_CLASS}>{t("App ID")}</label>
            <input id="feishu-app-id" value={feishuAppId} onChange={(event) => setFeishuAppId(event.target.value)} placeholder="cli_..." autoComplete="off" disabled={!canConfigureFeishu} className={INPUT_CLASS} />
          </div>
          <div>
            <label htmlFor="feishu-app-secret" className={LABEL_CLASS}>{t("App Secret")}</label>
            <PasswordInput id="feishu-app-secret" value={feishuAppSecret} onChange={setFeishuAppSecret} visible={showFeishuSecret} onToggle={() => setShowFeishuSecret((visible) => !visible)} placeholder={feishuConfigured ? t("Secret already saved; leave blank to keep it") : t("Paste App Secret")} autoComplete="off" disabled={!canConfigureFeishu} />
          </div>

          {feishuStatus && <StatusMessage type={feishuStatus.type} message={feishuStatus.message} />}
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={saveFeishu} disabled={feishuSaving || !canConfigureFeishu} className={`${SAVE_BUTTON_CLASS} flex items-center gap-2`}>{feishuSaving && ButtonSpinner}{feishuSaving ? t("Validating and connecting...") : t("Save & Connect")}</button>
            <button type="button" onClick={() => { setFeishuChecking(true); refreshFeishuStatus({ announce: true, force: true }).catch((error) => setFeishuStatus({ type: "error", message: String(error) })).finally(() => setFeishuChecking(false)); }} disabled={feishuChecking || !feishuConfigured} className="px-4 py-2.5 rounded-lg border border-gray-600 text-sm font-semibold text-[var(--text-secondary)] hover:border-[var(--coral-bright)] hover:text-[var(--text-primary)] disabled:opacity-50 disabled:cursor-not-allowed">{feishuChecking ? t("Checking...") : t("Check status")}</button>
          </div>

          {feishuDone && (
            <div className="border-t border-gray-700 pt-3 space-y-3">
              <div><p className="text-xs font-semibold text-[var(--text-secondary)]">{t("Approve the first user")}</p><p className="mt-1 text-xs leading-relaxed text-[var(--text-muted)]">{t("Open {bot} in {platform}, send a private message, then refresh and approve your account.", { bot: feishuBotName || t("your bot"), platform: feishuDomain === "lark" ? "Lark" : locale === "zh-CN" ? "飞书" : "Feishu" })}</p></div>
              <button type="button" onClick={refreshFeishuPairingRequests} disabled={feishuPairingLoading} className="px-4 py-2 rounded-lg border border-gray-600 text-xs font-semibold text-[var(--text-secondary)] hover:border-[var(--coral-bright)] hover:text-[var(--text-primary)] disabled:opacity-50">{feishuPairingLoading ? t("Refreshing...") : t("Refresh pairing requests")}</button>
              {feishuPairingRequests.length > 0 && <div className="space-y-2">{feishuPairingRequests.map((request) => (
                <div key={request.code} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-gray-700 bg-[var(--bg-deep)] px-3 py-2.5">
                  <div className="min-w-0"><p className="text-xs font-semibold text-[var(--text-primary)]">{request.displayName || t("Feishu user {id}", { id: request.senderId })}</p><p className="mt-0.5 break-all text-[11px] text-[var(--text-muted)]">ID: {request.senderId}</p></div>
                  <button type="button" onClick={() => approveFeishuRequest(request.code)} disabled={feishuApprovingCode !== null} className="px-3 py-1.5 btn-gradient text-white rounded-lg text-xs font-semibold disabled:opacity-50">{feishuApprovingCode === request.code ? t("Approving...") : t("Approve")}</button>
                </div>
              ))}</div>}
            </div>
          )}
        </ChannelContentSection>

        {/* LINE */}
        <ChannelContentSection
          id="line"
          title="LINE"
          active={activeChatChannel === "line"}
        >
          {!canConfigureLine ? (
            <div className="rounded-lg border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-xs leading-relaxed text-amber-300">
              {t("Configure your AI provider first. LINE setup unlocks after AI credentials are saved.")}
            </div>
          ) : (
            <div className="space-y-2 text-xs leading-relaxed text-[var(--text-muted)]">
              <p>{t("ClawBox itself needs no account or sign-in. You only sign in to LINE's official console to create and manage the Messaging API channel.")}</p>
              <p className="rounded-lg border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-amber-300">
                {t("LINE must reach this device through a public HTTPS URL. LAN HTTP, a private IP, and a self-signed certificate will not work; configure a trusted domain, reverse proxy, or tunnel first.")}
              </p>
            </div>
          )}

          <CredentialGuide
            title={t("How to create the LINE channel and webhook")}
            steps={locale === "zh-CN" ? [
              <>打开 <a href="https://manager.line.biz/" target="_blank" rel="noopener noreferrer">LINE Official Account Manager</a>，创建或选择一个 LINE Official Account。没有账号时，请从 <a href="https://developers.line.biz/en/docs/messaging-api/getting-started/" target="_blank" rel="noopener noreferrer">官方入门页</a>开始。</>,
              <>在 Official Account Manager 中进入 <strong>Settings → Messaging API</strong>，点击 <strong>Use Messaging API</strong>，选择或创建 Provider 后确认。Provider 绑定后不能更换或解除；此操作需要 Admin 权限。自 2024-09-04 起，不能再从 Developers Console 直接新建 Messaging API channel。</>,
              <>打开 <a href="https://developers.line.biz/console/" target="_blank" rel="noopener noreferrer">LINE Developers Console</a>，进入对应 Provider 和 Messaging API channel。在 <strong>Basic settings → Channel secret</strong> 复制 Secret；尚未生成时点击 <strong>Issue</strong>。</>,
              <>进入 <strong>Messaging API → Channel access token (long-lived)</strong>，点击 <strong>Issue</strong> 并复制 Token。当前静态设备配置使用长效 Token；重新签发后旧 Token 会失效。</>,
              <>先准备一个具有受信任证书的公网 HTTPS 域名、反向代理或隧道，将 <code>/line/webhook</code> 转发到此 ClawBox。把 HTTPS origin（例如 <code>https://line.example.com</code>）填到下方，不要附加路径。</>,
              <>保存后复制页面生成的完整 Webhook URL。在 Console 的 <strong>Messaging API → Webhook URL</strong> 中依次选择 <strong>Edit → Update → Verify</strong>，看到 Success 后开启 <strong>Use webhook</strong>。</>,
              <>在 Official Account Manager 的 <strong>Settings → Response settings</strong> 中关闭 Greeting messages 和 Auto-reply/Response messages，避免与 OpenClaw 重复回复。</>,
              <>在 Console 的 Messaging API 页扫描二维码添加 Official Account 为好友，发送一条真实消息，再回到这里检查状态并批准首次用户。只有收到真实入站 Webhook 后，本页才会显示完成。</>,
            ] : [
              <>Open <a href="https://manager.line.biz/" target="_blank" rel="noopener noreferrer">LINE Official Account Manager</a> and create or select a LINE Official Account. If you do not have one, begin with the <a href="https://developers.line.biz/en/docs/messaging-api/getting-started/" target="_blank" rel="noopener noreferrer">official getting-started guide</a>.</>,
              <>In Official Account Manager, open <strong>Settings → Messaging API</strong>, select <strong>Use Messaging API</strong>, choose or create a Provider, then confirm. The Provider cannot be changed or unlinked afterward, and this action requires Admin access. Since September 4, 2024, Messaging API channels can no longer be created directly in Developers Console.</>,
              <>Open <a href="https://developers.line.biz/console/" target="_blank" rel="noopener noreferrer">LINE Developers Console</a>, then open the matching Provider and Messaging API channel. Copy the secret from <strong>Basic settings → Channel secret</strong>; select <strong>Issue</strong> if it has not been created.</>,
              <>Open <strong>Messaging API → Channel access token (long-lived)</strong>, select <strong>Issue</strong>, and copy the token. A long-lived token fits this static device setup; issuing a replacement invalidates the old token.</>,
              <>Prepare a public HTTPS domain, reverse proxy, or tunnel with a publicly trusted certificate and forward <code>/line/webhook</code> to this ClawBox. Enter only the HTTPS origin below, for example <code>https://line.example.com</code>, without a path.</>,
              <>After saving, copy the complete Webhook URL generated below. In <strong>Messaging API → Webhook URL</strong>, select <strong>Edit → Update → Verify</strong>. After Verify reports Success, enable <strong>Use webhook</strong>.</>,
              <>In Official Account Manager, open <strong>Settings → Response settings</strong> and turn off Greeting messages and Auto-reply/Response messages to avoid duplicate replies from LINE and OpenClaw.</>,
              <>On the Console Messaging API page, scan the QR code to add the Official Account, send one real message, then return here to check status and approve the first user. This page is marked done only after a real inbound webhook is received.</>,
            ]}
            securityNote={locale === "zh-CN"
              ? "Channel access token 和 Channel secret 都是敏感凭据。不要提交到 GitHub，也不要放进截图或聊天消息；泄露后请立即重新签发。"
              : "The Channel access token and Channel secret are sensitive credentials. Never commit them to GitHub or include them in screenshots or chat messages; reissue them immediately if exposed."}
          />

          <div className="flex items-center gap-2">
            <span className="text-xs text-[var(--text-secondary)]">{t("Enable LINE")}</span>
            <label className={`relative inline-flex items-center ${canConfigureLine ? "cursor-pointer" : "cursor-not-allowed opacity-60"}`}>
              <input
                type="checkbox"
                checked={lineEnabled}
                onChange={(event) => setLineEnabled(event.target.checked)}
                disabled={!canConfigureLine}
                aria-label={t("Enable LINE")}
                className="sr-only peer"
              />
              <div className="w-9 h-5 bg-[var(--bg-deep)] peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-[var(--coral-bright)] rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-[var(--coral-bright)]" />
            </label>
          </div>

          <div>
            <label htmlFor="line-access-token" className={LABEL_CLASS}>{t("Channel access token (long-lived)")}</label>
            <PasswordInput
              id="line-access-token"
              value={lineAccessToken}
              onChange={setLineAccessToken}
              visible={showLineAccessToken}
              onToggle={() => setShowLineAccessToken((visible) => !visible)}
              placeholder={lineConfigured ? t("Token already saved; leave blank to keep it") : t("Paste the complete channel access token")}
              autoComplete="off"
              disabled={!canConfigureLine}
            />
          </div>

          <div>
            <label htmlFor="line-channel-secret" className={LABEL_CLASS}>{t("Channel secret")}</label>
            <PasswordInput
              id="line-channel-secret"
              value={lineChannelSecret}
              onChange={setLineChannelSecret}
              visible={showLineChannelSecret}
              onToggle={() => setShowLineChannelSecret((visible) => !visible)}
              placeholder={lineConfigured ? t("Secret already saved; leave blank to keep it") : t("Paste the complete channel secret")}
              autoComplete="off"
              disabled={!canConfigureLine}
            />
          </div>

          <div>
            <label htmlFor="line-public-base-url" className={LABEL_CLASS}>{t("Public HTTPS base URL")}</label>
            <input
              id="line-public-base-url"
              type="url"
              inputMode="url"
              value={linePublicBaseUrl}
              onChange={(event) => {
                setLinePublicBaseUrl(event.target.value);
                setLineWebhookCopied(false);
              }}
              placeholder="https://line.example.com"
              autoComplete="url"
              spellCheck={false}
              disabled={!canConfigureLine}
              className={INPUT_CLASS}
            />
            <p className="mt-1.5 text-[11px] leading-relaxed text-[var(--text-muted)]">
              {t("Enter the public origin only. ClawBox appends /line/webhook after validating and saving it.")}
            </p>
          </div>

          {linePublicWebhookUrl ? (
            <div className="rounded-lg border border-gray-700 bg-[var(--bg-deep)] p-3">
              <p className="text-xs font-semibold text-[var(--text-secondary)]">{t("Webhook URL to paste into LINE")}</p>
              <code className="mt-2 block break-all rounded-md bg-black/20 px-2.5 py-2 text-[11px] text-[#00e5cc]">{linePublicWebhookUrl}</code>
              <button
                type="button"
                onClick={copyLineWebhookUrl}
                className="mt-2 px-3 py-1.5 rounded-md border border-gray-600 text-xs font-semibold text-[var(--text-secondary)] hover:border-[var(--coral-bright)] hover:text-[var(--text-primary)]"
              >
                {lineWebhookCopied ? t("Copied") : t("Copy webhook URL")}
              </button>
            </div>
          ) : (
            <div className="rounded-lg border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-xs leading-relaxed text-amber-300">
              {t("No public webhook URL is saved yet. Credentials can be checked locally, but LINE cannot deliver messages until this URL is configured in both ClawBox and LINE Developers Console.")}
            </div>
          )}

          {lineStatus && <StatusMessage type={lineStatus.type} message={lineStatus.message} />}

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={saveLine}
              disabled={lineSaving || !canConfigureLine}
              className={`${SAVE_BUTTON_CLASS} flex items-center gap-2`}
            >
              {lineSaving && ButtonSpinner}
              {lineSaving
                ? t("Validating and connecting...")
                : lineEnabled
                  ? t("Save & Validate")
                  : t("Disable LINE")}
            </button>
            <button
              type="button"
              onClick={checkLineStatus}
              disabled={lineChecking || !lineConfigured}
              className="px-4 py-2.5 rounded-lg border border-gray-600 text-sm font-semibold text-[var(--text-secondary)] hover:border-[var(--coral-bright)] hover:text-[var(--text-primary)] disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {lineChecking ? t("Checking...") : t("Check status")}
            </button>
          </div>

          <div className="rounded-lg border border-gray-700 bg-[var(--bg-deep)] p-3" aria-label={t("LINE connection evidence")}>
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <p className="text-xs font-semibold text-[var(--text-secondary)]">{t("Live connection evidence")}</p>
              {(lineBotName || lineBotBasicId) && (
                <p className="break-all text-[11px] text-[var(--text-muted)]">
                  {lineBotName || t("LINE bot")}{lineBotBasicId ? ` (${lineBotBasicId})` : ""}
                </p>
              )}
            </div>
            <div className="mt-2 space-y-2 text-xs">
              <div className="flex items-start justify-between gap-3">
                <span className="text-[var(--text-secondary)]">{t("LINE channel token probe")}</span>
                <span className={lineProbeOk ? "text-[#00e5cc]" : "text-amber-400"}>
                  {lineProbeOk ? t("Verified") : t("Waiting")}
                </span>
              </div>
              <div className="flex items-start justify-between gap-3">
                <span className="text-[var(--text-secondary)]">{t("Local webhook listener")}</span>
                <span className={lineRunning ? "text-[#00e5cc]" : "text-amber-400"}>
                  {lineRunning ? t("Verified") : t("Waiting")}
                </span>
              </div>
              <div className="flex items-start justify-between gap-3">
                <span className="text-[var(--text-secondary)]">{t("Real inbound webhook")}</span>
                <span className={lineLastInboundAt !== null ? "text-[#00e5cc]" : "text-amber-400"}>
                  {lineLastInboundAt !== null
                    ? new Date(lineLastInboundAt).toLocaleString(locale)
                    : t("Waiting")}
                </span>
              </div>
            </div>
            <p className="mt-2 text-[11px] leading-relaxed text-[var(--text-muted)]">
              {t("LINE is marked done only after all three checks pass, including a real message delivered through the public webhook.")}
            </p>
          </div>

          {lineDone && (
            <div className="border-t border-gray-700 pt-3 space-y-3">
              <div>
                <p className="text-xs font-semibold text-[var(--text-secondary)]">{t("Approve the first user")}</p>
                <p className="mt-1 text-xs leading-relaxed text-[var(--text-muted)]">
                  {t("After sending a private message to the LINE Official Account, refresh this list and approve your account. Then send another message to verify the AI reply.")}
                </p>
              </div>
              <button
                type="button"
                onClick={refreshLinePairingRequests}
                disabled={linePairingLoading}
                className="px-4 py-2 rounded-lg border border-gray-600 text-xs font-semibold text-[var(--text-secondary)] hover:border-[var(--coral-bright)] hover:text-[var(--text-primary)] disabled:opacity-50"
              >
                {linePairingLoading ? t("Refreshing...") : t("Refresh pairing requests")}
              </button>
              {linePairingRequests.length > 0 && (
                <div className="space-y-2">
                  {linePairingRequests.map((request) => (
                    <div key={request.code} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-gray-700 bg-[var(--bg-deep)] px-3 py-2.5">
                      <div className="min-w-0">
                        <p className="text-xs font-semibold text-[var(--text-primary)]">
                          {request.displayName || t("LINE user {id}", { id: request.senderId })}
                        </p>
                        <p className="mt-0.5 break-all text-[11px] text-[var(--text-muted)]">ID: {request.senderId}</p>
                      </div>
                      <button
                        type="button"
                        onClick={() => approveLineRequest(request.code)}
                        disabled={lineApprovingCode !== null}
                        className="px-3 py-1.5 btn-gradient text-white rounded-lg text-xs font-semibold disabled:opacity-50"
                      >
                        {lineApprovingCode === request.code ? t("Approving...") : t("Approve")}
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </ChannelContentSection>

        {/* QQ Official Bot */}
        <ChannelContentSection
          id="qqbot"
          title={t("QQ Official Bot")}
          active={activeChatChannel === "qqbot"}
        >
          {!canConfigureQQBot ? (
            <div className="rounded-lg border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-xs leading-relaxed text-amber-300">
              {t("Configure your AI provider first. QQ Bot setup unlocks after AI credentials are saved.")}
            </div>
          ) : (
            <p className="text-xs leading-relaxed text-[var(--text-muted)]">
              {t("Connect through the official QQ Bot API. Private messages are enabled for users who can access the bot on QQ; group messages are disabled. The current OpenClaw QQ plugin does not use Telegram-style pairing.")}
            </p>
          )}

          {canConfigureQQBot && (
            <ChannelQrSetupPanel
              channel="qqbot"
              session={channelQrSessions.qqbot}
              loading={channelQrLoading.qqbot === true}
              onStart={() => void requestChannelQr("qqbot")}
              onCancel={() => void cancelChannelQr("qqbot")}
            />
          )}

          <CredentialGuide
            title={t("How to get QQ Bot AppID and AppSecret")}
            steps={locale === "zh-CN" ? [
              <>打开 <a href="https://q.qq.com/qqbot/openclaw/" target="_blank" rel="noopener noreferrer">QQ 机器人 OpenClaw 设置页</a>，使用将持有该机器人的手机 QQ 扫码登录。</>,
              <>选择<strong>创建机器人</strong>，或选择已有机器人，然后完成必要的基础信息。</>,
              <>打开机器人设置页，复制完整 <strong>AppID</strong> 和 <strong>AppSecret</strong>。AppID 是机器人应用标识，不是个人 QQ 号。</>,
              <>立即保存 AppSecret。QQ 只显示一次；再次查看可能需要重置并使旧密钥失效，重置后请同步更新此表单。</>,
              <>OpenClaw 通过 WebSocket 连接，因此不需要 webhook URL 或事件回调。首次私聊测试时，机器人所有者无需向所有人发布即可使用。</>,
              <>如需其他用户查找或添加机器人，请在 <a href="https://q.qq.com/qqbot/dashboard/" target="_blank" rel="noopener noreferrer">QQ 机器人管理端</a>配置体验用户和可见范围。这些选项可能需要额外协议或审核；ClawBox 仍禁用群聊。</>,
              <>将两个值粘贴到下方并选择“保存并连接”。通道在线后，在 QQ 中打开机器人并发送私聊消息。QQ 不需要单独的 ClawBox 配对批准。</>,
            ] : [
              <>
                Open the{" "}
                <a href="https://q.qq.com/qqbot/openclaw/" target="_blank" rel="noopener noreferrer">
                  QQ Bot OpenClaw setup page
                </a>{" "}
                and scan the sign-in QR code with the mobile QQ account that will own the bot.
              </>,
              <>
                Select <strong>Create Bot</strong>, or choose an existing bot, then complete any required basic information.
              </>,
              <>
                Open the bot settings page and copy the complete <strong>AppID</strong> and <strong>AppSecret</strong>. AppID is the bot application identifier, not your personal QQ number.
              </>,
              <>
                Save the AppSecret immediately. QQ displays it once; viewing it again can require a reset that invalidates the old secret, so update this form after any reset.
              </>,
              <>
                No webhook URL or event callback is needed because OpenClaw connects by WebSocket. For the first private-chat test, the bot owner can use the bot without publishing it to everyone.
              </>,
              <>
                To let other users find or add the bot later, configure its experience-user and visibility scope in the{" "}
                <a href="https://q.qq.com/qqbot/dashboard/" target="_blank" rel="noopener noreferrer">
                  QQ Bot dashboard
                </a>
                . Those options can require extra platform agreements or review; group messages remain disabled in ClawBox.
              </>,
              <>
                Paste both values below and select Save &amp; Connect. When the channel is online, open the bot in QQ and send a private message. QQ does not need a separate ClawBox pairing approval.
              </>,
            ]}
            securityNote={locale === "zh-CN"
              ? "不要将 AppSecret 提交到 GitHub，也不要在截图或聊天消息中泄露。如果已经泄露，请立即重新生成。"
              : "Never commit the AppSecret to GitHub or include it in screenshots or chat messages. Regenerate it immediately if it is exposed."}
          />

          <div className="flex items-center gap-2">
            <span className="text-xs text-[var(--text-secondary)]">{t("Enable QQ Bot")}</span>
            <label className={`relative inline-flex items-center ${canConfigureQQBot ? "cursor-pointer" : "cursor-not-allowed opacity-60"}`}>
              <input
                type="checkbox"
                checked={qqbotEnabled}
                onChange={(event) => setQQBotEnabled(event.target.checked)}
                disabled={!canConfigureQQBot}
                aria-label={t("Enable QQ Bot")}
                className="sr-only peer"
              />
              <div className="w-9 h-5 bg-[var(--bg-deep)] peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-[var(--coral-bright)] rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-[var(--coral-bright)]" />
            </label>
          </div>

          <div>
            <label htmlFor="qqbot-app-id" className={LABEL_CLASS}>AppID</label>
            <input
              id="qqbot-app-id"
              value={qqbotAppId}
              onChange={(event) => setQQBotAppId(event.target.value)}
              placeholder={t("Paste the complete AppID")}
              autoComplete="off"
              spellCheck={false}
              disabled={!canConfigureQQBot}
              className={INPUT_CLASS}
            />
          </div>

          <div>
            <label htmlFor="qqbot-app-secret" className={LABEL_CLASS}>AppSecret</label>
            <PasswordInput
              id="qqbot-app-secret"
              value={qqbotAppSecret}
              onChange={setQQBotAppSecret}
              visible={showQQBotSecret}
              onToggle={() => setShowQQBotSecret((visible) => !visible)}
              placeholder={qqbotConfigured ? t("Saved; leave blank to keep it") : t("Paste the complete AppSecret")}
              autoComplete="off"
              disabled={!canConfigureQQBot}
            />
          </div>

          {qqbotStatus && <StatusMessage type={qqbotStatus.type} message={qqbotStatus.message} />}

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={saveQQBot}
              disabled={qqbotSaving || !canConfigureQQBot}
              className={`${SAVE_BUTTON_CLASS} flex items-center gap-2`}
            >
              {qqbotSaving && ButtonSpinner}
              {qqbotSaving ? t("Validating and connecting...") : t("Save & Connect")}
            </button>
            <button
              type="button"
              onClick={checkQQBotStatus}
              disabled={qqbotChecking || !qqbotConfigured}
              className="px-4 py-2.5 rounded-lg border border-gray-600 text-sm font-semibold text-[var(--text-secondary)] hover:border-[var(--coral-bright)] hover:text-[var(--text-primary)] disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {qqbotChecking ? t("Checking...") : t("Check status")}
            </button>
          </div>

          {qqbotDone && (
            <div className="border-t border-gray-700 pt-3">
              <p className="text-xs font-semibold text-[var(--text-secondary)]">{t("Test the first private message")}</p>
              <p className="mt-1 text-xs leading-relaxed text-[var(--text-muted)]">
                {t("Use the QQ account that owns the bot, open the bot in QQ, and send a private message. It should reply through the configured AI provider; there is no pairing request to approve on this page. Configure platform visibility only when other users also need access.")}
              </p>
            </div>
          )}
        </ChannelContentSection>

        {/* Discord, Zalo, and Signal. Keep the status owner mounted so the summary stays live. */}
        <ChannelSetupExtras
          canConfigure={providerDone}
          activeChannel={isAdditionalChatChannel(activeChatChannel) ? activeChatChannel : null}
          initialZaloMode={initialZaloMode}
          statusRefreshToken={additionalStatusRefreshToken}
          onStatusesChange={handleAdditionalStatuses}
        />

        {/* WeChat Bot */}
        <ChannelContentSection id="wechat" title={t("WeChat Bot")} active={activeChatChannel === "wechat"}>
          {!canConfigureWechat ? (
            <div className="rounded-lg border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-xs leading-relaxed text-amber-300">
              {t("Configure your AI provider first. WeChat bot setup unlocks after AI credentials are saved.")}
            </div>
          ) : (
            <p className="text-xs text-[var(--text-muted)] leading-relaxed">
              {t("Optional after AI setup. Enable this if the device will receive tasks through WeChat.")}
            </p>
          )}
          <div className="flex items-center gap-2 mb-4">
            <span className="text-xs text-[var(--text-secondary)]">{t("Enable WeChat Bot")}</span>
            <label className={`relative inline-flex items-center ${canConfigureWechat ? "cursor-pointer" : "cursor-not-allowed opacity-60"}`}>
              <input type="checkbox" checked={wechatEnabled} onChange={(e) => setWechatEnabled(e.target.checked)} disabled={!canConfigureWechat} aria-label={t("Enable WeChat Bot")} className="sr-only peer" />
              <div className="w-9 h-5 bg-[var(--bg-deep)] peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-[var(--coral-bright)] rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-[var(--coral-bright)]"></div>
            </label>
          </div>
          <p className="text-xs text-[var(--text-muted)] mb-3 leading-relaxed">
            {t("Disabling saves config and restarts the OpenClaw gateway so the bot stops until you turn it back on.")}
          </p>
          <div className="rounded-lg border border-gray-700 bg-[var(--bg-surface)] p-3 space-y-3">
            <div className="flex flex-wrap items-center gap-2 justify-between">
              <div>
                <p className="text-xs font-semibold text-[var(--text-secondary)]">{t("QR code login (recommended)")}</p>
                <p className="text-xs text-[var(--text-muted)] mt-1">{t("Click refresh to generate a new QR code, then scan immediately in WeChat.")}</p>
              </div>
              <button
                type="button"
                onClick={requestWechatQrCode}
                disabled={wechatQrLoading || !canConfigureWechat}
                className={`${SAVE_BUTTON_CLASS} flex items-center gap-2`}
              >
                {wechatQrLoading && ButtonSpinner}
                {wechatQrLoading ? t("Refreshing...") : wechatQrUrl ? t("Refresh QR") : t("Get QR")}
              </button>
            </div>

            {wechatQrUrl && (
              <div className="rounded-lg border border-gray-700/70 bg-[var(--bg-deep)] p-3 space-y-2">
                <div className="w-full flex justify-center">
                  <div className="bg-white p-2 rounded-md">
                    <QRCodeSVG value={wechatQrUrl} size={170} level="M" />
                  </div>
                </div>
                <div className="space-y-2">
                  <p className="text-[11px] text-[var(--text-muted)]">
                    {t("MCP one-screen mode (experimental): use the same phone to open the WeChat auth link directly, then return here to verify.")}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={openWechatMcpLink}
                      className="px-3 py-1.5 rounded-md text-[11px] font-semibold bg-[#00e5cc]/20 text-[#00e5cc] hover:bg-[#00e5cc]/30"
                    >
                      {t("Open in WeChat (MCP)")}
                    </button>
                    <button
                      type="button"
                      onClick={copyWechatMcpLink}
                      className="px-3 py-1.5 rounded-md text-[11px] font-semibold bg-gray-700 text-gray-200 hover:bg-gray-600"
                    >
                      {wechatLinkCopied ? t("Copied") : t("Copy link")}
                    </button>
                    <button
                      type="button"
                      onClick={verifyWechatNow}
                      className="px-3 py-1.5 rounded-md text-[11px] font-semibold bg-[var(--coral-bright)]/20 text-[var(--coral-bright)] hover:bg-[var(--coral-bright)]/30"
                    >
                      {t("Check status")}
                    </button>
                  </div>
                  <p className="text-[11px] text-[var(--text-muted)] break-all">
                    {t("Fallback: if webview jumping fails, open this link manually:")}
                    <a href={wechatQrUrl} target="_blank" rel="noopener noreferrer" className="ml-1 text-[#00e5cc] underline">{t("Open QR link")}</a>
                  </p>
                </div>
              </div>
            )}
          </div>

          <div>
            <label htmlFor="wechat-token" className={LABEL_CLASS}>{t("Bot Token (fallback)")}</label>
            <PasswordInput
              id="wechat-token"
              value={wechatToken}
              onChange={setWechatToken}
              visible={showWechatToken}
              onToggle={() => setShowWechatToken((v) => !v)}
              placeholder={t("WeChat bot token")}
              autoComplete="off"
              disabled={!canConfigureWechat}
            />
          </div>
          <p className="text-xs text-[var(--text-muted)]">
            {t("Fallback only: use token mode if QR login is unavailable.")}
          </p>
          {wechatStatus && <StatusMessage type={wechatStatus.type} message={wechatStatus.message} />}
          <button type="button" onClick={saveWechat} disabled={wechatSaving || !canConfigureWechat} className={`${SAVE_BUTTON_CLASS} flex items-center gap-2`}>{wechatSaving && ButtonSpinner}{wechatSaving ? t("Saving...") : t("Save")}</button>
        </ChannelContentSection>

        {/* WeCom */}
        <ChannelContentSection id="wecom" title={t("WeCom")} active={activeChatChannel === "wecom"}>
          {!canConfigureWeCom ? (
            <div className="rounded-lg border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-xs leading-relaxed text-amber-300">
              {t("Configure your AI provider first. WeCom setup unlocks after AI credentials are saved.")}
            </div>
          ) : (
            <p className="text-xs leading-relaxed text-[var(--text-muted)]">
              {t("Connect an Enterprise WeChat smart bot over WebSocket with Bot ID and Secret.")}
            </p>
          )}

          <CredentialGuide
            title={t("How to configure a WeCom bot")}
            steps={locale === "zh-CN" ? [
              <>{t("WeCom step 1")} <code>openclaw plugins install @wecom/wecom-openclaw-plugin</code>。</>,
              <>{t("WeCom step 2")} <a href="https://open.work.weixin.qq.com/help?doc_id=21657" target="_blank" rel="noreferrer">{t("WeCom AI Bot documentation")}</a>。</>,
              <>{t("WeCom step 3")}</>,
              <>{t("WeCom step 4")}</>,
            ] : [
              <>Install the official WeCom OpenClaw plugin on the device running OpenClaw: <code>openclaw plugins install @wecom/wecom-openclaw-plugin</code>.</>,
              <>Create a WeCom smart bot by following the <a href="https://open.work.weixin.qq.com/help?doc_id=21657" target="_blank" rel="noreferrer">WeCom AI Bot documentation</a>.</>,
              <>Copy the Bot ID and Secret from the bot settings, then enter them below.</>,
              <>Save to reload the gateway in WebSocket mode, then use Check status to confirm that the plugin is connected.</>,
            ]}
            securityNote={locale === "zh-CN"
              ? t("Never commit WeCom Bot ID or Secret to GitHub or include them in screenshots or chat messages.")
              : "Never commit the WeCom Bot ID or Secret to GitHub or include them in screenshots or chat messages."}
          />

          <div className="flex items-center gap-2">
            <span className="text-xs text-[var(--text-secondary)]">{t("Enable WeCom")}</span>
            <label className={`relative inline-flex items-center ${canConfigureWeCom ? "cursor-pointer" : "cursor-not-allowed opacity-60"}`}>
              <input
                type="checkbox"
                checked={wecomEnabled}
                onChange={(event) => setWeComEnabled(event.target.checked)}
                disabled={!canConfigureWeCom}
                aria-label={t("Enable WeCom")}
                className="sr-only peer"
              />
              <div className="w-9 h-5 bg-[var(--bg-deep)] peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-[var(--coral-bright)] rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-[var(--coral-bright)]" />
            </label>
          </div>

          <div>
            <label htmlFor="wecom-bot-id" className={LABEL_CLASS}>{t("WeCom Bot ID")}</label>
            <input
              id="wecom-bot-id"
              value={wecomBotId}
              onChange={(event) => setWeComBotId(event.target.value)}
              placeholder={t("WeCom Bot ID")}
              autoComplete="off"
              spellCheck={false}
              disabled={!canConfigureWeCom}
              className={INPUT_CLASS}
            />
          </div>

          <div>
            <label htmlFor="wecom-secret" className={LABEL_CLASS}>{t("WeCom Secret")}</label>
            <PasswordInput
              id="wecom-secret"
              value={wecomSecret}
              onChange={setWeComSecret}
              visible={showWeComSecret}
              onToggle={() => setShowWeComSecret((visible) => !visible)}
              placeholder={wecomConfigured ? t("Secret already saved; leave blank to keep it") : t("WeCom Secret")}
              autoComplete="off"
              disabled={!canConfigureWeCom}
            />
          </div>

          {wecomStatus && <StatusMessage type={wecomStatus.type} message={wecomStatus.message} />}
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={saveWeCom}
              disabled={wecomSaving || !canConfigureWeCom}
              className={`${SAVE_BUTTON_CLASS} flex items-center gap-2`}
            >
              {wecomSaving && ButtonSpinner}
              {wecomSaving ? t("Saving...") : t("Save & Connect")}
            </button>
            <button
              type="button"
              onClick={checkWeComStatus}
              disabled={wecomChecking || !wecomConfigured}
              className="px-4 py-2.5 rounded-lg border border-gray-600 text-sm font-semibold text-[var(--text-secondary)] hover:border-[var(--coral-bright)] hover:text-[var(--text-primary)] disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {wecomChecking ? t("Checking...") : t("Check status")}
            </button>
          </div>

          {wecomDone && (
            <div className="border-t border-gray-700 pt-3">
              <p className="text-xs font-semibold text-[var(--text-secondary)]">{t("Test the first private message")}</p>
              <p className="mt-1 text-xs leading-relaxed text-[var(--text-muted)]">
                {t("Use the WeCom smart bot to send a private message. It should reply through the configured AI provider; no separate ClawBox pairing approval is required.")}
              </p>
            </div>
          )}
        </ChannelContentSection>

        </CollapsibleSection>

        {/* WiFi — change network / re-provision */}
        <CollapsibleSection
          id="wifi"
          title="WiFi"
          done={wifiDone}
          open={openSection === "wifi"}
          onToggle={toggle}
        >
          {wifiConnectedSSID && (
            <p className="text-xs text-[var(--text-secondary)] mb-3">
              {t("Currently connected: {ssid}", { ssid: wifiConnectedSSID })}
            </p>
          )}
          <div className="flex justify-end mb-2">
            <button
              type="button"
              onClick={scanWifiNetworks}
              disabled={wifiScanning}
              className="text-xs text-[var(--coral-bright)] hover:underline cursor-pointer disabled:opacity-50"
            >
              {wifiScanning ? t("Scanning...") : t("Scan networks")}
            </button>
          </div>
          {wifiNetworks.length > 0 && (
            <div className="mb-3 max-h-40 overflow-y-auto rounded-lg border border-gray-700 bg-[var(--bg-surface)]">
              {wifiNetworks.map((n, i) => (
                <button
                  key={`${n.ssid}-${i}`}
                  type="button"
                  onClick={() => {
                    setWifiSSID(n.ssid);
                    setWifiPassword("");
                  }}
                  className="w-full px-3 py-2 text-left text-sm text-gray-200 hover:bg-[var(--bg-elevated)] border-b border-gray-700 last:border-b-0"
                >
                  {n.ssid}
                  <span className="float-right text-xs text-gray-500">{n.signal} dBm</span>
                </button>
              ))}
            </div>
          )}
          <label htmlFor="wifi-ssid-dash" className={LABEL_CLASS}>
            {t("Network name (SSID)")}
          </label>
          <input
            id="wifi-ssid-dash"
            type="text"
            value={wifiSSID}
            onChange={(e) => setWifiSSID(e.target.value)}
            className={INPUT_CLASS}
            placeholder={t("Your WiFi name")}
            autoComplete="off"
          />
          <label htmlFor="wifi-pass-dash" className={LABEL_CLASS}>
            {t("Password")}
          </label>
          <PasswordInput
            id="wifi-pass-dash"
            value={wifiPassword}
            onChange={setWifiPassword}
            visible={showWifiPassword}
            onToggle={() => setShowWifiPassword((v) => !v)}
            placeholder={t("WiFi password (empty if open)")}
            autoComplete="off"
          />
          <p className="text-xs text-amber-400/80 leading-relaxed mt-2">
            {t("Connecting may drop this page briefly. After the device joins your router, open the device's .local address first. If your client does not resolve .local, use the IPv4 shown on the device screen.")}
          </p>
          <p className="text-xs mt-2">
            <Link href="/setup/wifi" className="text-[#00e5cc] underline">
              {t("Open dedicated WiFi setup page")}
            </Link>
          </p>
          {wifiStatus && <StatusMessage type={wifiStatus.type} message={wifiStatus.message} />}
          <button
            type="button"
            onClick={connectWifi}
            disabled={wifiConnecting || !wifiSSID.trim()}
            className={`${SAVE_BUTTON_CLASS} flex items-center gap-2 mt-2`}
          >
            {wifiConnecting && ButtonSpinner}
            {wifiConnecting ? t("Connecting...") : t("Connect")}
          </button>
        </CollapsibleSection>

        {/* Security & Hotspot */}
        <CollapsibleSection id="security" title={t("Security & Hotspot")} done={securityDone} open={openSection === "security"} onToggle={toggle}>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label htmlFor="password" className={LABEL_CLASS}>{t("Set Password")}</label>
              <PasswordInput
                id="password"
                value={password}
                onChange={setPassword}
                visible={showPassword}
                onToggle={() => setShowPassword((v) => !v)}
                placeholder={t("At least 8 characters")}
              />
            </div>
            <div>
              <label htmlFor="confirm" className={LABEL_CLASS}>{t("Confirm Password")}</label>
              <PasswordInput
                id="confirm"
                value={confirmPassword}
                onChange={setConfirmPassword}
                visible={showConfirm}
                onToggle={() => setShowConfirm((v) => !v)}
                placeholder={t("Confirm password")}
              />
            </div>
          </div>
          <div>
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={hotspotEnabled} onChange={(e) => setHotspotEnabled(e.target.checked)} className="w-4 h-4 rounded border-gray-600 bg-[var(--bg-deep)] text-[var(--coral-bright)] focus:ring-[var(--coral-bright)] cursor-pointer" />
              <span className="text-sm text-[var(--text-primary)]">{t("Enable Setup Hotspot")}</span>
            </label>
          </div>
          {hotspotEnabled && (
            <>
              <div>
                <label htmlFor="hotspot-name" className={LABEL_CLASS}>{t("Hotspot Name")}</label>
                <input
                  id="hotspot-name"
                  type="text"
                  value={hotspotName}
                  onChange={(e) => setHotspotName(e.target.value)}
                  placeholder="ClawBox-Setup"
                  className={INPUT_CLASS}
                />
              </div>
              <div>
                <label htmlFor="hotspot-password" className={LABEL_CLASS}>{t("Hotspot Password (optional)")}</label>
                <PasswordInput
                  id="hotspot-password"
                  value={hotspotPassword}
                  onChange={setHotspotPassword}
                  visible={showHotspotPassword}
                  onToggle={() => setShowHotspotPassword((v) => !v)}
                  placeholder={t("Leave empty for open network")}
                />
              </div>
            </>
          )}
          {secStatus && <StatusMessage type={secStatus.type} message={secStatus.message} />}
          <button type="button" onClick={saveSecurity} disabled={secSaving} className={`${SAVE_BUTTON_CLASS} flex items-center gap-2`}>{secSaving && ButtonSpinner}{secSaving ? t("Saving...") : t("Save")}</button>
        </CollapsibleSection>

        {/* System Info Widgets — 2 rows × 3 items */}
        {info && (
          <div className="space-y-3">
            <div className="card-surface rounded-xl p-4">
              <p className={WIDGET_LABEL_CLASS}>{t("Access")}</p>
              <p className="text-sm font-semibold text-gray-100 break-all">{info.accessUrl}</p>
              <p className="text-xs text-[var(--text-secondary)] mt-2">
                {t("IPv4 fallback: {ip}", { ip: info.networkIp })}
              </p>
              {info.localDnsAlias && (
                <p className="text-xs text-[var(--text-secondary)] mt-1">
                  {t("Optional local DNS alias: {alias}", { alias: info.localDnsAlias })}
                </p>
              )}
            </div>
            <div className="grid grid-cols-3 gap-3">
              {/* Row 1 */}
              <SystemInfoWidget
                label="CPU"
                detail={t("{count} cores", { count: info.cpus })}
                value={String(info.cpuLoadPercent)}
                unit="%"
                bar={{ percent: info.cpuLoadPercent, color: thresholdColor(info.cpuLoadPercent, 50, 80) }}
              />
              <SystemInfoWidget
                label="GPU"
                value={String(info.gpuLoadPercent)}
                unit="%"
                bar={{ percent: info.gpuLoadPercent, color: thresholdColor(info.gpuLoadPercent, 50, 80) }}
              />
              <SystemInfoWidget
                label={t("Memory")}
                detail={t("{amount} free", { amount: info.memoryFree })}
                value={String(info.memoryUsedPercent)}
                unit="%"
                bar={{ percent: info.memoryUsedPercent, color: thresholdColor(info.memoryUsedPercent, 60, 85) }}
              />
              {/* Row 2 */}
              <SystemInfoWidget
                label={t("Storage")}
                detail={t("{amount} free", { amount: info.diskFree })}
                value={String(info.diskUsedPercent)}
                unit="%"
                bar={{ percent: info.diskUsedPercent, color: thresholdColor(info.diskUsedPercent, 70, 90) }}
              />
              <SystemInfoWidget
                label={t("Temperature")}
                value={info.temperature}
                bar={info.temperatureValue != null ? {
                  percent: Math.min(100, (info.temperatureValue / 85) * 100),
                  color: thresholdColor(info.temperatureValue, 55, 75),
                } : undefined}
              />
              <SparklineWidget
                label={t("CPU Timeline")}
                currentValue={statsHistory.length >= 1 ? `${statsHistory[statsHistory.length - 1].cpu}%` : "—"}
                data={statsHistory.map((s) => s.cpu)}
                color="#f97316"
              />
            </div>
          </div>
        )}
        {!info && !loadError && (
          <div className="flex items-center justify-center gap-2.5 py-4 text-[var(--text-secondary)] text-sm">
            <div className="spinner" /> {t("Loading system info...")}
          </div>
        )}
      </div>
    </div>
  );
}
