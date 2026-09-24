import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

type StatusGet = (request?: Request) => Promise<Response>;
type RequestPost = (request: Request) => Promise<Response>;

const mocks = {
  getAll: vi.fn(),
  setMany: vi.fn(),
  getDiscordStatus: vi.fn(),
  getZaloStatus: vi.fn(),
  getClawBotStatus: vi.fn(),
  getZaloPersonalStatus: vi.fn(),
  getSignalStatus: vi.fn(),
  getZaloBotToken: vi.fn(),
  getZaloConfig: vi.fn(),
  prepareZaloPlugin: vi.fn(),
  restartZaloGateway: vi.fn(),
  saveZaloConfig: vi.fn(),
  validateZaloBotToken: vi.fn(),
  getZaloPersonalConfig: vi.fn(),
  saveZaloPersonalConfig: vi.fn(),
  disableZaloPersonalConfig: vi.fn(),
  restartGateway: vi.fn(),
};

let discordStatusGet: StatusGet;
let zaloStatusGet: StatusGet;
let clawBotStatusGet: StatusGet;
let personalStatusGet: StatusGet;
let signalStatusGet: StatusGet;
let zaloConfigPost: RequestPost;
let personalConfigPost: RequestPost;
let personalConfigPatch: () => Promise<Response>;

function jsonRequest(body: unknown): Request {
  return new Request("http://localhost/setup", {
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
  vi.doMock("@/lib/channels/discord", () => ({ getDiscordStatus: mocks.getDiscordStatus }));
  vi.doMock("@/lib/channels/zalo", () => ({
    getZaloBotToken: mocks.getZaloBotToken,
    getZaloConfig: mocks.getZaloConfig,
    getZaloStatus: mocks.getZaloStatus,
    prepareZaloPlugin: mocks.prepareZaloPlugin,
    restartZaloGateway: mocks.restartZaloGateway,
    saveZaloConfig: mocks.saveZaloConfig,
    validateZaloBotToken: mocks.validateZaloBotToken,
  }));
  vi.doMock("@/lib/channels/zalo-clawbot", () => ({ getClawBotStatus: mocks.getClawBotStatus }));
  vi.doMock("@/lib/channels/zalouser", () => ({
    disableZaloPersonalConfig: mocks.disableZaloPersonalConfig,
    getZaloPersonalConfig: mocks.getZaloPersonalConfig,
    getZaloPersonalStatus: mocks.getZaloPersonalStatus,
    saveZaloPersonalConfig: mocks.saveZaloPersonalConfig,
  }));
  vi.doMock("@/lib/channels/signal", () => ({ getSignalStatus: mocks.getSignalStatus }));
  vi.doMock("@/lib/openclaw-config", () => ({ restartGateway: mocks.restartGateway }));

  ({ GET: discordStatusGet } = await import("@/app/setup-api/channels/discord/status/route"));
  ({ GET: zaloStatusGet } = await import("@/app/setup-api/channels/zalo/status/route"));
  ({ GET: clawBotStatusGet } = await import("@/app/setup-api/channels/zalo-clawbot/status/route"));
  ({ GET: personalStatusGet } = await import("@/app/setup-api/channels/zalouser/status/route"));
  ({ GET: signalStatusGet } = await import("@/app/setup-api/channels/signal/status/route"));
  ({ POST: zaloConfigPost } = await import("@/app/setup-api/channels/zalo/route"));
  ({ POST: personalConfigPost, PATCH: personalConfigPatch } = await import("@/app/setup-api/channels/zalouser/route"));
});

beforeEach(() => {
  Object.values(mocks).forEach((mock) => mock.mockReset());
  mocks.getAll.mockResolvedValue({ ai_model_configured: true });
  mocks.setMany.mockResolvedValue(undefined);
  mocks.getDiscordStatus.mockResolvedValue({ state: "connected", connected: true, running: true });
  mocks.getZaloStatus.mockResolvedValue({ state: "connected", connected: true, running: true });
  mocks.getClawBotStatus.mockResolvedValue({ state: "connected", connected: true, running: true });
  mocks.getZaloPersonalStatus.mockResolvedValue({ state: "connected", connected: true, running: true });
  mocks.getSignalStatus.mockResolvedValue({ state: "connected", connected: true, running: true });
  mocks.getZaloBotToken.mockResolvedValue("123456789:existing_secret");
  mocks.getZaloConfig.mockResolvedValue({ configured: true, enabled: true, hasToken: true });
  mocks.prepareZaloPlugin.mockResolvedValue(undefined);
  mocks.restartZaloGateway.mockResolvedValue(undefined);
  mocks.saveZaloConfig.mockResolvedValue({ configured: true, enabled: true, hasToken: true });
  mocks.validateZaloBotToken.mockResolvedValue({ id: "42", name: "ClawBox" });
  mocks.getZaloPersonalConfig.mockResolvedValue({ configured: true, enabled: true, riskAccepted: true });
  mocks.saveZaloPersonalConfig.mockResolvedValue({ configured: true, enabled: false, riskAccepted: true });
  mocks.disableZaloPersonalConfig.mockResolvedValue({ configured: true, enabled: false, riskAccepted: true });
  mocks.restartGateway.mockResolvedValue(undefined);
});

afterAll(() => {
  vi.doUnmock("@/lib/config-store");
  vi.doUnmock("@/lib/channels/discord");
  vi.doUnmock("@/lib/channels/zalo");
  vi.doUnmock("@/lib/channels/zalo-clawbot");
  vi.doUnmock("@/lib/channels/zalouser");
  vi.doUnmock("@/lib/channels/signal");
  vi.doUnmock("@/lib/openclaw-config");
});

describe("additional channel status routes", () => {
  it("passes force refresh to all five live status probes", async () => {
    const cases: Array<{ route: StatusGet; probe: ReturnType<typeof vi.fn> }> = [
      { route: discordStatusGet, probe: mocks.getDiscordStatus },
      { route: zaloStatusGet, probe: mocks.getZaloStatus },
      { route: clawBotStatusGet, probe: mocks.getClawBotStatus },
      { route: personalStatusGet, probe: mocks.getZaloPersonalStatus },
      { route: signalStatusGet, probe: mocks.getSignalStatus },
    ];

    for (const { route, probe } of cases) {
      const response = await route(new Request("http://localhost/status?force=1"));
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect((await response.json()).connected).toBe(true);
      if (probe === mocks.getZaloStatus) {
        expect(probe).toHaveBeenCalledWith(undefined, { force: true });
      } else {
        expect(probe).toHaveBeenCalledWith({ force: true });
      }
    }
  });

  it("returns a sanitized 502 error when a live probe fails", async () => {
    mocks.getSignalStatus.mockRejectedValueOnce(new Error("signal-cli unavailable"));

    const response = await signalStatusGet(new Request("http://localhost/status"));
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({
      state: "error",
      connected: false,
      lastError: "signal-cli unavailable",
    });
  });
});

describe("additional channel config routes", () => {
  it("prepares the Zalo plugin before enabling an existing token", async () => {
    const response = await zaloConfigPost(jsonRequest({ enabled: true }));

    expect(response.status).toBe(200);
    expect(mocks.validateZaloBotToken).not.toHaveBeenCalled();
    expect(mocks.prepareZaloPlugin.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.saveZaloConfig.mock.invocationCallOrder[0],
    );
    expect(mocks.restartZaloGateway).toHaveBeenCalledOnce();
  });

  it("restarts Gateway after saving and disabling Zalo Personal", async () => {
    const saveResponse = await personalConfigPost(
      jsonRequest({ enabled: false, riskAccepted: true }),
    );
    expect(saveResponse.status).toBe(200);
    expect(mocks.saveZaloPersonalConfig).toHaveBeenCalledWith({ enabled: false, riskAccepted: true });
    expect(mocks.restartGateway).toHaveBeenCalledOnce();

    mocks.restartGateway.mockClear();
    const disableResponse = await personalConfigPatch();
    expect(disableResponse.status).toBe(200);
    expect(mocks.disableZaloPersonalConfig).toHaveBeenCalledOnce();
    expect(mocks.restartGateway).toHaveBeenCalledOnce();
  });
});
