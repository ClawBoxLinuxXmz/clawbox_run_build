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

const ROOT = path.join(
  os.tmpdir(),
  `clawbox-qqbot-routes-${process.pid}-${Date.now()}`,
);
const DATA = path.join(ROOT, "data");
const CONFIG = path.join(DATA, "config.json");
const APP_ID = "1023456789";
const APP_SECRET = "qq-client-secret-1234567890";
const mocks = {
  get: vi.fn(),
  credentials: vi.fn(),
  validate: vi.fn(),
  save: vi.fn(),
  wait: vi.fn(),
  probe: vi.fn(),
  restart: vi.fn(),
};
let configGet: () => Promise<Response>;
let configPost: (request: Request) => Promise<Response>;
let statusGet: () => Promise<Response>;

function request(body: unknown): Request {
  return new Request("http://localhost/test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function setup(value: Record<string, unknown>): Promise<void> {
  await fs.mkdir(DATA, { recursive: true });
  await fs.writeFile(CONFIG, JSON.stringify(value), "utf-8");
}

beforeAll(async () => {
  process.env.CLAWBOX_ROOT = ROOT;
  vi.resetModules();
  vi.doMock("@/lib/channels/qqbot", () => ({
    getQQBotConfig: mocks.get,
    getQQBotCredentials: mocks.credentials,
    validateQQBotCredentials: mocks.validate,
    saveQQBotConfig: mocks.save,
    waitForQQBotConnected: mocks.wait,
    probeQQBotChannel: mocks.probe,
  }));
  vi.doMock("@/lib/openclaw-config", () => ({
    restartGateway: mocks.restart,
  }));
  ({ GET: configGet, POST: configPost } = await import(
    "@/app/setup-api/channels/qqbot/route"
  ));
  ({ GET: statusGet } = await import(
    "@/app/setup-api/channels/qqbot/status/route"
  ));
});

beforeEach(async () => {
  Object.values(mocks).forEach((mock) => mock.mockReset());
  await fs.rm(DATA, { recursive: true, force: true });
  await fs.mkdir(DATA, { recursive: true });
  mocks.get.mockResolvedValue({
    configured: false,
    enabled: false,
    hasClientSecret: false,
    appId: null,
  });
  mocks.credentials.mockResolvedValue(null);
  mocks.validate.mockResolvedValue(undefined);
  mocks.save.mockResolvedValue({
    configured: true,
    enabled: true,
    hasClientSecret: true,
    appId: APP_ID,
  });
  mocks.restart.mockResolvedValue(undefined);
  mocks.wait.mockResolvedValue({
    state: "connected",
    configured: true,
    enabled: true,
    hasClientSecret: true,
    appId: APP_ID,
    connected: true,
    running: true,
    lastError: null,
  });
  mocks.probe.mockResolvedValue({
    state: "connected",
    configured: true,
    enabled: true,
    hasClientSecret: true,
    appId: APP_ID,
    connected: true,
    running: true,
    lastError: null,
  });
});

afterAll(async () => {
  delete process.env.CLAWBOX_ROOT;
  vi.doUnmock("@/lib/channels/qqbot");
  vi.doUnmock("@/lib/openclaw-config");
  await fs.rm(ROOT, { recursive: true, force: true });
});

describe("QQ Bot config route", () => {
  it("never returns the AppSecret", async () => {
    mocks.get.mockResolvedValue({
      configured: true,
      enabled: true,
      hasClientSecret: true,
      appId: APP_ID,
    });
    await setup({});

    const response = await configGet();
    expect(response.status).toBe(200);
    expect(JSON.stringify(await response.json())).not.toContain(APP_SECRET);
  });

  it("blocks setup until AI is configured", async () => {
    await setup({});
    const response = await configPost(
      request({ appId: APP_ID, clientSecret: APP_SECRET }),
    );

    expect(response.status).toBe(409);
    expect(mocks.validate).not.toHaveBeenCalled();
  });

  it("validates, saves, restarts, and waits for online status", async () => {
    await setup({ ai_model_configured: true });
    const response = await configPost(
      request({ appId: APP_ID, clientSecret: APP_SECRET, enabled: true }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.connected).toBe(true);
    expect(mocks.validate).toHaveBeenCalledWith({
      appId: APP_ID,
      clientSecret: APP_SECRET,
    });
    expect(mocks.save).toHaveBeenCalledOnce();
    expect(mocks.restart).toHaveBeenCalledOnce();
    expect(mocks.wait).toHaveBeenCalledOnce();
  });

  it("does not save credentials rejected by QQ Open Platform", async () => {
    await setup({ ai_model_configured: true });
    mocks.validate.mockRejectedValue(
      Object.assign(new Error("QQ Open Platform rejected these credentials."), {
        code: "invalid_credentials",
      }),
    );

    const response = await configPost(
      request({ appId: APP_ID, clientSecret: APP_SECRET, enabled: true }),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toMatchObject({ saved: false });
    expect(JSON.stringify(body)).not.toContain(APP_SECRET);
    expect(mocks.save).not.toHaveBeenCalled();
    expect(mocks.restart).not.toHaveBeenCalled();
  });

  it("reports saved=true when Gateway restart fails", async () => {
    await setup({ ai_model_configured: true });
    mocks.restart.mockRejectedValue(new Error("denied"));
    const response = await configPost(
      request({ appId: APP_ID, clientSecret: APP_SECRET }),
    );

    expect(response.status).toBe(502);
    expect((await response.json()).saved).toBe(true);
  });
});

describe("QQ Bot status route", () => {
  it("returns the live account status", async () => {
    await setup({});
    const response = await statusGet();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ state: "connected", connected: true });
    expect(mocks.probe).toHaveBeenCalledOnce();
  });
});
