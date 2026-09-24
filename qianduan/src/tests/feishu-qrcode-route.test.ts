import { beforeEach, describe, expect, it, vi } from "vitest";

interface RegisterOptions {
  source?: string;
  signal?: AbortSignal;
  createOnly?: boolean;
  onStatusChange?: (info: {
    status: "polling" | "slow_down" | "domain_switched";
  }) => void;
  onQRCodeReady: (info: { url: string; expireIn: number }) => void;
}

interface RegisterResult {
  client_id: string;
  client_secret: string;
  user_info?: {
    tenant_brand?: "feishu" | "lark";
    open_id?: string;
  };
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

const OWNER_A = "11111111-1111-4111-8111-111111111111";
const OWNER_B = "22222222-2222-4222-8222-222222222222";
const UNKNOWN_SESSION = "99999999-9999-4999-8999-999999999999";
const APP_ID = "cli_1234567890";
const APP_SECRET = "abcdefghijklmnopqrstuvwxyz123456";
const OWNER_OPEN_ID = "ou_7dab8a3d3cdcc9da365777c7ad535d62";
const QR_URL = "https://accounts.feishu.cn/device?code=temporary";

const mocks = vi.hoisted(() => ({
  getAll: vi.fn(),
  setMany: vi.fn(),
  save: vi.fn(),
  restart: vi.fn(),
  wait: vi.fn(),
  register: vi.fn(),
}));

const registrations: Array<{
  options: RegisterOptions;
  deferred: Deferred<RegisterResult>;
}> = [];

vi.mock("@larksuiteoapi/node-sdk", () => ({
  registerApp: mocks.register,
}));
vi.mock("@/lib/config-store", () => ({
  getAll: mocks.getAll,
  setMany: mocks.setMany,
}));
vi.mock("@/lib/channels/feishu", () => ({
  saveFeishuConfig: mocks.save,
  waitForFeishuConnected: mocks.wait,
}));
vi.mock("@/lib/openclaw-config", () => ({
  restartGateway: mocks.restart,
}));

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function request(
  method: "GET" | "POST" | "DELETE",
  owner = OWNER_A,
  sessionId?: string,
): Request {
  const headers = new Headers({ "X-ClawBox-QR-Owner": owner });
  if (sessionId) headers.set("X-ClawBox-QR-Session", sessionId);
  return new Request("http://localhost/setup-api/channels/feishu/qrcode", {
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
  const route = await import("@/app/setup-api/channels/feishu/qrcode/route");
  const domain = await import("@/lib/channels/feishu-qrcode");
  return { route, domain };
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
  registrations.length = 0;
  Object.values(mocks).forEach((mock) => mock.mockReset());
  mocks.getAll.mockResolvedValue({ ai_model_configured: true });
  mocks.setMany.mockResolvedValue(undefined);
  mocks.save.mockResolvedValue({
    configured: true,
    enabled: true,
    hasAppSecret: true,
    appId: APP_ID,
    domain: "feishu",
  });
  mocks.restart.mockResolvedValue(undefined);
  mocks.wait.mockResolvedValue({ connected: true });
  mocks.register.mockImplementation((options: RegisterOptions) => {
    const registration = { options, deferred: deferred<RegisterResult>() };
    registrations.push(registration);
    options.onQRCodeReady({ url: QR_URL, expireIn: 600 });
    return registration.deferred.promise;
  });
});

describe("Feishu QR route ownership", () => {
  it("requires a strong owner token and returns stable errors", async () => {
    const { route } = await loadModules();

    const response = await route.POST(request("POST", "short"));
    const body = await response.json();

    expect(response.status).toBe(400);
    expectNoStore(response);
    expect(body.errorCode).toBe("qr_owner_invalid");
    expect(mocks.register).not.toHaveBeenCalled();
  });

  it("blocks setup until AI is configured", async () => {
    mocks.getAll.mockResolvedValue({});
    const { route } = await loadModules();

    const response = await route.POST(request("POST"));

    expect(response.status).toBe(409);
    expect((await response.json()).errorCode).toBe("ai_model_required");
    expect(mocks.register).not.toHaveBeenCalled();
  });

  it("only exposes the QR session to its owner", async () => {
    const { route } = await loadModules();
    const started = await (await route.POST(request("POST"))).json();

    const ownerResponse = route.GET(
      request("GET", OWNER_A, started.sessionId),
    );
    const otherResponse = route.GET(request("GET", OWNER_B));
    const staleResponse = route.GET(
      request("GET", OWNER_A, UNKNOWN_SESSION),
    );
    const ownerBody = await ownerResponse.json();
    const otherBody = await otherResponse.json();
    expect(ownerBody.session.qrUrl).toBe(QR_URL);
    expect(otherBody.session).toBeNull();
    expect(JSON.stringify(otherBody)).not.toContain(QR_URL);
    expect(staleResponse.status).toBe(409);
    const staleBody = await staleResponse.json();
    expect(staleBody.errorCode).toBe("qr_session_mismatch");
    expect(JSON.stringify(staleBody)).not.toContain(QR_URL);
  });

  it("does not let another owner replace or cancel an active session", async () => {
    const { route } = await loadModules();
    const started = await (await route.POST(request("POST"))).json();
    const signal = registrations[0].options.signal;

    const replaceResponse = await route.POST(request("POST", OWNER_B));
    const deleteResponse = route.DELETE(
      request("DELETE", OWNER_B, started.sessionId),
    );

    expect(replaceResponse.status).toBe(409);
    expect((await replaceResponse.json()).errorCode).toBe(
      "qr_session_conflict",
    );
    expect(deleteResponse.status).toBe(409);
    expect((await deleteResponse.json()).errorCode).toBe(
      "qr_session_mismatch",
    );
    expect(signal?.aborted).toBe(false);
    expect(registrations).toHaveLength(1);
  });

  it("uses the optional session header to reject a stale refresh", async () => {
    const { route } = await loadModules();
    const first = await (await route.POST(request("POST"))).json();
    const firstSignal = registrations[0].options.signal;

    const staleResponse = await route.POST(
      request("POST", OWNER_A, UNKNOWN_SESSION),
    );
    expect(staleResponse.status).toBe(409);
    expect((await staleResponse.json()).errorCode).toBe(
      "qr_session_mismatch",
    );
    expect(firstSignal?.aborted).toBe(false);

    const refreshed = await route.POST(
      request("POST", OWNER_A, first.sessionId),
    );
    const refreshedBody = await refreshed.json();
    expect(refreshed.status).toBe(200);
    expect(firstSignal?.aborted).toBe(true);
    expect(refreshedBody.sessionId).not.toBe(first.sessionId);
  });

  it("requires both owner and session ID to cancel", async () => {
    const { route } = await loadModules();
    const started = await (await route.POST(request("POST"))).json();
    const signal = registrations[0].options.signal;

    const missing = route.DELETE(request("DELETE"));
    const wrong = route.DELETE(
      request("DELETE", OWNER_A, UNKNOWN_SESSION),
    );
    expect(missing.status).toBe(400);
    expect((await missing.json()).errorCode).toBe("qr_session_required");
    expect(wrong.status).toBe(409);
    expect(signal?.aborted).toBe(false);

    const cancelled = route.DELETE(
      request("DELETE", OWNER_A, started.sessionId),
    );
    expect(cancelled.status).toBe(200);
    expect((await cancelled.json()).session.status).toBe("cancelled");
    expect(signal?.aborted).toBe(true);
  });
});

describe("Feishu QR state transitions", () => {
  it.each([
    ["feishu" as const, "feishu" as const],
    ["lark" as const, "lark" as const],
  ])("saves and connects the %s tenant branch", async (tenantBrand, domain) => {
    const { route } = await loadModules();
    const startBody = await (await route.POST(request("POST"))).json();

    registrations[0].deferred.resolve({
      client_id: APP_ID,
      client_secret: APP_SECRET,
      user_info: { tenant_brand: tenantBrand, open_id: OWNER_OPEN_ID },
    });
    const connected = await waitForStatus(
      route.GET,
      "connected",
      OWNER_A,
      startBody.sessionId,
    );

    expect(mocks.save).toHaveBeenCalledWith({
      appId: APP_ID,
      appSecret: APP_SECRET,
      domain,
      enabled: true,
      ownerOpenId: OWNER_OPEN_ID,
    });
    expect(mocks.restart).toHaveBeenCalledOnce();
    expect(mocks.wait).toHaveBeenCalledOnce();
    expect(connected).toMatchObject({
      status: "connected",
      qrUrl: null,
      domain,
      connected: true,
      errorCode: null,
      error: null,
    });
    expect(JSON.stringify(connected)).not.toContain(APP_SECRET);
  });

  it("keeps the Lark domain when the final SDK result omits tenant_brand", async () => {
    const { route } = await loadModules();
    const started = await (await route.POST(request("POST"))).json();
    registrations[0].options.onStatusChange?.({ status: "domain_switched" });
    registrations[0].deferred.resolve({
      client_id: APP_ID,
      client_secret: APP_SECRET,
    });

    await waitForStatus(
      route.GET,
      "connected",
      OWNER_A,
      started.sessionId,
    );
    expect(mocks.save).toHaveBeenCalledWith(
      expect.objectContaining({ domain: "lark" }),
    );
  });

  it("keeps saving protected from refresh and cancellation", async () => {
    const save = deferred<unknown>();
    mocks.save.mockReturnValue(save.promise);
    const { route } = await loadModules();
    const started = await (await route.POST(request("POST"))).json();
    registrations[0].deferred.resolve({
      client_id: APP_ID,
      client_secret: APP_SECRET,
      user_info: { tenant_brand: "feishu" },
    });
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
    expect(registrations).toHaveLength(1);

    save.resolve({});
    await waitForStatus(route.GET, "connected", OWNER_A, started.sessionId);
  });

  it("lets the owner cancel an expired session", async () => {
    const { route } = await loadModules();
    const started = await (await route.POST(request("POST"))).json();
    registrations[0].deferred.reject(
      Object.assign(new Error("expired"), { code: "expired_token" }),
    );
    const expired = await waitForStatus(
      route.GET,
      "expired",
      OWNER_A,
      started.sessionId,
    );
    expect(expired.errorCode).toBe("qr_expired");

    const cancelled = route.DELETE(
      request("DELETE", OWNER_A, started.sessionId),
    );
    expect(cancelled.status).toBe(200);
    expect((await cancelled.json()).session.status).toBe("cancelled");
  });

  it("enforces QR/manual configuration mutual exclusion", async () => {
    const { route, domain } = await loadModules();
    const started = await (await route.POST(request("POST"))).json();

    expect(() => domain.beginFeishuManualConfig()).toThrowError(
      expect.objectContaining({ errorCode: "qr_session_busy" }),
    );
    route.DELETE(request("DELETE", OWNER_A, started.sessionId));

    const release = domain.beginFeishuManualConfig();
    const blocked = await route.POST(request("POST"));
    expect(blocked.status).toBe(409);
    expect((await blocked.json()).errorCode).toBe("manual_config_busy");
    release();

    expect((await route.POST(request("POST"))).status).toBe(200);
  });

  it("returns private-safe stable errors for SDK and save failures", async () => {
    mocks.register.mockRejectedValue(
      new Error(`registration failed: ${APP_SECRET}`),
    );
    let loaded = await loadModules();
    let response = await loaded.route.POST(request("POST"));
    let body = await response.json();
    expect(response.status).toBe(502);
    expect(body.errorCode).toBe("qr_authorization_failed");
    expect(JSON.stringify(body)).not.toContain(APP_SECRET);

    mocks.register.mockReset();
    mocks.register.mockImplementation((options: RegisterOptions) => {
      const registration = { options, deferred: deferred<RegisterResult>() };
      registrations.push(registration);
      options.onQRCodeReady({ url: QR_URL, expireIn: 600 });
      return registration.deferred.promise;
    });
    mocks.save.mockRejectedValue(new Error(`save failed: ${APP_SECRET}`));
    registrations.length = 0;
    loaded = await loadModules();
    const started = await (await loaded.route.POST(request("POST"))).json();
    registrations[0].deferred.resolve({
      client_id: APP_ID,
      client_secret: APP_SECRET,
      user_info: { tenant_brand: "feishu" },
    });
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

