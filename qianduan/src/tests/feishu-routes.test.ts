import fs from "fs/promises";
import os from "os";
import path from "path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const ROOT = path.join(os.tmpdir(), `clawbox-feishu-routes-${process.pid}-${Date.now()}`);
const DATA = path.join(ROOT, "data");
const CONFIG = path.join(DATA, "config.json");
const mocks = {
  get: vi.fn(), credentials: vi.fn(), validate: vi.fn(), save: vi.fn(), wait: vi.fn(), probe: vi.fn(), list: vi.fn(), approve: vi.fn(), restart: vi.fn(),
};
let configGet: () => Promise<Response>; let configPost: (r: Request) => Promise<Response>; let pairingGet: () => Promise<Response>; let pairingPost: (r: Request) => Promise<Response>;
const request = (body: unknown) => new Request("http://localhost/test", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const setup = async (value: Record<string, unknown>) => { await fs.mkdir(DATA, { recursive: true }); await fs.writeFile(CONFIG, JSON.stringify(value), "utf-8"); };

beforeAll(async () => {
  process.env.CLAWBOX_ROOT = ROOT; vi.resetModules();
  vi.doMock("@/lib/channels/feishu", () => ({ getFeishuConfig: mocks.get, getFeishuCredentials: mocks.credentials, validateFeishuCredentials: mocks.validate, saveFeishuConfig: mocks.save, waitForFeishuConnected: mocks.wait, probeFeishuChannel: mocks.probe, listFeishuPairingRequests: mocks.list, approveFeishuPairing: mocks.approve }));
  vi.doMock("@/lib/openclaw-config", () => ({ restartGateway: mocks.restart }));
  ({ GET: configGet, POST: configPost } = await import("@/app/setup-api/channels/feishu/route"));
  ({ GET: pairingGet, POST: pairingPost } = await import("@/app/setup-api/channels/feishu/pairing/route"));
});
beforeEach(async () => {
  Object.values(mocks).forEach((mock) => mock.mockReset()); await fs.rm(DATA, { recursive: true, force: true }); await fs.mkdir(DATA, { recursive: true });
  mocks.get.mockResolvedValue({ configured: false, enabled: false, hasAppSecret: false, appId: null, domain: "feishu" }); mocks.credentials.mockResolvedValue(null);
  mocks.validate.mockResolvedValue(undefined); mocks.save.mockResolvedValue({ configured: true, enabled: true, hasAppSecret: true, appId: "cli_1234567890", domain: "feishu" }); mocks.restart.mockResolvedValue(undefined);
  mocks.wait.mockResolvedValue({ state: "connected", configured: true, enabled: true, connected: true, running: true, probeOk: true, botName: "ClawBox", botOpenId: "ou_123" }); mocks.list.mockResolvedValue([]); mocks.approve.mockResolvedValue(undefined);
});
afterAll(async () => { delete process.env.CLAWBOX_ROOT; vi.doUnmock("@/lib/channels/feishu"); vi.doUnmock("@/lib/openclaw-config"); await fs.rm(ROOT, { recursive: true, force: true }); });

describe("Feishu config route", () => {
  it("never returns the App Secret", async () => { mocks.get.mockResolvedValue({ configured: true, enabled: true, hasAppSecret: true, appId: "cli_1234567890", domain: "feishu" }); await setup({}); const response = await configGet(); expect(response.status).toBe(200); expect(JSON.stringify(await response.json())).not.toContain("appSecret"); });
  it("blocks setup until AI is configured", async () => { await setup({}); const response = await configPost(request({ appId: "cli_1234567890", appSecret: "abcdefghijklmnopqrstuvwxyz123456" })); expect(response.status).toBe(409); expect(mocks.validate).not.toHaveBeenCalled(); });
  it("validates, saves, restarts, and waits for online status", async () => { await setup({ ai_model_configured: true }); const response = await configPost(request({ appId: "cli_1234567890", appSecret: "abcdefghijklmnopqrstuvwxyz123456", domain: "feishu", enabled: true })); const body = await response.json(); expect(response.status).toBe(200); expect(body.connected).toBe(true); expect(mocks.validate).toHaveBeenCalled(); expect(mocks.restart).toHaveBeenCalledOnce(); expect(mocks.wait).toHaveBeenCalledOnce(); });
  it("reports saved=true when Gateway restart fails", async () => { await setup({ ai_model_configured: true }); mocks.restart.mockRejectedValue(new Error("denied")); const response = await configPost(request({ appId: "cli_1234567890", appSecret: "abcdefghijklmnopqrstuvwxyz123456" })); expect(response.status).toBe(502); expect((await response.json()).saved).toBe(true); });
});

describe("Feishu pairing route", () => {
  it("blocks pairing while disabled", async () => { const response = await pairingGet(); expect(response.status).toBe(409); });
  it("lists and approves a sender", async () => { mocks.get.mockResolvedValue({ configured: true, enabled: true }); mocks.list.mockResolvedValue([{ code: "ABC123", senderId: "ou_1", createdAt: "now", displayName: "User" }]); expect((await (await pairingGet()).json()).requests).toHaveLength(1); const response = await pairingPost(request({ code: "ABC123" })); expect(response.status).toBe(200); expect(mocks.approve).toHaveBeenCalledWith("ABC123"); });
});
