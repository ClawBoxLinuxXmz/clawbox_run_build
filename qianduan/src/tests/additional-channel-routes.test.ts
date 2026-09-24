import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

type EmptyPost = () => Promise<Response>;
type RequestPost = (request: Request) => Promise<Response>;

const SESSION_ID = "qr-session-123";
const OWNER_TOKEN = "owner-token-123";
const WRONG_OWNER_TOKEN = "wrong-owner-token";

const mocks = {
  getAll: vi.fn(),
  getZaloPersonalConfig: vi.fn(),
  startZaloPersonalQrLogin: vi.fn(),
  getZaloPersonalQrLogin: vi.fn(),
  cancelZaloPersonalQrLogin: vi.fn(),
  getSignalConfig: vi.fn(),
  startSignalQrLogin: vi.fn(),
  getSignalQrLogin: vi.fn(),
  cancelSignalQrLogin: vi.fn(),
  getClawBotConfig: vi.fn(),
  startClawBotQrLogin: vi.fn(),
  getClawBotQrLogin: vi.fn(),
  cancelClawBotQrLogin: vi.fn(),
};

let zaloPersonalQrPost: EmptyPost;
let zaloPersonalStatusPost: RequestPost;
let zaloPersonalCancelPost: RequestPost;
let signalQrPost: RequestPost;
let signalStatusPost: RequestPost;
let signalCancelPost: RequestPost;
let clawBotQrPost: EmptyPost;
let clawBotStatusPost: RequestPost;
let clawBotCancelPost: RequestPost;

function jsonRequest(body: unknown): Request {
  return new Request("http://localhost/test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function rawRequest(body: string): Request {
  return new Request("http://localhost/test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
}

beforeAll(async () => {
  vi.resetModules();
  vi.doMock("@/lib/config-store", () => ({ getAll: mocks.getAll }));
  vi.doMock("@/lib/channels/zalouser", () => ({
    getZaloPersonalConfig: mocks.getZaloPersonalConfig,
    startZaloPersonalQrLogin: mocks.startZaloPersonalQrLogin,
    getZaloPersonalQrLogin: mocks.getZaloPersonalQrLogin,
    cancelZaloPersonalQrLogin: mocks.cancelZaloPersonalQrLogin,
  }));
  vi.doMock("@/lib/channels/signal", () => ({
    getSignalConfig: mocks.getSignalConfig,
    startSignalQrLogin: mocks.startSignalQrLogin,
    getSignalQrLogin: mocks.getSignalQrLogin,
    cancelSignalQrLogin: mocks.cancelSignalQrLogin,
  }));
  vi.doMock("@/lib/channels/zalo-clawbot", () => ({
    getClawBotConfig: mocks.getClawBotConfig,
    startClawBotQrLogin: mocks.startClawBotQrLogin,
    getClawBotQrLogin: mocks.getClawBotQrLogin,
    cancelClawBotQrLogin: mocks.cancelClawBotQrLogin,
  }));

  ({ POST: zaloPersonalQrPost } = await import(
    "@/app/setup-api/channels/zalouser/qrcode/route"
  ));
  ({ POST: zaloPersonalStatusPost } = await import(
    "@/app/setup-api/channels/zalouser/login-status/route"
  ));
  ({ POST: zaloPersonalCancelPost } = await import(
    "@/app/setup-api/channels/zalouser/cancel/route"
  ));
  ({ POST: signalQrPost } = await import(
    "@/app/setup-api/channels/signal/qrcode/route"
  ));
  ({ POST: signalStatusPost } = await import(
    "@/app/setup-api/channels/signal/login-status/route"
  ));
  ({ POST: signalCancelPost } = await import(
    "@/app/setup-api/channels/signal/cancel/route"
  ));
  ({ POST: clawBotQrPost } = await import(
    "@/app/setup-api/channels/zalo-clawbot/route"
  ));
  ({ POST: clawBotStatusPost } = await import(
    "@/app/setup-api/channels/zalo-clawbot/login-status/route"
  ));
  ({ POST: clawBotCancelPost } = await import(
    "@/app/setup-api/channels/zalo-clawbot/cancel/route"
  ));
});

beforeEach(() => {
  Object.values(mocks).forEach((mock) => mock.mockReset());

  mocks.getAll.mockResolvedValue({ ai_model_configured: true });
  mocks.getZaloPersonalConfig.mockResolvedValue({ riskAccepted: true });
  mocks.getSignalConfig.mockResolvedValue({ cliPath: "signal-cli" });
  mocks.getClawBotConfig.mockResolvedValue({ configured: false });

  mocks.startZaloPersonalQrLogin.mockResolvedValue({
    sessionId: SESSION_ID,
    ownerToken: OWNER_TOKEN,
  });
  mocks.startSignalQrLogin.mockResolvedValue({
    sessionId: SESSION_ID,
    ownerToken: OWNER_TOKEN,
  });
  mocks.startClawBotQrLogin.mockResolvedValue({
    sessionId: SESSION_ID,
    ownerToken: OWNER_TOKEN,
  });

  mocks.getZaloPersonalQrLogin.mockImplementation(
    (_sessionId: string, ownerToken: string) =>
      ownerToken === OWNER_TOKEN ? { state: "pending" } : null,
  );
  mocks.getSignalQrLogin.mockImplementation(
    (_sessionId: string, ownerToken: string) =>
      ownerToken === OWNER_TOKEN ? { state: "pending" } : null,
  );
  mocks.getClawBotQrLogin.mockImplementation(
    (_sessionId: string, ownerToken: string) =>
      ownerToken === OWNER_TOKEN ? { state: "pending" } : null,
  );
  mocks.cancelZaloPersonalQrLogin.mockImplementation(
    (_sessionId: string, ownerToken: string) => ownerToken === OWNER_TOKEN,
  );
  mocks.cancelSignalQrLogin.mockImplementation(
    (_sessionId: string, ownerToken: string) => ownerToken === OWNER_TOKEN,
  );
  mocks.cancelClawBotQrLogin.mockImplementation(
    (_sessionId: string, ownerToken: string) => ownerToken === OWNER_TOKEN,
  );
});

afterAll(() => {
  vi.doUnmock("@/lib/config-store");
  vi.doUnmock("@/lib/channels/zalouser");
  vi.doUnmock("@/lib/channels/signal");
  vi.doUnmock("@/lib/channels/zalo-clawbot");
});

describe("additional channel QR setup gates", () => {
  it("blocks every QR login until the AI provider is configured", async () => {
    mocks.getAll.mockResolvedValue({ wifi_configured: true });

    const cases: Array<{
      route: () => Promise<Response>;
      start: typeof mocks.startSignalQrLogin;
    }> = [
      { route: zaloPersonalQrPost, start: mocks.startZaloPersonalQrLogin },
      { route: () => signalQrPost(jsonRequest({})), start: mocks.startSignalQrLogin },
      { route: clawBotQrPost, start: mocks.startClawBotQrLogin },
    ];

    for (const testCase of cases) {
      const response = await testCase.route();
      const body = await response.json();

      expect(response.status).toBe(409);
      expect(body.error).toContain("AI provider");
      expect(testCase.start).not.toHaveBeenCalled();
    }
  });
});

describe("additional channel QR JSON validation", () => {
  it("rejects malformed JSON and incomplete ownership parameters", async () => {
    const routes = [
      zaloPersonalStatusPost,
      zaloPersonalCancelPost,
      signalStatusPost,
      signalCancelPost,
      clawBotStatusPost,
      clawBotCancelPost,
    ];

    for (const route of routes) {
      const malformedResponse = await route(rawRequest("{"));
      const incompleteResponse = await route(
        jsonRequest({ sessionId: SESSION_ID }),
      );

      expect(malformedResponse.status).toBe(400);
      expect(await malformedResponse.json()).toEqual({ error: "Invalid JSON" });
      expect(incompleteResponse.status).toBe(400);
      expect((await incompleteResponse.json()).error).toContain(
        "sessionId and ownerToken",
      );
    }
  });

  it("validates Signal QR options before starting signal-cli", async () => {
    const malformedResponse = await signalQrPost(rawRequest("{"));
    const cliPathResponse = await signalQrPost(
      jsonRequest({ cliPath: 123 }),
    );
    const timeoutResponse = await signalQrPost(
      jsonRequest({ timeoutMs: 2_999 }),
    );

    expect(malformedResponse.status).toBe(400);
    expect(cliPathResponse.status).toBe(400);
    expect((await cliPathResponse.json()).error).toContain("cliPath");
    expect(timeoutResponse.status).toBe(400);
    expect((await timeoutResponse.json()).error).toContain("3000 and 300000");
    expect(mocks.startSignalQrLogin).not.toHaveBeenCalled();
  });
});

describe("additional channel QR session ownership", () => {
  it("returns 404 from every status route for the wrong ownerToken", async () => {
    const cases = [
      { route: zaloPersonalStatusPost, get: mocks.getZaloPersonalQrLogin },
      { route: signalStatusPost, get: mocks.getSignalQrLogin },
      { route: clawBotStatusPost, get: mocks.getClawBotQrLogin },
    ];

    for (const testCase of cases) {
      const response = await testCase.route(
        jsonRequest({ sessionId: SESSION_ID, ownerToken: WRONG_OWNER_TOKEN }),
      );

      expect(response.status).toBe(404);
      expect((await response.json()).error).toContain("not found or expired");
      expect(testCase.get).toHaveBeenCalledWith(
        SESSION_ID,
        WRONG_OWNER_TOKEN,
      );
    }
  });

  it("returns 404 from every cancel route for the wrong ownerToken", async () => {
    const cases = [
      { route: zaloPersonalCancelPost, cancel: mocks.cancelZaloPersonalQrLogin },
      { route: signalCancelPost, cancel: mocks.cancelSignalQrLogin },
      { route: clawBotCancelPost, cancel: mocks.cancelClawBotQrLogin },
    ];

    for (const testCase of cases) {
      const response = await testCase.route(
        jsonRequest({ sessionId: SESSION_ID, ownerToken: WRONG_OWNER_TOKEN }),
      );

      expect(response.status).toBe(404);
      expect((await response.json()).error).toContain("not found");
      expect(testCase.cancel).toHaveBeenCalledWith(
        SESSION_ID,
        WRONG_OWNER_TOKEN,
      );
    }
  });
});
