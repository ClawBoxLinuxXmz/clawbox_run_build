import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { redirectToSetup } from "@/lib/redirect";

describe("redirectToSetup", () => {
  it("uses the incoming host instead of the server bind host", () => {
    const request = new NextRequest("http://0.0.0.0/", {
      headers: {
        host: "clawbox-947d364.local",
      },
    });

    const response = redirectToSetup(request);
    expect(response.headers.get("location")).toBe("http://clawbox-947d364.local/setup");
  });
});
