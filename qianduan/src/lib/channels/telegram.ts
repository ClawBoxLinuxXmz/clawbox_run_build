import { execFile } from "child_process";
import path from "path";
import { promisify } from "util";
import { readConfig, updateConfig } from "@/lib/openclaw-config";
import { getChannelStatusJson } from "./channel-status-cache";
import { fetchWithChannelProxy } from "./proxy";

const exec = promisify(execFile);
const OPENCLAW_BIN =
  process.env.OPENCLAW_BIN || "/home/clawbox/.npm-global/bin/openclaw";
const OPENCLAW_STATE_DIR =
  process.env.OPENCLAW_STATE_DIR ||
  process.env.OPENCLAW_HOME ||
  "/home/clawbox/.openclaw";
const OPENCLAW_CONFIG_PATH =
  process.env.OPENCLAW_CONFIG_PATH ||
  path.join(OPENCLAW_STATE_DIR, "openclaw.json");
const OPENCLAW_USER_HOME = "/home/clawbox";
const TELEGRAM_API_ROOT = "https://api.telegram.org";
const TELEGRAM_REQUEST_TIMEOUT_MS = 12_000;
const OPENCLAW_STATUS_TIMEOUT_MS = 12_000;

export const TELEGRAM_STATUS_ARGS = [
  "channels",
  "status",
  "--probe",
  "--timeout",
  "8000",
  "--json",
] as const;

export type TelegramChannelState =
  | "not_configured"
  | "disabled"
  | "configured"
  | "connected"
  | "error";

export type TelegramErrorCode =
  | "invalid_token"
  | "telegram_unreachable"
  | "gateway_unavailable"
  | "channel_not_connected"
  | "invalid_pairing_code";

export class TelegramChannelError extends Error {
  constructor(
    public readonly code: TelegramErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "TelegramChannelError";
  }
}

export interface TelegramBotIdentity {
  id: string;
  username: string;
  firstName: string;
}

export interface TelegramConfigView {
  configured: boolean;
  enabled: boolean;
  hasToken: boolean;
  dmPolicy: string;
  groupPolicy: string;
}

export interface TelegramChannelStatus extends TelegramConfigView {
  state: TelegramChannelState;
  connected: boolean;
  running: boolean;
  probeOk: boolean | null;
  botId: string | null;
  botUsername: string | null;
  lastError: string | null;
}

export interface TelegramPairingRequest {
  code: string;
  senderId: string;
  createdAt: string;
  displayName: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function telegramRecord(config: Awaited<ReturnType<typeof readConfig>>): Record<string, unknown> {
  const value = config.channels?.telegram;
  return isRecord(value) ? value : {};
}

function readString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function readBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

export function sanitizeTelegramError(message: string): string {
  return message
    .replace(/\/bot\d{5,}:[A-Za-z0-9_-]{20,}/g, "/bot[redacted]")
    .replace(/\b\d{5,}:[A-Za-z0-9_-]{20,}\b/g, "[redacted]");
}

export function normalizeTelegramToken(value: string): string {
  const token = value.trim();
  if (
    token.length > 512 ||
    !/^\d{5,}:[A-Za-z0-9_-]{20,}$/.test(token)
  ) {
    throw new TelegramChannelError(
      "invalid_token",
      "The Telegram Bot Token format is invalid. Copy it again from @BotFather.",
    );
  }
  return token;
}

export async function validateTelegramBotToken(
  value: string,
  fetcher: typeof fetch = fetch,
): Promise<TelegramBotIdentity> {
  const token = normalizeTelegramToken(value);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TELEGRAM_REQUEST_TIMEOUT_MS);

  try {
    const response = await fetchWithChannelProxy("telegram", `${TELEGRAM_API_ROOT}/bot${token}/getMe`, {
      method: "GET",
      cache: "no-store",
      redirect: "error",
      signal: controller.signal,
    }, fetcher);
    const payload = (await response.json().catch(() => null)) as unknown;

    if (!response.ok || !isRecord(payload) || payload.ok !== true) {
      if (response.status === 401 || response.status === 404) {
        throw new TelegramChannelError(
          "invalid_token",
          "Telegram rejected this Bot Token. Copy the current token from @BotFather.",
        );
      }
      throw new TelegramChannelError(
        "telegram_unreachable",
        `Telegram Bot API validation failed (${response.status}).`,
      );
    }

    const result = isRecord(payload.result) ? payload.result : null;
    const id = result && (typeof result.id === "number" || typeof result.id === "string")
      ? String(result.id)
      : "";
    const username = result ? readString(result.username) : null;
    const firstName = result ? readString(result.first_name) : null;

    if (!id || !username || result?.is_bot !== true) {
      throw new TelegramChannelError(
        "telegram_unreachable",
        "Telegram returned an unexpected bot identity response.",
      );
    }

    return {
      id,
      username,
      firstName: firstName || username,
    };
  } catch (error) {
    if (error instanceof TelegramChannelError) throw error;
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new TelegramChannelError(
        "telegram_unreachable",
        "Telegram Bot API validation timed out. Check internet or proxy access to api.telegram.org.",
      );
    }
    throw new TelegramChannelError(
      "telegram_unreachable",
      "Cannot reach Telegram Bot API. Check internet or proxy access to api.telegram.org.",
    );
  } finally {
    clearTimeout(timeout);
  }
}

export async function getTelegramConfig(): Promise<TelegramConfigView> {
  const config = await readConfig();
  const channel = telegramRecord(config);
  const hasToken = Boolean(readString(channel.botToken));

  return {
    configured: hasToken,
    enabled: hasToken && channel.enabled !== false,
    hasToken,
    dmPolicy: readString(channel.dmPolicy) || "pairing",
    groupPolicy: readString(channel.groupPolicy) || "disabled",
  };
}

export async function getTelegramBotToken(): Promise<string | null> {
  const config = await readConfig();
  return readString(telegramRecord(config).botToken);
}

export async function saveTelegramConfig(input: {
  botToken?: string;
  enabled: boolean;
  }): Promise<TelegramConfigView> {
    await updateConfig((config) => {
      const channels = isRecord(config.channels) ? { ...config.channels } : {};
      const current = isRecord(channels.telegram) ? channels.telegram : {};
      const next: Record<string, unknown> = {
        ...current,
        enabled: input.enabled,
        dmPolicy: readString(current.dmPolicy) || "pairing",
        groupPolicy: readString(current.groupPolicy) || "disabled",
      };

      if (input.botToken !== undefined) {
        next.botToken = normalizeTelegramToken(input.botToken);
      }

      channels.telegram = next;
      config.channels = channels;
    });
    return getTelegramConfig();
  }

export function getTelegramOpenClawEnvironment(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: OPENCLAW_USER_HOME,
    OPENCLAW_HOME: OPENCLAW_STATE_DIR,
    OPENCLAW_STATE_DIR,
    OPENCLAW_CONFIG_PATH,
  };
}

async function runOpenClaw(args: string[], timeout = OPENCLAW_STATUS_TIMEOUT_MS) {
  try {
    return await exec(OPENCLAW_BIN, args, {
      timeout,
      maxBuffer: 1024 * 1024,
      env: getTelegramOpenClawEnvironment(),
      windowsHide: true,
    });
  } catch (error) {
    const stderr = isRecord(error) ? readString(error.stderr) : null;
    const message = sanitizeTelegramError(stderr || "OpenClaw command failed.");
    throw new TelegramChannelError("gateway_unavailable", message);
  }
}

function accountBot(account: Record<string, unknown>): Record<string, unknown> | null {
  if (isRecord(account.bot)) return account.bot;
  if (isRecord(account.probe) && isRecord(account.probe.bot)) return account.probe.bot;
  return null;
}

export function parseTelegramStatusPayload(
  payload: unknown,
  stored: TelegramConfigView,
): TelegramChannelStatus {
  const base: TelegramChannelStatus = {
    ...stored,
    state: stored.configured
      ? stored.enabled
        ? "configured"
        : "disabled"
      : "not_configured",
    connected: false,
    running: false,
    probeOk: null,
    botId: null,
    botUsername: null,
    lastError: null,
  };

  if (!stored.configured || !stored.enabled) return base;
  if (!isRecord(payload)) {
    return { ...base, state: "error", lastError: "OpenClaw returned invalid channel status." };
  }
  if (payload.gatewayReachable === false || payload.configOnly === true) {
    return {
      ...base,
      state: "error",
      lastError: sanitizeTelegramError(readString(payload.error) || "OpenClaw Gateway is not reachable."),
    };
  }

  const channelAccounts = isRecord(payload.channelAccounts)
    ? payload.channelAccounts
    : null;
  const accounts = channelAccounts?.telegram;
  const account = Array.isArray(accounts) && isRecord(accounts[0])
    ? accounts[0]
    : null;

  if (!account) return base;

  const probe = isRecord(account.probe) ? account.probe : null;
  const bot = accountBot(account);
  const running = readBoolean(account.running) === true;
  const explicitlyConnected = readBoolean(account.connected);
  const probeOk = probe ? readBoolean(probe.ok) : null;
  const connected = explicitlyConnected === true || (running && probeOk === true);
  const rawError =
    readString(account.lastError) ||
    (probe ? readString(probe.error) : null);
  const lastError = rawError ? sanitizeTelegramError(rawError) : null;

  return {
    ...base,
    state: connected ? "connected" : probeOk === false || lastError ? "error" : "configured",
    connected,
    running,
    probeOk,
    botId:
      bot && (typeof bot.id === "number" || typeof bot.id === "string")
        ? String(bot.id)
        : null,
    botUsername: bot ? readString(bot.username) : null,
    lastError,
  };
}

export async function probeTelegramChannel(
  options: { force?: boolean } = {},
): Promise<TelegramChannelStatus> {
  const stored = await getTelegramConfig();
  if (!stored.configured || !stored.enabled) {
    return parseTelegramStatusPayload(null, stored);
  }

  let stdout: string;
  try {
    stdout = await getChannelStatusJson(options.force ? { force: true } : undefined);
  } catch (error) {
    throw new TelegramChannelError(
      "gateway_unavailable",
      sanitizeTelegramError(error instanceof Error ? error.message : "OpenClaw status command failed."),
    );
  }

  let payload: unknown;
  try {
    payload = JSON.parse(stdout);
  } catch {
    throw new TelegramChannelError(
      "gateway_unavailable",
      "OpenClaw returned invalid JSON while checking Telegram status.",
    );
  }
  return parseTelegramStatusPayload(payload, stored);
}

export async function waitForTelegramConnected(
  attempts = 3,
  intervalMs = 1_500,
): Promise<TelegramChannelStatus> {
  let lastStatus: TelegramChannelStatus | null = null;
  let lastError: string | null = null;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      lastStatus = await probeTelegramChannel({ force: true });
      if (lastStatus.connected) return lastStatus;
      lastError = lastStatus.lastError;
    } catch (error) {
      lastError = error instanceof Error ? error.message : "Telegram status check failed.";
    }

    if (attempt < attempts - 1) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }

  throw new TelegramChannelError(
    "channel_not_connected",
    sanitizeTelegramError(
      lastError ||
        "Telegram config was saved, but the channel did not become online. Check Gateway logs and access to api.telegram.org.",
    ),
  );
}

export async function listTelegramPairingRequests(): Promise<TelegramPairingRequest[]> {
  const { stdout } = await runOpenClaw([
    "pairing",
    "list",
    "telegram",
    "--json",
  ]);

  let payload: unknown;
  try {
    payload = JSON.parse(stdout);
  } catch {
    throw new TelegramChannelError(
      "gateway_unavailable",
      "OpenClaw returned invalid JSON while listing Telegram pairing requests.",
    );
  }

  if (!isRecord(payload) || !Array.isArray(payload.requests)) return [];
  return payload.requests.flatMap((value): TelegramPairingRequest[] => {
    if (!isRecord(value)) return [];
    const code = readString(value.code);
    const senderId = readString(value.id);
    const createdAt = readString(value.createdAt);
    if (!code || !senderId || !createdAt) return [];
    const meta = isRecord(value.meta) ? value.meta : null;
    const displayName = meta
      ? readString(meta.username) || readString(meta.name) || readString(meta.displayName)
      : null;
    return [{ code, senderId, createdAt, displayName }];
  });
}

export async function approveTelegramPairing(codeValue: string): Promise<void> {
  const code = codeValue.trim();
  if (!/^[A-Za-z0-9_-]{4,64}$/.test(code)) {
    throw new TelegramChannelError(
      "invalid_pairing_code",
      "The Telegram pairing code format is invalid.",
    );
  }
  await runOpenClaw([
    "pairing",
    "approve",
    "telegram",
    code,
    "--notify",
  ]);
}
