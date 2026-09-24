import fs from "fs/promises";
import os from "os";
import path from "path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

type RouteGet = () => Promise<Response>;
type RoutePost = (request: Request) => Promise<Response>;

const TEST_ROOT = path.join(
  os.tmpdir(),
  `clawbox-telegram-routes-${process.pid}-${Date.now()}`,
);
const DATA_DIR = path.join(TEST_ROOT, "data");
const CONFIG_PATH = path.join(DATA_DIR, "config.json");
const VALID_TOKEN = "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcd";

const getTelegramConfigMock = vi.fn();
const getTelegramBotTokenMock = vi.fn();
const validateTelegramBotTokenMock = vi.fn();
const saveTelegramConfigMock = vi.fn();
const waitForTelegramConnectedMock = vi.fn();
const probeTelegramChannelMock = vi.fn();
const listTelegramPairingRequestsMock = vi.fn();
const approveTelegramPairingMock = vi.fn();
const restartGatewayMock = vi.fn();

let configGet: RouteGet;
let configPost: RoutePost;
let statusGet: RouteGet;
let pairingGet: RouteGet;
let pairingPost: RoutePost;

function jsonRequest(body: unknown): Request {
  return new Request("http://localhost/test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function writeSetupConfig(config: Record<string, unknown>): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(CONFIG_PATH, JSON.stringify(config), "utf-8");
}

beforeAll(async () => {
  process.env.CLAWBOX_ROOT = TEST_ROOT;
  await fs.mkdir(DATA_DIR, { recursive: true });
  vi.resetModules();
  vi.doMock("@/lib/channels/telegram", () => ({
    getTelegramConfig: getTelegramConfigMock,
    getTelegramBotToken: getTelegramBotTokenMock,
    validateTelegramBotToken: validateTelegramBotTokenMock,
    saveTelegramConfig: saveTelegramConfigMock,
    waitForTelegramConnected: waitForTelegramConnectedMock,
    probeTelegramChannel: probeTelegramChannelMock,
    listTelegramPairingRequests: listTelegramPairingRequestsMock,
    approveTelegramPairing: approveTelegramPairingMock,
  }));
  vi.doMock("@/lib/openclaw-config", () => ({
    restartGateway: restartGatewayMock,
  }));

  ({ GET: configGet, POST: configPost } = await import("@/app/setup-api/channels/telegram/route"));
  ({ GET: statusGet } = await import("@/app/setup-api/channels/telegram/status/route"));
  ({ GET: pairingGet, POST: pairingPost } = await import("@/app/setup-api/channels/telegram/pairing/route"));
});

beforeEach(async () => {
  for (const mock of [
    getTelegramConfigMock,
    getTelegramBotTokenMock,
    validateTelegramBotTokenMock,
    saveTelegramConfigMock,
    waitForTelegramConnectedMock,
    probeTelegramChannelMock,
    listTelegramPairingRequestsMock,
    approveTelegramPairingMock,
    restartGatewayMock,
  ]) {
    mock.mockReset();
  }
  await fs.rm(DATA_DIR, { recursive: true, force: true });
  await fs.mkdir(DATA_DIR, { recursive: true });

  getTelegramConfigMock.mockResolvedValue({
    configured: false,
    enabled: false,
    hasToken: false,
    dmPolicy: "pairing",
    groupPolicy: "disabled",
  });
  getTelegramBotTokenMock.mockResolvedValue(null);
  validateTelegramBotTokenMock.mockResolvedValue({
    id: "123456789",
    username: "clawbox_test_bot",
    firstName: "ClawBox",
  });
  saveTelegramConfigMock.mockResolvedValue({
    configured: true,
    enabled: true,
    hasToken: true,
    dmPolicy: "pairing",
    groupPolicy: "disabled",
  });
  restartGatewayMock.mockResolvedValue(undefined);
  waitForTelegramConnectedMock.mockResolvedValue({
    state: "connected",
    configured: true,
    enabled: true,
    hasToken: true,
    dmPolicy: "pairing",
    groupPolicy: "disabled",
    connected: true,
    running: true,
    probeOk: true,
    botId: "123456789",
    botUsername: "clawbox_test_bot",
    lastError: null,
  });
  listTelegramPairingRequestsMock.mockResolvedValue([]);
  approveTelegramPairingMock.mockResolvedValue(undefined);
});

afterAll(async () => {
  delete process.env.CLAWBOX_ROOT;
  vi.doUnmock("@/lib/channels/telegram");
  vi.doUnmock("@/lib/openclaw-config");
  await fs.rm(TEST_ROOT, { recursive: true, force: true });
});

describe("Telegram config route", () => {
  it("does not return stored credentials from GET", async () => {
    getTelegramConfigMock.mockResolvedValue({
      configured: true,
      enabled: true,
      hasToken: true,
      dmPolicy: "pairing",
      groupPolicy: "disabled",
    });
    await writeSetupConfig({ telegram_last_error: null });

    const response = await configGet();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.hasToken).toBe(true);
    expect(JSON.stringify(body)).not.toContain("botToken");
    expect(JSON.stringify(body)).not.toContain(VALID_TOKEN);
  });

  it("returns 409 until the AI provider is configured", async () => {
    await writeSetupConfig({ wifi_configured: true });

    const response = await configPost(jsonRequest({ botToken: VALID_TOKEN, enabled: true }));

    expect(response.status).toBe(409);
    expect(validateTelegramBotTokenMock).not.toHaveBeenCalled();
    expect(saveTelegramConfigMock).not.toHaveBeenCalled();
  });

  it("requires a token when enabling an unconfigured bot", async () => {
    await writeSetupConfig({ ai_model_configured: true });

    const response = await configPost(jsonRequest({ enabled: true }));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toContain("Bot Token");
  });

  it("rejects invalid credentials without saving them", async () => {
    await writeSetupConfig({ ai_model_configured: true });
    validateTelegramBotTokenMock.mockRejectedValue(
      Object.assign(new Error("Telegram rejected this Bot Token."), {
        code: "invalid_token",
      }),
    );

    const response = await configPost(jsonRequest({ botToken: VALID_TOKEN, enabled: true }));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.saved).toBe(false);
    expect(saveTelegramConfigMock).not.toHaveBeenCalled();
  });

  it("validates, saves, restarts, and reports a connected bot without echoing the token", async () => {
    await writeSetupConfig({ ai_model_configured: true });

    const response = await configPost(jsonRequest({ botToken: VALID_TOKEN, enabled: true }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.connected).toBe(true);
    expect(validateTelegramBotTokenMock).toHaveBeenCalledWith(VALID_TOKEN);
    expect(saveTelegramConfigMock).toHaveBeenCalledWith({
      botToken: VALID_TOKEN,
      enabled: true,
    });
    expect(restartGatewayMock).toHaveBeenCalledTimes(1);
    expect(waitForTelegramConnectedMock).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(body)).not.toContain(VALID_TOKEN);
  });

  it("returns 502 with saved=true when Gateway restart fails", async () => {
    await writeSetupConfig({ ai_model_configured: true });
    restartGatewayMock.mockRejectedValue(new Error("systemctl denied"));

    const response = await configPost(jsonRequest({ botToken: VALID_TOKEN, enabled: true }));
    const body = await response.json();

    expect(response.status).toBe(502);
    expect(body.saved).toBe(true);
    expect(body.error).toContain("restart failed");
    expect(waitForTelegramConnectedMock).not.toHaveBeenCalled();
  });

  it("returns 502 with saved=true when the channel never becomes online", async () => {
    await writeSetupConfig({ ai_model_configured: true });
    waitForTelegramConnectedMock.mockRejectedValue(
      Object.assign(new Error("Telegram polling did not start"), {
        code: "channel_not_connected",
      }),
    );

    const response = await configPost(jsonRequest({ botToken: VALID_TOKEN, enabled: true }));
    const body = await response.json();

    expect(response.status).toBe(502);
    expect(body.saved).toBe(true);
    expect(body.error).toContain("polling");
  });
});

describe("Telegram status and pairing routes", () => {
  it("returns the live Telegram status", async () => {
    probeTelegramChannelMock.mockResolvedValue({
      state: "connected",
      configured: true,
      enabled: true,
      connected: true,
      running: true,
      probeOk: true,
      botUsername: "clawbox_test_bot",
      botId: "123456789",
      lastError: null,
    });

    const response = await statusGet();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.state).toBe("connected");
    expect(body.botUsername).toBe("clawbox_test_bot");
  });

  it("blocks pairing until Telegram is configured and enabled", async () => {
    const response = await pairingGet();

    expect(response.status).toBe(409);
    expect(listTelegramPairingRequestsMock).not.toHaveBeenCalled();
  });

  it("lists and approves a pending Telegram sender", async () => {
    getTelegramConfigMock.mockResolvedValue({ configured: true, enabled: true });
    listTelegramPairingRequestsMock.mockResolvedValue([
      {
        code: "ABC12345",
        senderId: "99887766",
        createdAt: "2026-07-31T00:00:00.000Z",
        displayName: "Melody",
      },
    ]);

    const listResponse = await pairingGet();
    const listBody = await listResponse.json();
    const approveResponse = await pairingPost(jsonRequest({ code: "ABC12345" }));
    const approveBody = await approveResponse.json();

    expect(listResponse.status).toBe(200);
    expect(listBody.requests).toHaveLength(1);
    expect(approveResponse.status).toBe(200);
    expect(approveBody.approved).toBe(true);
    expect(approveTelegramPairingMock).toHaveBeenCalledWith("ABC12345");
  });
});
