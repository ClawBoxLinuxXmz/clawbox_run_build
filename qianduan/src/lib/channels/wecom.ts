import { readConfig } from "@/lib/openclaw-config";
import { getChannelStatusJson } from "./channel-status-cache";
import { sanitizeChannelOutput } from "./openclaw-runtime";

export type WeComChannelState =
  | "not_configured"
  | "disabled"
  | "configured"
  | "connected"
  | "error";

export interface WeComConfigView {
  configured: boolean;
  enabled: boolean;
  hasSecret: boolean;
  botId: string | null;
  connectionMode: "websocket";
}

export interface WeComChannelStatus extends WeComConfigView {
  state: WeComChannelState;
  connected: boolean;
  running: boolean;
  probeOk: boolean | null;
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

function channelRecord(
  config: Awaited<ReturnType<typeof readConfig>>,
): Record<string, unknown> {
  const value = config.channels?.wecom;
  return isRecord(value) ? value : {};
}

export async function getWeComCredentials(): Promise<{
  botId: string | null;
  secret: string | null;
}> {
  const channel = channelRecord(await readConfig());
  return {
    botId: readString(channel.botId),
    secret: readString(channel.secret),
  };
}

export async function getWeComConfig(): Promise<WeComConfigView> {
  const credentials = await getWeComCredentials();
  const channel = channelRecord(await readConfig());
  const configured = Boolean(credentials.botId && credentials.secret);
  return {
    configured,
    enabled: configured && channel.enabled !== false,
    hasSecret: Boolean(credentials.secret),
    botId: credentials.botId,
    connectionMode: "websocket",
  };
}

function readChannelAccount(payload: Record<string, unknown>): Record<string, unknown> | null {
  const containers = [
    isRecord(payload.channelAccounts) ? payload.channelAccounts.wecom : undefined,
    isRecord(payload.channels) ? payload.channels.wecom : undefined,
  ];

  for (const candidate of containers) {
    if (Array.isArray(candidate)) {
      const account = candidate.find(isRecord);
      if (account) return account;
      continue;
    }
    if (!isRecord(candidate)) continue;
    if (Array.isArray(candidate.accounts)) {
      const account = candidate.accounts.find(isRecord);
      if (account) return account;
    }
    return candidate;
  }

  return null;
}

export function parseWeComStatusPayload(
  payload: unknown,
  stored: WeComConfigView,
): WeComChannelStatus {
  const base: WeComChannelStatus = {
    ...stored,
    state: stored.configured
      ? stored.enabled
        ? "configured"
        : "disabled"
      : "not_configured",
    connected: false,
    running: false,
    probeOk: null,
    lastError: null,
  };

  if (!stored.configured || !stored.enabled) return base;
  if (!isRecord(payload)) {
    return {
      ...base,
      state: "error",
      lastError: "OpenClaw returned invalid channel status.",
    };
  }
  if (payload.gatewayReachable === false || payload.configOnly === true) {
    return {
      ...base,
      state: "error",
      lastError: sanitizeChannelOutput(
        readString(payload.error) || "OpenClaw Gateway is not reachable.",
      ),
    };
  }

  const account = readChannelAccount(payload);
  if (!account) return base;

  const probe = isRecord(account.probe) ? account.probe : null;
  const running = account.running === true;
  const probeOk = probe && typeof probe.ok === "boolean" ? probe.ok : null;
  const connected = account.connected === true || (running && probeOk === true);
  const rawError = readString(account.lastError) || (probe ? readString(probe.error) : null);
  const lastError = rawError ? sanitizeChannelOutput(rawError) : null;

  return {
    ...base,
    state: connected ? "connected" : probeOk === false || lastError ? "error" : "configured",
    connected,
    running,
    probeOk,
    lastError,
  };
}

export async function probeWeComChannel(
  options: { force?: boolean } = {},
): Promise<WeComChannelStatus> {
  const stored = await getWeComConfig();
  if (!stored.configured || !stored.enabled) {
    return parseWeComStatusPayload(null, stored);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(await getChannelStatusJson(options.force ? { force: true } : {}));
  } catch {
    throw new Error("OpenClaw returned invalid JSON while checking WeCom status.");
  }
  return parseWeComStatusPayload(payload, stored);
}
