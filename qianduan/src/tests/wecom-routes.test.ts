import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

type RouteGet = () => Promise<Response>;
type RoutePost = (request: Request) => Promise<Response>;

const mocks = {
  getAll: vi.fn(),
  setMany: vi.fn(),
  getConfig: vi.fn(),
  getCredentials: vi.fn(),
  setChannelConfig: vi.fn(),
  probe: vi.fn(),
};

let configGet: RouteGet;
let configPost: RoutePost;
let statusGet: RouteGet;

function request(body: unknown): Request {
  return new Request("http://localhost/setup-api/channels/wecom", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  vi.resetModules();
  vi.doMock("@/lib/config-store", () => ({
    getAll: mocks.getAll,
    setMany: mocks.setMany,
  }));
  vi.doMock("@/lib/channels-config", () => ({
    setChannelConfig: mocks.setChannelConfig,
  }));
  vi.doMock("@/lib/channels/wecom", () => ({
    getWeComConfig: mocks.getConfig,
    getWeComCredentials: mocks.getCredentials,
    probeWeComChannel: mocks.probe,
  }));

  ({ GET: configGet, POST: configPost } = await import(
    "@/app/setup-api/channels/wecom/route"
  ));
  ({ GET: statusGet } = await import(
    "@/app/setup-api/channels/wecom/status/route"
  ));
});

beforeEach(() => {
  Object.values(mocks).forEach((mock) => mock.mockReset());
  mocks.getAll.mockResolvedValue({ ai_model_configured: true });
  mocks.setMany.mockResolvedValue(undefined);
  mocks.getConfig.mockResolvedValue({
    configured: false,
    enabled: false,
    hasSecret: false,
    botId: null,
    connectionMode: "websocket",
  });
  mocks.getCredentials.mockResolvedValue({ botId: null, secret: null });
  mocks.setChannelConfig.mockResolvedValue({});
  mocks.probe.mockResolvedValue({
    state: "connected",
    configured: true,
    enabled: true,
    connected: true,
    running: true,
    probeOk: true,
    lastError: null,
  });
});

describe("WeCom config route", () => {
  it("blocks setup until the AI provider is configured", async () => {
    mocks.getAll.mockResolvedValue({ wifi_configured: true });

    const response = await configPost(
      request({ botId: "bot-123", secret: "secret-123" }),
    );

    expect(response.status).toBe(409);
    expect(mocks.setChannelConfig).not.toHaveBeenCalled();
  });

  it("requires both Bot ID and Secret when enabling the channel", async () => {
    const response = await configPost(request({ enabled: true }));

    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain("Bot ID");
    expect(mocks.setChannelConfig).not.toHaveBeenCalled();
  });

  it("allows saving a disabled state without credentials", async () => {
    const response = await configPost(request({ enabled: false }));

    expect(response.status).toBe(200);
    expect(mocks.setChannelConfig).toHaveBeenCalledWith("wecom", {
      enabled: false,
      connectionMode: "websocket",
    });
  });

  it("keeps an existing Secret when the form submits it empty", async () => {
    mocks.getCredentials.mockResolvedValue({ botId: "old-bot", secret: "stored-secret" });
    mocks.getConfig.mockResolvedValue({
      configured: true,
      enabled: true,
      hasSecret: true,
      botId: "new-bot",
      connectionMode: "websocket",
    });

    const response = await configPost(
      request({ botId: "new-bot", secret: "", enabled: true }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mocks.setChannelConfig).toHaveBeenCalledWith("wecom", {
      enabled: true,
      connectionMode: "websocket",
      botId: "new-bot",
    });
    expect(JSON.stringify(body)).not.toContain("stored-secret");
    expect(body.connectionMode).toBe("websocket");
  });

  it("does not return a Secret from the config endpoint", async () => {
    mocks.getAll.mockResolvedValue({ ai_model_configured: true, wecom_last_error: null });
    mocks.getConfig.mockResolvedValue({
      configured: true,
      enabled: true,
      hasSecret: true,
      botId: "bot-123",
      connectionMode: "websocket",
    });

    const response = await configGet();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).not.toHaveProperty("secret");
    expect(body.hasSecret).toBe(true);
  });
});

describe("WeCom status route", () => {
  it("returns the live status from the probe", async () => {
    const response = await statusGet();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ state: "connected", connected: true });
  });

  it("returns a visible error when status probing fails", async () => {
    mocks.probe.mockRejectedValue(new Error("OpenClaw status command failed."));

    const response = await statusGet();
    const body = await response.json();

    expect(response.status).toBe(502);
    expect(body).toMatchObject({ state: "error", connected: false });
    expect(body.lastError).toContain("OpenClaw status command failed.");
  });
});
