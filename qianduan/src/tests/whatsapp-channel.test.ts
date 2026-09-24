import fs from "fs/promises";
import os from "os";
import path from "path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawRunner } from "@/lib/channels/whatsapp";

const TEST_ROOT = path.join(
  os.tmpdir(),
  `clawbox-whatsapp-channel-${process.pid}-${Date.now()}`,
);
const OPENCLAW_HOME = path.join(TEST_ROOT, ".openclaw");
const CONFIG_PATH = path.join(OPENCLAW_HOME, "openclaw.json");

let whatsapp: typeof import("@/lib/channels/whatsapp");

function pluginPayload(input: {
  enabled: boolean;
  status: string;
  error?: string;
}) {
  return {
    plugins: [
      {
        id: "whatsapp",
        version: "2026.4.25",
        origin: "bundled",
        ...input,
      },
    ],
  };
}

function runnerMock(
  implementation?: OpenClawRunner,
): ReturnType<typeof vi.fn<OpenClawRunner>> {
  return vi.fn<OpenClawRunner>(implementation);
}

beforeAll(async () => {
  process.env.OPENCLAW_HOME = OPENCLAW_HOME;
  await fs.mkdir(OPENCLAW_HOME, { recursive: true });
  vi.resetModules();
  whatsapp = await import("@/lib/channels/whatsapp");
});

beforeEach(async () => {
  await fs.rm(OPENCLAW_HOME, { recursive: true, force: true });
  await fs.mkdir(OPENCLAW_HOME, { recursive: true });
});

afterAll(async () => {
  delete process.env.OPENCLAW_HOME;
  await fs.rm(TEST_ROOT, { recursive: true, force: true });
});

describe("WhatsApp configuration and plugin preparation", () => {
  it("writes a dedicated-number configuration without credentials", async () => {
    const result = await whatsapp.saveWhatsAppConfig({
      enabled: true,
      mode: "dedicated",
    });
    const stored = JSON.parse(await fs.readFile(CONFIG_PATH, "utf-8"));

    expect(stored.channels.whatsapp).toEqual({
      enabled: true,
      dmPolicy: "pairing",
      groupPolicy: "disabled",
      selfChatMode: false,
    });
    expect(result).toMatchObject({
      changed: true,
      config: {
        configured: true,
        enabled: true,
        mode: "dedicated",
        dmPolicy: "pairing",
        groupPolicy: "disabled",
        ownerNumber: null,
      },
    });
    expect(JSON.stringify(stored)).not.toContain("creds.json");
    expect(JSON.stringify(stored)).not.toContain("qrDataUrl");
  });

  it("normalizes and allowlists the owner in personal-number mode", async () => {
    await whatsapp.saveWhatsAppConfig({
      enabled: true,
      mode: "personal",
      ownerNumber: "+86 138-0000-0000",
    });
    const stored = JSON.parse(await fs.readFile(CONFIG_PATH, "utf-8"));

    expect(stored.channels.whatsapp).toMatchObject({
      enabled: true,
      selfChatMode: true,
      dmPolicy: "allowlist",
      allowFrom: ["+8613800000000"],
      groupPolicy: "disabled",
    });
  });

  it("requires an E.164 owner number for personal-number mode", async () => {
    await expect(
      whatsapp.saveWhatsAppConfig({
        enabled: true,
        mode: "personal",
        ownerNumber: "not-a-phone",
      }),
    ).rejects.toMatchObject({ code: "invalid_owner_number" });
  });

  it("enables the bundled plugin, saves config, and restarts once", async () => {
    const runner = runnerMock();
    runner
      .mockResolvedValueOnce({
        stdout: JSON.stringify(pluginPayload({ enabled: false, status: "disabled" })),
      })
      .mockResolvedValueOnce({ stdout: "" })
      .mockResolvedValueOnce({
        stdout: JSON.stringify(pluginPayload({ enabled: true, status: "loaded" })),
      });
    const restart = vi.fn(async () => {});

    const result = await whatsapp.prepareWhatsAppChannel(
      { mode: "dedicated" },
      { runner, restart },
    );

    expect(runner.mock.calls[1]?.[0]).toEqual([
      "plugins",
      "enable",
      "whatsapp",
    ]);
    expect(restart).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      prepared: true,
      restarted: true,
      changed: true,
      plugin: { origin: "bundled", status: "loaded" },
    });
  });

  it("installs the WhatsApp runtime when the bundled plugin cannot enable yet", async () => {
    const runner = runnerMock();
    runner
      .mockResolvedValueOnce({
        stdout: JSON.stringify(pluginPayload({ enabled: false, status: "disabled" })),
      })
      .mockRejectedValueOnce(new Error("Cannot find package @whiskeysockets/baileys"))
      .mockResolvedValueOnce({ stdout: "" })
      .mockResolvedValueOnce({ stdout: "" })
      .mockResolvedValueOnce({
        stdout: JSON.stringify(pluginPayload({ enabled: true, status: "loaded" })),
      });
    const restart = vi.fn(async () => {});

    const result = await whatsapp.prepareWhatsAppChannel(
      { mode: "dedicated" },
      { runner, restart },
    );

    expect(runner.mock.calls[2]?.[0]).toEqual([
      "plugins",
      "install",
      "@openclaw/whatsapp",
    ]);
    expect(runner.mock.calls[3]?.[0]).toEqual([
      "plugins",
      "enable",
      "whatsapp",
    ]);
    expect(restart).toHaveBeenCalledOnce();
    expect(result.plugin).toMatchObject({ enabled: true, status: "loaded" });
  });

  it("does not restart when the plugin and configuration are unchanged", async () => {
    await whatsapp.saveWhatsAppConfig({
      enabled: true,
      mode: "dedicated",
    });
    const runner = runnerMock(async () => ({
      stdout: JSON.stringify(pluginPayload({ enabled: true, status: "loaded" })),
    }));
    const restart = vi.fn(async () => {});

    const result = await whatsapp.prepareWhatsAppChannel(
      { mode: "dedicated" },
      { runner, restart },
    );

    expect(result.restarted).toBe(false);
    expect(restart).not.toHaveBeenCalled();
    expect(runner).toHaveBeenCalledOnce();
  });

  it("reports a missing bundled plugin explicitly", async () => {
    const runner = runnerMock(async () => ({
      stdout: JSON.stringify({ plugins: [] }),
    }));

    await expect(
      whatsapp.prepareWhatsAppChannel({}, { runner, restart: vi.fn() }),
    ).rejects.toMatchObject({ code: "plugin_unavailable" });
  });
});

describe("WhatsApp QR gateway RPC", () => {
  it("starts QR login with web.login.start and returns only the current QR", async () => {
    const qrDataUrl = "data:image/png;base64,QUJDRA==";
    const runner = runnerMock(async () => ({
      stdout: JSON.stringify({
        connected: false,
        qrDataUrl,
        message: "Scan this QR in WhatsApp.",
      }),
    }));

    const result = await whatsapp.startWhatsAppQrLogin(
      { force: true },
      runner,
    );
    const args = runner.mock.calls[0]?.[0] || [];
    const paramsIndex = args.indexOf("--params");
    const params = JSON.parse(args[paramsIndex + 1] || "{}");

    expect(args.slice(0, 3)).toEqual(["gateway", "call", "web.login.start"]);
    expect(params).toMatchObject({
      accountId: "default",
      force: true,
      timeoutMs: 30_000,
    });
    expect(result).toEqual({
      connected: false,
      qrDataUrl,
      message: "Scan this QR in WhatsApp.",
    });
  });

  it("forwards the current QR and returns a refreshed QR without persisting it", async () => {
    const currentQrDataUrl = "data:image/png;base64,Q1VSUkVOVA==";
    const refreshedQrDataUrl = "data:image/png;base64,U0VDUkVU";
    const runner = runnerMock(async () => ({
      stdout: JSON.stringify({
        connected: false,
        message: "Still waiting.",
        qrDataUrl: refreshedQrDataUrl,
      }),
    }));

    const result = await whatsapp.waitForWhatsAppQrLogin(
      { currentQrDataUrl },
      runner,
    );
    const args = runner.mock.calls[0]?.[0] || [];
    const paramsIndex = args.indexOf("--params");
    const serializedParams = args[paramsIndex + 1] || "{}";
    const params = JSON.parse(serializedParams);

    expect(args.slice(0, 3)).toEqual(["gateway", "call", "web.login.wait"]);
    expect(params.currentQrDataUrl).toBe(currentQrDataUrl);
    expect(result).toEqual({
      connected: false,
      qrDataUrl: refreshedQrDataUrl,
      message: "Still waiting.",
    });
  });

  it("maps an unavailable web login provider to plugin_unavailable", async () => {
    const runner = runnerMock(async () => {
      throw new Error("web login provider is not available");
    });

    await expect(
      whatsapp.startWhatsAppQrLogin({}, runner),
    ).rejects.toMatchObject({ code: "plugin_unavailable" });
  });

  it("keeps Gateway diagnostics written to stdout when the CLI exits with no stderr", async () => {
    const runner = runnerMock(async () => {
      throw Object.assign(new Error("Command failed: openclaw gateway call"), {
        stdout: JSON.stringify({
          error: "gateway closed (1006): abnormal closure",
        }),
        stderr: "",
      });
    });

    await expect(
      whatsapp.startWhatsAppQrLogin({}, runner),
    ).rejects.toMatchObject({
      code: "gateway_unavailable",
      message: expect.stringContaining("gateway closed (1006)"),
    });
  });
});

describe("WhatsApp status, pairing, and logout", () => {
  const stored = {
    configured: true,
    enabled: true,
    mode: "dedicated" as const,
    dmPolicy: "pairing",
    groupPolicy: "disabled",
    ownerNumber: null,
  };

  it("never reports connected unless both linked and connected are true", () => {
    const notLinked = whatsapp.parseWhatsAppStatusPayload(
      {
        channels: { whatsapp: { linked: false, connected: true } },
        channelAccounts: {
          whatsapp: [{ accountId: "default", linked: false, connected: true }],
        },
      },
      stored,
    );
    const linkedOffline = whatsapp.parseWhatsAppStatusPayload(
      {
        channels: { whatsapp: { linked: true, connected: false } },
        channelAccounts: {
          whatsapp: [{ accountId: "default", linked: true, connected: false }],
        },
      },
      stored,
    );
    const connected = whatsapp.parseWhatsAppStatusPayload(
      {
        channels: { whatsapp: { linked: true, connected: true } },
        channelAccounts: {
          whatsapp: [{ accountId: "default", linked: true, connected: true }],
        },
      },
      stored,
    );

    expect(notLinked).toMatchObject({ state: "not_linked", connected: false });
    expect(linkedOffline).toMatchObject({
      state: "linked_offline",
      connected: false,
    });
    expect(connected).toMatchObject({ state: "connected", connected: true });
  });

  it("treats a missing runtime plugin entry as unavailable", () => {
    const status = whatsapp.parseWhatsAppStatusPayload(
      { channels: {}, channelAccounts: {} },
      stored,
    );

    expect(status).toMatchObject({
      state: "error",
      pluginAvailable: false,
      connected: false,
    });
  });

  it("parses pending senders and approves with --notify", async () => {
    const listRunner = runnerMock(async () => ({
      stdout: JSON.stringify({
        requests: [
          {
            code: "ABC123",
            id: "+8613800000000",
            accountId: "default",
            createdAt: "2026-07-31T00:00:00.000Z",
            meta: { name: "Melody" },
          },
        ],
      }),
    }));
    const requests = await whatsapp.listWhatsAppPairingRequests(listRunner);
    const approveRunner = runnerMock(async () => ({ stdout: "" }));
    await whatsapp.approveWhatsAppPairing("ABC123", approveRunner);

    expect(requests).toEqual([
      {
        code: "ABC123",
        senderId: "+8613800000000",
        accountId: "default",
        createdAt: "2026-07-31T00:00:00.000Z",
        displayName: "Melody",
      },
    ]);
    expect(approveRunner.mock.calls[0]?.[0]).toEqual([
      "pairing",
      "approve",
      "whatsapp",
      "ABC123",
      "--notify",
    ]);
  });

  it("logs out through channels.logout", async () => {
    const runner = runnerMock(async () => ({
      stdout: JSON.stringify({ cleared: true, loggedOut: true }),
    }));

    const result = await whatsapp.logoutWhatsApp(undefined, runner);
    const args = runner.mock.calls[0]?.[0] || [];
    const paramsIndex = args.indexOf("--params");
    const params = JSON.parse(args[paramsIndex + 1] || "{}");

    expect(args.slice(0, 3)).toEqual(["gateway", "call", "channels.logout"]);
    expect(params).toEqual({ channel: "whatsapp", accountId: "default" });
    expect(result).toEqual({ cleared: true, loggedOut: true });
  });
});
