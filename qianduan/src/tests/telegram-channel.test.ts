import fs from "fs/promises";
import os from "os";
import path from "path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const TEST_ROOT = path.join(
  os.tmpdir(),
  `clawbox-telegram-channel-${process.pid}-${Date.now()}`,
);
const OPENCLAW_HOME = path.join(TEST_ROOT, ".openclaw");
const CONFIG_PATH = path.join(OPENCLAW_HOME, "openclaw.json");
const VALID_TOKEN = "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcd";

let telegram: typeof import("@/lib/channels/telegram");

beforeAll(async () => {
  process.env.OPENCLAW_HOME = OPENCLAW_HOME;
  await fs.mkdir(OPENCLAW_HOME, { recursive: true });
  vi.resetModules();
  telegram = await import("@/lib/channels/telegram");
});

beforeEach(async () => {
  await fs.rm(OPENCLAW_HOME, { recursive: true, force: true });
  await fs.mkdir(OPENCLAW_HOME, { recursive: true });
});

afterAll(async () => {
  delete process.env.OPENCLAW_HOME;
  await fs.rm(TEST_ROOT, { recursive: true, force: true });
});

describe("Telegram token validation", () => {
  it("validates a BotFather token with Telegram getMe", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          ok: true,
          result: {
            id: 123456789,
            is_bot: true,
            first_name: "ClawBox",
            username: "clawbox_test_bot",
          },
        }),
        { status: 200 },
      ),
    );

    const identity = await telegram.validateTelegramBotToken(
      VALID_TOKEN,
      fetchMock as typeof fetch,
    );

    expect(identity).toEqual({
      id: "123456789",
      username: "clawbox_test_bot",
      firstName: "ClawBox",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed tokens before making a network request", async () => {
    const fetchMock = vi.fn();

    await expect(
      telegram.validateTelegramBotToken("not-a-token", fetchMock as typeof fetch),
    ).rejects.toMatchObject({ code: "invalid_token" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps Telegram authentication rejection to invalid_token", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ ok: false, description: "Unauthorized" }), {
        status: 401,
      }),
    );

    await expect(
      telegram.validateTelegramBotToken(VALID_TOKEN, fetchMock as typeof fetch),
    ).rejects.toMatchObject({ code: "invalid_token" });
  });
});

describe("Telegram OpenClaw config", () => {
  it("points OpenClaw CLI commands at the same state and config paths", () => {
    const env = telegram.getTelegramOpenClawEnvironment();

    expect(env.OPENCLAW_STATE_DIR).toBe(OPENCLAW_HOME);
    expect(env.OPENCLAW_CONFIG_PATH).toBe(CONFIG_PATH);
    expect(env.OPENCLAW_HOME).toBe(OPENCLAW_HOME);
    expect(env.HOME).toBe("/home/clawbox");
    expect(env.OPENCLAW_HOME).not.toBe(env.HOME);
  });

  it("writes the verified OpenClaw Telegram schema without exposing the token", async () => {
    const view = await telegram.saveTelegramConfig({
      botToken: VALID_TOKEN,
      enabled: true,
    });
    const stored = JSON.parse(await fs.readFile(CONFIG_PATH, "utf-8"));

    expect(stored.channels.telegram).toEqual({
      enabled: true,
      dmPolicy: "pairing",
      groupPolicy: "disabled",
      botToken: VALID_TOKEN,
    });
    expect(view).toEqual({
      configured: true,
      enabled: true,
      hasToken: true,
      dmPolicy: "pairing",
      groupPolicy: "disabled",
    });
    expect(JSON.stringify(view)).not.toContain(VALID_TOKEN);
  });

  it("retains the saved token when only the enabled flag changes", async () => {
    await telegram.saveTelegramConfig({ botToken: VALID_TOKEN, enabled: true });
    await telegram.saveTelegramConfig({ enabled: false });
    const stored = JSON.parse(await fs.readFile(CONFIG_PATH, "utf-8"));

    expect(stored.channels.telegram.botToken).toBe(VALID_TOKEN);
    expect(stored.channels.telegram.enabled).toBe(false);
    expect(await telegram.getTelegramConfig()).toMatchObject({
      configured: true,
      enabled: false,
      hasToken: true,
    });
  });
});

describe("Telegram status parsing", () => {
  const stored = {
    configured: true,
    enabled: true,
    hasToken: true,
    dmPolicy: "pairing",
    groupPolicy: "disabled",
  };

  it("uses the channel-status flags supported by OpenClaw", () => {
    expect(telegram.TELEGRAM_STATUS_ARGS).toEqual([
      "channels",
      "status",
      "--probe",
      "--timeout",
      "8000",
      "--json",
    ]);
    expect(telegram.TELEGRAM_STATUS_ARGS).not.toContain("--channel");
  });

  it("requires a running account and successful probe before reporting connected", () => {
    const status = telegram.parseTelegramStatusPayload(
      {
        gatewayReachable: true,
        channelAccounts: {
          telegram: [
            {
              running: true,
              connected: false,
              probe: {
                ok: true,
                bot: { id: 123456789, username: "clawbox_test_bot" },
              },
            },
          ],
        },
      },
      stored,
    );

    expect(status).toMatchObject({
      state: "connected",
      connected: true,
      running: true,
      probeOk: true,
      botId: "123456789",
      botUsername: "clawbox_test_bot",
    });
  });

  it("reports gateway fallback as an error and redacts token-shaped values", () => {
    const status = telegram.parseTelegramStatusPayload(
      {
        gatewayReachable: false,
        configOnly: true,
        error: `failed near /bot${VALID_TOKEN}`,
      },
      stored,
    );

    expect(status.state).toBe("error");
    expect(status.lastError).toContain("[redacted]");
    expect(status.lastError).not.toContain(VALID_TOKEN);
  });
});
