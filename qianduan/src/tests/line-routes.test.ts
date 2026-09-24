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

type RouteGet = () => Promise<Response>;
type RoutePost = (request: Request) => Promise<Response>;

const TEST_ROOT = path.join(
  os.tmpdir(),
  `clawbox-line-routes-${process.pid}-${Date.now()}`,
);
const DATA_DIR = path.join(TEST_ROOT, "data");
const CONFIG_PATH = path.join(DATA_DIR, "config.json");
const CHANNEL_ACCESS_TOKEN =
  "line-channel-access-token-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const CHANNEL_SECRET = "0123456789abcdef0123456789abcdef";

const mocks = {
  get: vi.fn(),
  credentials: vi.fn(),
  validate: vi.fn(),
  save: vi.fn(),
  parse: vi.fn(),
  wait: vi.fn(),
  probe: vi.fn(),
  list: vi.fn(),
  approve: vi.fn(),
  restart: vi.fn(),
};

let configGet: RouteGet;
let configPost: RoutePost;
let statusGet: RouteGet;
let pairingGet: RouteGet;
let pairingPost: RoutePost;

function request(body: unknown): Request {
  return new Request("http://localhost/test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function setup(config: Record<string, unknown>): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(CONFIG_PATH, JSON.stringify(config), "utf-8");
}

const configView = {
  configured: true,
  enabled: true,
  hasChannelAccessToken: true,
  hasChannelSecret: true,
  dmPolicy: "pairing",
  groupPolicy: "disabled",
  webhookPath: "/line/webhook",
};

const readyStatus = {
  ...configView,
  state: "ready",
  running: true,
  probe: {
    ok: true,
    bot: {
      displayName: "ClawBox",
      userId: "U1234567890abcdef1234567890abcdef",
      basicId: "@clawbox",
      pictureUrl: null,
    },
    error: null,
  },
  lastInboundAt: null,
  lastError: null,
};

beforeAll(async () => {
  process.env.CLAWBOX_ROOT = TEST_ROOT;
  vi.resetModules();
  vi.doMock("@/lib/channels/line", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@/lib/channels/line")>();
    return {
      ...actual,
      getLineConfig: mocks.get,
      getLineCredentials: mocks.credentials,
      validateLineChannelAccessToken: mocks.validate,
      saveLineConfig: mocks.save,
      parseLineStatusPayload: mocks.parse,
      waitForLineReady: mocks.wait,
      probeLineChannel: mocks.probe,
      listLinePairingRequests: mocks.list,
      approveLinePairing: mocks.approve,
    };
  });
  vi.doMock("@/lib/openclaw-config", () => ({
    restartGateway: mocks.restart,
  }));

  ({ GET: configGet, POST: configPost } = await import(
    "@/app/setup-api/channels/line/route"
  ));
  ({ GET: statusGet } = await import(
    "@/app/setup-api/channels/line/status/route"
  ));
  ({ GET: pairingGet, POST: pairingPost } = await import(
    "@/app/setup-api/channels/line/pairing/route"
  ));
});

beforeEach(async () => {
  Object.values(mocks).forEach((mock) => mock.mockReset());
  await fs.rm(DATA_DIR, { recursive: true, force: true });
  await fs.mkdir(DATA_DIR, { recursive: true });

  mocks.get.mockResolvedValue({
    ...configView,
    configured: false,
    enabled: false,
    hasChannelAccessToken: false,
    hasChannelSecret: false,
  });
  mocks.credentials.mockResolvedValue({
    channelAccessToken: null,
    channelSecret: null,
  });
  mocks.validate.mockResolvedValue({
    displayName: "ClawBox",
    userId: "U1234567890abcdef1234567890abcdef",
    basicId: "@clawbox",
    pictureUrl: null,
  });
  mocks.save.mockResolvedValue(configView);
  mocks.parse.mockImplementation((_payload, stored) => ({
    ...stored,
    state: "disabled",
    running: false,
    probe: null,
    lastInboundAt: null,
    lastError: null,
  }));
  mocks.wait.mockResolvedValue(readyStatus);
  mocks.probe.mockResolvedValue(readyStatus);
  mocks.list.mockResolvedValue([]);
  mocks.approve.mockResolvedValue(undefined);
  mocks.restart.mockResolvedValue(undefined);
});

afterAll(async () => {
  delete process.env.CLAWBOX_ROOT;
  vi.doUnmock("@/lib/channels/line");
  vi.doUnmock("@/lib/openclaw-config");
  await fs.rm(TEST_ROOT, { recursive: true, force: true });
});

describe("LINE config route", () => {
  it("never returns either stored credential", async () => {
    mocks.get.mockResolvedValue(configView);
    await setup({ line_public_base_url: "https://line.example.com" });

    const response = await configGet();
    const body = await response.json();
    const serialized = JSON.stringify(body);

    expect(response.status).toBe(200);
    expect(body.hasChannelAccessToken).toBe(true);
    expect(body.hasChannelSecret).toBe(true);
    expect(body.publicBaseUrl).toBe("https://line.example.com");
    expect(body.publicWebhookUrl).toBe(
      "https://line.example.com/line/webhook",
    );
    expect(serialized).not.toContain("channelAccessToken");
    expect(serialized).not.toContain("channelSecret");
    expect(serialized).not.toContain(CHANNEL_ACCESS_TOKEN);
    expect(serialized).not.toContain(CHANNEL_SECRET);
  });

  it("blocks setup until the AI provider is configured", async () => {
    await setup({ wifi_configured: true });

    const response = await configPost(
      request({
        channelAccessToken: CHANNEL_ACCESS_TOKEN,
        channelSecret: CHANNEL_SECRET,
      }),
    );

    expect(response.status).toBe(409);
    expect(mocks.validate).not.toHaveBeenCalled();
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("requires both credentials when enabling LINE", async () => {
    await setup({ ai_model_configured: true });

    const response = await configPost(
      request({ channelAccessToken: CHANNEL_ACCESS_TOKEN, enabled: true }),
    );

    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain("Channel secret");
    expect(mocks.validate).not.toHaveBeenCalled();
  });

  it("validates, saves, restarts, and returns layered readiness", async () => {
    await setup({ ai_model_configured: true });

    const response = await configPost(
      request({
        channelAccessToken: CHANNEL_ACCESS_TOKEN,
        channelSecret: CHANNEL_SECRET,
        publicBaseUrl: "https://line.example.com/",
        enabled: true,
      }),
    );
    const body = await response.json();
    const serialized = JSON.stringify(body);

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      success: true,
      saved: true,
      state: "ready",
      configured: true,
      running: true,
      probe: { ok: true },
      lastInboundAt: null,
      publicBaseUrl: "https://line.example.com",
      publicWebhookUrl: "https://line.example.com/line/webhook",
    });
    expect(body).not.toHaveProperty("connected");
    expect(mocks.validate).toHaveBeenCalledWith(CHANNEL_ACCESS_TOKEN);
    expect(mocks.save).toHaveBeenCalledWith({
      channelAccessToken: CHANNEL_ACCESS_TOKEN,
      channelSecret: CHANNEL_SECRET,
      enabled: true,
    });
    expect(mocks.restart).toHaveBeenCalledOnce();
    expect(mocks.wait).toHaveBeenCalledOnce();
    expect(serialized).not.toContain(CHANNEL_ACCESS_TOKEN);
    expect(serialized).not.toContain(CHANNEL_SECRET);
    const stored = JSON.parse(await fs.readFile(CONFIG_PATH, "utf-8"));
    expect(stored.line_public_base_url).toBe("https://line.example.com");
  });

  it("rejects a non-HTTPS public webhook address", async () => {
    await setup({ ai_model_configured: true });

    const response = await configPost(
      request({
        channelAccessToken: CHANNEL_ACCESS_TOKEN,
        channelSecret: CHANNEL_SECRET,
        publicBaseUrl: "http://line.example.com",
      }),
    );

    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain("HTTPS");
    expect(mocks.validate).not.toHaveBeenCalled();
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("reports saved=true when Gateway restart fails", async () => {
    await setup({ ai_model_configured: true });
    mocks.restart.mockRejectedValue(new Error("denied"));

    const response = await configPost(
      request({
        channelAccessToken: CHANNEL_ACCESS_TOKEN,
        channelSecret: CHANNEL_SECRET,
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(502);
    expect(body.saved).toBe(true);
    expect(mocks.wait).not.toHaveBeenCalled();
  });
});

describe("LINE status and pairing routes", () => {
  it("returns readiness fields without a connected shortcut", async () => {
    const response = await statusGet();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      configured: true,
      running: true,
      probe: { ok: true },
      lastInboundAt: null,
    });
    expect(body).not.toHaveProperty("connected");
  });

  it("blocks pairing until LINE is configured and enabled", async () => {
    const response = await pairingGet();

    expect(response.status).toBe(409);
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it("lists and approves a pending LINE sender", async () => {
    mocks.get.mockResolvedValue(configView);
    mocks.list.mockResolvedValue([
      {
        code: "ABC12345",
        senderId: "U1234567890abcdef1234567890abcdef",
        createdAt: "2026-07-31T00:00:00.000Z",
        displayName: "Melody",
      },
    ]);

    const listResponse = await pairingGet();
    const listBody = await listResponse.json();
    const approveResponse = await pairingPost(request({ code: "ABC12345" }));

    expect(listResponse.status).toBe(200);
    expect(listBody.requests).toHaveLength(1);
    expect(approveResponse.status).toBe(200);
    expect(mocks.approve).toHaveBeenCalledWith("ABC12345");
  });
});
