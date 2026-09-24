import fs from "fs/promises";
import path from "path";
import { describe, expect, it } from "vitest";
import { isLocalChannelPreview, resolveSetupFlowState } from "@/lib/setup-flow";

describe("setup flow UI behavior", () => {
  it("only enables the channel preview bypass on local hosts", () => {
    expect(
      isLocalChannelPreview({ hostname: "localhost", search: "?preview=channels" }),
    ).toBe(true);
    expect(
      isLocalChannelPreview({ hostname: "127.0.0.1", search: "?preview=channels" }),
    ).toBe(true);
    expect(
      isLocalChannelPreview({ hostname: "clawbox-123.local", search: "?preview=channels" }),
    ).toBe(false);
    expect(
      isLocalChannelPreview({ hostname: "localhost", search: "?preview=wifi" }),
    ).toBe(false);
  });

  it("keeps the wizard on the WiFi step while the hotspot is active", () => {
    expect(
      resolveSetupFlowState({
        setup_complete: true,
        wifi_configured: true,
        wifi_mode: "ap",
        hotspot_active: true,
      }),
    ).toEqual({
      currentStep: 1,
      setupComplete: false,
    });
  });

  it("advances to the done step only after leaving hotspot mode", () => {
    expect(
      resolveSetupFlowState({
        wifi_configured: true,
        wifi_mode: "client",
        hotspot_active: false,
      }),
    ).toEqual({
      currentStep: 2,
      setupComplete: false,
    });
  });

  it("does not keep the old auto-advance timeout in WifiStep", async () => {
    const source = await fs.readFile(
      path.join(process.cwd(), "src/components/WifiStep.tsx"),
      "utf-8",
    );

    expect(source).not.toMatch(/setTimeout\s*\(\s*\(\)\s*=>\s*onNext/);
  });

  it("keeps Telegram locked behind AI setup and supports web pairing approval", async () => {
    const source = await fs.readFile(
      path.join(process.cwd(), "src/components/DoneStep.tsx"),
      "utf-8",
    );

    expect(source).toContain("const canConfigureTelegram = providerDone");
    expect(source).toContain('id="telegram-token"');
    expect(source).toContain('disabled={!canConfigureTelegram}');
    expect(source).toContain('/setup-api/channels/telegram/pairing');
    expect(source).toContain("approveTelegramRequest(request.code)");
  });

  it("keeps Feishu locked behind AI setup and supports web pairing approval", async () => {
    const source = await fs.readFile(
      path.join(process.cwd(), "src/components/DoneStep.tsx"),
      "utf-8",
    );

    expect(source).toContain("const canConfigureFeishu = providerDone");
    expect(source).toContain('id="feishu-app-secret"');
    expect(source).toContain('/setup-api/channels/feishu/status');
    expect(source).toContain('/setup-api/channels/feishu/pairing');
    expect(source).toContain("approveFeishuRequest(request.code)");
  });

  it("keeps WhatsApp in the setup wizard and requires live link plus gateway evidence", async () => {
    const source = await fs.readFile(
      path.join(process.cwd(), "src/components/DoneStep.tsx"),
      "utf-8",
    );

    expect(source).toContain("const canConfigureWhatsApp = providerDone");
    expect(source).toContain('id="whatsapp-owner-number"');
    expect(source).toContain('/setup-api/channels/whatsapp/prepare');
    expect(source).toContain('/setup-api/channels/whatsapp/qrcode');
    expect(source).toContain('/setup-api/channels/whatsapp/login-status');
    expect(source).toContain('/setup-api/channels/whatsapp/status');
    expect(source).toContain('/setup-api/channels/whatsapp/pairing');
    expect(source).toContain('/setup-api/channels/whatsapp/logout');
    expect(source).toContain("const connected = data.linked === true && data.connected === true");
    expect(source).toContain('active={activeChatChannel === "whatsapp"}');
    expect(source).not.toContain("setWhatsAppDone(true)");
    expect(source).toContain("src={whatsappQrDataUrl}");
  });

  it("uses an asynchronous, cache-free WeChat QR session flow", async () => {
    const source = await fs.readFile(
      path.join(process.cwd(), "src/components/DoneStep.tsx"),
      "utf-8",
    );

    expect(source).toContain("const waitWechatQr = async (sessionId: string");
    expect(source).toContain("body: JSON.stringify({ sessionId })");
    expect(source).toContain("body: JSON.stringify({ refresh: refreshingExistingQr })");
    expect(source).toContain('cache: "no-store"');
    expect(source).toContain("data.sessionId");
    expect(source).toContain("data.state === \"expired\"");
  });

  it("keeps LINE in the setup wizard and requires a real inbound webhook", async () => {
    const source = await fs.readFile(
      path.join(process.cwd(), "src/components/DoneStep.tsx"),
      "utf-8",
    );

    expect(source).toContain("const canConfigureLine = providerDone");
    expect(source).toContain('id="line-access-token"');
    expect(source).toContain('id="line-channel-secret"');
    expect(source).toContain('id="line-public-base-url"');
    expect(source).toContain('/setup-api/channels/line/status');
    expect(source).toContain('/setup-api/channels/line/pairing');
    expect(source).toContain('data.state === "active" && hasInbound');
    expect(source).toContain('data.lastInboundAt > 0');
    expect(source).toContain('active={activeChatChannel === "line"}');
    expect(source).toContain("LINE channel token probe");
    expect(source).toContain("Local webhook listener");
    expect(source).toContain("Real inbound webhook");
  });

  it("keeps QQ Bot locked behind AI setup and uses live status without pairing", async () => {
    const source = await fs.readFile(
      path.join(process.cwd(), "src/components/DoneStep.tsx"),
      "utf-8",
    );

    expect(source).toContain("const canConfigureQQBot = providerDone");
    expect(source).toContain('id="qqbot-app-id"');
    expect(source).toContain('id="qqbot-app-secret"');
    expect(source).toContain('/setup-api/channels/qqbot/status');
    expect(source).toContain("no ClawBox pairing approval is required");
    expect(source).not.toContain('/setup-api/channels/qqbot/pairing');
  });
});
