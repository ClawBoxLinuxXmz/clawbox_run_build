import { NextRequest } from "next/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const originalFetch = globalThis.fetch;
const fetchMock = vi.fn();
let webhookGet: (request: NextRequest) => Promise<Response>;
let webhookPost: (request: NextRequest) => Promise<Response>;

beforeAll(async () => {
  process.env.GATEWAY_URL = "http://127.0.0.1:18789";
  vi.resetModules();
  ({ GET: webhookGet, POST: webhookPost } = await import(
    "@/app/line/webhook/route"
  ));
});

beforeEach(() => {
  fetchMock.mockReset();
  globalThis.fetch = fetchMock as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
  delete process.env.GATEWAY_URL;
});

describe("LINE webhook proxy", () => {
  it("forwards POST bytes and the LINE signature unchanged", async () => {
    const body = new Uint8Array([0, 255, 13, 10, 123, 34, 97, 34, 58, 49, 125]);
    fetchMock.mockResolvedValue(
      new Response("accepted", {
        status: 202,
        headers: {
          "Content-Type": "text/plain",
          "Cache-Control": "public, max-age=300",
        },
      }),
    );
    const request = new NextRequest(
      "https://device.example/line/webhook?source=line",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/octet-stream",
          "x-line-signature": "line-signature-value",
        },
        body,
      },
    );

    const response = await webhookPost(request);
    const [target, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    const headers = new Headers(init.headers);

    expect(String(target)).toBe(
      "http://127.0.0.1:18789/line/webhook?source=line",
    );
    expect(init.method).toBe("POST");
    expect(new Uint8Array(init.body as ArrayBuffer)).toEqual(body);
    expect(headers.get("x-line-signature")).toBe("line-signature-value");
    expect(response.status).toBe(202);
    expect(await response.text()).toBe("accepted");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("forwards GET verification without adding a body", async () => {
    fetchMock.mockResolvedValue(new Response("ok", { status: 200 }));
    const request = new NextRequest("https://device.example/line/webhook", {
      method: "GET",
      headers: { "x-line-signature": "verification-signature" },
    });

    const response = await webhookGet(request);
    const [, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    const headers = new Headers(init.headers);

    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
    expect(headers.get("x-line-signature")).toBe("verification-signature");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("keeps proxy failures non-cacheable", async () => {
    fetchMock.mockRejectedValue(new Error("gateway down"));
    const request = new NextRequest("https://device.example/line/webhook", {
      method: "POST",
      headers: { "x-line-signature": "signature" },
      body: "{}",
    });

    const response = await webhookPost(request);
    const body = await response.json();

    expect(response.status).toBe(502);
    expect(body.error).toContain("Gateway unavailable");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });
});
