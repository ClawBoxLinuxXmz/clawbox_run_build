import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const ROOT = path.join(os.tmpdir(), `clawbox-status-cache-${process.pid}-${Date.now()}`);
const STATE_DIR = path.join(ROOT, ".openclaw");
const CACHE_FILE = path.join(STATE_DIR, "channel-status-cache.json");
const STATUS_JSON = JSON.stringify({ gatewayReachable: true, channelAccounts: {} });

let cache: typeof import("@/lib/channels/channel-status-cache");

beforeAll(async () => {
  process.env.OPENCLAW_HOME = STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = STATE_DIR;
  await fs.mkdir(STATE_DIR, { recursive: true });
  vi.resetModules();
  cache = await import("@/lib/channels/channel-status-cache");
});

beforeEach(async () => {
  cache.invalidateChannelStatusCache();
  await fs.rm(STATE_DIR, { recursive: true, force: true });
  await fs.mkdir(STATE_DIR, { recursive: true });
});

afterAll(async () => {
  delete process.env.OPENCLAW_HOME;
  delete process.env.OPENCLAW_STATE_DIR;
  await fs.rm(ROOT, { recursive: true, force: true });
});

describe("shared channel status cache", () => {
  it("shares one cold CLI request across concurrent channels", async () => {
    let release!: (value: { stdout: string }) => void;
    const runner = vi.fn(() => new Promise<{ stdout: string }>((resolve) => { release = resolve; }));

    const first = cache.getChannelStatusJson({ force: true, runner });
    const second = cache.getChannelStatusJson({ force: true, runner });
    const third = cache.getChannelStatusJson({ runner });
    expect(runner).toHaveBeenCalledOnce();

    release({ stdout: STATUS_JSON });
    await expect(Promise.all([first, second, third])).resolves.toEqual([
      STATUS_JSON,
      STATUS_JSON,
      STATUS_JSON,
    ]);
  });

  it("uses a channel-specific probe without polluting the shared status cache", async () => {
    const runner = vi.fn(async (_executable, args) => ({
      stdout: JSON.stringify({ gatewayReachable: true, channelAccounts: {} }),
      args,
    }));

    await cache.getChannelStatusJson({ channelId: "openclaw-zaloclawbot", runner });

    expect(runner).toHaveBeenCalledWith(
      expect.any(String),
      [...cache.CHANNEL_STATUS_ARGS, "--channel", "openclaw-zaloclawbot"],
      expect.objectContaining({ timeoutMs: 45_000 }),
    );
    await expect(fs.access(CACHE_FILE)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("forces a new request and invalidation prevents the old result being cached", async () => {
    const runner = vi.fn()
      .mockResolvedValueOnce({ stdout: STATUS_JSON })
      .mockResolvedValueOnce({ stdout: JSON.stringify({ gatewayReachable: true, refreshed: true }) });

    await expect(cache.getChannelStatusJson({ force: true, runner })).resolves.toBe(STATUS_JSON);
    await expect(cache.getChannelStatusJson({ force: true, runner })).resolves.toContain('"refreshed":true');
    expect(runner).toHaveBeenCalledTimes(2);

    const oldRunner = vi.fn(async () => ({ stdout: STATUS_JSON }));
    const oldRequest = cache.getChannelStatusJson({ force: true, runner: oldRunner });
    cache.invalidateChannelStatusCache();
    const newRunner = vi.fn(async () => ({ stdout: JSON.stringify({ gatewayReachable: true, fresh: true }) }));
    await expect(cache.getChannelStatusJson({ force: true, runner: newRunner })).resolves.toContain('"fresh":true');
    await oldRequest;
    expect(newRunner).toHaveBeenCalledOnce();
  });

  it("uses recent file cache data and rejects indefinitely old data", async () => {
    await fs.writeFile(CACHE_FILE, JSON.stringify({ json: STATUS_JSON, at: Date.now() }), "utf8");
    const runner = vi.fn(async () => ({ stdout: JSON.stringify({ gatewayReachable: true, refreshed: true }) }));
    await expect(cache.getChannelStatusJson({ runner })).resolves.toBe(STATUS_JSON);
    expect(runner).not.toHaveBeenCalled();

    cache.invalidateChannelStatusCache();
    await fs.writeFile(CACHE_FILE, JSON.stringify({ json: STATUS_JSON, at: Date.now() - 10 * 60_000 }), "utf8");
    await expect(cache.getChannelStatusJson({ runner })).resolves.toContain('"refreshed":true');
    expect(runner).toHaveBeenCalledOnce();
  });

  it("does not persist a transient Gateway-unavailable response", async () => {
    const unavailable = JSON.stringify({
      gatewayReachable: false,
      configOnly: true,
      error: "gateway timeout",
    });
    const runner = vi.fn()
      .mockResolvedValueOnce({ stdout: unavailable })
      .mockResolvedValueOnce({ stdout: STATUS_JSON });

    await expect(cache.getChannelStatusJson({ force: true, runner })).resolves.toBe(unavailable);
    await expect(fs.access(CACHE_FILE)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(cache.getChannelStatusJson({ runner })).resolves.toBe(STATUS_JSON);
    expect(runner).toHaveBeenCalledTimes(2);
  });
});
