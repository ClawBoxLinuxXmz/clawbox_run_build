import fs from "fs/promises";
import os from "os";
import path from "path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

type WifiConnectRoutePost = (request: Request) => Promise<Response>;

const TEST_ROOT = path.join(
  os.tmpdir(),
  `clawbox-wifi-connect-tests-${process.pid}-${Date.now()}`,
);
const DATA_DIR = path.join(TEST_ROOT, "data");
const CONFIG_PATH = path.join(DATA_DIR, "config.json");

const switchToClientMock = vi.fn();
const getDeviceAccessInfoMock = vi.fn();

let wifiConnectPost: WifiConnectRoutePost;

function jsonRequest(body: unknown): Request {
  return new Request("http://localhost/test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function waitForConfigState(
  predicate: (config: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const saved = JSON.parse(await fs.readFile(CONFIG_PATH, "utf-8")) as Record<string, unknown>;
    if (predicate(saved)) {
      return saved;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return JSON.parse(await fs.readFile(CONFIG_PATH, "utf-8")) as Record<string, unknown>;
}

beforeAll(async () => {
  process.env.CLAWBOX_ROOT = TEST_ROOT;
  process.env.WIFI_DEFERRED_CONNECT_LEAD_MS = "0";
  await fs.mkdir(DATA_DIR, { recursive: true });

  vi.resetModules();
  vi.doMock("@/lib/network", () => ({
    switchToClient: switchToClientMock,
  }));
  vi.doMock("@/lib/device-identity", () => ({
    getDeviceAccessInfo: getDeviceAccessInfoMock,
  }));

  ({ POST: wifiConnectPost } = await import("@/app/setup-api/wifi/connect/route"));
});

beforeEach(async () => {
  switchToClientMock.mockReset();
  getDeviceAccessInfoMock.mockReset();
  getDeviceAccessInfoMock.mockResolvedValue({
    hostname: "clawbox-947d364",
    mdnsHost: "clawbox-947d364.local",
    accessUrl: "http://clawbox-947d364.local/",
    localDnsAlias: null,
  });
  await fs.rm(DATA_DIR, { recursive: true, force: true });
  await fs.mkdir(DATA_DIR, { recursive: true });
});

afterAll(async () => {
  delete process.env.CLAWBOX_ROOT;
  delete process.env.WIFI_DEFERRED_CONNECT_LEAD_MS;
  vi.doUnmock("@/lib/network");
  vi.doUnmock("@/lib/device-identity");
  await fs.rm(TEST_ROOT, { recursive: true, force: true });
});

describe("wifi connect route", () => {
  it("clears stored WiFi targets when the setup is explicitly skipped for Ethernet", async () => {
    await fs.writeFile(
      CONFIG_PATH,
      JSON.stringify({ wifi_ssid: "AKA-ylwz", wifi_target_ssid: "AKA-ylwz" }, null, 2),
      "utf-8",
    );

    const res = await wifiConnectPost(jsonRequest({ skip: true }));
    const body = await res.json();
    const saved = JSON.parse(await fs.readFile(CONFIG_PATH, "utf-8")) as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(saved.wifi_configured).toBe(true);
    expect(saved.wifi_ssid).toBeUndefined();
    expect(saved.wifi_target_ssid).toBeUndefined();
  });

  it("records a pending WiFi switch immediately and marks success after DHCP is ready", async () => {
    switchToClientMock.mockResolvedValue({
      message: "ready",
      status: {
        mode: "client",
        connected: true,
        ssid: "AKA-ylwz",
        interface: "wlan0",
        ipv4: "192.168.31.55",
        gateway: "192.168.31.1",
        hostname: "clawbox-947d364",
        mdnsHost: "clawbox-947d364.local",
        accessUrl: "http://clawbox-947d364.local/",
        localDnsAlias: null,
        mdnsReady: true,
        pending: false,
        targetSsid: null,
        lastError: null,
      },
    });

    const res = await wifiConnectPost(
      jsonRequest({ ssid: "AKA-ylwz", password: "secret" }),
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.applying).toBe(true);
    expect(body.mdnsHost).toBe("clawbox-947d364.local");

    const saved = await waitForConfigState(
      (config) => config.wifi_connecting === false && config.wifi_configured === true,
    );
    expect(saved.wifi_connecting).toBe(false);
    expect(saved.wifi_configured).toBe(true);
    expect(saved.wifi_target_ssid).toBe("AKA-ylwz");
    expect(saved.wifi_last_error).toBeUndefined();
  });

  it("keeps wifi_configured false and records the failure reason when connection fails", async () => {
    switchToClientMock.mockRejectedValue(
      new Error("DHCP did not provide an IPv4 lease"),
    );

    const res = await wifiConnectPost(
      jsonRequest({ ssid: "AKA-ylwz", password: "wrong" }),
    );

    expect(res.status).toBe(200);

    const saved = await waitForConfigState(
      (config) =>
        config.wifi_connecting === false &&
        config.wifi_configured === false &&
        typeof config.wifi_last_error === "string",
    );
    expect(saved.wifi_connecting).toBe(false);
    expect(saved.wifi_configured).toBe(false);
    expect(saved.wifi_last_error).toContain("DHCP");
  });
});
