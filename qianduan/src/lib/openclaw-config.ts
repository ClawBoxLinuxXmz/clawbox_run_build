import fs from "fs/promises";
import path from "path";
import { execFile } from "child_process";
import { randomUUID } from "crypto";
import { promisify } from "util";
import { invalidateChannelStatusCache } from "@/lib/channels/channel-status-cache";

const exec = promisify(execFile);
const OPENCLAW_STATE_DIR =
  process.env.OPENCLAW_STATE_DIR ||
  process.env.OPENCLAW_HOME ||
  "/home/clawbox/.openclaw";
const CONFIG_PATH =
  process.env.OPENCLAW_CONFIG_PATH ||
  path.join(OPENCLAW_STATE_DIR, "openclaw.json");
const WECHAT_CHANNEL_KEY = "openclaw-weixin";
const LEGACY_WECHAT_CHANNEL_KEY = "wechat";
const GATEWAY_SERVICE = "clawbox-gateway.service";
const GATEWAY_PID_RETRIES = 8;
const GATEWAY_PID_RETRY_DELAY_MS = 250;
let configWriteQueue: Promise<void> = Promise.resolve();

export interface OpenClawConfig {
  [key: string]: unknown;
  channels?: {
    [name: string]: {
      enabled?: boolean;
      botToken?: string;
      dmPolicy?: string;
      accounts?: Record<string, unknown>;
      [key: string]: unknown;
    };
  };
}

export async function readConfig(): Promise<OpenClawConfig> {
  try {
    const raw = await fs.readFile(CONFIG_PATH, "utf-8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function writeConfigFile(config: OpenClawConfig): Promise<void> {
  await fs.mkdir(path.dirname(CONFIG_PATH), { recursive: true });
  const tmpPath = `${CONFIG_PATH}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(tmpPath, JSON.stringify(config, null, 2), {
      encoding: "utf-8",
      mode: 0o600,
    });
    await fs.rename(tmpPath, CONFIG_PATH);
    await fs.chmod(CONFIG_PATH, 0o600);
    invalidateChannelStatusCache();
  } finally {
    await fs.rm(tmpPath, { force: true }).catch(() => {});
  }
}

function serializeConfigWrite<T>(operation: () => Promise<T>): Promise<T> {
  const result = configWriteQueue.then(operation);
  configWriteQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

export function writeConfig(config: OpenClawConfig): Promise<void> {
  return serializeConfigWrite(() => writeConfigFile(config));
}

export function updateConfig<T>(
  update: (config: OpenClawConfig) => T | Promise<T>,
): Promise<T> {
  return serializeConfigWrite(async () => {
    const config = await readConfig();
    const result = await update(config);
    await writeConfigFile(config);
    return result;
  });
}

/**
 * Reload the Gateway through its supported signal path. The setup server runs
 * as `clawbox`, so asking systemd to restart a service would require an
 * interactive Polkit authorization and make config saves fail on the device.
 */
export async function restartGateway(): Promise<void> {
  for (let attempt = 0; attempt < GATEWAY_PID_RETRIES; attempt += 1) {
    const { stdout } = await exec(
      "systemctl",
      ["show", GATEWAY_SERVICE, "--property=MainPID", "--value", "--no-pager"],
      { timeout: 3_000 },
    );
    const pid = Number.parseInt(stdout.trim(), 10);
    if (Number.isSafeInteger(pid) && pid > 1) {
      try {
        process.kill(pid, "SIGUSR1");
        return;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ESRCH") throw error;
      }
    }

    if (attempt < GATEWAY_PID_RETRIES - 1) {
      await new Promise((resolve) => setTimeout(resolve, GATEWAY_PID_RETRY_DELAY_MS));
    }
  }

  throw new Error("clawbox-gateway is not running");
}

/** Fully restart Gateway when systemd must reload service environment values. */
export async function restartGatewayService(): Promise<void> {
  await exec("systemctl", ["restart", GATEWAY_SERVICE], {
    timeout: 15_000,
  });
}

async function readWeixinAccountStatus(): Promise<{ connected: boolean; accountIds: string[] }> {
  const accountsDir = path.join(OPENCLAW_STATE_DIR, WECHAT_CHANNEL_KEY, "accounts");
  try {
    const ents = await fs.readdir(accountsDir, { withFileTypes: true });
    const accountIds: string[] = [];
    let connected = false;

    for (const ent of ents) {
      if (!ent.isFile() || !ent.name.endsWith(".json")) continue;
      if (ent.name.endsWith(".sync.json") || ent.name.endsWith(".context-tokens.json")) continue;
      const accountId = ent.name.replace(/\.json$/, "");
      accountIds.push(accountId);
      try {
        const raw = await fs.readFile(path.join(accountsDir, ent.name), "utf-8");
        const parsed = JSON.parse(raw) as { token?: string };
        if (typeof parsed.token === "string" && parsed.token.trim()) {
          connected = true;
        }
      } catch {
        // ignore bad file
      }
    }

    return { connected, accountIds };
  } catch {
    return { connected: false, accountIds: [] };
  }
}

// 微信机器人配置（合并写入，避免只改开关时清空 token）
export async function setWechatConfig(botToken?: string, enabled?: boolean): Promise<void> {
  await updateConfig((config) => {
    if (!config.channels) {
      config.channels = {};
    }

    const current = (config.channels[WECHAT_CHANNEL_KEY] ||
      config.channels[LEGACY_WECHAT_CHANNEL_KEY] ||
      {}) as Record<string, unknown>;

    const next: Record<string, unknown> = {
      ...current,
      dmPolicy: "open",
      allowFrom: ["*"],
    };

    if (botToken !== undefined) {
      next.botToken = botToken || undefined;
    }
    if (enabled !== undefined) {
      next.enabled = enabled;
    } else if (next.enabled === undefined) {
      next.enabled = true;
    }

    config.channels[WECHAT_CHANNEL_KEY] = next as NonNullable<OpenClawConfig["channels"]>[string];
    if (config.channels[LEGACY_WECHAT_CHANNEL_KEY]) {
      delete config.channels[LEGACY_WECHAT_CHANNEL_KEY];
    }
  });
  await restartGateway();
}

// 获取微信机器人配置（不回传明文 token）
export async function getWechatConfig(): Promise<{
  enabled?: boolean;
  botToken?: string;
  connected?: boolean;
  accountIds?: string[];
}> {
  const config = await readConfig();
  const ch =
    (config.channels?.[WECHAT_CHANNEL_KEY] as Record<string, unknown> | undefined) ||
    (config.channels?.[LEGACY_WECHAT_CHANNEL_KEY] as Record<string, unknown> | undefined) ||
    {};

  const status = await readWeixinAccountStatus();
  const enabled = typeof ch.enabled === "boolean" ? ch.enabled : undefined;

  return {
    enabled,
    botToken: typeof ch.botToken === "string" && ch.botToken ? "********" : undefined,
    connected: enabled !== false && status.connected,
    accountIds: status.accountIds,
  };
}

export async function getWechatLoginStatus(): Promise<{
  connected: boolean;
  accountIds: string[];
}> {
  return readWeixinAccountStatus();
}

// 启用/禁用微信机器人
export async function toggleWechatBot(enabled: boolean): Promise<void> {
  await setWechatConfig(undefined, enabled);
}

export async function restartServices(): Promise<void> {
  await restartGateway();
}
