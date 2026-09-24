import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  readConfig: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({
  default: { readFile: mocks.readFile },
  readFile: mocks.readFile,
}));
vi.mock("@/lib/openclaw-config", () => ({
  readConfig: mocks.readConfig,
  updateConfig: vi.fn(),
}));

const { getProxyConfig } = await import("@/lib/channels/proxy");

describe("proxy configuration migration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.readFile.mockRejectedValue(new Error("proxy file does not exist"));
    mocks.readConfig.mockResolvedValue({
      channels: {
        telegram: { proxy: "http://192.168.1.4:7890" },
        discord: { proxy: "http://192.168.1.12:7890/" },
      },
    });
  });

  it("preserves existing native channel proxies when the dedicated file is missing", async () => {
    await expect(getProxyConfig()).resolves.toMatchObject({
      channels: {
        telegram: { mode: "channel", url: "http://192.168.1.4:7890" },
        discord: { mode: "channel", url: "http://192.168.1.12:7890" },
      },
    });
  });

  it("does not override an explicit direct mode with a legacy proxy", async () => {
    mocks.readFile.mockResolvedValue(JSON.stringify({
      global: { enabled: false, url: "" },
      channels: { telegram: { mode: "direct", url: "" } },
    }));

    await expect(getProxyConfig()).resolves.toMatchObject({
      channels: { telegram: { mode: "direct", url: "" } },
    });
  });
});
