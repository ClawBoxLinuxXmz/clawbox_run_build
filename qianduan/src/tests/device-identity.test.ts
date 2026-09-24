import fs from "fs/promises";
import os from "os";
import path from "path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const TEST_ROOT = path.join(
  os.tmpdir(),
  `clawbox-device-identity-${process.pid}-${Date.now()}`,
);
const DATA_DIR = path.join(TEST_ROOT, "data");
const IDENTITY_PATH = path.join(DATA_DIR, "device-identity.json");
const realReadFile = fs.readFile.bind(fs);

beforeAll(async () => {
  process.env.CLAWBOX_ROOT = TEST_ROOT;
  await fs.mkdir(DATA_DIR, { recursive: true });
});

beforeEach(async () => {
  await fs.rm(DATA_DIR, { recursive: true, force: true });
  await fs.mkdir(DATA_DIR, { recursive: true });
  vi.resetModules();
  vi.restoreAllMocks();
  delete process.env.CLAWBOX_DEVICE_HOSTNAME;
  delete process.env.CLAWBOX_LOCAL_DNS_ALIAS;
});

afterAll(async () => {
  delete process.env.CLAWBOX_ROOT;
  delete process.env.CLAWBOX_DEVICE_HOSTNAME;
  delete process.env.CLAWBOX_LOCAL_DNS_ALIAS;
  await fs.rm(TEST_ROOT, { recursive: true, force: true });
});

describe("device identity", () => {
  it("prefers explicit hostname and local DNS alias from env", async () => {
    process.env.CLAWBOX_DEVICE_HOSTNAME = "ClawBox-Lab-01";
    process.env.CLAWBOX_LOCAL_DNS_ALIAS = "clawbox.home.arpa";

    const { getDeviceAccessInfo } = await import("@/lib/device-identity");
    const info = await getDeviceAccessInfo();

    expect(info.hostname).toBe("clawbox-lab-01");
    expect(info.mdnsHost).toBe("clawbox-lab-01.local");
    expect(info.accessUrl).toBe("http://clawbox-lab-01.local/");
    expect(info.localDnsAlias).toBe("clawbox.home.arpa");
  });

  it("reuses a persisted identity when present", async () => {
    await fs.writeFile(
      IDENTITY_PATH,
      JSON.stringify({ hostname: "clawbox-a1b2c3", localDnsAlias: null }),
      "utf-8",
    );

    const { getDeviceAccessInfo } = await import("@/lib/device-identity");
    const info = await getDeviceAccessInfo();

    expect(info.hostname).toBe("clawbox-a1b2c3");
    expect(info.mdnsHost).toBe("clawbox-a1b2c3.local");
  });

  it("persists a derived hostname when no stored identity exists", async () => {
    vi.spyOn(fs, "readFile").mockImplementation(async (target, encoding) => {
      if (String(target).endsWith("/sys/class/net/wlan0/address")) {
        return "02:11:22:33:44:ab\n" as never;
      }
      if (String(target).endsWith("/etc/machine-id")) {
        return "00112233445566778899aabbccddeeff\n" as never;
      }
      return realReadFile(target as Parameters<typeof realReadFile>[0], encoding as never);
    });

    const { getDeviceAccessInfo } = await import("@/lib/device-identity");
    const info = await getDeviceAccessInfo();
    const saved = JSON.parse(await fs.readFile(IDENTITY_PATH, "utf-8"));

    expect(info.hostname).toBe("clawbox-3344ab");
    expect(saved.hostname).toBe("clawbox-3344ab");
  });
});
