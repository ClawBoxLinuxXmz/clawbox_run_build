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

const ROOT = path.join(os.tmpdir(), `clawbox-qqbot-${process.pid}-${Date.now()}`);
const STATE = path.join(ROOT, ".openclaw");
const CONFIG = path.join(STATE, "openclaw.json");
const APP_ID = "1023456789";
const APP_SECRET = "qq-client-secret-1234567890";
let qqbot: typeof import("@/lib/channels/qqbot");

beforeAll(async () => {
  process.env.OPENCLAW_HOME = STATE;
  await fs.mkdir(STATE, { recursive: true });
  vi.resetModules();
  qqbot = await import("@/lib/channels/qqbot");
});

beforeEach(async () => {
  await fs.rm(STATE, { recursive: true, force: true });
  await fs.mkdir(STATE, { recursive: true });
});

afterAll(async () => {
  delete process.env.OPENCLAW_HOME;
  await fs.rm(ROOT, { recursive: true, force: true });
});

describe("QQ Bot credentials and config", () => {
  it("validates AppID and AppSecret with the official token endpoint", async () => {
    const fetcher = vi.fn(async () =>
      new Response(
        JSON.stringify({ access_token: "access-token", expires_in: 7200 }),
        { status: 200 },
      ),
    );

    await qqbot.validateQQBotCredentials(
      { appId: APP_ID, clientSecret: APP_SECRET },
      fetcher as typeof fetch,
    );

    expect(fetcher).toHaveBeenCalledWith(
      "https://bots.qq.com/app/getAppAccessToken",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ appId: APP_ID, clientSecret: APP_SECRET }),
      }),
    );
  });

  it("rejects a platform response without an access token", async () => {
    const fetcher = vi.fn(async () =>
      new Response(JSON.stringify({ code: 11265, message: "invalid appid" }), {
        status: 200,
      }),
    );

    await expect(
      qqbot.validateQQBotCredentials(
        { appId: APP_ID, clientSecret: APP_SECRET },
        fetcher as typeof fetch,
      ),
    ).rejects.toMatchObject({ code: "invalid_credentials" });
  });

  it("writes the OpenClaw QQ Bot schema and never returns the secret", async () => {
    const view = await qqbot.saveQQBotConfig({
      appId: APP_ID,
      clientSecret: APP_SECRET,
      enabled: true,
    });
    const stored = JSON.parse(await fs.readFile(CONFIG, "utf-8"));

    expect(stored.channels.qqbot).toMatchObject({
      enabled: true,
      appId: APP_ID,
      clientSecret: APP_SECRET,
      dmPolicy: "open",
      groupPolicy: "disabled",
      allowFrom: ["*"],
    });
    expect(view).toMatchObject({
      configured: true,
      enabled: true,
      hasClientSecret: true,
      appId: APP_ID,
    });
    expect(JSON.stringify(view)).not.toContain(APP_SECRET);
  });

  it("retains saved credentials when the channel is disabled", async () => {
    await qqbot.saveQQBotConfig({
      appId: APP_ID,
      clientSecret: APP_SECRET,
      enabled: true,
    });
    const view = await qqbot.saveQQBotConfig({ enabled: false });
    const stored = JSON.parse(await fs.readFile(CONFIG, "utf-8"));

    expect(stored.channels.qqbot).toMatchObject({
      enabled: false,
      appId: APP_ID,
      clientSecret: APP_SECRET,
    });
    expect(view).toMatchObject({ configured: true, enabled: false });
  });
});

describe("QQ Bot status parsing", () => {
  it("requires the QQ Bot account to report connected", () => {
    const stored = {
      configured: true,
      enabled: true,
      hasClientSecret: true,
      appId: APP_ID,
    };
    const status = qqbot.parseQQBotStatusPayload(
      {
        gatewayReachable: true,
        channelAccounts: {
          qqbot: [{ running: true, connected: true, lastError: null }],
        },
      },
      stored,
    );

    expect(status).toMatchObject({
      state: "connected",
      connected: true,
      running: true,
      appId: APP_ID,
    });
  });

  it("surfaces the account runtime error", () => {
    const stored = {
      configured: true,
      enabled: true,
      hasClientSecret: true,
      appId: APP_ID,
    };
    const status = qqbot.parseQQBotStatusPayload(
      {
        gatewayReachable: true,
        channelAccounts: {
          qqbot: [{ running: false, connected: false, lastError: "socket closed" }],
        },
      },
      stored,
    );

    expect(status).toMatchObject({
      state: "error",
      connected: false,
      lastError: "socket closed",
    });
  });
});
