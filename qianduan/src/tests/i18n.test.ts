import fs from "fs/promises";
import path from "path";
import { describe, expect, it } from "vitest";
import {
  resolveLocale,
  translate,
  translateRuntime,
} from "@/lib/i18n";
import { i18n } from "@/i18n.config";

describe("setup i18n", () => {
  it("exposes all configured language options", () => {
    expect(i18n.locales).toHaveLength(21);
  });

  it("resolves a saved locale before the browser preference", () => {
    expect(resolveLocale("en", ["zh-CN"])).toBe("en");
    expect(resolveLocale("zh-CN", ["en-US"])).toBe("zh-CN");
  });

  it("uses simplified Chinese for Chinese browser locales", () => {
    expect(resolveLocale(null, ["zh-HK", "en-US"])).toBe("zh-CN");
    expect(resolveLocale(null, ["ja-JP", "en-US"])).toBe("ja");
    expect(resolveLocale(null, ["pt-BR", "en-US"])).toBe("pt-BR");
    expect(resolveLocale("unsupported", ["en-US"])).toBe("en");
  });

  it("translates typed messages and interpolates values", () => {
    expect(
      translate("zh-CN", "Connected to {ssid}. You can continue setup on this network.", {
        ssid: "Office WiFi",
      }),
    ).toBe("已连接到 Office WiFi。现在可以在此网络中继续设置。");
    expect(translate("en", "Retry")).toBe("Retry");
    expect(translate("ja", "welcome")).toBe("ClawBox へようこそ");
    expect(translate("ru", "wifi_step_title")).toBe("Подключение к WiFi");
    expect(translate("fr", "system_update")).toBe("Mise à jour système");
  });

  it("retranslates dynamic channel status messages", () => {
    expect(translate("zh-CN", "Save proxy settings")).toBe("\u4fdd\u5b58\u4ee3\u7406\u8bbe\u7f6e");
    expect(translateRuntime("zh-CN", "gateway timeout after 8000ms\nGateway target: ws://127.0.0.1:18789")).toBe(
      "\u7f51\u5173\u72b6\u6001\u68c0\u67e5\u8d85\u65f6\uff0c\u7f51\u5173\u672c\u8eab\u53ef\u80fd\u4ecd\u5728\u8fd0\u884c\uff0c\u8bf7\u7a0d\u540e\u91cd\u8bd5\u3002",
    );
    expect(translateRuntime("zh-CN", "gateway closed (1006 abnormal closure (no close frame)): no close reason")).toBe(
      "\u7f51\u5173\u8fde\u63a5\u5df2\u65ad\u5f00\uff0c\u8bf7\u7a0d\u540e\u91cd\u8bd5\uff1b\u5982\u6301\u7eed\u51fa\u73b0\uff0c\u8bf7\u68c0\u67e5\u7f51\u5173\u548c\u7f51\u7edc\u3002",
    );
    expect(translateRuntime("zh-CN", "A channel proxy URL is required.")).toBe("\u4f7f\u7528\u901a\u9053\u4ee3\u7406\u65f6\u5fc5\u987b\u586b\u5199\u4ee3\u7406\u5730\u5740\u3002");
    expect(translateRuntime("zh-CN", "Request failed (502)")).toBe("\u8bf7\u6c42\u5931\u8d25\uff08\u72b6\u6001\u7801 502\uff09\u3002");
    expect(translateRuntime("zh-CN", "Login is starting. The page will check again shortly.")).toBe(
      "登录正在启动，页面稍后会再次检查。",
    );
    expect(translateRuntime("zh-CN", "Login is still starting. The page will check again shortly.")).toBe(
      "登录仍在启动，页面稍后会再次检查。",
    );
    expect(translateRuntime("zh-CN", "Telegram is online as @clawbox_bot.")).toBe(
      "Telegram 已在线，机器人为 @clawbox_bot。",
    );
    expect(translateRuntime("zh-CN", "2 Feishu pairing requests waiting for approval.")).toBe(
      "2 个飞书配对请求等待批准。",
    );
    expect(translateRuntime("zh-CN", "WhatsApp is linked but currently offline.")).toBe(
      "WhatsApp 已关联，但当前离线。",
    );
    expect(
      translateRuntime(
        "zh-CN",
        "LINE received a verified inbound webhook; the channel is active.",
      ),
    ).toBe("LINE 已收到经过验证的入站 Webhook，通道已激活。");
  });

  it("translates every chat-channel picker description", () => {
    const descriptions = [
      "Sign in to a Tencent iLink bot with a QR code; direct messages only.",
      "Create a bot with BotFather, then paste its complete Bot Token.",
      "Link a WhatsApp account by scanning a QR code. No Bot Token is needed.",
      "Create or connect a Feishu / Lark bot through its official authorization flow.",
      "Connect a LINE Messaging API bot through a public HTTPS webhook.",
      "Connect an official QQ bot through its official authorization flow.",
      "Connect a Discord bot with a Bot Token and optional server allowlist.",
      "Connect an official Zalo Bot Platform bot with its Bot Token.",
      "Create an owner-bound Zalo bot through the official Mini App QR flow.",
      "Link a personal Zalo account by QR code after accepting the account risk.",
      "Link Signal through signal-cli and a device-linking QR code.",
    ];

    for (const description of descriptions) {
      expect(translateRuntime("en", description)).toBe(description);
      expect(translateRuntime("zh-CN", description)).not.toBe(description);
    }
  });

  it("switches language without reloading the page", async () => {
    const selector = await fs.readFile(
      path.join(process.cwd(), "src/components/LanguageSelector.tsx"),
      "utf-8",
    );
    const provider = await fs.readFile(
      path.join(process.cwd(), "src/components/I18nProvider.tsx"),
      "utf-8",
    );

    expect(selector).not.toContain("window.location.reload");
    expect(selector).toContain("i18n.locales.map");
    expect(selector).toContain("<select");
    expect(provider).toContain("window.localStorage.setItem");
    expect(provider).toContain("document.documentElement.lang = locale");
  });
});
