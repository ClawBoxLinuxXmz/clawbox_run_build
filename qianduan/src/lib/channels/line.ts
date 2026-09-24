import { execFile } from "child_process";
import path from "path";
import { promisify } from "util";
import { readConfig, updateConfig } from "@/lib/openclaw-config";
import { getChannelStatusJson } from "./channel-status-cache";

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
const LINE_API_ROOT = "https://api.line.me";
const REQUEST_TIMEOUT_MS = 12_000;
const OPENCLAW_STATUS_TIMEOUT_MS = 15_000;

export const LINE_WEBHOOK_PATH = "/line/webhook";
export const LINE_STATUS_ARGS = [
  "channels",
  "status",
  "--probe",
  "--timeout",
  "8000",
  "--json",
] as const;

export type LineErrorCode =
  | "invalid_credentials"
  | "platform_unreachable"
  | "gateway_unavailable"
  | "channel_not_ready"
  | "invalid_pairing_code";

export class LineChannelError extends Error {
  constructor(
    public readonly code: LineErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "LineChannelError";
  }
}

export interface LineBotIdentity {
  displayName: string;
  userId: string;
  basicId: string | null;
  pictureUrl: string | null;
}

export interface LineConfigView {
  configured: boolean;
  enabled: boolean;
  hasChannelAccessToken: boolean;
  hasChannelSecret: boolean;
  dmPolicy: "pairing";
  groupPolicy: "disabled";
  webhookPath: typeof LINE_WEBHOOK_PATH;
}

export interface LineProbeStatus {
  ok: boolean;
  bot: LineBotIdentity | null;
  error: string | null;
}

export interface LineChannelStatus extends LineConfigView {
  state:
    | "not_configured"
    | "disabled"
    | "configured"
    | "running"
    | "ready"
    | "active"
    | "error";
  running: boolean;
  probe: LineProbeStatus | null;
  lastInboundAt: number | null;
  lastError: string | null;
}

export interface LinePairingRequest {
  code: string;
  senderId: string;
  createdAt: string;
  displayName: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readTimestamp(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : null;
}

function channelRecord(
  config: Awaited<ReturnType<typeof readConfig>>,
): Record<string, unknown> {
  const value = config.channels?.line;
  return isRecord(value) ? value : {};
}

function normalizeChannelAccessToken(value: string): string {
  const token = value.trim();
  if (
    token.length < 20 ||
    token.length > 4096 ||
    /[\s\u0000-\u001f\u007f]/.test(token)
  ) {
    throw new LineChannelError(
      "invalid_credentials",
      "The LINE Channel access token format is invalid.",
    );
  }
  return token;
}

function normalizeChannelSecret(value: string): string {
  const secret = value.trim();
  if (
    secret.length < 16 ||
    secret.length > 512 ||
    /[\s\u0000-\u001f\u007f]/.test(secret)
  ) {
    throw new LineChannelError(
      "invalid_credentials",
      "The LINE Channel secret format is invalid.",
    );
  }
  return secret;
}

export function normalizeLinePublicBaseUrl(value: string): string {
  const input = value.trim();
  if (!input) return "";

  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new LineChannelError(
      "invalid_credentials",
      "Enter a valid public HTTPS base URL for the LINE webhook.",
    );
  }

  if (
    url.protocol !== "https:" ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "/" && url.pathname !== "")
  ) {
    throw new LineChannelError(
      "invalid_credentials",
      "The LINE webhook base URL must be an HTTPS origin without a path, query, or credentials.",
    );
  }

  return url.origin;
}

export function buildLinePublicWebhookUrl(
  publicBaseUrl: string | null,
): string | null {
  return publicBaseUrl ? `${publicBaseUrl}${LINE_WEBHOOK_PATH}` : null;
}

function sanitizeLineError(
  message: string,
  sensitiveValues: readonly string[] = [],
): string {
  let sanitized = message.replace(/Bearer\s+\S+/gi, "Bearer [redacted]");
  for (const value of sensitiveValues) {
    if (value) sanitized = sanitized.split(value).join("[redacted]");
  }
  return sanitized;
}

export async function validateLineChannelAccessToken(
  value: string,
  fetcher: typeof fetch = fetch,
): Promise<LineBotIdentity> {
  const token = normalizeChannelAccessToken(value);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetcher(`${LINE_API_ROOT}/v2/bot/info`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
      redirect: "error",
      signal: controller.signal,
    });
    const payload = (await response.json().catch(() => null)) as unknown;

    if (!response.ok) {
      if ([400, 401, 403].includes(response.status)) {
        throw new LineChannelError(
          "invalid_credentials",
          "LINE rejected this Channel access token.",
        );
      }
      throw new LineChannelError(
        "platform_unreachable",
        `LINE credential validation failed (${response.status}).`,
      );
    }

    const displayName = isRecord(payload) ? readString(payload.displayName) : null;
    const userId = isRecord(payload) ? readString(payload.userId) : null;
    if (!displayName || !userId) {
      throw new LineChannelError(
        "platform_unreachable",
        "LINE returned an unexpected bot identity response.",
      );
    }

    return {
      displayName,
      userId,
      basicId: isRecord(payload) ? readString(payload.basicId) : null,
      pictureUrl: isRecord(payload) ? readString(payload.pictureUrl) : null,
    };
  } catch (error) {
    if (error instanceof LineChannelError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new LineChannelError(
        "platform_unreachable",
        "LINE credential validation timed out. Check internet access.",
      );
    }
    throw new LineChannelError(
      "platform_unreachable",
      "Cannot reach the LINE Messaging API. Check internet access.",
    );
  } finally {
    clearTimeout(timeout);
  }
}

export async function getLineConfig(): Promise<LineConfigView> {
  const channel = channelRecord(await readConfig());
  const hasChannelAccessToken = Boolean(readString(channel.channelAccessToken));
  const hasChannelSecret = Boolean(readString(channel.channelSecret));
  const configured = hasChannelAccessToken && hasChannelSecret;

  return {
    configured,
    enabled: configured && channel.enabled !== false,
    hasChannelAccessToken,
    hasChannelSecret,
    dmPolicy: "pairing",
    groupPolicy: "disabled",
    webhookPath: LINE_WEBHOOK_PATH,
  };
}

export async function getLineCredentials(): Promise<{
  channelAccessToken: string | null;
  channelSecret: string | null;
}> {
  const channel = channelRecord(await readConfig());
  return {
    channelAccessToken: readString(channel.channelAccessToken),
    channelSecret: readString(channel.channelSecret),
  };
}

export async function saveLineConfig(input: {
  channelAccessToken?: string;
  channelSecret?: string;
  enabled: boolean;
  }): Promise<LineConfigView> {
    await updateConfig((config) => {
      const channels = isRecord(config.channels) ? { ...config.channels } : {};
      const current = isRecord(channels.line) ? channels.line : {};
      const next: Record<string, unknown> = {
        ...current,
        enabled: input.enabled,
        dmPolicy: "pairing",
        groupPolicy: "disabled",
        webhookPath: LINE_WEBHOOK_PATH,
        ...(input.channelAccessToken !== undefined
          ? {
              channelAccessToken: normalizeChannelAccessToken(
                input.channelAccessToken,
              ),
            }
          : {}),
        ...(input.channelSecret !== undefined
          ? { channelSecret: normalizeChannelSecret(input.channelSecret) }
          : {}),
      };

      if (input.channelAccessToken !== undefined) delete next.tokenFile;
      if (input.channelSecret !== undefined) delete next.secretFile;
      channels.line = next;
      config.channels = channels;
    });
    return getLineConfig();
  }

export function getLineOpenClawEnvironment(): NodeJS.ProcessEnv {
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
      timeout: OPENCLAW_STATUS_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
      env: getLineOpenClawEnvironment(),
      windowsHide: true,
    });
  } catch {
    throw new LineChannelError(
      "gateway_unavailable",
      "OpenClaw command failed while checking the LINE channel.",
    );
  }
}

function parseLineProbe(
  value: unknown,
  sensitiveValues: readonly string[],
): LineProbeStatus | null {
  if (!isRecord(value) || typeof value.ok !== "boolean") return null;
  const rawBot = isRecord(value.bot) ? value.bot : null;
  const displayName = rawBot ? readString(rawBot.displayName) : null;
  const userId = rawBot ? readString(rawBot.userId) : null;
  const bot = displayName && userId
    ? {
        displayName,
        userId,
        basicId: readString(rawBot?.basicId),
        pictureUrl: readString(rawBot?.pictureUrl),
      }
    : null;
  const error = readString(value.error);
  return {
    ok: value.ok,
    bot,
    error: error ? sanitizeLineError(error, sensitiveValues) : null,
  };
}

export function parseLineStatusPayload(
  payload: unknown,
  stored: LineConfigView,
  sensitiveValues: readonly string[] = [],
): LineChannelStatus {
  const base: LineChannelStatus = {
    ...stored,
    state: stored.configured
      ? stored.enabled
        ? "configured"
        : "disabled"
      : "not_configured",
    running: false,
    probe: null,
    lastInboundAt: null,
    lastError: null,
  };

  if (!stored.configured || !stored.enabled) return base;
  if (!isRecord(payload)) {
    return {
      ...base,
      state: "error",
      lastError: "OpenClaw returned invalid LINE channel status.",
    };
  }
  if (payload.gatewayReachable === false || payload.configOnly === true) {
    const error = readString(payload.error);
    return {
      ...base,
      state: "error",
      lastError: error
        ? sanitizeLineError(error, sensitiveValues)
        : "OpenClaw Gateway is not reachable.",
    };
  }

  const channelAccounts = isRecord(payload.channelAccounts)
    ? payload.channelAccounts
    : null;
  const accounts = channelAccounts?.line;
  const account = Array.isArray(accounts) && isRecord(accounts[0])
    ? accounts[0]
    : null;
  if (!account) return base;

  const running = account.running === true;
  const probe = parseLineProbe(account.probe, sensitiveValues);
  const lastInboundAt = readTimestamp(account.lastInboundAt);
  const rawError = readString(account.lastError) || probe?.error || null;
  const lastError = rawError
    ? sanitizeLineError(rawError, sensitiveValues)
    : null;

  let state: LineChannelStatus["state"] = "configured";
  if (lastError || probe?.ok === false) state = "error";
  else if (running && probe?.ok === true && lastInboundAt !== null) {
    state = "active";
  } else if (running && probe?.ok === true) state = "ready";
  else if (running) state = "running";

  return {
    ...base,
    state,
    running,
    probe,
    lastInboundAt,
    lastError,
  };
}

export async function probeLineChannel(
  options: { force?: boolean } = {},
): Promise<LineChannelStatus> {
  const stored = await getLineConfig();
  if (!stored.configured || !stored.enabled) {
    return parseLineStatusPayload(null, stored);
  }

  const credentials = await getLineCredentials();
  const sensitiveValues = [
    credentials.channelAccessToken,
    credentials.channelSecret,
  ].filter((value): value is string => Boolean(value));
  let stdout: string;
  try {
    stdout = await getChannelStatusJson(options.force ? { force: true } : undefined);
  } catch (error) {
    throw new LineChannelError("gateway_unavailable", error instanceof Error ? error.message : "OpenClaw status command failed.");
  }
  try {
    return parseLineStatusPayload(JSON.parse(stdout), stored, sensitiveValues);
  } catch {
    throw new LineChannelError(
      "gateway_unavailable",
      "OpenClaw returned invalid JSON while checking LINE status.",
    );
  }
}

export async function waitForLineReady(
  attempts = 3,
  intervalMs = 1_500,
): Promise<LineChannelStatus> {
  let lastStatus: LineChannelStatus | null = null;
  let lastError: string | null = null;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      lastStatus = await probeLineChannel({ force: true });
      if (lastStatus.running && lastStatus.probe?.ok === true) return lastStatus;
      lastError = lastStatus.lastError;
    } catch (error) {
      lastError = error instanceof Error ? error.message : null;
    }
    if (attempt < attempts - 1) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }

  throw new LineChannelError(
    "channel_not_ready",
    lastError ||
      "LINE configuration was saved, but the local webhook listener did not become ready.",
  );
}

export async function listLinePairingRequests(): Promise<
  LinePairingRequest[]
> {
  const { stdout } = await runOpenClaw([
    "pairing",
    "list",
    "line",
    "--json",
  ]);
  let payload: unknown;
  try {
    payload = JSON.parse(stdout);
  } catch {
    throw new LineChannelError(
      "gateway_unavailable",
      "OpenClaw returned invalid JSON while listing LINE pairing requests.",
    );
  }
  if (!isRecord(payload) || !Array.isArray(payload.requests)) return [];

  return payload.requests.flatMap((value): LinePairingRequest[] => {
    if (!isRecord(value)) return [];
    const code = readString(value.code);
    const senderId = readString(value.id);
    const createdAt = readString(value.createdAt);
    if (!code || !senderId || !createdAt) return [];
    const meta = isRecord(value.meta) ? value.meta : null;
    return [
      {
        code,
        senderId,
        createdAt,
        displayName: meta
          ? readString(meta.name) || readString(meta.displayName)
          : null,
      },
    ];
  });
}

export async function approveLinePairing(value: string): Promise<void> {
  const code = value.trim();
  if (!/^[A-Za-z0-9_-]{4,64}$/.test(code)) {
    throw new LineChannelError(
      "invalid_pairing_code",
      "The LINE pairing code format is invalid.",
    );
  }
  await runOpenClaw([
    "pairing",
    "approve",
    "line",
    code,
    "--notify",
  ]);
}
