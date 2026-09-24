import { describe, expect, it } from "vitest";
import { parseWeComStatusPayload, type WeComConfigView } from "@/lib/channels/wecom";

const stored: WeComConfigView = {
  configured: true,
  enabled: true,
  hasSecret: true,
  botId: "bot-123",
  connectionMode: "websocket",
};

describe("WeCom channel status", () => {
  it("reports disabled and unconfigured states without probing", () => {
    expect(
      parseWeComStatusPayload(null, { ...stored, enabled: false }),
    ).toMatchObject({ state: "disabled", connected: false });
    expect(
      parseWeComStatusPayload(null, { ...stored, configured: false, hasSecret: false }),
    ).toMatchObject({ state: "not_configured", connected: false });
  });

  it("requires a running account and a successful probe before reporting connected", () => {
    const status = parseWeComStatusPayload(
      {
        gatewayReachable: true,
        channelAccounts: {
          wecom: [{ running: true, connected: false, probe: { ok: true } }],
        },
      },
      stored,
    );

    expect(status).toMatchObject({
      state: "connected",
      connected: true,
      running: true,
      probeOk: true,
    });
  });

  it("accepts an object account and surfaces probe failures", () => {
    const status = parseWeComStatusPayload(
      {
        gatewayReachable: true,
        channelAccounts: {
          wecom: { running: true, probe: { ok: false, error: "socket closed" } },
        },
      },
      stored,
    );

    expect(status).toMatchObject({
      state: "error",
      connected: false,
      lastError: "socket closed",
    });
  });

  it("reports a gateway error without exposing unrelated credential-shaped text", () => {
    const status = parseWeComStatusPayload(
      { gatewayReachable: false, error: "gateway unavailable" },
      stored,
    );

    expect(status).toMatchObject({ state: "error", connected: false });
    expect(status.lastError).toBe("gateway unavailable");
  });
});
