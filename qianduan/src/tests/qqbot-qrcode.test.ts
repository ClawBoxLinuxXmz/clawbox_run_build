import type { QrConnectCallbacks } from "@tencent-connect/qqbot-connector";
import { beforeEach, describe, expect, it, vi } from "vitest";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

const OWNER_A = "11111111-1111-4111-8111-111111111111";
const OWNER_B = "22222222-2222-4222-8222-222222222222";
const UNKNOWN_SESSION = "99999999-9999-4999-8999-999999999999";
const APP_ID = "1023456789";
const APP_SECRET = "qq-secret-from-scan";
const QR_URL = "https://q.qq.com/qqbot/openclaw/connect.html?task_id=test";

const mocks = vi.hoisted(() => ({
  startQrConnect: vi.fn(),
  stop: vi.fn(),
  getAll: vi.fn(),
  setMany: vi.fn(),
  save: vi.fn(),
  restart: vi.fn(),
  wait: vi.fn(),
}));

vi.mock("@tencent-connect/qqbot-connector", () => ({
  startQrConnect: mocks.startQrConnect,
}));
vi.mock("@/lib/config-store", () => ({
  getAll: mocks.getAll,
  setMany: mocks.setMany,
}));
vi.mock("@/lib/channels/qqbot", () => ({
  saveQQBotConfig: mocks.save,
  waitForQQBotConnected: mocks.wait,
}));
vi.mock("@/lib/openclaw-config", () => ({
  restartGateway: mocks.restart,
}));

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function request(
  method: "GET" | "POST" | "DELETE",
  owner = OWNER_A,
  sessionId?: string,
): Request {
  const headers = new Headers({ "X-ClawBox-QR-Owner": owner });
  if (sessionId) headers.set("X-ClawBox-QR-Session", sessionId);
  return new Request("http://localhost/setup-api/channels/qqbot/qrcode", {
    method,
    headers,
  });
}

function expectNoStore(response: Response): void {
  expect(response.headers.get("cache-control")).toContain("no-store");
  expect(response.headers.get("pragma")).toBe("no-cache");
}

async function loadModules() {
  vi.resetModules();
  const route = await import("@/app/setup-api/channels/qqbot/qrcode/route");
  const domain = await import("@/lib/channels/qqbot-qr");
  return { route, domain };
}

function callbacks(call = -1): QrConnectCallbacks {
  return mocks.startQrConnect.mock.calls.at(call)?.[0] as QrConnectCallbacks;
}

async function waitForStatus(
  get: (request: Request) => Response,
  status: string,
  owner = OWNER_A,
  sessionId?: string,
): Promise<Record<string, unknown>> {
  let session: Record<string, unknown> = {};
  await vi.waitFor(async () => {
    const response = get(request("GET", owner, sessionId));
    const payload = (await response.json()) as {
      session?: Record<string, unknown>;
    };
    session = payload.session || {};
    expect(session.status).toBe(status);
  });
  return session;
}

beforeEach(() => {
  Object.values(mocks).forEach((mock) => mock.mockReset());
  mocks.getAll.mockResolvedValue({ ai_model_configured: true });
  mocks.setMany.mockResolvedValue(undefined);
  mocks.save.mockResolvedValue({
    configured: true,
    enabled: true,
    hasClientSecret: true,
    appId: APP_ID,
  });
  mocks.restart.mockResolvedValue(undefined);
  mocks.wait.mockResolvedValue({ connected: true, state: "connected" });
  mocks.startQrConnect.mockImplementation((handlers: QrConnectCallbacks) => {
    handlers.onQrDisplayed?.(QR_URL);
    return mocks.stop;
  });
});

describe("QQ Bot QR route ownership", () => {
  it("requires a strong owner token and returns stable errors", async () => {
    const { route } = await loadModules();

    const response = await route.POST(request("POST", "short"));

    expect(response.status).toBe(400);
    expectNoStore(response);
    expect((await response.json()).errorCode).toBe("qr_owner_invalid");
    expect(mocks.startQrConnect).not.toHaveBeenCalled();
  });

  it("only exposes a QR session to its owner", async () => {
    const { route } = await loadModules();
    const started = await (await route.POST(request("POST"))).json();

    const ownerBody = await route
      .GET(request("GET", OWNER_A, started.sessionId))
      .json();
    const otherBody = await route.GET(request("GET", OWNER_B)).json();
    const staleResponse = route.GET(
      request("GET", OWNER_A, UNKNOWN_SESSION),
    );

    expect(ownerBody.session.qrUrl).toBe(QR_URL);
    expect(otherBody.session).toBeNull();
    expect(JSON.stringify(otherBody)).not.toContain(QR_URL);
    expect(staleResponse.status).toBe(409);
    expect((await staleResponse.json()).errorCode).toBe(
      "qr_session_mismatch",
    );
  });

  it("does not let another owner replace or cancel an active session", async () => {
    const { route } = await loadModules();
    const started = await (await route.POST(request("POST"))).json();

    const replace = await route.POST(request("POST", OWNER_B));
    const cancel = route.DELETE(
      request("DELETE", OWNER_B, started.sessionId),
    );

    expect(replace.status).toBe(409);
    expect((await replace.json()).errorCode).toBe("qr_session_conflict");
    expect(cancel.status).toBe(409);
    expect((await cancel.json()).errorCode).toBe("qr_session_mismatch");
    expect(mocks.stop).not.toHaveBeenCalled();
    expect(mocks.startQrConnect).toHaveBeenCalledOnce();
  });

  it("uses session headers to reject stale refresh and delete requests", async () => {
    const { route } = await loadModules();
    const first = await (await route.POST(request("POST"))).json();

    const staleRefresh = await route.POST(
      request("POST", OWNER_A, UNKNOWN_SESSION),
    );
    const missingDelete = route.DELETE(request("DELETE"));
    const staleDelete = route.DELETE(
      request("DELETE", OWNER_A, UNKNOWN_SESSION),
    );

    expect(staleRefresh.status).toBe(409);
    expect((await staleRefresh.json()).errorCode).toBe(
      "qr_session_mismatch",
    );
    expect(missingDelete.status).toBe(400);
    expect((await missingDelete.json()).errorCode).toBe(
      "qr_session_required",
    );
    expect(staleDelete.status).toBe(409);
    expect(mocks.stop).not.toHaveBeenCalled();

    const refreshed = await route.POST(
      request("POST", OWNER_A, first.sessionId),
    );
    const refreshedBody = await refreshed.json();
    expect(refreshed.status).toBe(200);
    expect(refreshedBody.sessionId).not.toBe(first.sessionId);
    expect(mocks.stop).toHaveBeenCalledOnce();
  });
});

describe("QQ Bot QR state transitions", () => {
  it("saves credentials server-side and never returns the AppSecret", async () => {
    const { route } = await loadModules();
    const started = await (await route.POST(request("POST"))).json();

    callbacks().onSuccess([{ appId: APP_ID, appSecret: APP_SECRET }]);
    const connected = await waitForStatus(
      route.GET,
      "connected",
      OWNER_A,
      started.sessionId,
    );

    expect(mocks.save).toHaveBeenCalledWith({
      appId: APP_ID,
      clientSecret: APP_SECRET,
      enabled: true,
    });
    expect(mocks.restart).toHaveBeenCalledOnce();
    expect(mocks.wait).toHaveBeenCalledOnce();
    expect(connected).toMatchObject({
      status: "connected",
      qrUrl: null,
      errorCode: null,
      error: null,
    });
    expect(JSON.stringify(connected)).not.toContain(APP_SECRET);
  });

  it("keeps saving protected from refresh and cancellation", async () => {
    const save = deferred<unknown>();
    mocks.save.mockReturnValue(save.promise);
    const { route } = await loadModules();
    const started = await (await route.POST(request("POST"))).json();
    callbacks().onSuccess([{ appId: APP_ID, appSecret: APP_SECRET }]);
    await waitForStatus(route.GET, "saving", OWNER_A, started.sessionId);

    const refresh = await route.POST(
      request("POST", OWNER_A, started.sessionId),
    );
    const cancel = route.DELETE(
      request("DELETE", OWNER_A, started.sessionId),
    );
    expect(refresh.status).toBe(409);
    expect((await refresh.json()).errorCode).toBe("qr_session_busy");
    expect(cancel.status).toBe(409);
    expect((await cancel.json()).errorCode).toBe("qr_session_busy");

    save.resolve({});
    await waitForStatus(route.GET, "connected", OWNER_A, started.sessionId);
  });

  it("keeps an SDK-expired session expired when onFailure follows", async () => {
    const { route } = await loadModules();
    const started = await (await route.POST(request("POST"))).json();

    callbacks().onQrExpired?.();
    callbacks().onFailure?.(new Error("expired"));
    const expired = await waitForStatus(
      route.GET,
      "expired",
      OWNER_A,
      started.sessionId,
    );

    expect(expired.errorCode).toBe("qr_expired");
    expect(expired.error).toContain("expired");
    const cancelled = route.DELETE(
      request("DELETE", OWNER_A, started.sessionId),
    );
    expect(cancelled.status).toBe(200);
    expect((await cancelled.json()).session.status).toBe("cancelled");
  });

  it("ignores SDK callbacks after the total session lifetime", async () => {
    vi.useFakeTimers();
    try {
      const { route } = await loadModules();
      const started = await (await route.POST(request("POST"))).json();

      await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
      callbacks().onQrDisplayed?.(QR_URL);
      callbacks().onSuccess([{ appId: APP_ID, appSecret: APP_SECRET }]);
      await Promise.resolve();

      const response = route.GET(
        request("GET", OWNER_A, started.sessionId),
      );
      const expired = (await response.json()).session;
      expect(expired).toMatchObject({
        status: "expired",
        qrUrl: null,
        expiresAt: null,
        errorCode: "qr_expired",
      });
      expect(mocks.save).not.toHaveBeenCalled();
      expect(mocks.restart).not.toHaveBeenCalled();
      expect(mocks.wait).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("enforces QR/manual configuration mutual exclusion", async () => {
    const { route, domain } = await loadModules();
    const started = await (await route.POST(request("POST"))).json();

    expect(() => domain.beginQQBotManualConfig()).toThrowError(
      expect.objectContaining({ errorCode: "qr_session_busy" }),
    );
    route.DELETE(request("DELETE", OWNER_A, started.sessionId));

    const release = domain.beginQQBotManualConfig();
    const blocked = await route.POST(request("POST"));
    expect(blocked.status).toBe(409);
    expect((await blocked.json()).errorCode).toBe("manual_config_busy");
    release();
    expect((await route.POST(request("POST"))).status).toBe(200);
  });

  it("returns private-safe stable errors for invalid QR and save failures", async () => {
    mocks.startQrConnect.mockImplementation((handlers: QrConnectCallbacks) => {
      handlers.onQrDisplayed?.("http://q.qq.com/not-secure");
      return mocks.stop;
    });
    let loaded = await loadModules();
    let response = await loaded.route.POST(request("POST"));
    let body = await response.json();
    expect(response.status).toBe(502);
    expect(body.errorCode).toBe("qr_invalid_url");
    expect(body.session.qrUrl).toBeNull();

    mocks.startQrConnect.mockReset();
    mocks.startQrConnect.mockImplementation((handlers: QrConnectCallbacks) => {
      handlers.onQrDisplayed?.(QR_URL);
      return mocks.stop;
    });
    mocks.save.mockRejectedValue(new Error(`save failed: ${APP_SECRET}`));
    loaded = await loadModules();
    const started = await (await loaded.route.POST(request("POST"))).json();
    callbacks().onSuccess([{ appId: APP_ID, appSecret: APP_SECRET }]);
    const failed = await waitForStatus(
      loaded.route.GET,
      "error",
      OWNER_A,
      started.sessionId,
    );
    expect(failed.errorCode).toBe("qr_save_failed");
    expect(JSON.stringify(failed)).not.toContain(APP_SECRET);
  });
});

