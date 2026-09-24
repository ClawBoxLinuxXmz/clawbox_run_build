import fs from "node:fs/promises";
import path from "node:path";
import { get, set } from "@/lib/config-store";
import { readConfig, restartGateway, updateConfig } from "@/lib/openclaw-config";
import {
  cancelQrSession,
  cleanupPngPathOutput,
  createCliQrSession,
  getQrSession,
  parsePngPathOutput,
  type QrSessionView,
} from "./qr-session";
import { OPENCLAW_STATE_DIR, runOpenClaw } from "./openclaw-runtime";
import { probeOpenClawChannel } from "./openclaw-runtime";

const RISK_ACCEPTED_KEY = "zalouser_risk_accepted";

export interface ZaloPersonalConfigView {
  configured: boolean;
  enabled: boolean;
  dmPolicy: string;
  riskAccepted: boolean;
}

export interface ZaloPersonalStatus extends ZaloPersonalConfigView {
  state: "not_configured" | "disabled" | "configured" | "connected" | "error";
  connected: boolean;
  running: boolean;
  lastError: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function section(config: Awaited<ReturnType<typeof readConfig>>): Record<string, unknown> {
  const value = config.channels?.zalouser;
  return isRecord(value) ? value : {};
}

function withoutLegacyRiskFlag(channel: Record<string, unknown>): Record<string, unknown> {
  const next = { ...channel };
  delete next.riskAccepted;
  return next;
}

async function hasZaloPersonalCredentials(): Promise<boolean> {
  try {
    const files = await fs.readdir(
      path.join(OPENCLAW_STATE_DIR, "credentials", "zalouser"),
    );
    return files.some((file) => /^credentials(?:-[^/\\]+)?\.json$/i.test(file));
  } catch {
    return false;
  }
}

async function readRiskAccepted(channel: Record<string, unknown>): Promise<boolean> {
  const stored = await get(RISK_ACCEPTED_KEY);
  if (typeof stored === "boolean") return stored;
  return channel.riskAccepted === true;
}

export async function getZaloPersonalConfig(): Promise<ZaloPersonalConfigView> {
  const channel = section(await readConfig());
  return {
    configured: await hasZaloPersonalCredentials(),
    enabled: channel.enabled === true,
    dmPolicy: readString(channel.dmPolicy) || "pairing",
    riskAccepted: await readRiskAccepted(channel),
  };
}

export async function getZaloPersonalStatus(
  options: { force?: boolean } = {},
): Promise<ZaloPersonalStatus> {
  const config = await getZaloPersonalConfig();
  const base: ZaloPersonalStatus = {
    ...config,
    state: config.configured ? (config.enabled ? "configured" : "disabled") : "not_configured",
    connected: false,
    running: false,
    lastError: null,
  };
  if (!config.configured || !config.enabled) return base;
  const runtime = await probeOpenClawChannel("zalouser", undefined, options);
  return {
    ...base,
    state: runtime.state,
    connected: runtime.connected,
    running: runtime.running,
    lastError: runtime.lastError,
  };
}

export async function saveZaloPersonalConfig(input: {
  enabled: boolean;
  riskAccepted: boolean;
}): Promise<ZaloPersonalConfigView> {
  if (input.enabled && !input.riskAccepted) {
    throw new Error(
      "Confirm the unofficial Zalo Personal account automation risk before enabling it.",
    );
  }

  await set(RISK_ACCEPTED_KEY, input.riskAccepted);
  await updateConfig((config) => {
    const channels = isRecord(config.channels) ? { ...config.channels } : {};
    const current = withoutLegacyRiskFlag(section(config));
    channels.zalouser = {
      ...current,
      enabled: input.enabled,
      dmPolicy: readString(current.dmPolicy) || "pairing",
    };
    config.channels = channels;
  });
  return getZaloPersonalConfig();
}

export async function disableZaloPersonalConfig(): Promise<ZaloPersonalConfigView> {
  const config = await readConfig();
  return saveZaloPersonalConfig({
    enabled: false,
    riskAccepted: await readRiskAccepted(section(config)),
  });
}

export async function finalizeZaloPersonalLogin(): Promise<ZaloPersonalConfigView> {
  await set(RISK_ACCEPTED_KEY, true);
  await updateConfig((config) => {
    const channels = isRecord(config.channels) ? { ...config.channels } : {};
    const current = withoutLegacyRiskFlag(section(config));
    channels.zalouser = {
      ...current,
      enabled: true,
      dmPolicy: readString(current.dmPolicy) || "pairing",
    };
    config.channels = channels;
  });
  await restartGateway();
  return getZaloPersonalConfig();
}

export async function startZaloPersonalQrLogin(): Promise<QrSessionView> {
  await runOpenClaw(["plugins", "enable", "zalouser"], { timeoutMs: 60_000 });
  return createCliQrSession({
    kind: "zalouser",
    args: ["channels", "login", "--channel", "zalouser"],
    parseOutput: parsePngPathOutput,
    cleanupOutput: cleanupPngPathOutput,
    isConnected: (output) => /Login successful\./i.test(output),
    onConnected: async () => {
      await finalizeZaloPersonalLogin();
    },
  });
}

export function getZaloPersonalQrLogin(
  sessionId: string,
  ownerToken: string,
): QrSessionView | null {
  return getQrSession(sessionId, ownerToken);
}

export function cancelZaloPersonalQrLogin(
  sessionId: string,
  ownerToken: string,
): boolean {
  return cancelQrSession(sessionId, ownerToken);
}
