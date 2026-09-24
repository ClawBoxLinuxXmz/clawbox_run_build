import { execFile } from "child_process";
import path from "path";
import { promisify } from "util";
import { readConfig, updateConfig } from "@/lib/openclaw-config";
import { getChannelStatusJson } from "./channel-status-cache";

const exec = promisify(execFile);
const OPENCLAW_BIN = process.env.OPENCLAW_BIN || "/home/clawbox/.npm-global/bin/openclaw";
const OPENCLAW_STATE_DIR = process.env.OPENCLAW_STATE_DIR || process.env.OPENCLAW_HOME || "/home/clawbox/.openclaw";
const OPENCLAW_CONFIG_PATH = process.env.OPENCLAW_CONFIG_PATH || path.join(OPENCLAW_STATE_DIR, "openclaw.json");
const OPENCLAW_USER_HOME = "/home/clawbox";
const REQUEST_TIMEOUT_MS = 12_000;

export type FeishuDomain = "feishu" | "lark";
export type FeishuErrorCode = "invalid_credentials" | "platform_unreachable" | "gateway_unavailable" | "channel_not_connected" | "invalid_pairing_code";

export class FeishuChannelError extends Error {
  constructor(public readonly code: FeishuErrorCode, message: string) {
    super(message);
    this.name = "FeishuChannelError";
  }
}

export interface FeishuConfigView {
  configured: boolean;
  enabled: boolean;
  hasAppSecret: boolean;
  appId: string | null;
  domain: FeishuDomain;
}

export interface FeishuChannelStatus extends FeishuConfigView {
  state: "not_configured" | "disabled" | "configured" | "connected" | "error";
  connected: boolean;
  running: boolean;
  probeOk: boolean | null;
  botName: string | null;
  botOpenId: string | null;
  lastError: string | null;
}

export interface FeishuPairingRequest {
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

function channelRecord(config: Awaited<ReturnType<typeof readConfig>>): Record<string, unknown> {
  const value = config.channels?.feishu;
  return isRecord(value) ? value : {};
}

function normalizeAppId(value: string): string {
  const appId = value.trim();
  if (!/^cli_[A-Za-z0-9]{8,128}$/.test(appId)) {
    throw new FeishuChannelError("invalid_credentials", "The Feishu App ID format is invalid.");
  }
  return appId;
}

function normalizeAppSecret(value: string): string {
  const secret = value.trim();
  if (secret.length < 16 || secret.length > 512 || /\s/.test(secret)) {
    throw new FeishuChannelError("invalid_credentials", "The Feishu App Secret format is invalid.");
  }
  return secret;
}

function normalizeOwnerOpenId(value: unknown): string {
  if (typeof value !== "string" || !/^ou_[A-Za-z0-9]{8,128}$/.test(value.trim())) {
    throw new FeishuChannelError("invalid_credentials", "The Feishu owner Open ID format is invalid.");
  }
  return value.trim();
}

function apiRoot(domain: FeishuDomain): string {
  return domain === "lark" ? "https://open.larksuite.com" : "https://open.feishu.cn";
}

export async function validateFeishuCredentials(input: { appId: string; appSecret: string; domain: FeishuDomain }, fetcher: typeof fetch = fetch): Promise<void> {
  const appId = normalizeAppId(input.appId);
  const appSecret = normalizeAppSecret(input.appSecret);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetcher(`${apiRoot(input.domain)}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
      cache: "no-store",
      redirect: "error",
      signal: controller.signal,
    });
    const payload = (await response.json().catch(() => null)) as unknown;
    if (!response.ok || !isRecord(payload) || payload.code !== 0 || !readString(payload.tenant_access_token)) {
      if (response.status === 400 || response.status === 401 || response.status === 403 || (isRecord(payload) && typeof payload.code === "number")) {
        throw new FeishuChannelError("invalid_credentials", "Feishu rejected this App ID or App Secret.");
      }
      throw new FeishuChannelError("platform_unreachable", `Feishu credential validation failed (${response.status}).`);
    }
  } catch (error) {
    if (error instanceof FeishuChannelError) throw error;
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new FeishuChannelError("platform_unreachable", "Feishu credential validation timed out. Check internet access.");
    }
    throw new FeishuChannelError("platform_unreachable", "Cannot reach the Feishu Open Platform. Check internet access.");
  } finally {
    clearTimeout(timeout);
  }
}

export async function getFeishuConfig(): Promise<FeishuConfigView> {
  const channel = channelRecord(await readConfig());
  const appId = readString(channel.appId);
  const hasAppSecret = Boolean(readString(channel.appSecret));
  const configured = Boolean(appId && hasAppSecret);
  return {
    configured,
    enabled: configured && channel.enabled !== false,
    hasAppSecret,
    appId,
    domain: channel.domain === "lark" ? "lark" : "feishu",
  };
}

export async function getFeishuCredentials(): Promise<{ appId: string; appSecret: string; domain: FeishuDomain } | null> {
  const channel = channelRecord(await readConfig());
  const appId = readString(channel.appId);
  const appSecret = readString(channel.appSecret);
  if (!appId || !appSecret) return null;
  return { appId, appSecret, domain: channel.domain === "lark" ? "lark" : "feishu" };
}

export async function saveFeishuConfig(input: {
  appId?: string;
  appSecret?: string;
  domain: FeishuDomain;
  enabled: boolean;
  ownerOpenId?: string;
}): Promise<FeishuConfigView> {
  const ownerOpenId = input.ownerOpenId === undefined
    ? undefined
    : normalizeOwnerOpenId(input.ownerOpenId);
  await updateConfig((config) => {
    const channels = isRecord(config.channels) ? { ...config.channels } : {};
    const current = isRecord(channels.feishu) ? channels.feishu : {};
    channels.feishu = {
      ...current,
      enabled: input.enabled,
      domain: input.domain,
      connectionMode: "websocket",
      dmPolicy: ownerOpenId === undefined
        ? readString(current.dmPolicy) || "pairing"
        : "allowlist",
      groupPolicy: readString(current.groupPolicy) || "disabled",
      ...(input.appId !== undefined ? { appId: normalizeAppId(input.appId) } : {}),
      ...(input.appSecret !== undefined ? { appSecret: normalizeAppSecret(input.appSecret) } : {}),
      ...(ownerOpenId !== undefined ? { allowFrom: [ownerOpenId] } : {}),
    };
    config.channels = channels;
  });
  return getFeishuConfig();
}

function cliEnvironment(): NodeJS.ProcessEnv {
  return { ...process.env, HOME: OPENCLAW_USER_HOME, OPENCLAW_HOME: OPENCLAW_STATE_DIR, OPENCLAW_STATE_DIR, OPENCLAW_CONFIG_PATH };
}

async function runOpenClaw(args: string[]) {
  try {
    return await exec(OPENCLAW_BIN, args, { timeout: 12_000, maxBuffer: 1024 * 1024, env: cliEnvironment(), windowsHide: true });
  } catch (error) {
    const stderr = isRecord(error) ? readString(error.stderr) : null;
    throw new FeishuChannelError("gateway_unavailable", stderr || "OpenClaw command failed.");
  }
}

export function parseFeishuStatusPayload(payload: unknown, stored: FeishuConfigView): FeishuChannelStatus {
  const base: FeishuChannelStatus = { ...stored, state: stored.configured ? (stored.enabled ? "configured" : "disabled") : "not_configured", connected: false, running: false, probeOk: null, botName: null, botOpenId: null, lastError: null };
  if (!stored.configured || !stored.enabled) return base;
  if (!isRecord(payload) || payload.gatewayReachable === false || payload.configOnly === true) {
    return { ...base, state: "error", lastError: isRecord(payload) ? readString(payload.error) || "OpenClaw Gateway is not reachable." : "OpenClaw returned invalid channel status." };
  }
  const channelAccounts = isRecord(payload.channelAccounts) ? payload.channelAccounts : null;
  const accounts = channelAccounts?.feishu;
  const account = Array.isArray(accounts) && isRecord(accounts[0]) ? accounts[0] : null;
  if (!account) return base;
  const probe = isRecord(account.probe) ? account.probe : null;
  const running = account.running === true;
  const probeOk = probe && typeof probe.ok === "boolean" ? probe.ok : null;
  const connected = account.connected === true || (running && probeOk === true);
  const lastError = readString(account.lastError) || (probe ? readString(probe.error) : null);
  return { ...base, state: connected ? "connected" : probeOk === false || lastError ? "error" : "configured", connected, running, probeOk, botName: probe ? readString(probe.botName) : null, botOpenId: probe ? readString(probe.botOpenId) : null, lastError };
}

export async function probeFeishuChannel(
  options: { force?: boolean } = {},
): Promise<FeishuChannelStatus> {
  const stored = await getFeishuConfig();
  if (!stored.configured || !stored.enabled) return parseFeishuStatusPayload(null, stored);
  let stdout: string;
  try {
    stdout = await getChannelStatusJson(options.force ? { force: true } : undefined);
  } catch (error) {
    throw new FeishuChannelError("gateway_unavailable", error instanceof Error ? error.message : "OpenClaw status command failed.");
  }
  try {
    return parseFeishuStatusPayload(JSON.parse(stdout), stored);
  } catch {
    throw new FeishuChannelError("gateway_unavailable", "OpenClaw returned invalid JSON while checking Feishu status.");
  }
}

export async function waitForFeishuConnected(attempts = 3, intervalMs = 1_500): Promise<FeishuChannelStatus> {
  let lastError: string | null = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const status = await probeFeishuChannel({ force: true });
      if (status.connected) return status;
      lastError = status.lastError;
    } catch (error) {
      lastError = error instanceof Error ? error.message : "Feishu status check failed.";
    }
    if (attempt < attempts - 1) await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new FeishuChannelError("channel_not_connected", lastError || "Feishu config was saved, but the channel did not become online.");
}

export async function listFeishuPairingRequests(): Promise<FeishuPairingRequest[]> {
  const { stdout } = await runOpenClaw(["pairing", "list", "feishu", "--json"]);
  let payload: unknown;
  try { payload = JSON.parse(stdout); } catch { throw new FeishuChannelError("gateway_unavailable", "OpenClaw returned invalid JSON while listing Feishu pairing requests."); }
  if (!isRecord(payload) || !Array.isArray(payload.requests)) return [];
  return payload.requests.flatMap((value): FeishuPairingRequest[] => {
    if (!isRecord(value)) return [];
    const code = readString(value.code); const senderId = readString(value.id); const createdAt = readString(value.createdAt);
    if (!code || !senderId || !createdAt) return [];
    const meta = isRecord(value.meta) ? value.meta : null;
    return [{ code, senderId, createdAt, displayName: meta ? readString(meta.name) || readString(meta.displayName) : null }];
  });
}

export async function approveFeishuPairing(value: string): Promise<void> {
  const code = value.trim();
  if (!/^[A-Za-z0-9_-]{4,64}$/.test(code)) throw new FeishuChannelError("invalid_pairing_code", "The Feishu pairing code format is invalid.");
  await runOpenClaw(["pairing", "approve", "feishu", code, "--notify"]);
}
