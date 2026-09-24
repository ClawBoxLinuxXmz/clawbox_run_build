import fs from "fs/promises";
import os from "os";
import path from "path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const ROOT = path.join(os.tmpdir(), `clawbox-feishu-${process.pid}-${Date.now()}`);
const STATE = path.join(ROOT, ".openclaw");
const CONFIG = path.join(STATE, "openclaw.json");
const APP_ID = "cli_1234567890";
const APP_SECRET = "abcdefghijklmnopqrstuvwxyz123456";
let feishu: typeof import("@/lib/channels/feishu");

beforeAll(async () => {
  process.env.OPENCLAW_HOME = STATE;
  await fs.mkdir(STATE, { recursive: true });
  vi.resetModules();
  feishu = await import("@/lib/channels/feishu");
});
beforeEach(async () => { await fs.rm(STATE, { recursive: true, force: true }); await fs.mkdir(STATE, { recursive: true }); });
afterAll(async () => { delete process.env.OPENCLAW_HOME; await fs.rm(ROOT, { recursive: true, force: true }); });

describe("Feishu credentials and config", () => {
  it("validates credentials against the selected platform", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ code: 0, tenant_access_token: "token", expire: 7200 }), { status: 200 }));
    await feishu.validateFeishuCredentials({ appId: APP_ID, appSecret: APP_SECRET, domain: "feishu" }, fetcher as typeof fetch);
    expect(fetcher).toHaveBeenCalledWith(expect.stringContaining("open.feishu.cn"), expect.objectContaining({ method: "POST" }));
  });

  it("rejects bad credentials without accepting a platform error", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ code: 10003, msg: "invalid app secret" }), { status: 200 }));
    await expect(feishu.validateFeishuCredentials({ appId: APP_ID, appSecret: APP_SECRET, domain: "feishu" }, fetcher as typeof fetch)).rejects.toMatchObject({ code: "invalid_credentials" });
  });

  it("writes the OpenClaw websocket schema and never returns the secret", async () => {
    const view = await feishu.saveFeishuConfig({ appId: APP_ID, appSecret: APP_SECRET, domain: "feishu", enabled: true });
    const stored = JSON.parse(await fs.readFile(CONFIG, "utf-8"));
    expect(stored.channels.feishu).toMatchObject({ enabled: true, appId: APP_ID, appSecret: APP_SECRET, domain: "feishu", connectionMode: "websocket", dmPolicy: "pairing", groupPolicy: "disabled" });
    expect(view).toMatchObject({ configured: true, enabled: true, hasAppSecret: true, appId: APP_ID });
    expect(JSON.stringify(view)).not.toContain(APP_SECRET);
  });
});

describe("Feishu status parsing", () => {
  it("requires a running account and successful probe", () => {
    const stored = { configured: true, enabled: true, hasAppSecret: true, appId: APP_ID, domain: "feishu" as const };
    const status = feishu.parseFeishuStatusPayload({ channelAccounts: { feishu: [{ running: true, probe: { ok: true, botName: "ClawBox", botOpenId: "ou_123" } }] } }, stored);
    expect(status).toMatchObject({ state: "connected", connected: true, botName: "ClawBox", botOpenId: "ou_123" });
  });
});
