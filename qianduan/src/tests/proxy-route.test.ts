import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = {
  getProxyConfig: vi.fn(),
  getProxyChannelView: vi.fn(),
  saveProxySettings: vi.fn(),
  restartGateway: vi.fn(),
};

vi.mock("@/lib/channels/proxy", () => ({
  PROXY_CHANNEL_IDS: ["telegram", "discord", "whatsapp", "signal", "zalo", "openclaw-zaloclawbot", "zalouser"],
  getProxyConfig: mocks.getProxyConfig,
  getProxyChannelView: mocks.getProxyChannelView,
  saveProxySettings: mocks.saveProxySettings,
}));
vi.mock("@/lib/openclaw-config", () => ({ restartGateway: mocks.restartGateway }));

const { GET, POST } = await import("@/app/setup-api/proxy/route");

function request(body: unknown): Request {
  return new Request("http://localhost/setup-api/proxy", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("proxy settings route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getProxyConfig.mockResolvedValue({ global: { enabled: false, url: "" }, channels: {} });
    mocks.getProxyChannelView.mockResolvedValue({ mode: "direct", url: "", effectiveMode: "direct", effectiveProxy: null, globalEnabled: false, globalProxy: null });
    mocks.saveProxySettings.mockResolvedValue({ config: { global: { enabled: false, url: "" }, channels: {} }, channel: null });
    mocks.restartGateway.mockResolvedValue(undefined);
  });

  it("returns the global configuration and a selected channel view", async () => {
    const response = await GET(new Request("http://localhost/setup-api/proxy?channel=telegram"));
    expect(response.status).toBe(200);
    expect(mocks.getProxyChannelView).toHaveBeenCalledWith("telegram");
    expect(await response.json()).toMatchObject({ config: { global: { enabled: false } }, channel: { mode: "direct" } });
  });

  it("rejects an unsupported channel before writing", async () => {
    const response = await POST(request({ channelId: "qqbot", mode: "direct" }));
    expect(response.status).toBe(400);
    expect(mocks.saveProxySettings).not.toHaveBeenCalled();
  });

  it("saves a channel mode and reloads the Gateway", async () => {
    const response = await POST(request({ channelId: "telegram", mode: "channel", channelUrl: "http://192.168.1.10:7890" }));
    expect(response.status).toBe(200);
    expect(mocks.saveProxySettings).toHaveBeenCalledWith({ channelId: "telegram", mode: "channel", channelUrl: "http://192.168.1.10:7890", globalEnabled: undefined, globalUrl: undefined });
    expect(mocks.restartGateway).toHaveBeenCalledTimes(1);
  });
});
