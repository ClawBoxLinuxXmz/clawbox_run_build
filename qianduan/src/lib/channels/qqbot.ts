import { execFile } from "child_process";
import path from "path";
import { promisify } from "util";
import { readConfig, updateConfig } from "@/lib/openclaw-config";
import { getChannelStatusJson } from "./channel-status-cache";

const exec = promisify(execFile);
const OPENCLAW_BIN = process.env.OPENCLAW_BIN || "/home/clawbox/.npm-global/bin/openclaw";
const OPENCLAW_STATE_DIR =
  process.env.OPENCLAW_STATE_DIR ||
  process.env.OPENCLAW_HOME ||
  "/home/clawbox/.openclaw";
const OPENCLAW_CONFIG_PATH =
  process.env.OPENCLAW_CONFIG_PATH ||
  path.join(OPENCLAW_STATE_DIR, "openclaw.json");
const OPENCLAW_USER_HOME = "/home/clawbox";
const QQBOT_TOKEN_URL = "https://bots.qq.com/app/getAppAccessToken";
const REQUEST_TIMEOUT_MS = 12_000;

export type QQBotErrorCode =
  | "invalid_credentials"
  | "platform_unreachable"
  | "gateway_unavailable"
  | "channel_not_connected";

export class QQBotChannelError extends Error {
  constructor(public readonly code: QQBotErrorCode, message: string) {
    super(message);
    this.name = "QQBotChannelError";
  }
}

export interface QQBotConfigView {
  configured: boolean;
  enabled: boolean;
  hasClientSecret: boolean;
  appId: string | null;
}

export interface QQBotChannelStatus extends QQBotConfigView {
  state: "not_configured" | "disabled" | "configured" | "connected" | "error";
  connected: boolean;
  running: boolean;
  lastError: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function channelRecord(
  config: Awaited<ReturnType<typeof readConfig>>,
): Record<string, unknown> {
  const value = config.channels?.qqbot;
  return isRecord(value) ? value : {};
}

function normalizeAppId(value: string): string {
  const appId = value.trim();
  if (!appId || appId.length > 128 || /\s/.test(appId)) {
    throw new QQBotChannelError(
      "invalid_credentials",
      "The QQ Bot AppID format is invalid.",
    );
  }
  return appId;
}

function normalizeClientSecret(value: string): string {
  const clientSecret = value.trim();
  if (!clientSecret || clientSecret.length > 512 || /\s/.test(clientSecret)) {
    throw new QQBotChannelError(
      "invalid_credentials",
      "The QQ Bot AppSecret format is invalid.",
    );
  }
  return clientSecret;
}

export async function validateQQBotCredentials(
  input: { appId: string; clientSecret: string },
  fetcher: typeof fetch = fetch,
): Promise<void> {
  const appId = normalizeAppId(input.appId);
  const clientSecret = normalizeClientSecret(input.clientSecret);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetcher(QQBOT_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ appId, clientSecret }),
      cache: "no-store",
      redirect: "error",
      signal: controller.signal,
    });
    const payload = (await response.json().catch(() => null)) as unknown;
    if (response.ok && isRecord(payload) && readString(payload.access_token)) {
      return;
    }
    if (
      response.status === 400 ||
      response.status === 401 ||
      response.status === 403 ||
      response.ok
    ) {
      throw new QQBotChannelError(
        "invalid_credentials",
        "QQ Open Platform rejected this AppID or AppSecret.",
      );
    }
    throw new QQBotChannelError(
      "platform_unreachable",
      `QQ credential validation failed (${response.status}).`,
    );
  } catch (error) {
    if (error instanceof QQBotChannelError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new QQBotChannelError(
        "platform_unreachable",
        "QQ credential validation timed out. Check internet access.",
      );
    }
    throw new QQBotChannelError(
      "platform_unreachable",
      "Cannot reach the QQ Open Platform. Check internet access.",
    );
  } finally {
    clearTimeout(timeout);
  }
}

export async function getQQBotConfig(): Promise<QQBotConfigView> {
  const channel = channelRecord(await readConfig());
  const appId = readString(channel.appId);
  const hasClientSecret = Boolean(readString(channel.clientSecret));
  const configured = Boolean(appId && hasClientSecret);
  return {
    configured,
    enabled: configured && channel.enabled !== false,
    hasClientSecret,
    appId,
  };
}

export async function getQQBotCredentials(): Promise<{
  appId: string;
  clientSecret: string;
} | null> {
  const channel = channelRecord(await readConfig());
  const appId = readString(channel.appId);
  const clientSecret = readString(channel.clientSecret);
  return appId && clientSecret ? { appId, clientSecret } : null;
}

export async function saveQQBotConfig(input: {
  appId?: string;
  clientSecret?: string;
  enabled: boolean;
}): Promise<QQBotConfigView> {
  await updateConfig((config) => {
    const channels = isRecord(config.channels) ? { ...config.channels } : {};
    const current = isRecord(channels.qqbot) ? channels.qqbot : {};
    const next: Record<string, unknown> = {
      ...current,
      enabled: input.enabled,
      dmPolicy: readString(current.dmPolicy) || "open",
      groupPolicy: readString(current.groupPolicy) || "disabled",
      allowFrom: Array.isArray(current.allowFrom) ? current.allowFrom : ["*"],
      ...(input.appId !== undefined ? { appId: normalizeAppId(input.appId) } : {}),
      ...(input.clientSecret !== undefined
        ? { clientSecret: normalizeClientSecret(input.clientSecret) }
        : {}),
    };
    if (input.clientSecret !== undefined) delete next.clientSecretFile;
    channels.qqbot = next;
    config.channels = channels;
  });
  return getQQBotConfig();
}

function cliEnvironment(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: OPENCLAW_USER_HOME,
    OPENCLAW_HOME: OPENCLAW_STATE_DIR,
    OPENCLAW_STATE_DIR,
    OPENCLAW_CONFIG_PATH,
  };
}

async function runOpenClaw(args: string[]) {
  try {
    return await exec(OPENCLAW_BIN, args, {
      timeout: 12_000,
      maxBuffer: 1024 * 1024,
      env: cliEnvironment(),
      windowsHide: true,
    });
  } catch (error) {
    const stderr = isRecord(error) ? readString(error.stderr) : null;
    throw new QQBotChannelError(
      "gateway_unavailable",
      stderr || "OpenClaw command failed.",
    );
  }
}

export function parseQQBotStatusPayload(
  payload: unknown,
  stored: QQBotConfigView,
): QQBotChannelStatus {
  const base: QQBotChannelStatus = {
    ...stored,
    state: stored.configured
      ? stored.enabled
        ? "configured"
        : "disabled"
      : "not_configured",
    connected: false,
    running: false,
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
      lastError: readString(payload.error) || "OpenClaw Gateway is not reachable.",
    };
  }

  const channelAccounts = isRecord(payload.channelAccounts)
    ? payload.channelAccounts
    : null;
  const accounts = channelAccounts?.qqbot;
  const account = Array.isArray(accounts) && isRecord(accounts[0])
    ? accounts[0]
    : null;
  if (!account) return base;

  const running = account.running === true;
  const connected = account.connected === true;
  const lastError = readString(account.lastError);
  return {
    ...base,
    state: connected ? "connected" : lastError ? "error" : "configured",
    connected,
    running,
    lastError,
  };
}

export async function probeQQBotChannel(
  options: { force?: boolean } = {},
): Promise<QQBotChannelStatus> {
  const stored = await getQQBotConfig();
  if (!stored.configured || !stored.enabled) {
    return parseQQBotStatusPayload(null, stored);
  }
  let stdout: string;
  try {
    stdout = await getChannelStatusJson(options.force ? { force: true } : undefined);
  } catch (error) {
    throw new QQBotChannelError("gateway_unavailable", error instanceof Error ? error.message : "OpenClaw status command failed.");
  }
  try {
    return parseQQBotStatusPayload(JSON.parse(stdout), stored);
  } catch {
    throw new QQBotChannelError(
      "gateway_unavailable",
      "OpenClaw returned invalid JSON while checking QQ Bot status.",
    );
  }
}

export async function waitForQQBotConnected(
  attempts = 3,
  intervalMs = 1_500,
): Promise<QQBotChannelStatus> {
  let lastError: string | null = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const status = await probeQQBotChannel({ force: true });
      if (status.connected) return status;
      lastError = status.lastError;
    } catch (error) {
      lastError = error instanceof Error ? error.message : "QQ Bot status check failed.";
    }
    if (attempt < attempts - 1) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
  throw new QQBotChannelError(
    "channel_not_connected",
    lastError || "QQ Bot config was saved, but the channel did not become online.",
  );
}
