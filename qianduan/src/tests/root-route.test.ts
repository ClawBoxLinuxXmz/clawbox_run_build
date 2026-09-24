import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

type RootRouteGet = (request: NextRequest) => Promise<Response>;

let rootGet: RootRouteGet;

beforeAll(async () => {
  vi.resetModules();
  ({ GET: rootGet } = await import("@/app/route"));
});

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("root route", () => {
  it("always redirects to /setup instead of requiring a sign-in", async () => {
    const request = new NextRequest("http://192.168.31.55/", {
      headers: {
        host: "clawbox-947d364.local",
      },
    });

    const response = await rootGet(request);
    expect(response.headers.get("location")).toBe(
      "http://clawbox-947d364.local/setup",
    );
    expect(response.status).toBe(302);
  });
});
