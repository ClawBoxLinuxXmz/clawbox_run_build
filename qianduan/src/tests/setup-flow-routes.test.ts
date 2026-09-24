import fs from "fs/promises";
import os from "os";
import path from "path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

type WechatRoutePost = (request: Request) => Promise<Response>;
type SetupCompleteRoutePost = () => Promise<Response>;
type SetupStatusRouteGet = () => Promise<Response>;

const TEST_ROOT = path.join(
  os.tmpdir(),
  `clawbox-setup-flow-tests-${process.pid}-${Date.now()}`,
);
const DATA_DIR = path.join(TEST_ROOT, "data");
const CONFIG_PATH = path.join(DATA_DIR, "config.json");

const setWechatConfigMock = vi.fn();
const getWifiRuntimeStateMock = vi.fn();

let wechatPost: WechatRoutePost;
let completePost: SetupCompleteRoutePost;
let statusGet: SetupStatusRouteGet;

function jsonRequest(body: unknown): Request {
  return new Request("http://localhost/test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function writeConfig(config: Record<string, unknown>): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(CONFIG_PATH, JSON.stringify(config, null, 2), "utf-8");
}

beforeAll(async () => {
  process.env.CLAWBOX_ROOT = TEST_ROOT;
  await fs.mkdir(DATA_DIR, { recursive: true });

  vi.resetModules();
  vi.doMock("@/lib/openclaw-config", () => ({
    setWechatConfig: setWechatConfigMock,
    getWechatConfig: vi.fn(async () => ({ botToken: "", enabled: false })),
  }));
  vi.doMock("@/lib/network", () => ({
    getWifiRuntimeState: getWifiRuntimeStateMock,
  }));

  ({ POST: wechatPost } = await import("@/app/setup-api/wechat/configure/route"));
  ({ POST: completePost } = await import("@/app/setup-api/setup/complete/route"));
  ({ GET: statusGet } = await import("@/app/setup-api/setup/status/route"));
});

beforeEach(async () => {
  setWechatConfigMock.mockReset();
  getWifiRuntimeStateMock.mockReset();
  getWifiRuntimeStateMock.mockResolvedValue({
    mode: "unknown",
    connected: false,
    ssid: null,
    ipv4: null,
    hotspotActive: false,
  });
  await fs.rm(DATA_DIR, { recursive: true, force: true });
  await fs.mkdir(DATA_DIR, { recursive: true });
});

afterAll(async () => {
  delete process.env.CLAWBOX_ROOT;
  vi.doUnmock("@/lib/openclaw-config");
  await fs.rm(TEST_ROOT, { recursive: true, force: true });
});

describe("WeChat configure route", () => {
  it("returns 409 until the AI provider is configured", async () => {
    await writeConfig({ wifi_configured: true });

    const res = await wechatPost(
      jsonRequest({ botToken: "wx-token", enabled: true }),
    );
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error).toContain("AI provider");
    expect(setWechatConfigMock).not.toHaveBeenCalled();
  });

  it("saves WeChat config after AI setup is complete", async () => {
    setWechatConfigMock.mockResolvedValue(undefined);
    await writeConfig({ wifi_configured: true, ai_model_configured: true });

    const res = await wechatPost(
      jsonRequest({ botToken: "wx-token", enabled: true }),
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(setWechatConfigMock).toHaveBeenCalledWith("wx-token", true);
  });

  it("returns 502 when WeChat config write succeeds but gateway restart fails", async () => {
    setWechatConfigMock.mockRejectedValue(new Error("gateway restart failed"));
    await writeConfig({ wifi_configured: true, ai_model_configured: true });

    const res = await wechatPost(
      jsonRequest({ botToken: "wx-token", enabled: true }),
    );
    const body = await res.json();

    expect(res.status).toBe(502);
    expect(body.error).toContain("gateway");
  });
});

describe("Setup complete route", () => {
  it("returns 409 when WiFi setup is incomplete", async () => {
    await writeConfig({ ai_model_configured: true });

    const res = await completePost();
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error).toContain("WiFi");
  });

  it("returns 409 when the AI provider is incomplete", async () => {
    await writeConfig({ wifi_configured: true });

    const res = await completePost();
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error).toContain("AI provider");
  });

  it("marks setup complete after WiFi and AI are configured", async () => {
    await writeConfig({
      wifi_configured: true,
      ai_model_configured: true,
    });

    const res = await completePost();
    const body = await res.json();
    const saved = JSON.parse(await fs.readFile(CONFIG_PATH, "utf-8"));

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(saved.setup_complete).toBe(true);
    expect(typeof saved.setup_completed_at).toBe("string");
  });

  it("self-heals wifi_configured when runtime state is already connected", async () => {
    getWifiRuntimeStateMock.mockResolvedValue({
      mode: "client",
      connected: true,
      ssid: "AKA-ylwz",
      ipv4: "192.168.31.55",
      hotspotActive: false,
    });
    await writeConfig({
      wifi_configured: false,
      wifi_connecting: true,
      wifi_target_ssid: "AKA-ylwz",
      ai_model_configured: true,
    });

    const res = await statusGet();
    const body = await res.json();
    const saved = JSON.parse(await fs.readFile(CONFIG_PATH, "utf-8"));

    expect(res.status).toBe(200);
    expect(body.wifi_configured).toBe(true);
    expect(body.wifi_connecting).toBe(false);
    expect(body.wifi_target_ssid).toBe("AKA-ylwz");
    expect(saved.wifi_configured).toBe(true);
    expect(saved.wifi_connecting).toBe(false);
  });

  it("treats hotspot fallback as WiFi incomplete even when config still says configured", async () => {
    getWifiRuntimeStateMock.mockResolvedValue({
      mode: "ap",
      connected: false,
      ssid: null,
      ipv4: null,
      hotspotActive: true,
    });
    await writeConfig({
      wifi_configured: true,
      wifi_target_ssid: "AKA-ylwz",
      ai_model_configured: true,
    });

    const res = await statusGet();
    const body = await res.json();
    const saved = JSON.parse(await fs.readFile(CONFIG_PATH, "utf-8"));

    expect(res.status).toBe(200);
    expect(body.wifi_configured).toBe(false);
    expect(body.wifi_mode).toBe("ap");
    expect(body.hotspot_active).toBe(true);
    expect(saved.wifi_configured).toBe(true);
  });

  it("preserves explicit Ethernet-only skip state when no WiFi target exists", async () => {
    await writeConfig({
      wifi_configured: true,
      ai_model_configured: true,
    });

    const res = await statusGet();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.wifi_configured).toBe(true);
    expect(body.hotspot_active).toBe(false);
  });

  it("clears pending WiFi state immediately after the device falls back to the hotspot", async () => {
    getWifiRuntimeStateMock.mockResolvedValue({
      mode: "ap",
      connected: false,
      ssid: null,
      ipv4: null,
      hotspotActive: true,
    });
    await writeConfig({
      wifi_configured: false,
      wifi_connecting: true,
      wifi_target_ssid: "AKA-ylwz",
      ai_model_configured: true,
    });

    const res = await statusGet();
    const body = await res.json();
    const saved = JSON.parse(await fs.readFile(CONFIG_PATH, "utf-8"));

    expect(res.status).toBe(200);
    expect(body.wifi_connecting).toBe(false);
    expect(body.wifi_configured).toBe(false);
    expect(typeof body.wifi_last_error).toBe("string");
    expect(body.wifi_last_error).toContain("setup hotspot is active again");
    expect(saved.wifi_connecting).toBe(false);
    expect(typeof saved.wifi_last_error).toBe("string");
  });

  it("clears stale wifi_connecting pending state when runtime never reaches connected", async () => {
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    await writeConfig({
      wifi_configured: false,
      wifi_connecting: true,
      wifi_target_ssid: "AKA-ylwz",
      wifi_last_attempt_at: tenMinutesAgo,
      ai_model_configured: true,
    });

    const res = await statusGet();
    const body = await res.json();
    const saved = JSON.parse(await fs.readFile(CONFIG_PATH, "utf-8"));

    expect(res.status).toBe(200);
    expect(body.wifi_configured).toBe(false);
    expect(body.wifi_connecting).toBe(false);
    expect(typeof body.wifi_last_error).toBe("string");
    expect(body.wifi_last_error).toContain("status is still pending");
    expect(saved.wifi_connecting).toBe(false);
    expect(typeof saved.wifi_last_error).toBe("string");
  });
});
