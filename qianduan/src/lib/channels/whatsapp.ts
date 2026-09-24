import { execFile } from "child_process";
import path from "path";
import { promisify } from "util";
import { readConfig, restartGateway, updateConfig } from "@/lib/openclaw-config";
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
const DEFAULT_ACCOUNT_ID = "default";
const PLUGIN_COMMAND_TIMEOUT_MS = 120_000;
const STATUS_COMMAND_TIMEOUT_MS = 20_000;
const QR_START_TIMEOUT_MS = 30_000;
const QR_WAIT_TIMEOUT_MS = 15_000;
const QR_DATA_URL_MAX_LENGTH = 16_384;
const COMMAND_ERROR_MAX_LENGTH = 4_000;

export const WHATSAPP_PLUGIN_ID = "whatsapp";
export const WHATSAPP_STATUS_ARGS = [
  "channels",
  "status",
  "--timeout",
  "8000",
  "--json",
] as const;

export type WhatsAppSetupMode = "dedicated" | "personal";
export type WhatsAppChannelState =
  | "not_configured"
  | "disabled"
  | "not_linked"
  | "linked_offline"
  | "connected"
  | "error";
export type WhatsAppErrorCode =
  | "invalid_config"
  | "invalid_owner_number"
  | "invalid_pairing_code"
  | "plugin_unavailable"
  | "gateway_unavailable"
  | "qr_login_failed";

export class WhatsAppChannelError extends Error {
  constructor(
    public readonly code: WhatsAppErrorCode,
    message: string,
    public readonly saved = false,
  ) {
    super(message);
    this.name = "WhatsAppChannelError";
  }
}

export interface WhatsAppConfigView {
  configured: boolean;
  enabled: boolean;
  mode: WhatsAppSetupMode;
  dmPolicy: string;
  groupPolicy: string;
  ownerNumber: string | null;
}

export interface WhatsAppPluginState {
  available: boolean;
  enabled: boolean;
  prepared: boolean;
  status: string | null;
  origin: string | null;
  version: string | null;
  lastError: string | null;
}

export interface WhatsAppPrepareResult {
  prepared: true;
  restarted: boolean;
  changed: boolean;
  config: WhatsAppConfigView;
  plugin: WhatsAppPluginState;
}

export interface WhatsAppQrStartResult {
  connected: boolean;
  qrDataUrl: string | null;
  message: string;
}

export interface WhatsAppQrWaitResult {
  connected: boolean;
  qrDataUrl: string | null;
  message: string;
}

export interface WhatsAppChannelStatus extends WhatsAppConfigView {
  state: WhatsAppChannelState;
  pluginAvailable: boolean | null;
  linked: boolean;
  connected: boolean;
  running: boolean;
  accountId: string | null;
  selfNumber: string | null;
  statusState: string | null;
  healthState: string | null;
  reconnectAttempts: number | null;
  authAgeMs: number | null;
  lastConnectedAt: number | null;
  lastMessageAt: number | null;
  lastError: string | null;
}

export interface WhatsAppPairingRequest {
  code: string;
  senderId: string;
  accountId: string | null;
  createdAt: string;
  displayName: string | null;
}

export interface WhatsAppLogoutResult {
  cleared: boolean;
  loggedOut: boolean;
}

export interface OpenClawCommandResult {
  stdout: string;
  stderr?: string;
}

export type OpenClawRunner = (
  args: readonly string[],
  timeoutMs: number,
) => Promise<OpenClawCommandResult>;

interface PrepareOptions {
  runner?: OpenClawRunner;
  restart?: () => Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function readBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function channelRecord(
  config: Awaited<ReturnType<typeof readConfig>>,
): Record<string, unknown> {
  const value = config.channels?.whatsapp;
  return isRecord(value) ? value : {};
}

function configView(channel: Record<string, unknown>): WhatsAppConfigView {
  const configured = Object.keys(channel).length > 0;
  const allowFrom = Array.isArray(channel.allowFrom)
    ? channel.allowFrom.map(readString).filter((value): value is string => Boolean(value))
    : [];

  return {
    configured,
    enabled: configured && channel.enabled !== false,
    mode: channel.selfChatMode === true ? "personal" : "dedicated",
    dmPolicy: readString(channel.dmPolicy) || "pairing",
    groupPolicy: readString(channel.groupPolicy) || "disabled",
    ownerNumber: allowFrom.find((value) => value !== "*") || null,
  };
}

function normalizeOwnerNumber(value: string): string {
  const normalized = value.trim().replace(/[\s().-]/g, "");
  if (!/^\+[1-9]\d{7,14}$/.test(normalized)) {
    throw new WhatsAppChannelError(
      "invalid_owner_number",
      "Enter the WhatsApp owner number in E.164 format, for example +8613800000000.",
    );
  }
  return normalized;
}

function normalizeAccountId(value?: string): string {
  const accountId = value?.trim() || DEFAULT_ACCOUNT_ID;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(accountId)) {
    throw new WhatsAppChannelError(
      "invalid_config",
      "The WhatsApp account ID format is invalid.",
    );
  }
  return accountId;
}

function clampTimeout(
  value: number | undefined,
  fallback: number,
  maximum: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(1_000, Math.floor(value)));
}

export function sanitizeWhatsAppError(message: string): string {
  const sanitized = message
    .replace(
      /data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=_-]+/gi,
      "[redacted WhatsApp QR]",
    )
    .replace(/\u001b\[[0-?]*[ -\/]*[@-~]/g, "")
    .trim();
  if (sanitized.length <= COMMAND_ERROR_MAX_LENGTH) return sanitized;
  return `${sanitized.slice(0, COMMAND_ERROR_MAX_LENGTH)}...`;
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof WhatsAppChannelError) return error.message;
  if (isRecord(error)) {
    const output = [readString(error.stderr), readString(error.stdout)].filter(
      (value): value is string => Boolean(value),
    );
    if (output.length > 0) return sanitizeWhatsAppError(output.join("\n"));

    if (
      error.killed === true ||
      error.code === "ETIMEDOUT" ||
      error.signal === "SIGTERM"
    ) {
      return "OpenClaw command was terminated before it returned a diagnostic response. Check the Gateway status and logs, then retry.";
    }
  }
  return sanitizeWhatsAppError(error instanceof Error ? error.message : fallback);
}

function looksLikePluginUnavailable(message: string): boolean {
  return /web login provider is not available|web login is not supported|cannot find package.*(?:baileys|whatsapp)|err_module_not_found|whatsapp plugin.*(?:missing|unavailable|failed)|plugin.*whatsapp.*(?:missing|unavailable|failed)/i.test(
    message,
  );
}

export function getWhatsAppOpenClawEnvironment(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: OPENCLAW_USER_HOME,
    OPENCLAW_HOME: OPENCLAW_STATE_DIR,
    OPENCLAW_STATE_DIR,
    OPENCLAW_CONFIG_PATH,
  };
}

const runOpenClaw: OpenClawRunner = async (args, timeoutMs) => {
  try {
    const { stdout, stderr } = await exec(OPENCLAW_BIN, [...args], {
      timeout: timeoutMs,
      maxBuffer: 2 * 1024 * 1024,
      env: getWhatsAppOpenClawEnvironment(),
      windowsHide: true,
    });
    return { stdout, stderr };
  } catch (error) {
    throw new Error(errorMessage(error, "OpenClaw command failed."));
  }
};

function parseJsonOutput(stdout: string, context: string): unknown {
  try {
    return JSON.parse(stdout);
  } catch {
    throw new WhatsAppChannelError(
      "gateway_unavailable",
      `OpenClaw returned invalid JSON while ${context}.`,
    );
  }
}

export async function getWhatsAppConfig(): Promise<WhatsAppConfigView> {
  return configView(channelRecord(await readConfig()));
}

export async function saveWhatsAppConfig(input: {
  enabled: boolean;
  mode?: WhatsAppSetupMode;
  ownerNumber?: string;
}): Promise<{ config: WhatsAppConfigView; changed: boolean }> {
  let saved: { config: WhatsAppConfigView; changed: boolean } | undefined;
  await updateConfig((config) => {
    const channels = isRecord(config.channels) ? { ...config.channels } : {};
    const current = isRecord(channels.whatsapp) ? channels.whatsapp : {};
    const next: Record<string, unknown> = {
      ...current,
      enabled: input.enabled,
      dmPolicy: readString(current.dmPolicy) || "pairing",
      groupPolicy: readString(current.groupPolicy) || "disabled",
    };

    if (input.mode === "dedicated") {
      next.selfChatMode = false;
      next.dmPolicy = "pairing";
      delete next.allowFrom;
    } else if (input.mode === "personal") {
      const existingOwner = configView(current).ownerNumber;
      const ownerNumber = input.ownerNumber
        ? normalizeOwnerNumber(input.ownerNumber)
        : existingOwner;
      if (!ownerNumber) {
        throw new WhatsAppChannelError(
          "invalid_owner_number",
          "Your WhatsApp number is required when using personal-number mode.",
        );
      }
      next.selfChatMode = true;
      next.dmPolicy = "allowlist";
      next.allowFrom = [ownerNumber];
    } else if (input.ownerNumber !== undefined) {
      throw new WhatsAppChannelError(
        "invalid_config",
        "ownerNumber can only be set with personal-number mode.",
      );
    }

    const changed = JSON.stringify(current) !== JSON.stringify(next);
    if (changed) {
      channels.whatsapp = next;
      config.channels = channels;
    }
    saved = { config: configView(next), changed };
  });

  return saved as { config: WhatsAppConfigView; changed: boolean };
}

export function parseWhatsAppPluginListPayload(
  payload: unknown,
): WhatsAppPluginState {
  const plugins = isRecord(payload) && Array.isArray(payload.plugins)
    ? payload.plugins
    : [];
  const plugin = plugins.find(
    (value) => isRecord(value) && readString(value.id) === WHATSAPP_PLUGIN_ID,
  );
  if (!isRecord(plugin)) {
    return {
      available: false,
      enabled: false,
      prepared: false,
      status: null,
      origin: null,
      version: null,
      lastError: "The bundled WhatsApp plugin is not available in this OpenClaw installation.",
    };
  }

  const status = readString(plugin.status);
  const enabled = plugin.enabled === true;
  const diagnostic =
    readString(plugin.error) ||
    readString(plugin.lastError) ||
    (Array.isArray(plugin.diagnostics)
      ? plugin.diagnostics
          .map((value) => (isRecord(value) ? readString(value.message) : null))
          .find((value): value is string => Boolean(value)) || null
      : null);

  return {
    available: true,
    enabled,
    prepared: enabled && status === "loaded",
    status,
    origin: readString(plugin.origin),
    version: readString(plugin.version),
    lastError: diagnostic ? sanitizeWhatsAppError(diagnostic) : null,
  };
}

export async function inspectWhatsAppPlugin(
  runner: OpenClawRunner = runOpenClaw,
): Promise<WhatsAppPluginState> {
  let result: OpenClawCommandResult;
  try {
    result = await runner(
      ["plugins", "list", "--json"],
      PLUGIN_COMMAND_TIMEOUT_MS,
    );
  } catch (error) {
    throw new WhatsAppChannelError(
      "plugin_unavailable",
      `Unable to inspect the bundled WhatsApp plugin: ${errorMessage(error, "OpenClaw plugin inspection failed.")}`,
    );
  }

  let payload: unknown;
  try {
    payload = JSON.parse(result.stdout);
  } catch {
    throw new WhatsAppChannelError(
      "plugin_unavailable",
      "OpenClaw returned invalid plugin status while preparing WhatsApp.",
    );
  }
  return parseWhatsAppPluginListPayload(payload);
}

async function enableWhatsAppPlugin(runner: OpenClawRunner): Promise<void> {
  try {
    await runner(
      ["plugins", "enable", WHATSAPP_PLUGIN_ID],
      PLUGIN_COMMAND_TIMEOUT_MS,
    );
  } catch (error) {
    throw new WhatsAppChannelError(
      "plugin_unavailable",
      `The bundled WhatsApp plugin could not be enabled: ${errorMessage(error, "OpenClaw plugin activation failed.")}`,
    );
  }
}

async function installWhatsAppPlugin(runner: OpenClawRunner): Promise<void> {
  try {
    await runner(
      ["plugins", "install", "@openclaw/whatsapp"],
      PLUGIN_COMMAND_TIMEOUT_MS,
    );
  } catch (error) {
    throw new WhatsAppChannelError(
      "plugin_unavailable",
      `The WhatsApp runtime could not be installed: ${errorMessage(error, "OpenClaw plugin installation failed.")}`,
    );
  }
}

export async function prepareWhatsAppChannel(
  input: { mode?: WhatsAppSetupMode; ownerNumber?: string },
  options: PrepareOptions = {},
): Promise<WhatsAppPrepareResult> {
  const runner = options.runner || runOpenClaw;
  const restart = options.restart || restartGateway;
  const before = await inspectWhatsAppPlugin(runner);

  if (!before.available) {
    throw new WhatsAppChannelError(
      "plugin_unavailable",
      before.lastError || "The bundled WhatsApp plugin is unavailable.",
    );
  }
  const pluginChanged = !before.prepared;
  if (pluginChanged) {
    try {
      await enableWhatsAppPlugin(runner);
    } catch {
      // Bundled metadata can exist before the on-demand Baileys runtime is installed.
      await installWhatsAppPlugin(runner);
      await enableWhatsAppPlugin(runner);
    }
  }

  const saved = await saveWhatsAppConfig({
    enabled: true,
    mode: input.mode,
    ownerNumber: input.ownerNumber,
  });
  const changed = pluginChanged || saved.changed;

  if (changed) {
    try {
      await restart();
    } catch (error) {
      throw new WhatsAppChannelError(
        "gateway_unavailable",
        `WhatsApp was prepared, but OpenClaw Gateway restart failed: ${errorMessage(error, "unknown error")}`,
        true,
      );
    }
  }

  let plugin: WhatsAppPluginState;
  try {
    plugin = changed ? await inspectWhatsAppPlugin(runner) : before;
  } catch (error) {
    if (!changed) throw error;
    try {
      await installWhatsAppPlugin(runner);
      await enableWhatsAppPlugin(runner);
      await restart();
      plugin = await inspectWhatsAppPlugin(runner);
    } catch (retryError) {
      throw new WhatsAppChannelError(
        "plugin_unavailable",
        errorMessage(
          retryError,
          errorMessage(error, "The WhatsApp runtime is unavailable."),
        ),
        true,
      );
    }
  }
  if (!plugin.available || !plugin.prepared) {
    try {
      await installWhatsAppPlugin(runner);
      await enableWhatsAppPlugin(runner);
      await restart();
      plugin = await inspectWhatsAppPlugin(runner);
    } catch (error) {
      throw new WhatsAppChannelError(
        "plugin_unavailable",
        errorMessage(
          error,
          plugin.lastError ||
            "The bundled WhatsApp plugin is enabled but its runtime is unavailable.",
        ),
        true,
      );
    }
  }
  if (!plugin.available || !plugin.prepared) {
    throw new WhatsAppChannelError(
      "plugin_unavailable",
      plugin.lastError ||
        "The WhatsApp plugin is enabled but its runtime is unavailable.",
      true,
    );
  }

  return {
    prepared: true,
    restarted: changed,
    changed,
    config: saved.config,
    plugin,
  };
}

export async function disableWhatsAppChannel(
  options: Pick<PrepareOptions, "restart"> = {},
): Promise<{ config: WhatsAppConfigView; restarted: boolean }> {
  const saved = await saveWhatsAppConfig({ enabled: false });
  if (saved.changed) {
    try {
      await (options.restart || restartGateway)();
    } catch (error) {
      throw new WhatsAppChannelError(
        "gateway_unavailable",
        `WhatsApp was disabled, but OpenClaw Gateway restart failed: ${errorMessage(error, "unknown error")}`,
        true,
      );
    }
  }
  return { config: saved.config, restarted: saved.changed };
}

async function callGatewayRpc(
  method: string,
  params: Record<string, unknown>,
  timeoutMs: number,
  runner: OpenClawRunner,
): Promise<unknown> {
  try {
    const result = await runner(
      [
        "gateway",
        "call",
        method,
        "--params",
        JSON.stringify(params),
        "--timeout",
        String(timeoutMs),
        "--json",
      ],
      timeoutMs + 15_000,
    );
    return parseJsonOutput(result.stdout, `calling ${method}`);
  } catch (error) {
    if (error instanceof WhatsAppChannelError) throw error;
    const message = errorMessage(error, `Gateway RPC ${method} failed.`);
    throw new WhatsAppChannelError(
      looksLikePluginUnavailable(message)
        ? "plugin_unavailable"
        : "gateway_unavailable",
      message,
    );
  }
}

export async function startWhatsAppQrLogin(
  input: { force?: boolean; accountId?: string; timeoutMs?: number } = {},
  runner: OpenClawRunner = runOpenClaw,
): Promise<WhatsAppQrStartResult> {
  const timeoutMs = clampTimeout(
    input.timeoutMs,
    QR_START_TIMEOUT_MS,
    QR_START_TIMEOUT_MS,
  );
  const payload = await callGatewayRpc(
    "web.login.start",
    {
      accountId: normalizeAccountId(input.accountId),
      force: input.force === true,
      timeoutMs,
    },
    timeoutMs + 5_000,
    runner,
  );
  if (!isRecord(payload)) {
    throw new WhatsAppChannelError(
      "qr_login_failed",
      "OpenClaw returned an invalid WhatsApp QR response.",
    );
  }

  const message = sanitizeWhatsAppError(
    readString(payload.message) || "WhatsApp QR login did not return a message.",
  );
  if (looksLikePluginUnavailable(message)) {
    throw new WhatsAppChannelError("plugin_unavailable", message);
  }
  const qrDataUrl = readQrDataUrl(payload.qrDataUrl);
  if (!qrDataUrl && payload.connected !== true && /^failed\b/i.test(message)) {
    throw new WhatsAppChannelError("qr_login_failed", message);
  }

  return {
    connected: payload.connected === true,
    qrDataUrl,
    message,
  };
}

export async function waitForWhatsAppQrLogin(
  input: {
    accountId?: string;
    timeoutMs?: number;
    currentQrDataUrl?: string;
  } = {},
  runner: OpenClawRunner = runOpenClaw,
): Promise<WhatsAppQrWaitResult> {
  const currentQrDataUrl = input.currentQrDataUrl
    ? readQrDataUrl(input.currentQrDataUrl)
    : null;
  const timeoutMs = clampTimeout(
    input.timeoutMs,
    QR_WAIT_TIMEOUT_MS,
    QR_WAIT_TIMEOUT_MS,
  );
  const payload = await callGatewayRpc(
    "web.login.wait",
    {
      accountId: normalizeAccountId(input.accountId),
      timeoutMs,
      ...(currentQrDataUrl
        ? { currentQrDataUrl }
        : {}),
    },
    timeoutMs + 5_000,
    runner,
  );
  if (!isRecord(payload)) {
    throw new WhatsAppChannelError(
      "qr_login_failed",
      "OpenClaw returned an invalid WhatsApp login status.",
    );
  }

  const message = sanitizeWhatsAppError(
    readString(payload.message) || "WhatsApp login status is unavailable.",
  );
  if (looksLikePluginUnavailable(message)) {
    throw new WhatsAppChannelError("plugin_unavailable", message);
  }
  return {
    connected: payload.connected === true,
    qrDataUrl: readQrDataUrl(payload.qrDataUrl),
    message,
  };
}

function recordAt(
  record: Record<string, unknown> | null,
  key: string,
): Record<string, unknown> | null {
  return record && isRecord(record[key]) ? record[key] : null;
}

function readStatusValue(
  account: Record<string, unknown> | null,
  summary: Record<string, unknown> | null,
  key: string,
): unknown {
  return account?.[key] ?? summary?.[key];
}

function readQrDataUrl(value: unknown): string | null {
  const qrDataUrl = readString(value);
  if (
    qrDataUrl &&
    (qrDataUrl.length > QR_DATA_URL_MAX_LENGTH ||
      !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(qrDataUrl))
  ) {
    throw new WhatsAppChannelError(
      "qr_login_failed",
      "OpenClaw returned an invalid WhatsApp QR image.",
    );
  }
  return qrDataUrl;
}

export function parseWhatsAppStatusPayload(
  payload: unknown,
  stored: WhatsAppConfigView,
): WhatsAppChannelStatus {
  const base: WhatsAppChannelStatus = {
    ...stored,
    state: stored.configured
      ? stored.enabled
        ? "not_linked"
        : "disabled"
      : "not_configured",
    pluginAvailable: null,
    linked: false,
    connected: false,
    running: false,
    accountId: null,
    selfNumber: null,
    statusState: null,
    healthState: null,
    reconnectAttempts: null,
    authAgeMs: null,
    lastConnectedAt: null,
    lastMessageAt: null,
    lastError: null,
  };
  if (!stored.configured || !stored.enabled) return base;
  if (!isRecord(payload)) {
    return {
      ...base,
      state: "error",
      lastError: "OpenClaw returned invalid WhatsApp channel status.",
    };
  }
  if (payload.gatewayReachable === false || payload.configOnly === true) {
    return {
      ...base,
      state: "error",
      lastError: sanitizeWhatsAppError(
        readString(payload.error) || "OpenClaw Gateway is not reachable.",
      ),
    };
  }

  const channels = isRecord(payload.channels) ? payload.channels : null;
  const summary = recordAt(channels, "whatsapp");
  const accountsByChannel = isRecord(payload.channelAccounts)
    ? payload.channelAccounts
    : null;
  const accounts = accountsByChannel?.whatsapp;
  const candidates = Array.isArray(accounts)
    ? accounts.filter(isRecord)
    : [];
  const defaultIds = isRecord(payload.channelDefaultAccountId)
    ? payload.channelDefaultAccountId
    : null;
  const defaultId = readString(defaultIds?.whatsapp);
  const account =
    (defaultId
      ? candidates.find((candidate) => readString(candidate.accountId) === defaultId)
      : null) || candidates[0] || null;

  if (!summary && !account) {
    return {
      ...base,
      state: "error",
      pluginAvailable: false,
      lastError:
        "The WhatsApp plugin is not available in the running OpenClaw Gateway. Prepare WhatsApp and restart Gateway.",
    };
  }

  const linked = readBoolean(readStatusValue(account, summary, "linked")) === true;
  const runtimeConnected =
    readBoolean(readStatusValue(account, summary, "connected")) === true;
  const connected = linked && runtimeConnected;
  const running =
    readBoolean(readStatusValue(account, summary, "running")) === true;
  const statusState = readString(
    readStatusValue(account, summary, "statusState"),
  );
  const healthState = readString(
    readStatusValue(account, summary, "healthState"),
  );
  const rawError = readString(readStatusValue(account, summary, "lastError"));
  const lastError = rawError ? sanitizeWhatsAppError(rawError) : null;
  const self = recordAt(summary, "self") || recordAt(account, "self");
  const severeHealth = new Set([
    "conflict",
    "logged-out",
    "stale",
    "stopped",
  ]);
  let state: WhatsAppChannelState;
  if (!linked) state = statusState === "unstable" ? "error" : "not_linked";
  else if (connected) state = "connected";
  else if (lastError || (healthState && severeHealth.has(healthState))) {
    state = "error";
  } else state = "linked_offline";

  return {
    ...base,
    state,
    pluginAvailable: true,
    linked,
    connected,
    running,
    accountId: readString(account?.accountId),
    selfNumber: readString(self?.e164),
    statusState,
    healthState,
    reconnectAttempts: readNumber(
      readStatusValue(account, summary, "reconnectAttempts"),
    ),
    authAgeMs: readNumber(readStatusValue(account, summary, "authAgeMs")),
    lastConnectedAt: readNumber(
      readStatusValue(account, summary, "lastConnectedAt"),
    ),
    lastMessageAt: readNumber(
      readStatusValue(account, summary, "lastMessageAt"),
    ),
    lastError:
      statusState === "unstable" && !lastError
        ? "WhatsApp auth state is still stabilizing. Retry shortly."
        : lastError,
  };
}

export async function probeWhatsAppChannel(
  runner?: OpenClawRunner,
  options: { force?: boolean } = {},
): Promise<WhatsAppChannelStatus> {
  const stored = await getWhatsAppConfig();
  if (!stored.configured || !stored.enabled) {
    return parseWhatsAppStatusPayload(null, stored);
  }

  let result: OpenClawCommandResult;
  try {
    result = runner
      ? await runner(WHATSAPP_STATUS_ARGS, STATUS_COMMAND_TIMEOUT_MS)
      : { stdout: await getChannelStatusJson(options.force ? { force: true } : undefined) };
  } catch (error) {
    const message = errorMessage(error, "OpenClaw channel status failed.");
    throw new WhatsAppChannelError(
      looksLikePluginUnavailable(message)
        ? "plugin_unavailable"
        : "gateway_unavailable",
      message,
    );
  }
  return parseWhatsAppStatusPayload(
    parseJsonOutput(result.stdout, "checking WhatsApp status"),
    stored,
  );
}

export async function listWhatsAppPairingRequests(
  runner: OpenClawRunner = runOpenClaw,
): Promise<WhatsAppPairingRequest[]> {
  let result: OpenClawCommandResult;
  try {
    result = await runner(
      ["pairing", "list", "whatsapp", "--json"],
      STATUS_COMMAND_TIMEOUT_MS,
    );
  } catch (error) {
    const message = errorMessage(error, "Failed to list WhatsApp pairing requests.");
    throw new WhatsAppChannelError(
      looksLikePluginUnavailable(message)
        ? "plugin_unavailable"
        : "gateway_unavailable",
      message,
    );
  }
  const payload = parseJsonOutput(
    result.stdout,
    "listing WhatsApp pairing requests",
  );
  if (!isRecord(payload) || !Array.isArray(payload.requests)) return [];

  return payload.requests.flatMap((value): WhatsAppPairingRequest[] => {
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
        accountId: readString(value.accountId),
        createdAt,
        displayName: meta
          ? readString(meta.name) || readString(meta.displayName)
          : null,
      },
    ];
  });
}

export async function approveWhatsAppPairing(
  value: string,
  runner: OpenClawRunner = runOpenClaw,
): Promise<void> {
  const code = value.trim();
  if (!/^[A-Za-z0-9_-]{4,64}$/.test(code)) {
    throw new WhatsAppChannelError(
      "invalid_pairing_code",
      "The WhatsApp pairing code format is invalid.",
    );
  }
  try {
    await runner(
      ["pairing", "approve", "whatsapp", code, "--notify"],
      STATUS_COMMAND_TIMEOUT_MS,
    );
  } catch (error) {
    const message = errorMessage(error, "Failed to approve WhatsApp pairing.");
    throw new WhatsAppChannelError(
      looksLikePluginUnavailable(message)
        ? "plugin_unavailable"
        : "gateway_unavailable",
      message,
    );
  }
}

export async function logoutWhatsApp(
  accountId?: string,
  runner: OpenClawRunner = runOpenClaw,
): Promise<WhatsAppLogoutResult> {
  const payload = await callGatewayRpc(
    "channels.logout",
    { channel: "whatsapp", accountId: normalizeAccountId(accountId) },
    STATUS_COMMAND_TIMEOUT_MS,
    runner,
  );
  if (!isRecord(payload)) {
    throw new WhatsAppChannelError(
      "gateway_unavailable",
      "OpenClaw returned an invalid WhatsApp logout response.",
    );
  }
  return {
    cleared: payload.cleared === true,
    loggedOut: payload.loggedOut === true,
  };
}
