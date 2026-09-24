import fs from "fs/promises";
import os from "os";
import path from "path";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const TEST_ROOT = path.join(
  os.tmpdir(),
  `clawbox-line-channel-${process.pid}-${Date.now()}`,
);
const OPENCLAW_HOME = path.join(TEST_ROOT, ".openclaw");
const CONFIG_PATH = path.join(OPENCLAW_HOME, "openclaw.json");
const CHANNEL_ACCESS_TOKEN =
  "line-channel-access-token-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const CHANNEL_SECRET = "0123456789abcdef0123456789abcdef";

let line: typeof import("@/lib/channels/line");

beforeAll(async () => {
  process.env.OPENCLAW_HOME = OPENCLAW_HOME;
  await fs.mkdir(OPENCLAW_HOME, { recursive: true });
  vi.resetModules();
  line = await import("@/lib/channels/line");
});

beforeEach(async () => {
  await fs.rm(OPENCLAW_HOME, { recursive: true, force: true });
  await fs.mkdir(OPENCLAW_HOME, { recursive: true });
});

afterAll(async () => {
  delete process.env.OPENCLAW_HOME;
  await fs.rm(TEST_ROOT, { recursive: true, force: true });
});

describe("LINE credential validation", () => {
  it("validates the access token with the LINE bot info endpoint", async () => {
    const fetcher = vi.fn(async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      void input;
      void init;
      return new Response(
        JSON.stringify({
          displayName: "ClawBox",
          userId: "U1234567890abcdef1234567890abcdef",
          basicId: "@clawbox",
          pictureUrl: "https://profile.line-scdn.net/example",
        }),
        { status: 200 },
      );
    });

    const identity = await line.validateLineChannelAccessToken(
      CHANNEL_ACCESS_TOKEN,
      fetcher as typeof fetch,
    );

    expect(identity).toEqual({
      displayName: "ClawBox",
      userId: "U1234567890abcdef1234567890abcdef",
      basicId: "@clawbox",
      pictureUrl: "https://profile.line-scdn.net/example",
    });
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe("https://api.line.me/v2/bot/info");
    expect(url).not.toContain(CHANNEL_ACCESS_TOKEN);
    expect(init?.headers).toEqual({
      Authorization: `Bearer ${CHANNEL_ACCESS_TOKEN}`,
    });
    expect(init?.cache).toBe("no-store");
  });

  it("rejects malformed tokens before making a network request", async () => {
    const fetcher = vi.fn();

    await expect(
      line.validateLineChannelAccessToken("short", fetcher as typeof fetch),
    ).rejects.toMatchObject({ code: "invalid_credentials" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("maps LINE authentication rejection to invalid_credentials", async () => {
    const fetcher = vi.fn(async () =>
      new Response(JSON.stringify({ message: "Authentication failed" }), {
        status: 401,
      }),
    );

    await expect(
      line.validateLineChannelAccessToken(
        CHANNEL_ACCESS_TOKEN,
        fetcher as typeof fetch,
      ),
    ).rejects.toMatchObject({ code: "invalid_credentials" });
  });
});

describe("LINE OpenClaw config", () => {
  it("writes the verified schema without returning either credential", async () => {
    const view = await line.saveLineConfig({
      channelAccessToken: CHANNEL_ACCESS_TOKEN,
      channelSecret: CHANNEL_SECRET,
      enabled: true,
    });
    const stored = JSON.parse(await fs.readFile(CONFIG_PATH, "utf-8"));

    expect(stored.channels.line).toEqual({
      enabled: true,
      dmPolicy: "pairing",
      groupPolicy: "disabled",
      webhookPath: "/line/webhook",
      channelAccessToken: CHANNEL_ACCESS_TOKEN,
      channelSecret: CHANNEL_SECRET,
    });
    expect(view).toEqual({
      configured: true,
      enabled: true,
      hasChannelAccessToken: true,
      hasChannelSecret: true,
      dmPolicy: "pairing",
      groupPolicy: "disabled",
      webhookPath: "/line/webhook",
    });
    expect(JSON.stringify(view)).not.toContain(CHANNEL_ACCESS_TOKEN);
    expect(JSON.stringify(view)).not.toContain(CHANNEL_SECRET);
  });

  it("retains credentials while enforcing policies when disabling", async () => {
    await line.saveLineConfig({
      channelAccessToken: CHANNEL_ACCESS_TOKEN,
      channelSecret: CHANNEL_SECRET,
      enabled: true,
    });
    await line.saveLineConfig({ enabled: false });
    const stored = JSON.parse(await fs.readFile(CONFIG_PATH, "utf-8"));

    expect(stored.channels.line).toMatchObject({
      enabled: false,
      channelAccessToken: CHANNEL_ACCESS_TOKEN,
      channelSecret: CHANNEL_SECRET,
      dmPolicy: "pairing",
      groupPolicy: "disabled",
      webhookPath: "/line/webhook",
    });
    expect(await line.getLineConfig()).toMatchObject({
      configured: true,
      enabled: false,
    });
  });

  it("can complete credentials that were saved while disabled", async () => {
    await line.saveLineConfig({
      channelAccessToken: CHANNEL_ACCESS_TOKEN,
      enabled: false,
    });
    const partial = await line.getLineCredentials();

    expect(partial).toEqual({
      channelAccessToken: CHANNEL_ACCESS_TOKEN,
      channelSecret: null,
    });

    await line.saveLineConfig({
      channelSecret: CHANNEL_SECRET,
      enabled: true,
    });
    expect(await line.getLineConfig()).toMatchObject({
      configured: true,
      enabled: true,
    });
  });
});

describe("LINE status parsing", () => {
  const stored = {
    configured: true,
    enabled: true,
    hasChannelAccessToken: true,
    hasChannelSecret: true,
    dmPolicy: "pairing" as const,
    groupPolicy: "disabled" as const,
    webhookPath: "/line/webhook" as const,
  };

  it("uses the supported OpenClaw probe command", () => {
    expect(line.LINE_STATUS_ARGS).toEqual([
      "channels",
      "status",
      "--probe",
      "--timeout",
      "8000",
      "--json",
    ]);
    expect(line.LINE_STATUS_ARGS).not.toContain("--channel");
  });

  it("reports local readiness without claiming a connection", () => {
    const status = line.parseLineStatusPayload(
      {
        channelAccounts: {
          line: [
            {
              running: true,
              lastInboundAt: null,
              probe: {
                ok: true,
                bot: {
                  displayName: "ClawBox",
                  userId: "U1234567890abcdef1234567890abcdef",
                  basicId: "@clawbox",
                },
              },
            },
          ],
        },
      },
      stored,
    );

    expect(status).toMatchObject({
      state: "ready",
      configured: true,
      running: true,
      lastInboundAt: null,
      probe: { ok: true, bot: { displayName: "ClawBox" } },
    });
    expect(status).not.toHaveProperty("connected");
  });

  it("only reports active after a real inbound webhook", () => {
    const status = line.parseLineStatusPayload(
      {
        channelAccounts: {
          line: [
            {
              running: true,
              lastInboundAt: 1_786_000_000_000,
              probe: { ok: true, bot: null },
            },
          ],
        },
      },
      stored,
    );

    expect(status.state).toBe("active");
    expect(status.lastInboundAt).toBe(1_786_000_000_000);
  });

  it("does not treat a zero timestamp sentinel as a real inbound webhook", () => {
    const status = line.parseLineStatusPayload(
      {
        channelAccounts: {
          line: [
            {
              running: true,
              lastInboundAt: 0,
              probe: { ok: true, bot: null },
            },
          ],
        },
      },
      stored,
    );

    expect(status.state).toBe("ready");
    expect(status.lastInboundAt).toBeNull();
  });

  it("redacts stored credentials from gateway errors", () => {
    const status = line.parseLineStatusPayload(
      {
        gatewayReachable: false,
        configOnly: true,
        error: `failed for ${CHANNEL_ACCESS_TOKEN} and ${CHANNEL_SECRET}`,
      },
      stored,
      [CHANNEL_ACCESS_TOKEN, CHANNEL_SECRET],
    );

    expect(status.state).toBe("error");
    expect(status.lastError).toContain("[redacted]");
    expect(status.lastError).not.toContain(CHANNEL_ACCESS_TOKEN);
    expect(status.lastError).not.toContain(CHANNEL_SECRET);
  });
});
