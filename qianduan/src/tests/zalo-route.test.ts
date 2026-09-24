import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = {
  getAll: vi.fn(),
  getZaloBotToken: vi.fn(),
  getZaloConfig: vi.fn(),
  getZaloProxy: vi.fn(),
  normalizeZaloProxy: vi.fn((value: string) => value.trim()),
  prepareZaloPlugin: vi.fn(),
  restartZaloGateway: vi.fn(),
  saveZaloConfig: vi.fn(),
  validateZaloBotToken: vi.fn(),
  setMany: vi.fn(),
};

vi.mock("@/lib/config-store", () => ({
  getAll: mocks.getAll,
  setMany: mocks.setMany,
}));
vi.mock("@/lib/channels/zalo", () => ({
  getZaloBotToken: mocks.getZaloBotToken,
  getZaloConfig: mocks.getZaloConfig,
  getZaloProxy: mocks.getZaloProxy,
  normalizeZaloProxy: mocks.normalizeZaloProxy,
  prepareZaloPlugin: mocks.prepareZaloPlugin,
  restartZaloGateway: mocks.restartZaloGateway,
  saveZaloConfig: mocks.saveZaloConfig,
  validateZaloBotToken: mocks.validateZaloBotToken,
}));

let post: (request: Request) => Promise<Response>;

beforeAll(async () => {
  ({ POST: post } = await import("@/app/setup-api/channels/zalo/route"));
});

beforeEach(() => {
  Object.values(mocks).forEach((mock) => mock.mockReset());
  mocks.getAll.mockResolvedValue({ ai_model_configured: true });
  mocks.getZaloBotToken.mockResolvedValue(null);
  mocks.getZaloProxy.mockResolvedValue(null);
  mocks.normalizeZaloProxy.mockImplementation((value: string) => value.trim());
  mocks.prepareZaloPlugin.mockResolvedValue(undefined);
  mocks.restartZaloGateway.mockResolvedValue(undefined);
  mocks.saveZaloConfig.mockResolvedValue({ configured: true, enabled: true, hasToken: true, proxy: "http://192.168.1.10:7890", proxyConfigured: true, dmPolicy: "pairing", groupPolicy: "disabled" });
  mocks.setMany.mockResolvedValue(undefined);
  mocks.validateZaloBotToken.mockResolvedValue({ id: "42", name: "ClawBox Zalo" });
});

function request(body: unknown): Request {
  return new Request("http://localhost/setup-api/channels/zalo", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("Zalo proxy configuration route", () => {
  it("rejects a non-HTTP proxy before validating or saving credentials", async () => {
    mocks.normalizeZaloProxy.mockImplementation(() => {
      throw Object.assign(new Error("Enter a valid HTTP or HTTPS proxy URL."), { code: "invalid_proxy" });
    });

    const response = await post(request({ botToken: "123456789:secret_value", proxy: "socks5://192.168.1.10:7890", enabled: true }));

    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain("HTTP or HTTPS");
    expect(mocks.validateZaloBotToken).not.toHaveBeenCalled();
    expect(mocks.saveZaloConfig).not.toHaveBeenCalled();
  });

  it("passes the saved proxy to token validation and OpenClaw config", async () => {
    const response = await post(request({ botToken: "123456789:secret_value", proxy: "http://192.168.1.10:7890", enabled: true }));

    expect(response.status).toBe(200);
    expect(mocks.validateZaloBotToken).toHaveBeenCalledWith("123456789:secret_value", expect.any(Function), "http://192.168.1.10:7890");
    expect(mocks.saveZaloConfig).toHaveBeenCalledWith({ botToken: "123456789:secret_value", enabled: true, proxy: "http://192.168.1.10:7890" });
    expect(mocks.restartZaloGateway).toHaveBeenCalledTimes(1);
  });
});
