import fs from "fs/promises";
import os from "os";
import path from "path";
import { promisify } from "util";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

type ResetRoutePost = (request?: Request) => Promise<Response>;

const TEST_ROOT = path.join(
  os.tmpdir(),
  `clawbox-reset-tests-${process.pid}-${Date.now()}`,
);
const DATA_DIR = path.join(TEST_ROOT, "data");
const CONFIG_PATH = path.join(DATA_DIR, "config.json");
const OPENCLAW_HOME = path.join(TEST_ROOT, ".openclaw");

const execFileCbMock = vi.fn();
const execFileAsyncMock = vi.fn();
const restartAPMock = vi.fn();
const resetUpdateStateMock = vi.fn();

let resetPost: ResetRoutePost;

function jsonRequest(body: unknown): Request {
  return new Request("http://localhost/setup-api/setup/reset", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function writeConfig(config: Record<string, unknown>): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(CONFIG_PATH, JSON.stringify(config, null, 2), "utf-8");
}

async function readConfig(): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(CONFIG_PATH, "utf-8")) as Record<string, unknown>;
}

beforeAll(async () => {
  process.env.CLAWBOX_ROOT = TEST_ROOT;
  process.env.OPENCLAW_HOME = OPENCLAW_HOME;

  (execFileCbMock as typeof execFileCbMock & { [promisify.custom]: typeof execFileAsyncMock })[
    promisify.custom
  ] = execFileAsyncMock;

  vi.resetModules();
  vi.doMock("child_process", () => ({
    execFile: execFileCbMock,
  }));
  vi.doMock("@/lib/network", () => ({
    restartAP: restartAPMock,
  }));
  vi.doMock("@/lib/updater", () => ({
    resetUpdateState: resetUpdateStateMock,
  }));

  ({ POST: resetPost } = await import("@/app/setup-api/setup/reset/route"));
});

beforeEach(async () => {
  execFileCbMock.mockReset();
  execFileAsyncMock.mockReset();
  restartAPMock.mockReset();
  resetUpdateStateMock.mockReset();
  restartAPMock.mockResolvedValue(undefined);
  execFileAsyncMock.mockImplementation(async (cmd: string, args: string[] = []) => {
    if (cmd === "nmcli" && args.join(" ") === "-t -f NAME,TYPE connection show") {
      return {
        stdout: "ClawBox-Setup:802-11-wireless\nHomeWiFi:802-11-wireless\nWired connection 1:802-3-ethernet\n",
        stderr: "",
      };
    }
    return { stdout: "", stderr: "" };
  });

  await fs.rm(TEST_ROOT, { recursive: true, force: true });
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.mkdir(OPENCLAW_HOME, { recursive: true });
});

afterAll(async () => {
  delete process.env.CLAWBOX_ROOT;
  delete process.env.OPENCLAW_HOME;
  vi.doUnmock("child_process");
  vi.doUnmock("@/lib/network");
  vi.doUnmock("@/lib/updater");
  await fs.rm(TEST_ROOT, { recursive: true, force: true });
});

describe("setup reset route", () => {
  it("resets WiFi state, preserves AI config, and restores the setup hotspot", async () => {
    await writeConfig({
      setup_complete: true,
      wifi_configured: true,
      wifi_ssid: "HomeWiFi",
      wifi_connecting: true,
      wifi_target_ssid: "HomeWiFi",
      wifi_last_error: "old failure",
      wifi_last_attempt_at: "2026-05-10T12:00:00.000Z",
      ai_model_configured: true,
    });

    const res = await resetPost(jsonRequest({ mode: "wifi" }));
    const body = await res.json();
    const saved = await readConfig();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.mode).toBe("wifi");
    expect(body.hotspotUrl).toBe("http://192.168.4.1/setup");
    expect(saved.setup_complete).toBe(false);
    expect(saved.wifi_configured).toBe(false);
    expect(saved.ai_model_configured).toBe(true);
    expect(saved.wifi_ssid).toBeUndefined();
    expect(saved.wifi_target_ssid).toBeUndefined();
    expect(restartAPMock).toHaveBeenCalledTimes(1);
    expect(execFileAsyncMock).toHaveBeenCalledWith(
      "nmcli",
      ["connection", "delete", "HomeWiFi"],
      { timeout: 10_000 },
    );
    expect(execFileAsyncMock).not.toHaveBeenCalledWith(
      "nmcli",
      ["connection", "delete", "ClawBox-Setup"],
      { timeout: 10_000 },
    );
  });

  it("returns 502 when WiFi reset saved state but hotspot restore fails", async () => {
    restartAPMock.mockRejectedValue(new Error("AP restore failed"));
    await writeConfig({ setup_complete: true, wifi_configured: true, wifi_ssid: "HomeWiFi" });

    const res = await resetPost(jsonRequest({ mode: "wifi" }));
    const body = await res.json();
    const saved = await readConfig();

    expect(res.status).toBe(502);
    expect(body.error).toContain("AP restore failed");
    expect(saved.setup_complete).toBe(false);
    expect(saved.wifi_configured).toBe(false);
  });

  it("factory reset preserves hardware identity files and clears OpenClaw data", async () => {
    vi.useFakeTimers();
    await writeConfig({
      setup_complete: true,
      wifi_configured: true,
      ai_model_configured: true,
      hotspot_ssid: "CustomSetup",
    });
    await fs.writeFile(path.join(DATA_DIR, "network.env"), "NETWORK_INTERFACE=wlan0\n", "utf-8");
    await fs.writeFile(path.join(DATA_DIR, "device-hostname.env"), "CLAWBOX_DEVICE_HOSTNAME=clawbox-a1b2c3\n", "utf-8");
    await fs.writeFile(path.join(DATA_DIR, "hotspot.env"), "HOTSPOT_SSID=CustomSetup\n", "utf-8");
    await fs.writeFile(path.join(OPENCLAW_HOME, "secret.json"), "{}", "utf-8");
    execFileAsyncMock.mockImplementation(async (cmd: string, args: string[] = []) => {
      if (cmd === "nmcli" && args.join(" ") === "-t -f NAME,TYPE connection show") {
        return {
          stdout: "CustomSetup:802-11-wireless\nHomeWiFi:802-11-wireless\n",
          stderr: "",
        };
      }
      return { stdout: "", stderr: "" };
    });

    const res = await resetPost();
    const body = await res.json();
    const saved = await readConfig();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.mode).toBe("factory");
    expect(resetUpdateStateMock).toHaveBeenCalledTimes(1);
    await expect(fs.access(path.join(DATA_DIR, "network.env"))).resolves.toBeUndefined();
    await expect(fs.access(path.join(DATA_DIR, "device-hostname.env"))).resolves.toBeUndefined();
    await expect(fs.access(path.join(DATA_DIR, "hotspot.env"))).rejects.toBeTruthy();
    await expect(fs.access(path.join(OPENCLAW_HOME, "secret.json"))).rejects.toBeTruthy();
    expect(saved.setup_complete).toBe(false);
    expect(saved.password_configured).toBe(false);
    expect(saved.wifi_configured).toBe(false);
    expect(saved.ai_model_configured).toBe(false);
    expect(execFileAsyncMock).toHaveBeenCalledWith(
      "nmcli",
      ["connection", "delete", "HomeWiFi"],
      { timeout: 10_000 },
    );
    expect(execFileAsyncMock).toHaveBeenCalledWith(
      "nmcli",
      ["connection", "delete", "CustomSetup"],
      { timeout: 10_000 },
    );
    expect(restartAPMock).not.toHaveBeenCalled();
    await vi.runOnlyPendingTimersAsync();
    expect(restartAPMock).toHaveBeenCalledTimes(1);
    expect(execFileAsyncMock).toHaveBeenCalledWith(
      "systemctl",
      ["start", "clawbox-root-update@reboot.service"],
      { timeout: 10_000 },
    );
    vi.useRealTimers();
  });

  it("rejects unknown reset modes", async () => {
    const res = await resetPost(jsonRequest({ mode: "network" }));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toContain("Reset mode");
  });
});
