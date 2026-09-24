import fs from "node:fs/promises";
import path from "node:path";
import { ProxyAgent } from "undici";
import { readConfig, updateConfig } from "@/lib/openclaw-config";

export const PROXY_CHANNEL_IDS = [
  "telegram",
  "discord",
  "whatsapp",
  "signal",
  "zalo",
  "openclaw-zaloclawbot",
  "zalouser",
] as const;

const NATIVE_PROXY_CHANNEL_IDS = ["telegram", "discord", "zalo"] as const;

export type ProxyChannelId = (typeof PROXY_CHANNEL_IDS)[number];
export type ProxyMode = "direct" | "channel" | "global";

export interface ProxyChannelSettings {
  mode: ProxyMode;
  url: string;
}

export interface ProxyConfig {
  global: {
    enabled: boolean;
    url: string;
  };
  channels: Partial<Record<ProxyChannelId, ProxyChannelSettings>>;
}

export interface ProxyChannelView extends ProxyChannelSettings {
  effectiveMode: ProxyMode;
  effectiveProxy: string | null;
  globalEnabled: boolean;
  globalProxy: string | null;
}

const OPENCLAW_STATE_DIR =
  process.env.OPENCLAW_STATE_DIR ||
  process.env.OPENCLAW_HOME ||
  "/home/clawbox/.openclaw";
export const PROXY_CONFIG_PATH =
  process.env.CLAWBOX_PROXY_CONFIG_PATH ||
  path.join(OPENCLAW_STATE_DIR, "clawbox-proxy.json");

let writeQueue: Promise<void> = Promise.resolve();
const dispatcherCache = new Map<string, ProxyAgent>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isProxyChannelId(value: string): value is ProxyChannelId {
  return (PROXY_CHANNEL_IDS as readonly string[]).includes(value);
}

function normalizeMode(value: unknown): ProxyMode {
  return value === "channel" || value === "global" ? value : "direct";
}

export function normalizeProxyUrl(value: string): string {
  const url = value.trim();
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Enter a valid HTTP or HTTPS proxy URL.");
  }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || !parsed.hostname) {
    throw new Error("Enter a valid HTTP or HTTPS proxy URL.");
  }
  return url.replace(/\/+$/, "");
}

function defaultConfig(): ProxyConfig {
  return { global: { enabled: false, url: "" }, channels: {} };
}

function normalizeConfig(value: unknown): ProxyConfig {
  const next = defaultConfig();
  if (!isRecord(value)) return next;

  const global = isRecord(value.global) ? value.global : {};
  next.global.enabled = global.enabled === true;
  const globalUrl = readString(global.url);
  if (globalUrl) {
    try {
      next.global.url = normalizeProxyUrl(globalUrl);
    } catch {
      next.global.url = "";
    }
  }

  const channels = isRecord(value.channels) ? value.channels : {};
  for (const channelId of PROXY_CHANNEL_IDS) {
    const entry = isRecord(channels[channelId]) ? channels[channelId] : null;
    if (!entry) continue;
    const url = readString(entry.url);
    next.channels[channelId] = {
      mode: normalizeMode(entry.mode),
      url: url
        ? (() => {
            try {
              return normalizeProxyUrl(url);
            } catch {
              return "";
            }
          })()
        : "",
    };
  }
  return next;
}

async function readStoredConfig(): Promise<ProxyConfig> {
  let stored: unknown;
  try {
    stored = JSON.parse(await fs.readFile(PROXY_CONFIG_PATH, "utf8"));
  } catch {
    stored = undefined;
  }

  const config = normalizeConfig(stored);
  // Preserve native OpenClaw proxy settings created before the dedicated
  // ClawBox proxy file existed. An explicit direct-mode entry still wins.
  if (NATIVE_PROXY_CHANNEL_IDS.some((channelId) => !config.channels[channelId])) {
    const native = await readNativeChannelProxies();
    for (const channelId of NATIVE_PROXY_CHANNEL_IDS) {
      const proxy = native[channelId];
      if (proxy && !config.channels[channelId]) {
        config.channels[channelId] = { mode: "channel", url: proxy };
      }
    }
  }
  return config;
}

async function writeStoredConfig(config: ProxyConfig): Promise<void> {
  await fs.mkdir(path.dirname(PROXY_CONFIG_PATH), { recursive: true, mode: 0o700 });
  const tempPath = `${PROXY_CONFIG_PATH}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(tempPath, JSON.stringify(config, null, 2), { encoding: "utf8", mode: 0o600 });
    await fs.rename(tempPath, PROXY_CONFIG_PATH);
    await fs.chmod(PROXY_CONFIG_PATH, 0o600);
  } finally {
    await fs.rm(tempPath, { force: true }).catch(() => {});
  }
}

function serializeWrite<T>(operation: () => Promise<T>): Promise<T> {
  const result = writeQueue.then(operation);
  writeQueue = result.then(() => undefined, () => undefined);
  return result;
}

async function readLegacyZaloProxy(): Promise<string | null> {
  const config = await readConfig();
  const channel = config.channels?.zalo;
  if (!isRecord(channel)) return null;
  const value = readString(channel.proxy);
  if (!value) return null;
  try {
    return normalizeProxyUrl(value);
  } catch {
    return null;
  }
}

async function readNativeChannelProxies(): Promise<Partial<Record<ProxyChannelId, string>>> {
  const config = await readConfig();
  const channels = isRecord(config.channels) ? config.channels : {};
  const native: Partial<Record<ProxyChannelId, string>> = {};
  for (const channelId of NATIVE_PROXY_CHANNEL_IDS) {
    const channel = isRecord(channels[channelId]) ? channels[channelId] : null;
    const value = channel ? readString(channel.proxy) : "";
    if (!value) continue;
    try {
      native[channelId] = normalizeProxyUrl(value);
    } catch {
      // Ignore malformed legacy values and let the user configure them again.
    }
  }
  return native;
}

function channelEntry(config: ProxyConfig, channelId: ProxyChannelId): ProxyChannelSettings {
  return config.channels[channelId] || { mode: "direct", url: "" };
}

export async function getProxyConfig(): Promise<ProxyConfig> {
  return readStoredConfig();
}

export async function getProxyChannelView(channelId: ProxyChannelId): Promise<ProxyChannelView> {
  const config = await readStoredConfig();
  let entry = channelEntry(config, channelId);
  if (!config.channels[channelId] && channelId === "zalo") {
    const legacyProxy = await readLegacyZaloProxy();
    if (legacyProxy) entry = { mode: "channel", url: legacyProxy };
  }
  const globalProxy = config.global.enabled && config.global.url ? config.global.url : null;
  const effectiveProxy = entry.mode === "channel"
    ? entry.url || null
    : entry.mode === "global"
      ? globalProxy
      : null;
  return {
    ...entry,
    effectiveMode: effectiveProxy ? entry.mode : "direct",
    effectiveProxy,
    globalEnabled: config.global.enabled,
    globalProxy,
  };
}

export async function getEffectiveChannelProxy(channelId: ProxyChannelId): Promise<string | null> {
  return (await getProxyChannelView(channelId)).effectiveProxy;
}

export async function saveProxySettings(input: {
  channelId?: string;
  mode?: unknown;
  channelUrl?: unknown;
  globalEnabled?: unknown;
  globalUrl?: unknown;
}): Promise<{ config: ProxyConfig; channel: ProxyChannelView | null }> {
  if (input.channelId !== undefined && !isProxyChannelId(input.channelId)) {
    throw new Error("Unsupported proxy channel.");
  }
  const channelId = input.channelId as ProxyChannelId | undefined;
  const mode = normalizeMode(input.mode);
  const channelUrl = readString(input.channelUrl);
  const globalUrl = readString(input.globalUrl);
  if (mode === "channel" && !channelUrl) throw new Error("A channel proxy URL is required.");

  const config = await serializeWrite(async () => {
    const next = await readStoredConfig();
    if (input.globalEnabled !== undefined || input.globalUrl !== undefined) {
      next.global.enabled = input.globalEnabled === true;
      next.global.url = globalUrl ? normalizeProxyUrl(globalUrl) : "";
    }
    if (channelId) {
      next.channels[channelId] = {
        mode,
        url: mode === "channel" ? normalizeProxyUrl(channelUrl) : "",
      };
    }
    await writeStoredConfig(next);
    return next;
  });

  await syncNativeChannelProxies(config);
  return {
    config,
    channel: channelId ? await getProxyChannelView(channelId) : null,
  };
}

async function syncNativeChannelProxies(config: ProxyConfig): Promise<void> {
  const nativeChannels = new Set<ProxyChannelId>(["telegram", "discord", "zalo"]);
  const entries = [...nativeChannels].map((channelId) => [channelId, channelEntry(config, channelId)] as const);
  const legacyZaloProxy = config.channels.zalo?.mode === "channel"
    ? config.channels.zalo.url
    : config.channels.zalo?.mode === "global"
      ? config.global.enabled
        ? config.global.url
        : ""
      : "";
  await updateConfig((openclaw) => {
    const channels = isRecord(openclaw.channels) ? { ...openclaw.channels } : {};
    for (const [channelId, entry] of entries) {
      const currentValue = channels[channelId];
      const current = isRecord(currentValue) ? { ...currentValue } : null;
      const proxy = channelId === "zalo"
        ? legacyZaloProxy
        : entry.mode === "channel"
          ? entry.url
          : entry.mode === "global"
            ? config.global.enabled
              ? config.global.url
              : ""
            : "";
      if (!current && !proxy) continue;
      const next = current || {};
      if (proxy) next.proxy = proxy;
      else delete next.proxy;
      channels[channelId] = next;
    }
    openclaw.channels = channels;
  });
}

export async function fetchWithChannelProxy(
  channelId: ProxyChannelId,
  input: RequestInfo | URL,
  init: RequestInit = {},
  fetcher: typeof fetch = fetch,
): Promise<Response> {
  const proxy = await getEffectiveChannelProxy(channelId);
  if (!proxy) return fetcher(input, init);
  let dispatcher = dispatcherCache.get(proxy);
  if (!dispatcher) {
    dispatcher = new ProxyAgent(proxy);
    dispatcherCache.set(proxy, dispatcher);
  }
  return fetcher(input, { ...init, dispatcher } as RequestInit);
}
