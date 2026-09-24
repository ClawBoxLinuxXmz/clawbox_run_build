import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  mkdir: vi.fn(),
  writeFile: vi.fn(),
  rename: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({
  default: {
    mkdir: mocks.mkdir,
    writeFile: mocks.writeFile,
    rename: mocks.rename,
  },
  mkdir: mocks.mkdir,
  writeFile: mocks.writeFile,
  rename: mocks.rename,
}));

const {
  notifyDaemonChatQr,
  notifyDaemonLocale,
  notifyQrIfChanged,
  qrTypeFor,
  CHAT_QR_TRIGGER_FILE,
  LOCALE_TRIGGER_FILE,
} = await import("@/lib/notify-daemon");

describe("notify-daemon", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.mkdir.mockResolvedValue(undefined);
    mocks.writeFile.mockResolvedValue(undefined);
    mocks.rename.mockResolvedValue(undefined);
  });

  describe("notifyDaemonChatQr", () => {
    it("writes chat-qr.json with platform and qr_type", async () => {
      const ok = await notifyDaemonChatQr("wechat", "https://example.com/qr");
      expect(ok).toBe(true);
      expect(mocks.mkdir).toHaveBeenCalledWith(
        expect.stringContaining("/home/clawbox/clawbox/data"),
        expect.objectContaining({ recursive: true }),
      );
      expect(mocks.writeFile).toHaveBeenCalledTimes(1);
      const [tmpFile, content] = mocks.writeFile.mock.calls[0];
      expect(tmpFile).toContain(".tmp");
      const parsed = JSON.parse(content);
      expect(parsed.platform).toBe("wechat");
      expect(parsed.qr_type).toBe("url");
      expect(parsed.qr_url).toBe("https://example.com/qr");
      expect(parsed.updated_at).toBeTypeOf("number");
      expect(mocks.rename).toHaveBeenCalledWith(
        expect.stringContaining(".tmp"),
        CHAT_QR_TRIGGER_FILE,
      );
    });

    it("writes qr_type=image for data URLs", async () => {
      await notifyDaemonChatQr(
        "whatsapp",
        "data:image/png;base64,AAAA",
        "image",
      );
      const parsed = JSON.parse(mocks.writeFile.mock.calls[0][1]);
      expect(parsed.qr_type).toBe("image");
    });

    it("returns false on write failure", async () => {
      mocks.writeFile.mockRejectedValue(new Error("disk full"));
      const ok = await notifyDaemonChatQr("wechat", "https://x");
      expect(ok).toBe(false);
    });
  });

  describe("notifyDaemonLocale", () => {
    it("writes locale.json with the locale", async () => {
      const ok = await notifyDaemonLocale("zh-CN");
      expect(ok).toBe(true);
      const parsed = JSON.parse(mocks.writeFile.mock.calls[0][1]);
      expect(parsed.locale).toBe("zh-CN");
      expect(mocks.rename).toHaveBeenCalledWith(
        expect.stringContaining(".tmp"),
        LOCALE_TRIGGER_FILE,
      );
    });
  });

  describe("notifyQrIfChanged", () => {
    it("notifies only when the value changes", async () => {
      notifyQrIfChanged("feishu", "https://qr/1");
      await vi.waitFor(() =>
        expect(mocks.writeFile).toHaveBeenCalledTimes(1),
      );
      notifyQrIfChanged("feishu", "https://qr/1");
      await new Promise((r) => setTimeout(r, 20));
      expect(mocks.writeFile).toHaveBeenCalledTimes(1);
      notifyQrIfChanged("feishu", "https://qr/2");
      await vi.waitFor(() =>
        expect(mocks.writeFile).toHaveBeenCalledTimes(2),
      );
    });

    it("ignores null/empty values", async () => {
      notifyQrIfChanged("feishu", null);
      notifyQrIfChanged("feishu", undefined);
      notifyQrIfChanged("feishu", "");
      await new Promise((r) => setTimeout(r, 20));
      expect(mocks.writeFile).not.toHaveBeenCalled();
    });

    it("tracks platforms independently", async () => {
      notifyQrIfChanged("feishu", "https://qr/1");
      notifyQrIfChanged("qqbot", "https://qr/1");
      await vi.waitFor(() =>
        expect(mocks.writeFile).toHaveBeenCalledTimes(2),
      );
    });
  });

  describe("qrTypeFor", () => {
    it("detects image data URLs", () => {
      expect(qrTypeFor("data:image/png;base64,AAAA")).toBe("image");
      expect(qrTypeFor("data:image/jpeg;base64,AAAA")).toBe("image");
    });
    it("defaults to url", () => {
      expect(qrTypeFor("https://example.com/qr")).toBe("url");
      expect(qrTypeFor("sgnl://linkdevice?x=1")).toBe("url");
    });
  });
});