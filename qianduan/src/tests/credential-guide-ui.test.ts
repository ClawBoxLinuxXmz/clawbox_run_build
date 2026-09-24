import fs from "fs/promises";
import path from "path";
import { describe, expect, it } from "vitest";

describe("channel credential guides", () => {
  it("uses a native disclosure with narrow-screen wrapping", async () => {
    const source = await fs.readFile(
      path.join(process.cwd(), "src/components/CredentialGuide.tsx"),
      "utf-8",
    );

    expect(source).toContain("<details");
    expect(source).toContain("<summary");
    expect(source).toContain("focus-visible:ring-2");
    expect(source).toContain("[&_a]:break-all");
    expect(source).toContain("[&_code]:break-all");
  });

  it("explains how to obtain and protect every channel credential", async () => {
    const source = await fs.readFile(
      path.join(process.cwd(), "src/components/DoneStep.tsx"),
      "utf-8",
    );

    expect(source).toContain("How to get the complete Bot Token");
    expect(source).toContain("https://t.me/BotFather");
    expect(source).toContain("<code>/newbot</code>");
    expect(source).toContain("<code>/mybots</code>");
    expect(source).toMatch(/digits before the colon are only the bot ID;\s*this field needs the complete token/);
    expect(source).toContain("<code>/start</code>");

    expect(source).toContain("enterprise self-built app");
    expect(source).toContain("Enable the Bot capability");
    expect(source).toContain("im:message");
    expect(source).toContain("im:chat");
    expect(source).toContain("contact:user.base:readonly");
    expect(source).toContain("im.message.receive_v1");
    expect(source).toContain("long connection/WebSocket");
    expect(source).toContain("Create and publish an app version");
    expect(source).toContain("https://open.feishu.cn/app");
    expect(source).toContain("https://open.larksuite.com/app");

    expect(source).toContain("How to link WhatsApp");
    expect(source).toContain("No Bot ID, API token, developer app, webhook, or ClawBox account is required");
    expect(source).toContain("Settings → Linked devices → Link a device");
    expect(source).toContain("menu, then Linked devices → Link a device");
    expect(source).toContain("The QR code authorizes a linked device");

    expect(source).toContain("How to create the LINE channel and webhook");
    expect(source).toContain("https://manager.line.biz/");
    expect(source).toContain("https://developers.line.biz/console/");
    expect(source).toContain("https://developers.line.biz/en/docs/messaging-api/getting-started/");
    expect(source).toContain("Channel access token (long-lived)");
    expect(source).toContain("Edit → Update → Verify");
    expect(source).toContain("Use webhook");
    expect(source).toContain("public HTTPS domain, reverse proxy, or tunnel");
    expect(source).toContain("This page is marked done only after a real inbound webhook is received");

    expect(source).toContain("How to get QQ Bot AppID and AppSecret");
    expect(source).toContain("https://q.qq.com/qqbot/openclaw/");
    expect(source).toContain("https://q.qq.com/qqbot/dashboard/");
    expect(source).toContain("Create Bot");
    expect(source).toContain("not your personal QQ number");
    expect(source).toContain("No webhook URL or event callback is needed");
    expect(source).toContain("without publishing it to everyone");
    expect(source).toContain("QQ does not need a separate ClawBox pairing approval");

    expect(source).toContain("Never commit the Bot Token to GitHub");
    expect(source).toContain("Never commit the App Secret to GitHub");
    expect(source).toContain("Never commit them to GitHub");
    expect(source).toContain("screenshots or chat messages");
  });
});
