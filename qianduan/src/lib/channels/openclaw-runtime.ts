import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { getChannelStatusJson } from "./channel-status-cache";

const exec = promisify(execFile);

export const OPENCLAW_BIN =
  process.env.OPENCLAW_BIN || "/home/clawbox/.npm-global/bin/openclaw";
export const OPENCLAW_STATE_DIR =
  process.env.OPENCLAW_STATE_DIR ||
  process.env.OPENCLAW_HOME ||
  "/home/clawbox/.openclaw";
export const OPENCLAW_CONFIG_PATH =
  process.env.OPENCLAW_CONFIG_PATH ||
  path.join(OPENCLAW_STATE_DIR, "openclaw.json");
export const OPENCLAW_USER_HOME = "/home/clawbox";
const CLAWBOX_PROXY_RUNTIME_PATH =
  process.env.CLAWBOX_PROXY_RUNTIME_PATH ||
  path.join(process.cwd(), "scripts", "clawbox-proxy-runtime.mjs");

export interface CommandResult {
  stdout: string;
  stderr: string;
}

export type CommandRunner = (
  executable: string,
  args: readonly string[],
  options?: { timeoutMs?: number; env?: NodeJS.ProcessEnv },
) => Promise<CommandResult>;

export function getOpenClawEnvironment(): NodeJS.ProcessEnv {
  const nodeOptions = [
    process.env.NODE_OPTIONS,
    `--import=${CLAWBOX_PROXY_RUNTIME_PATH}`,
  ]
    .filter(Boolean)
    .join(" ");
  return {
    ...process.env,
    HOME: "/home/clawbox",
    OPENCLAW_HOME: OPENCLAW_USER_HOME,
    OPENCLAW_STATE_DIR,
    OPENCLAW_CONFIG_PATH,
    NODE_OPTIONS: nodeOptions,
  };
}

export const runCommand: CommandRunner = async (executable, args, options) => {
  const result = await exec(executable, [...args], {
    timeout: options?.timeoutMs ?? 20_000,
    maxBuffer: 2 * 1024 * 1024,
    windowsHide: true,
    env: options?.env ?? process.env,
  });
  return { stdout: result.stdout, stderr: result.stderr };
};

export async function runOpenClaw(
  args: readonly string[],
  options?: { timeoutMs?: number; runner?: CommandRunner },
): Promise<CommandResult> {
  return (options?.runner ?? runCommand)(OPENCLAW_BIN, args, {
    timeoutMs: options?.timeoutMs,
    env: getOpenClawEnvironment(),
  });
}

export function sanitizeChannelOutput(value: string): string {
  return value
    .replace(/data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=_-]+/gi, "[redacted QR]")
    .replace(/sgnl:\/\/linkdevice\?[^\s]+/gi, "[redacted Signal link]")
    .replace(/([?&]zbsk=)[^&\s]+/gi, "$1[redacted]")
    .replace(/\b\d{5,}:[A-Za-z0-9_-]{16,}\b/g, "[redacted token]")
    .replace(/\u001b\[[0-?]*[ -\/]*[@-~]/g, "")
    .trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

export interface RuntimeChannelStatus {
  state: "configured" | "connected" | "error";
  connected: boolean;
  running: boolean;
  accountId: string | null;
  displayName: string | null;
  lastError: string | null;
}

export function parseRuntimeChannelStatus(
  payload: unknown,
  channelId: string,
): RuntimeChannelStatus {
  const base: RuntimeChannelStatus = {
    state: "configured",
    connected: false,
    running: false,
    accountId: null,
    displayName: null,
    lastError: null,
  };
  if (!isRecord(payload)) return { ...base, state: "error", lastError: "OpenClaw returned invalid channel status." };
  if (payload.gatewayReachable === false || payload.configOnly === true) {
    return { ...base, state: "error", lastError: sanitizeChannelOutput(readString(payload.error) || "OpenClaw Gateway is not reachable.") };
  }
  const channelAccounts = isRecord(payload.channelAccounts) ? payload.channelAccounts : null;
  const rawAccounts = channelAccounts?.[channelId];
  const account = Array.isArray(rawAccounts)
    ? rawAccounts.find(isRecord)
    : isRecord(rawAccounts)
      ? rawAccounts
      : null;
  if (!account) return base;
  const probe = isRecord(account.probe) ? account.probe : null;
  const running = account.running === true;
  const probeOk = probe?.ok === true;
  const lastError = readString(account.lastError) || (probe ? readString(probe.error) : null);
  const connected = account.connected === true || (running && (probeOk || (channelId === "openclaw-zaloclawbot" && !probe && !lastError)));
  return {
    state: connected ? "connected" : lastError || probe?.ok === false ? "error" : "configured",
    connected,
    running,
    accountId: readString(account.accountId),
    displayName: readString(account.name) || readString(account.username),
    lastError: lastError ? sanitizeChannelOutput(lastError) : null,
  };
}

export async function probeOpenClawChannel(
  channelId: string,
  runner?: CommandRunner,
  options: { force?: boolean } = {},
): Promise<RuntimeChannelStatus> {
  try {
    const stdout = runner
      ? (await runOpenClaw(
          ["channels", "status", "--probe", "--timeout", "8000", "--json"],
          { timeoutMs: 15_000, runner },
        )).stdout
      : await getChannelStatusJson({
          force: options.force,
          channelId: channelId === "zalo" ? undefined : channelId,
        });
    return parseRuntimeChannelStatus(JSON.parse(stdout) as unknown, channelId);
  } catch (error) {
    const message = error instanceof Error ? error.message : "OpenClaw status command failed.";
    return { state: "error", connected: false, running: false, accountId: null, displayName: null, lastError: sanitizeChannelOutput(message) };
  }
}
