import { readConfig, restartGateway, updateConfig } from "@/lib/openclaw-config";
import { probeOpenClawChannel } from "./openclaw-runtime";
import { fetchWithChannelProxy } from "./proxy";

const DISCORD_API_ROOT = "https://discord.com/api/v10";
const REQUEST_TIMEOUT_MS = 12_000;

export type DiscordChannelState =
  | "not_configured"
  | "disabled"
  | "configured"
  | "connected"
  | "error";

export interface DiscordConfigView {
  configured: boolean;
  enabled: boolean;
  hasToken: boolean;
  serverId: string | null;
  userId: string | null;
  groupPolicy: string;
  dmPolicy: string;
}

export interface DiscordBotIdentity {
  id: string;
  username: string;
  globalName: string | null;
}

export interface DiscordChannelStatus extends DiscordConfigView {
  state: DiscordChannelState;
  connected: boolean;
  running: boolean;
  bot: DiscordBotIdentity | null;
  lastError: string | null;
}

export class DiscordChannelError extends Error {
  constructor(public readonly code: "invalid_token" | "invalid_id" | "unreachable" | "gateway", message: string) {
    super(message);
    this.name = "DiscordChannelError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function channelRecord(config: Awaited<ReturnType<typeof readConfig>>): Record<string, unknown> {
  const value = config.channels?.discord;
  return isRecord(value) ? value : {};
}

function normalizeId(value: string, label: string): string {
  const id = value.trim();
  if (!/^\d{5,25}$/.test(id)) {
    throw new DiscordChannelError("invalid_id", `${label} must be a Discord snowflake ID.`);
  }
  return id;
}

export function normalizeDiscordToken(value: string): string {
  const token = value.trim();
  if (!token || token.length > 512 || /[\r\n]/.test(token)) {
    throw new DiscordChannelError("invalid_token", "Discord Bot Token is empty or contains invalid characters.");
  }
  return token;
}

export function getDiscordTokenFromConfig(config: Awaited<ReturnType<typeof readConfig>>): string | null {
  return readString(channelRecord(config).token);
}

export async function getDiscordConfig(): Promise<DiscordConfigView> {
  const channel = channelRecord(await readConfig());
  const hasToken = Boolean(readString(channel.token));
  const configured = hasToken;
  return {
    configured,
    enabled: configured && channel.enabled !== false,
    hasToken,
    serverId: readString(channel.serverId),
    userId: readString(channel.userId),
    groupPolicy: readString(channel.groupPolicy) || "allowlist",
    dmPolicy: readString(channel.dmPolicy) || "pairing",
  };
}

export async function validateDiscordBotToken(value: string, fetcher: typeof fetch = fetch): Promise<DiscordBotIdentity> {
  const token = normalizeDiscordToken(value);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetchWithChannelProxy("discord", `${DISCORD_API_ROOT}/users/@me`, {
      headers: { Authorization: `Bot ${token}` },
      cache: "no-store",
      redirect: "error",
      signal: controller.signal,
    }, fetcher);
    const payload = (await response.json().catch(() => null)) as unknown;
    if (response.status === 401 || response.status === 403) {
      throw new DiscordChannelError("invalid_token", "Discord rejected this Bot Token. Copy the current token from the Developer Portal.");
    }
    if (!response.ok || !isRecord(payload)) {
      throw new DiscordChannelError("unreachable", `Discord Bot API validation failed (${response.status}).`);
    }
    const id = readString(payload.id);
    const username = readString(payload.username);
    if (!id || !username) throw new DiscordChannelError("unreachable", "Discord returned an unexpected bot identity response.");
    return { id, username, globalName: readString(payload.global_name) };
  } catch (error) {
    if (error instanceof DiscordChannelError) throw error;
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new DiscordChannelError("unreachable", "Discord Bot API validation timed out. Check internet access to discord.com.");
    }
    throw new DiscordChannelError("unreachable", "Cannot reach Discord Bot API. Check internet access or proxy settings.");
  } finally {
    clearTimeout(timer);
  }
}

export async function saveDiscordConfig(input: {
  token?: string;
  serverId?: string;
  userId?: string;
  enabled: boolean;
}): Promise<DiscordConfigView> {
  await updateConfig((config) => {
    const channels = isRecord(config.channels) ? { ...config.channels } : {};
    const current = isRecord(channels.discord) ? channels.discord : {};
    const next: Record<string, unknown> = {
      ...current,
      enabled: input.enabled,
      dmPolicy: readString(current.dmPolicy) || "pairing",
      groupPolicy: readString(current.groupPolicy) || "allowlist",
    };
    if (input.token !== undefined) next.token = normalizeDiscordToken(input.token);
    if (input.serverId !== undefined) next.serverId = normalizeId(input.serverId, "Server ID");
    if (input.userId !== undefined) next.userId = normalizeId(input.userId, "User ID");
    const serverId = readString(next.serverId);
    const userId = readString(next.userId);
    if (serverId) {
      const guilds = isRecord(next.guilds) ? { ...next.guilds } : {};
      const existing = isRecord(guilds[serverId]) ? guilds[serverId] : {};
      guilds[serverId] = { ...existing, requireMention: existing.requireMention !== false, ...(userId ? { users: [userId] } : {}) };
      next.guilds = guilds;
    }
    channels.discord = next;
    config.channels = channels;
  });
  return getDiscordConfig();
}

export async function getDiscordStatus(
  options: { force?: boolean } = {},
): Promise<DiscordChannelStatus> {
  const stored = await getDiscordConfig();
  const base: DiscordChannelStatus = { ...stored, state: stored.configured ? stored.enabled ? "configured" : "disabled" : "not_configured", connected: false, running: false, bot: null, lastError: null };
  if (!stored.configured || !stored.enabled) return base;
  const runtime = await probeOpenClawChannel("discord", undefined, options);
  const bot = runtime.displayName
    ? { id: runtime.accountId || "default", username: runtime.displayName, globalName: null }
    : null;
  return { ...base, state: runtime.state, connected: runtime.connected, running: runtime.running, bot, lastError: runtime.lastError };
}

export async function restartDiscordGateway(): Promise<void> {
  await restartGateway();
}
