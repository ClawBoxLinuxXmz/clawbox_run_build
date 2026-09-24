import { readConfig, restartGateway, updateConfig } from "./openclaw-config";

export const MANAGED_CHANNELS = [
  "feishu",
  "qqbot",
  "telegram",
  "whatsapp",
  "line",
  "wecom",
] as const;
export type ManagedChannel = (typeof MANAGED_CHANNELS)[number];

const CHANNEL_CONFIG_KEY: Record<ManagedChannel, string> = {
  feishu: "feishu",
  qqbot: "qqbot",
  telegram: "telegram",
  whatsapp: "whatsapp",
  line: "line",
  wecom: "wecom",
};

const FIELD_WHITELIST: Record<ManagedChannel, readonly string[]> = {
  feishu: ["enabled", "appId", "appSecret", "connectionMode", "domain"],
  qqbot: ["enabled", "appId", "clientSecret"],
  telegram: ["enabled", "botToken"],
  whatsapp: ["enabled"],
  line: ["enabled", "channelAccessToken", "channelSecret"],
  wecom: ["enabled", "botId", "secret", "connectionMode"],
};

const SECRET_FIELDS: Record<ManagedChannel, readonly string[]> = {
  feishu: ["appSecret"],
  qqbot: ["clientSecret"],
  telegram: ["botToken"],
  whatsapp: [],
  line: ["channelAccessToken", "channelSecret"],
  wecom: ["secret"],
};

type ChannelRecord = Record<string, unknown>;

function isRecord(value: unknown): value is ChannelRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function getChannelsConfig(): Promise<Record<string, ChannelRecord>> {
  const config = await readConfig();
  const stored = isRecord(config.channels) ? config.channels : {};
  const channels: Record<string, ChannelRecord> = {};

  for (const channel of MANAGED_CHANNELS) {
    const existing = stored[CHANNEL_CONFIG_KEY[channel]];
    if (!isRecord(existing)) continue;

    const view: ChannelRecord = {};
    for (const key of FIELD_WHITELIST[channel]) {
      if (!(key in existing)) continue;
      if (SECRET_FIELDS[channel].includes(key)) {
        view[key] = "";
        if (existing[key]) view[`has_${key}`] = true;
      } else {
        view[key] = existing[key];
      }
    }
    channels[channel] = view;
  }

  return channels;
}

export async function setChannelConfig(
  channel: ManagedChannel,
  incoming: ChannelRecord,
): Promise<ChannelRecord> {
  let merged: ChannelRecord | undefined;
  await updateConfig((config) => {
    const channels = isRecord(config.channels) ? { ...config.channels } : {};
    const configKey = CHANNEL_CONFIG_KEY[channel];
    const existing = isRecord(channels[configKey]) ? channels[configKey] : {};
    const next: ChannelRecord = { ...existing };

    for (const key of FIELD_WHITELIST[channel]) {
      if (!(key in incoming)) continue;
      const value = incoming[key];
      if (key === "enabled") {
        next[key] = value !== false;
        continue;
      }
      if (typeof value !== "string") continue;
      const trimmed = value.trim();
      if (trimmed === "" && SECRET_FIELDS[channel].includes(key)) continue;
      next[key] = trimmed;
    }

    if (channel === "feishu" && next.connectionMode === "app") {
      next.connectionMode = "websocket";
    }
    if (channel === "wecom") {
      next.connectionMode = "websocket";
    }
    channels[configKey] = next;
    config.channels = channels;
    merged = next;
  });

  await restartGateway();
  return merged as ChannelRecord;
}
