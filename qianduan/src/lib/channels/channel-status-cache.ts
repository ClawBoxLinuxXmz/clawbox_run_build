import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

const OPENCLAW_BIN =
  process.env.OPENCLAW_BIN || "/home/clawbox/.npm-global/bin/openclaw";
const OPENCLAW_STATE_DIR =
  process.env.OPENCLAW_STATE_DIR ||
  process.env.OPENCLAW_HOME ||
  "/home/clawbox/.openclaw";
const OPENCLAW_USER_HOME = "/home/clawbox";
const CACHE_FILE = path.join(OPENCLAW_STATE_DIR, "channel-status-cache.json");
const TTL_MS = 8_000;
const MAX_FILE_AGE_MS = 5 * 60_000;
const FILE_FUTURE_SKEW_MS = 60_000;

export const CHANNEL_STATUS_ARGS = [
  "channels",
  "status",
  "--probe",
  "--timeout",
  "8000",
  "--json",
] as const;

export interface ChannelStatusCommandResult {
  stdout: string;
  stderr?: string;
}

export type ChannelStatusCommandRunner = (
  executable: string,
  args: readonly string[],
  options?: { timeoutMs?: number; env?: NodeJS.ProcessEnv },
) => Promise<ChannelStatusCommandResult>;

export interface ChannelStatusCacheOptions {
  force?: boolean;
  channelId?: string;
  runner?: ChannelStatusCommandRunner;
}

interface CacheEntry {
  json: string;
  at: number;
}

interface FileCacheEntry extends CacheEntry {
  ageMs: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCacheableStatusJson(json: string): boolean {
  try {
    const value = JSON.parse(json) as unknown;
    if (!isRecord(value)) return false;
    return value.gatewayReachable !== false && value.configOnly !== true;
  } catch {
    return false;
  }
}

let memoryEntry: CacheEntry | null = null;
let inFlight: { generation: number; promise: Promise<string> } | null = null;
let generation = 0;
let invalidatedAt = 0;

function cliEnvironment(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: OPENCLAW_USER_HOME,
    OPENCLAW_HOME: OPENCLAW_USER_HOME,
    OPENCLAW_STATE_DIR,
    OPENCLAW_CONFIG_PATH: path.join(OPENCLAW_STATE_DIR, "openclaw.json"),
  };
}

const defaultRunner: ChannelStatusCommandRunner = async (
  executable,
  args,
  options,
) => {
  const result = await exec(executable, [...args], {
    timeout: options?.timeoutMs ?? 45_000,
    maxBuffer: 2 * 1024 * 1024,
    env: options?.env ?? process.env,
    windowsHide: true,
  });
  return { stdout: result.stdout, stderr: result.stderr };
};

function parseFileCache(raw: string): FileCacheEntry | null {
  try {
    const parsed = JSON.parse(raw) as { json?: unknown; at?: unknown };
    if (typeof parsed.json !== "string" || typeof parsed.at !== "number") {
      return null;
    }
    if (!Number.isFinite(parsed.at)) return null;
    const value = JSON.parse(parsed.json) as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    // A Gateway timeout is a transient observation, not a usable status snapshot.
    if (!isCacheableStatusJson(parsed.json)) return null;
    if (parsed.at <= invalidatedAt) return null;
    const ageMs = Date.now() - parsed.at;
    if (ageMs < -FILE_FUTURE_SKEW_MS || ageMs > MAX_FILE_AGE_MS) {
      return null;
    }
    return { json: parsed.json, at: parsed.at, ageMs: Math.max(0, ageMs) };
  } catch {
    return null;
  }
}

async function readFileCache(): Promise<FileCacheEntry | null> {
  try {
    return parseFileCache(await fs.readFile(CACHE_FILE, "utf8"));
  } catch {
    return null;
  }
}

async function writeFileCache(entry: CacheEntry): Promise<void> {
  const temporaryPath = `${CACHE_FILE}.${process.pid}.tmp`;
  try {
    await fs.mkdir(path.dirname(CACHE_FILE), { recursive: true });
    await fs.writeFile(
      temporaryPath,
      JSON.stringify({ json: entry.json, at: entry.at }),
      { encoding: "utf8", mode: 0o600 },
    );
    await fs.rename(temporaryPath, CACHE_FILE);
    await fs.chmod(CACHE_FILE, 0o600);
  } catch {
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
  }
}

async function runStatus(
  runner: ChannelStatusCommandRunner,
  expectedGeneration: number,
  channelId?: string,
): Promise<string> {
  const args = channelId
    ? [...CHANNEL_STATUS_ARGS, "--channel", channelId]
    : CHANNEL_STATUS_ARGS;
  const result = await runner(OPENCLAW_BIN, args, {
    timeoutMs: 45_000,
    env: cliEnvironment(),
  });
  const json = result.stdout.trim();
  if (!json) throw new Error("OpenClaw returned an empty channel status response.");

  try {
    JSON.parse(json);
  } catch {
    throw new Error("OpenClaw returned invalid JSON while checking channel status.");
  }

  // Do not make a short Gateway restart look like a persistent channel failure.
  if (!isCacheableStatusJson(json)) return json;

  const entry = { json, at: Date.now() };
  if (!channelId && expectedGeneration === generation) {
    memoryEntry = entry;
    await writeFileCache(entry);
  }
  return json;
}

function startRefresh(runner: ChannelStatusCommandRunner): Promise<string> {
  if (inFlight?.generation === generation) return inFlight.promise;

  const expectedGeneration = generation;
  const promise = runStatus(runner, expectedGeneration).finally(() => {
    if (inFlight?.promise === promise) inFlight = null;
  });
  inFlight = { generation: expectedGeneration, promise };
  return promise;
}

export async function getChannelStatusJson(
  options: ChannelStatusCacheOptions = {},
): Promise<string> {
  const runner = options.runner ?? defaultRunner;
  if (options.channelId) {
    return runStatus(runner, generation, options.channelId);
  }
  if (options.force) return startRefresh(runner);

  const now = Date.now();
  if (memoryEntry) {
    if (!isCacheableStatusJson(memoryEntry.json)) {
      memoryEntry = null;
      return startRefresh(runner);
    }
    if (now - memoryEntry.at < TTL_MS) return memoryEntry.json;
    void startRefresh(runner).catch(() => {});
    return memoryEntry.json;
  }

  const fileEntry = await readFileCache();
  if (fileEntry) {
    memoryEntry = { json: fileEntry.json, at: fileEntry.at };
    if (fileEntry.ageMs >= TTL_MS) void startRefresh(runner).catch(() => {});
    return fileEntry.json;
  }

  return startRefresh(runner);
}

export function invalidateChannelStatusCache(): void {
  generation += 1;
  invalidatedAt = Date.now();
  memoryEntry = null;
  inFlight = null;
  void fs.rm(CACHE_FILE, { force: true }).catch(() => {});
}

export function warmChannelStatusCache(): void {
  void startRefresh(defaultRunner).catch(() => {});
}
