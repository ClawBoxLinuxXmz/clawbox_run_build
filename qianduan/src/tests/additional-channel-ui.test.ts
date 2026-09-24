import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("additional channel and connection summary UI", () => {
  it("exposes all eleven channel selectors and URL section navigation", async () => {
    const source = await fs.readFile(
      path.join(process.cwd(), "src/components/DoneStep.tsx"),
      "utf8",
    );

    for (const label of [
      "Telegram",
      "Feishu / Lark",
      "QQ Official Bot",
      "WhatsApp",
      "LINE",
      "WeChat Bot",
      "Discord",
      "Signal",
    ]) {
      expect(source).toContain(`label: "${label}"`);
    }
    expect(source).toContain('new URLSearchParams(window.location.search).get("section")');
    expect(source).toContain('url.searchParams.set("section", id)');
    expect(source).toContain('{ id: "zalo", tag: "ZL", name: "Zalo"');
    expect(source).not.toContain('{ id: "zalo-clawbot", tag: "ZC"');
    expect(source).not.toContain('{ id: "zalouser", tag: "ZP"');
  });

  it("keeps all channel configuration inside one selectable channels panel", async () => {
    const doneSource = await fs.readFile(
      path.join(process.cwd(), "src/components/DoneStep.tsx"),
      "utf8",
    );
    const extrasSource = await fs.readFile(
      path.join(process.cwd(), "src/components/ChannelSetupExtras.tsx"),
      "utf8",
    );

    expect(doneSource).toContain('id="channels"');
    expect(doneSource).toContain("const [activeChatChannel, setActiveChatChannel]");
    expect(doneSource).toContain("const [channelPickerOpen, setChannelPickerOpen]");
    expect(doneSource).toContain('aria-controls="chat-channel-picker"');
    expect(doneSource).toContain("function ChannelContentSection");
    expect(doneSource).toContain('active={activeChatChannel === "whatsapp"}');
    expect(doneSource).toContain("translateText(channel.description)");
    expect(doneSource).toContain("translateText(channel.label)");
    expect(doneSource).toContain('document.getElementById("section-channels")');
    expect(extrasSource).toContain("activeChannel: AdditionalChannelId | null");
    expect(doneSource).toContain("activeChannel={isAdditionalChatChannel(activeChatChannel) ? activeChatChannel : null}");
    expect(extrasSource).toContain('open={activeChannel === "signal"}');
  });

  it("keeps live-only connected summary, shared refresh, and channel-specific disconnect routes", async () => {
    const doneSource = await fs.readFile(
      path.join(process.cwd(), "src/components/DoneStep.tsx"),
      "utf8",
    );
    const extrasSource = await fs.readFile(
      path.join(process.cwd(), "src/components/ChannelSetupExtras.tsx"),
      "utf8",
    );

    expect(doneSource).toContain('"Connected chat channels"');
    expect(doneSource).toContain("refreshAllChannelStatuses");
    expect(doneSource).toContain("disconnectChatChannel");
    expect(doneSource).toContain('`/setup-api/channels/${channel}`');
    expect(doneSource).toContain('channel === "zalo-clawbot" || channel === "zalouser"');
    expect(doneSource).toContain('method: isPatch ? "PATCH" : "POST"');
    expect(doneSource).toContain("status.connected === true || status.state === \"connected\"");
    expect(extrasSource).toContain("statusRefreshToken");
    expect(extrasSource).toContain('role="tablist"');
    expect(extrasSource).toContain("Existing configurations for other modes are preserved");
    expect(extrasSource).toContain("initialZaloMode");
    expect(extrasSource).toContain("/setup-api/channels/discord/status?force=1");
    expect(extrasSource).toContain("loadPersonal(true)");
    expect(extrasSource).toContain("loadClawbot(true)");
    expect(extrasSource).toContain("loadSignal(true)");
    expect(extrasSource).toContain('status.state === "not_configured" || status.configured === false');
    expect(extrasSource).toContain('t("Not configured yet")');
  });
});
