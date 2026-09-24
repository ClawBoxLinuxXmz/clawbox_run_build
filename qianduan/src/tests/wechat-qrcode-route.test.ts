import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getAll: vi.fn(),
  setMany: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock("child_process", () => ({ spawn: mocks.spawn }));
vi.mock("@/lib/config-store", () => ({
  getAll: mocks.getAll,
  setMany: mocks.setMany,
}));

type FakeChild = EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  killed: boolean;
  kill: ReturnType<typeof vi.fn>;
};

function createChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.kill = vi.fn(() => {
    child.killed = true;
    return true;
  });
  return child;
}

function request(body: unknown = {}): Request {
  return new Request("http://localhost/setup-api/wechat/qrcode", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function loadRoute() {
  vi.resetModules();
  return import("@/app/setup-api/wechat/qrcode/route");
}

describe("WeChat QR route", () => {
  let child: FakeChild;

  beforeEach(() => {
    mocks.getAll.mockReset();
    mocks.setMany.mockReset();
    mocks.spawn.mockReset();
    mocks.getAll.mockResolvedValue({ ai_model_configured: true });
    mocks.setMany.mockResolvedValue(undefined);
    child = createChild();
    mocks.spawn.mockReturnValue(child);
  });

  it("returns a session immediately and exposes the QR on a later poll", async () => {
    const route = await loadRoute();

    const start = await route.POST(request());
    const startBody = await start.json();

    expect(start.status).toBe(202);
    expect(startBody).toMatchObject({ pending: true, state: "starting" });
    expect(typeof startBody.sessionId).toBe("string");

    child.stdout.emit(
      "data",
      Buffer.from("Login URL: https://liteapp.weixin.qq.com/q/test-session\n"),
    );

    const poll = await route.POST(request({ sessionId: startBody.sessionId }));
    const pollBody = await poll.json();

    expect(poll.status).toBe(200);
    expect(pollBody).toMatchObject({
      success: true,
      state: "ready",
      sessionId: startBody.sessionId,
      qrUrl: "https://liteapp.weixin.qq.com/q/test-session",
    });
  });

  it("reuses an active QR and only starts a new process when refreshed", async () => {
    const route = await loadRoute();
    const start = await route.POST(request());
    const startBody = await start.json();

    child.stdout.emit(
      "data",
      Buffer.from("https://liteapp.weixin.qq.com/q/reusable\n"),
    );

    const reuse = await route.POST(request());
    const reuseBody = await reuse.json();
    expect(reuse.status).toBe(200);
    expect(reuseBody).toMatchObject({
      state: "ready",
      sessionId: startBody.sessionId,
      qrUrl: "https://liteapp.weixin.qq.com/q/reusable",
    });
    expect(mocks.spawn).toHaveBeenCalledTimes(1);

    const replacement = createChild();
    mocks.spawn.mockReturnValueOnce(replacement);
    const refreshed = await route.POST(request({ refresh: true }));
    const refreshedBody = await refreshed.json();

    expect(refreshed.status).toBe(202);
    expect(refreshedBody).toMatchObject({ pending: true, state: "starting" });
    expect(refreshedBody.sessionId).not.toBe(startBody.sessionId);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(mocks.spawn).toHaveBeenCalledTimes(2);
  });

  it("reports a failed login session instead of waiting for the request timeout", async () => {
    const route = await loadRoute();
    const start = await route.POST(request());
    const startBody = await start.json();

    child.emit("close");

    const poll = await route.POST(request({ sessionId: startBody.sessionId }));
    const pollBody = await poll.json();

    expect(poll.status).toBe(502);
    expect(pollBody).toMatchObject({
      state: "failed",
      sessionId: startBody.sessionId,
    });
  });

  it("keeps the AI prerequisite before starting a login process", async () => {
    mocks.getAll.mockResolvedValue({ ai_model_configured: false });
    const route = await loadRoute();

    const response = await route.POST(request());
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error).toContain("AI provider");
    expect(mocks.spawn).not.toHaveBeenCalled();
  });
});
