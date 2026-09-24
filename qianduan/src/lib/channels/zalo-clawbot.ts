import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { readConfig, restartGateway, type OpenClawConfig, updateConfig } from "@/lib/openclaw-config";
import {
  cancelQrSession,
  createAsyncQrSession,
  getQrSession,
  type QrSessionView,
} from "./qr-session";
import { OPENCLAW_STATE_DIR, runOpenClaw } from "./openclaw-runtime";
import { fetchWithChannelProxy } from "./proxy";

export const CLAWBOT_PLUGIN_SPEC = "@zalo-platforms/openclaw-zaloclawbot@0.1.4";
const DEFAULT_SESSION_SERVICE_URL = "https://bot.zaloplatforms.com";
const DEFAULT_ZALO_API_BASE_URL = "https://bot-api.zaloplatforms.com";
const LOGIN_TIMEOUT_MS = 5 * 60_000;
const LOGIN_POLL_INTERVAL_MS = 1_500;

let clawBotPluginReady = false;
let clawBotPluginPreparation: Promise<void> | null = null;

export interface ClawBotConfigView {
  configured: boolean;
  enabled: boolean;
  accountIds: string[];
}

export interface ClawBotStatus extends ClawBotConfigView {
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

function readRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function normalizeAccountId(value: string): string {
  const normalized = value.trim().toLowerCase();
  return (
    normalized
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64) || "default"
  );
}

function tokenFingerprint(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 8);
}

interface ClawBotLoginStart {
  loginUrl: string;
  zbsk: string;
}

interface ClawBotLoginResult {
  connected: boolean;
  botToken?: string;
  botId?: string;
  ownerId?: string;
  oaId?: string;
  accountName?: string;
  message: string;
}

function unwrapLoginResponse(value: unknown): Record<string, unknown> {
  const root = readRecord(value);
  if (!root || !("result" in root || "ok" in root || "error_code" in root)) return root || {};
  return readRecord(root.result) || {};
}

async function sessionServiceUrl(): Promise<string> {
  const config = await readConfig();
  const channel = config.channels?.["openclaw-zaloclawbot"];
  return (
    readString(channel?.sessionServiceUrl) ||
    process.env.ZALOCLAWBOT_SESSION_SERVICE_URL?.trim() ||
    DEFAULT_SESSION_SERVICE_URL
  ).replace(/\/+$/, "");
}

async function requestClawBotLogin(): Promise<ClawBotLoginStart> {
  const response = await fetchWithChannelProxy("openclaw-zaloclawbot", `${await sessionServiceUrl()}/agent/request-login`, {
    method: "GET",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Zalo login service unavailable (HTTP ${response.status}).`);
  const payload = unwrapLoginResponse(await response.json());
  const loginUrl = readString(payload.loginUrl);
  const zbsk = readString(payload.zbsk);
  if (!loginUrl || !zbsk) throw new Error("Zalo login service returned an invalid QR session.");
  try {
    const parsed = new URL(loginUrl);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error("invalid protocol");
  } catch {
    throw new Error("Zalo login service returned an invalid login URL.");
  }
  return { loginUrl, zbsk };
}

async function waitForClawBotLogin(zbsk: string, signal: AbortSignal): Promise<ClawBotLoginResult> {
  const base = await sessionServiceUrl();
  const deadline = Date.now() + LOGIN_TIMEOUT_MS;
  while (Date.now() < deadline && !signal.aborted) {
    let response: Response;
    try {
      response = await fetchWithChannelProxy(
        "openclaw-zaloclawbot",
        `${base}/agent/get-login-status?zbsk=${encodeURIComponent(zbsk)}`,
        { method: "GET", signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]) },
      );
    } catch (error) {
      if (signal.aborted) return { connected: false, message: "Login cancelled." };
      if (error instanceof Error && error.name === "TimeoutError") continue;
      throw new Error("Unable to reach the Zalo login service.");
    }
    if (response.status === 498) return { connected: false, message: "QR/session expired. Generate a new QR code." };
    if (!response.ok && response.status !== 202) {
      throw new Error(`Zalo login service unavailable (HTTP ${response.status}).`);
    }
    const payload = unwrapLoginResponse(await response.json().catch(() => ({})));
    const botToken = readString(payload.botToken);
    if (payload.isLogin === true && botToken) {
      return {
        connected: true,
        botToken,
        botId: readString(payload.botId) || undefined,
        ownerId: readString(payload.ownerId) || undefined,
        oaId: readString(payload.oaId) || undefined,
        message: "Login confirmed.",
      };
    }
    if (payload.code === 498 || payload.error_code === 498) {
      return { connected: false, message: "QR/session expired. Generate a new QR code." };
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, LOGIN_POLL_INTERVAL_MS);
      signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
    });
  }
  return { connected: false, message: signal.aborted ? "Login cancelled." : "Login timeout. Generate a new QR code." };
}

async function resolveBotIdentity(
  token: string,
  botId: string | undefined,
): Promise<{ accountId: string; storageBotId: string; accountName?: string; botId?: string }> {
  let resolvedBotId = botId;
  let accountName: string | undefined;
  try {
    const response = await fetchWithChannelProxy("openclaw-zaloclawbot", `${DEFAULT_ZALO_API_BASE_URL}/bot${token}/getMe`, {
      method: "POST",
      signal: AbortSignal.timeout(10_000),
    });
    const payload = readRecord(await response.json().catch(() => ({})));
    const result = payload && readRecord(payload.result);
    if (payload?.ok === true && result) {
      accountName = readString(result.account_name) || undefined;
      resolvedBotId = resolvedBotId || readString(result.id) || undefined;
    }
  } catch {
    // The login service already confirmed the token; identity lookup is best effort.
  }
  const identity = accountName || resolvedBotId || `token-${tokenFingerprint(token)}`;
  return {
    accountId: normalizeAccountId(`clawbot-${identity}`),
    storageBotId: resolvedBotId || accountName || identity,
    accountName,
    botId: resolvedBotId,
  };
}

async function persistClawBotLogin(result: ClawBotLoginResult): Promise<void> {
  const token = result.botToken;
  if (!result.connected || !token) throw new Error(result.message || "Zalo login was not confirmed.");
  const identity = await resolveBotIdentity(token, result.botId);
  const stateDir = clawBotStateDir();
  const accountsDir = path.join(stateDir, "accounts");
  await fs.mkdir(accountsDir, { recursive: true, mode: 0o700 });
  const accountPath = path.join(accountsDir, `${identity.accountId}.json`);
  let existing: Record<string, unknown> = {};
  try {
    existing = readRecord(JSON.parse(await fs.readFile(accountPath, "utf8"))) || {};
  } catch {
    // New account or incomplete previous login.
  }
  await fs.writeFile(
    accountPath,
    JSON.stringify({
      ...existing,
      botId: identity.botId || identity.storageBotId,
      botToken: token,
      accountName: identity.accountName || existing.accountName,
      ownerId: result.ownerId,
      oaId: result.oaId,
      savedAt: new Date().toISOString(),
    }, null, 2),
    { encoding: "utf8", mode: 0o600 },
  );
  let accountIds: string[] = [];
  try {
    const indexed = JSON.parse(await fs.readFile(path.join(stateDir, "accounts.json"), "utf8")) as unknown;
    if (Array.isArray(indexed)) accountIds = indexed.filter((value): value is string => typeof value === "string");
  } catch {
    // Create the index on first login.
  }
  if (!accountIds.includes(identity.accountId)) accountIds.push(identity.accountId);
  await fs.writeFile(path.join(stateDir, "accounts.json"), JSON.stringify(accountIds, null, 2), { encoding: "utf8", mode: 0o600 });
}

function clawBotStateDir(): string {
  return path.join(OPENCLAW_STATE_DIR, "openclaw-zaloclawbot");
}

async function configuredAccountIds(): Promise<string[]> {
  let indexed: unknown;
  try {
    indexed = JSON.parse(
      await fs.readFile(path.join(clawBotStateDir(), "accounts.json"), "utf8"),
    ) as unknown;
  } catch {
    return [];
  }
  if (!Array.isArray(indexed)) return [];

  const configured: string[] = [];
  for (const accountId of indexed) {
    if (typeof accountId !== "string" || !accountId.trim()) continue;
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(accountId)) continue;
    try {
      const raw = JSON.parse(
        await fs.readFile(
          path.join(clawBotStateDir(), "accounts", `${accountId}.json`),
          "utf8",
        ),
      ) as unknown;
      if (isRecord(raw) && readString(raw.botToken)) configured.push(accountId);
    } catch {
      // Ignore stale index entries; the official plugin does the same.
    }
  }
  return configured;
}

export async function getClawBotConfig(): Promise<ClawBotConfigView> {
  const accountIds = await configuredAccountIds();
  const config = await readConfig();
  const channel = config.channels?.["openclaw-zaloclawbot"];
  return {
    configured: accountIds.length > 0,
    enabled: accountIds.length > 0 && channel?.enabled !== false,
    accountIds,
  };
}

export async function getClawBotStatus(
  _options: { force?: boolean } = {},
): Promise<ClawBotStatus> {
  const config = await getClawBotConfig();
  const base: ClawBotStatus = {
    ...config,
    state: config.configured ? (config.enabled ? "configured" : "disabled") : "not_configured",
    connected: false,
    running: false,
    lastError: null,
  };
  if (!config.configured || !config.enabled) return base;

  // The plugin exposes account registration but no reliable probe payload.
  // A full channels.status call also waits on unrelated channel proxies, so
  // use the successful QR login registration as this channel's live evidence.
  return {
    ...base,
    state: "connected",
    connected: true,
    running: true,
    lastError: null,
  };
}

export async function setClawBotEnabled(enabled: boolean): Promise<ClawBotConfigView> {
  await updateConfig((config) => {
    const channels = isRecord(config.channels) ? { ...config.channels } : {};
    const current = isRecord(channels["openclaw-zaloclawbot"])
      ? channels["openclaw-zaloclawbot"]
      : {};
    channels["openclaw-zaloclawbot"] = { ...current, enabled };
    config.channels = channels;
  });
  await restartGateway();
  return getClawBotConfig();
}

function isClawBotPluginEnabled(config: OpenClawConfig): boolean {
  const plugins = isRecord(config.plugins) ? config.plugins : null;
  const entries = plugins && isRecord(plugins.entries) ? plugins.entries : null;
  const entry = entries && isRecord(entries["openclaw-zaloclawbot"])
    ? entries["openclaw-zaloclawbot"]
    : null;
  return entry?.enabled === true;
}

async function hasInstalledClawBotPlugin(): Promise<boolean> {
  try {
    const projectsDir = path.join(OPENCLAW_STATE_DIR, "npm", "projects");
    const projects = await fs.readdir(projectsDir, { withFileTypes: true });
    for (const project of projects) {
      if (
        !project.isDirectory() ||
        !project.name.startsWith("zalo-platforms-openclaw-zaloclawbot-")
      ) {
        continue;
      }
      try {
        const packagePath = path.join(
          projectsDir,
          project.name,
          "node_modules",
          "@zalo-platforms",
          "openclaw-zaloclawbot",
          "package.json",
        );
        const packageJson = JSON.parse(await fs.readFile(packagePath, "utf8")) as unknown;
        if (isRecord(packageJson) && readString(packageJson.version) === "0.1.4") return true;
      } catch {
        // Ignore stale or incomplete plugin project directories.
      }
    }
  } catch {
    // The CLI fallback below remains authoritative when the local registry is unavailable.
  }
  return false;
}

async function prepareClawBotPluginOnce(): Promise<void> {
  const config = await readConfig();
  if (isClawBotPluginEnabled(config) && await hasInstalledClawBotPlugin()) return;

  let installed = false;
  try {
    const { stdout } = await runOpenClaw(["plugins", "list", "--json"], {
      timeoutMs: 30_000,
    });
    const payload = JSON.parse(stdout) as unknown;
    const plugins = isRecord(payload) && Array.isArray(payload.plugins) ? payload.plugins : [];
    installed = plugins.some(
      (plugin) => isRecord(plugin) && readString(plugin.id) === "openclaw-zaloclawbot",
    );
  } catch {
    // The pinned install command below will provide the actionable error.
  }

  if (!installed) {
    await runOpenClaw(["plugins", "install", CLAWBOT_PLUGIN_SPEC], {
      timeoutMs: 120_000,
    });
  }
  await runOpenClaw(["plugins", "enable", "openclaw-zaloclawbot"], {
    timeoutMs: 60_000,
  });
}

export async function prepareClawBotPlugin(): Promise<void> {
  if (clawBotPluginReady) return;
  if (!clawBotPluginPreparation) {
    clawBotPluginPreparation = prepareClawBotPluginOnce()
      .then(() => {
        clawBotPluginReady = true;
      })
      .finally(() => {
        clawBotPluginPreparation = null;
      });
  }
  await clawBotPluginPreparation;
}

export async function startClawBotQrLogin(): Promise<QrSessionView> {
  return createAsyncQrSession({
    kind: "zalo-clawbot",
    timeoutMs: LOGIN_TIMEOUT_MS,
    start: async (runtime) => {
      runtime.setWaiting("Requesting Zalo login session...");
      const login = await requestClawBotLogin();
      runtime.setQrData(login.loginUrl, "Scan the QR code with Zalo, then keep this page open.");
      const result = await waitForClawBotLogin(login.zbsk, runtime.signal);
      if (!result.connected) {
        if (!runtime.signal.aborted) runtime.setError(result.message);
        return;
      }
      await persistClawBotLogin(result);
      await runtime.finishConnected();
    },
    onConnected: async () => {
      await prepareClawBotPlugin();
      await restartGateway();
    },
  });
}

export function getClawBotQrLogin(
  sessionId: string,
  ownerToken: string,
): QrSessionView | null {
  return getQrSession(sessionId, ownerToken);
}

export function cancelClawBotQrLogin(
  sessionId: string,
  ownerToken: string,
): boolean {
  return cancelQrSession(sessionId, ownerToken);
}
