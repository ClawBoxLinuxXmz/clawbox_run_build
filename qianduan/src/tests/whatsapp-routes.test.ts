import fs from "fs/promises";
import os from "os";
import path from "path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

type RouteGet = () => Promise<Response>;
type RoutePost = (request: Request) => Promise<Response>;

const TEST_ROOT = path.join(
  os.tmpdir(),
  `clawbox-whatsapp-routes-${process.pid}-${Date.now()}`,
);
const DATA_DIR = path.join(TEST_ROOT, "data");
const CONFIG_PATH = path.join(DATA_DIR, "config.json");
const QR_DATA_URL = "data:image/png;base64,QUJDRA==";

const mocks = {
  getConfig: vi.fn(),
  prepare: vi.fn(),
  disable: vi.fn(),
  startQr: vi.fn(),
  waitQr: vi.fn(),
  probe: vi.fn(),
  listPairing: vi.fn(),
  approvePairing: vi.fn(),
  logout: vi.fn(),
};

let configGet: RouteGet;
let configPost: RoutePost;
let preparePost: RoutePost;
let qrPost: RoutePost;
let loginStatusPost: RoutePost;
let statusGet: RouteGet;
let pairingGet: RouteGet;
let pairingPost: RoutePost;
let logoutPost: RoutePost;

function jsonRequest(body: unknown): Request {
  return new Request("http://localhost/test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function writeSetupConfig(config: Record<string, unknown>) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(CONFIG_PATH, JSON.stringify(config), "utf-8");
}

function expectNoStore(response: Response) {
  expect(response.headers.get("cache-control")).toContain("no-store");
  expect(response.headers.get("pragma")).toBe("no-cache");
}

beforeAll(async () => {
  process.env.CLAWBOX_ROOT = TEST_ROOT;
  await fs.mkdir(DATA_DIR, { recursive: true });
  vi.resetModules();
  vi.doMock("@/lib/channels/whatsapp", () => ({
    getWhatsAppConfig: mocks.getConfig,
    prepareWhatsAppChannel: mocks.prepare,
    disableWhatsAppChannel: mocks.disable,
    startWhatsAppQrLogin: mocks.startQr,
    waitForWhatsAppQrLogin: mocks.waitQr,
    probeWhatsAppChannel: mocks.probe,
    listWhatsAppPairingRequests: mocks.listPairing,
    approveWhatsAppPairing: mocks.approvePairing,
    logoutWhatsApp: mocks.logout,
  }));

  ({ GET: configGet, POST: configPost } = await import(
    "@/app/setup-api/channels/whatsapp/route"
  ));
  ({ POST: preparePost } = await import(
    "@/app/setup-api/channels/whatsapp/prepare/route"
  ));
  ({ POST: qrPost } = await import(
    "@/app/setup-api/channels/whatsapp/qrcode/route"
  ));
  ({ POST: loginStatusPost } = await import(
    "@/app/setup-api/channels/whatsapp/login-status/route"
  ));
  ({ GET: statusGet } = await import(
    "@/app/setup-api/channels/whatsapp/status/route"
  ));
  ({ GET: pairingGet, POST: pairingPost } = await import(
    "@/app/setup-api/channels/whatsapp/pairing/route"
  ));
  ({ POST: logoutPost } = await import(
    "@/app/setup-api/channels/whatsapp/logout/route"
  ));
});

beforeEach(async () => {
  Object.values(mocks).forEach((mock) => mock.mockReset());
  await fs.rm(DATA_DIR, { recursive: true, force: true });
  await fs.mkdir(DATA_DIR, { recursive: true });

  mocks.getConfig.mockResolvedValue({
    configured: true,
    enabled: true,
    mode: "dedicated",
    dmPolicy: "pairing",
    groupPolicy: "disabled",
    ownerNumber: null,
  });
  mocks.prepare.mockResolvedValue({
    prepared: true,
    restarted: true,
    changed: true,
    config: { configured: true, enabled: true, mode: "dedicated" },
    plugin: {
      available: true,
      enabled: true,
      prepared: true,
      status: "loaded",
      origin: "bundled",
      version: "2026.4.25",
      lastError: null,
    },
  });
  mocks.disable.mockResolvedValue({
    config: { configured: true, enabled: false, mode: "dedicated" },
    restarted: true,
  });
  mocks.startQr.mockResolvedValue({
    connected: false,
    qrDataUrl: QR_DATA_URL,
    message: "Scan this QR in WhatsApp.",
  });
  mocks.waitQr.mockResolvedValue({
    connected: false,
    qrDataUrl: null,
    message: "Still waiting.",
  });
  mocks.probe.mockResolvedValue({
    state: "connected",
    linked: true,
    connected: true,
    running: true,
    pluginAvailable: true,
    lastError: null,
  });
  mocks.listPairing.mockResolvedValue([]);
  mocks.approvePairing.mockResolvedValue(undefined);
  mocks.logout.mockResolvedValue({ cleared: true, loggedOut: true });
});

afterAll(async () => {
  delete process.env.CLAWBOX_ROOT;
  vi.doUnmock("@/lib/channels/whatsapp");
  await fs.rm(TEST_ROOT, { recursive: true, force: true });
});

describe("WhatsApp config and prepare routes", () => {
  it("returns config without credentials and disables caching", async () => {
    const response = await configGet();
    const body = await response.json();

    expect(response.status).toBe(200);
    expectNoStore(response);
    expect(JSON.stringify(body)).not.toContain("creds.json");
    expect(JSON.stringify(body)).not.toContain("qrDataUrl");
  });

  it("blocks prepare until AI is configured", async () => {
    await writeSetupConfig({ wifi_configured: true });

    const response = await preparePost(jsonRequest({ mode: "dedicated" }));

    expect(response.status).toBe(409);
    expectNoStore(response);
    expect(mocks.prepare).not.toHaveBeenCalled();
  });

  it("prepares the bundled plugin and returns no-store", async () => {
    await writeSetupConfig({ ai_model_configured: true });

    const response = await preparePost(jsonRequest({ mode: "dedicated" }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expectNoStore(response);
    expect(body.prepared).toBe(true);
    expect(mocks.prepare).toHaveBeenCalledWith({
      mode: "dedicated",
      ownerNumber: undefined,
    });
  });

  it("returns 503 when the WhatsApp plugin is unavailable", async () => {
    await writeSetupConfig({ ai_model_configured: true });
    mocks.prepare.mockRejectedValue(
      Object.assign(new Error("Bundled WhatsApp plugin is unavailable."), {
        code: "plugin_unavailable",
      }),
    );

    const response = await preparePost(jsonRequest({ mode: "dedicated" }));
    const body = await response.json();

    expect(response.status).toBe(503);
    expectNoStore(response);
    expect(body.error).toContain("unavailable");
  });

  it("disables WhatsApp through the config route", async () => {
    await writeSetupConfig({ ai_model_configured: true });

    const response = await configPost(jsonRequest({ enabled: false }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expectNoStore(response);
    expect(body.state).toBe("disabled");
    expect(mocks.disable).toHaveBeenCalledOnce();
  });
});

describe("WhatsApp QR and live status routes", () => {
  it("returns a transient QR response without persisting it", async () => {
    await writeSetupConfig({ ai_model_configured: true });

    const response = await qrPost(jsonRequest({ force: false }));
    const body = await response.json();
    const storedSetup = await fs.readFile(CONFIG_PATH, "utf-8");

    expect(response.status).toBe(200);
    expectNoStore(response);
    expect(body.qrDataUrl).toBe(QR_DATA_URL);
    expect(storedSetup).not.toContain(QR_DATA_URL);
  });

  it("waits for a scan and returns no-store QR state", async () => {
    const response = await loginStatusPost(jsonRequest({ timeoutMs: 10_000 }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expectNoStore(response);
    expect(body).toEqual({
      success: true,
      connected: false,
      qrDataUrl: null,
      message: "Still waiting.",
    });
  });

  it("returns the strict live connection state with no-store", async () => {
    const response = await statusGet();
    const body = await response.json();

    expect(response.status).toBe(200);
    expectNoStore(response);
    expect(body).toMatchObject({ linked: true, connected: true });
  });
});

describe("WhatsApp pairing and logout routes", () => {
  it("lists and approves a pending sender", async () => {
    mocks.listPairing.mockResolvedValue([
      {
        code: "ABC123",
        senderId: "+8613800000000",
        accountId: "default",
        createdAt: "now",
        displayName: "Melody",
      },
    ]);

    const listResponse = await pairingGet();
    const listBody = await listResponse.json();
    const approveResponse = await pairingPost(jsonRequest({ code: "ABC123" }));

    expectNoStore(listResponse);
    expectNoStore(approveResponse);
    expect(listBody.requests).toHaveLength(1);
    expect(approveResponse.status).toBe(200);
    expect(mocks.approvePairing).toHaveBeenCalledWith("ABC123");
  });

  it("logs out without exposing auth state", async () => {
    const response = await logoutPost(jsonRequest({}));
    const body = await response.json();

    expect(response.status).toBe(200);
    expectNoStore(response);
    expect(body).toEqual({ success: true, cleared: true, loggedOut: true });
    expect(JSON.stringify(body)).not.toContain("creds");
  });
});
