import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const TEST_ROOT = path.join(os.tmpdir(), `clawbox-extra-channels-${process.pid}-${Date.now()}`);
const OPENCLAW_HOME = path.join(TEST_ROOT, ".openclaw");
const CONFIG_PATH = path.join(OPENCLAW_HOME, "openclaw.json");
const SETUP_CONFIG_PATH = path.join(TEST_ROOT, "data", "config.json");

let discord: typeof import("@/lib/channels/discord");
let zalo: typeof import("@/lib/channels/zalo");
let signal: typeof import("@/lib/channels/signal");
let zalouser: typeof import("@/lib/channels/zalouser");
let clawbot: typeof import("@/lib/channels/zalo-clawbot");
let runtime: typeof import("@/lib/channels/openclaw-runtime");
let qr: typeof import("@/lib/channels/qr-session");
let openclawConfig: typeof import("@/lib/openclaw-config");

beforeAll(async () => {
  process.env.OPENCLAW_HOME = OPENCLAW_HOME;
  process.env.OPENCLAW_STATE_DIR = OPENCLAW_HOME;
  process.env.CLAWBOX_ROOT = TEST_ROOT;
  await fs.mkdir(OPENCLAW_HOME, { recursive: true });
  vi.resetModules();
  [discord, zalo, signal, zalouser, clawbot, runtime, qr, openclawConfig] = await Promise.all([
    import("@/lib/channels/discord"),
    import("@/lib/channels/zalo"),
    import("@/lib/channels/signal"),
    import("@/lib/channels/zalouser"),
    import("@/lib/channels/zalo-clawbot"),
    import("@/lib/channels/openclaw-runtime"),
    import("@/lib/channels/qr-session"),
    import("@/lib/openclaw-config"),
  ]);
});

beforeEach(async () => {
  await fs.rm(OPENCLAW_HOME, { recursive: true, force: true });
  await fs.mkdir(OPENCLAW_HOME, { recursive: true });
  await fs.rm(path.dirname(SETUP_CONFIG_PATH), { recursive: true, force: true });
});

afterAll(async () => {
  delete process.env.OPENCLAW_HOME;
  delete process.env.OPENCLAW_STATE_DIR;
  delete process.env.CLAWBOX_ROOT;
  await fs.rm(TEST_ROOT, { recursive: true, force: true });
});

describe("Discord channel", () => {
  it("validates the Bot Token without returning it", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ id: "123456789012345678", username: "clawbox", global_name: "ClawBox" }), { status: 200 }));
    const result = await discord.validateDiscordBotToken("secret-discord-token", fetcher as typeof fetch);
    expect(result).toEqual({ id: "123456789012345678", username: "clawbox", globalName: "ClawBox" });
    expect(JSON.stringify(result)).not.toContain("secret-discord-token");
    expect(fetcher).toHaveBeenCalledWith("https://discord.com/api/v10/users/@me", expect.objectContaining({ headers: { Authorization: "Bot secret-discord-token" } }));
  });

  it("writes token, pairing policy, and a restricted guild entry", async () => {
    const view = await discord.saveDiscordConfig({ token: "secret-discord-token", serverId: "123456789012345678", userId: "987654321098765432", enabled: true });
    const stored = JSON.parse(await fs.readFile(CONFIG_PATH, "utf8"));
    expect(stored.channels.discord).toMatchObject({ enabled: true, token: "secret-discord-token", dmPolicy: "pairing", groupPolicy: "allowlist", serverId: "123456789012345678", userId: "987654321098765432", guilds: { "123456789012345678": { requireMention: true, users: ["987654321098765432"] } } });
    expect(view.hasToken).toBe(true);
    expect(JSON.stringify(view)).not.toContain("secret-discord-token");
  });
});

describe("Zalo Bot channel", () => {
  it("uses the official getMe endpoint and account-scoped schema", async () => {
    const token = "123456789:secret_value";
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ ok: true, result: { id: "42", name: "ClawBox Zalo" } }), { status: 200 }));
    await expect(zalo.validateZaloBotToken(token, fetcher as typeof fetch)).resolves.toEqual({ id: "42", name: "ClawBox Zalo" });
    await zalo.saveZaloConfig({ botToken: token, enabled: true });
    const stored = JSON.parse(await fs.readFile(CONFIG_PATH, "utf8"));
    expect(stored.channels.zalo).toEqual({ enabled: true, accounts: { default: { enabled: true, dmPolicy: "pairing", groupPolicy: "disabled", botToken: token } } });
    expect(await zalo.getZaloConfig()).toEqual({ configured: true, enabled: true, hasToken: true, proxy: null, proxyConfigured: false, dmPolicy: "pairing", groupPolicy: "disabled" });
  });

  it("stores a channel-scoped HTTP proxy without changing the token schema", async () => {
    await zalo.saveZaloConfig({ botToken: "123456789:secret_value", proxy: "http://192.168.1.10:7890", enabled: true });
    const stored = JSON.parse(await fs.readFile(CONFIG_PATH, "utf8"));
    expect(stored.channels.zalo.proxy).toBe("http://192.168.1.10:7890");
    expect(await zalo.getZaloProxy()).toBe("http://192.168.1.10:7890");
    expect(await zalo.getZaloConfig()).toMatchObject({ proxyConfigured: true });
  });

  it("accepts only HTTP and HTTPS proxy URLs", () => {
    expect(zalo.normalizeZaloProxy("http://192.168.1.10:7890/")).toBe("http://192.168.1.10:7890");
    expect(() => zalo.normalizeZaloProxy("socks5://192.168.1.10:7890")).toThrow("HTTP or HTTPS");
  });
});

describe("Signal channel", () => {
  it("normalizes an E.164 account and writes the external signal-cli configuration", async () => {
    const view = await signal.saveSignalConfig({ account: "+86 138-0000-0000", cliPath: "/usr/local/bin/signal-cli", enabled: true });
    const stored = JSON.parse(await fs.readFile(CONFIG_PATH, "utf8"));
    expect(stored.channels.signal).toMatchObject({ account: "+8613800000000", cliPath: "/usr/local/bin/signal-cli", enabled: true, dmPolicy: "pairing" });
    expect(view).toMatchObject({ configured: true, enabled: true, account: "+8613800000000" });
  });

  it("extracts only a real sgnl link-device URI", () => {
    const uri = "sgnl://linkdevice?uuid=abcd&pub_key=xyz";
    expect(qr.parseSignalLinkOutput(`Scan this QR\n${uri}\nWaiting`)).toBe(uri);
    expect(qr.parseSignalLinkOutput("not a Signal link")).toBeNull();
  });

  it("accepts only signal-cli's explicit linked-account success output", () => {
    expect(qr.parseSignalLinkedAccount("Associated with: +8613800000000\n")).toBe("+8613800000000");
    expect(qr.parseSignalLinkedAccount("sgnl://linkdevice?uuid=abc&pub_key=xyz")).toBeNull();
    expect(qr.parseSignalLinkedAccount("Process exited successfully")).toBeNull();
  });

  it("checks the signal-cli executable before starting a QR session", async () => {
    const runner = vi.fn(async () => ({ stdout: "signal-cli 0.13.20", stderr: "" }));
    await expect(signal.ensureSignalCli("/opt/signal-cli", runner)).resolves.toBeUndefined();
    expect(runner).toHaveBeenCalledWith(
      "/opt/signal-cli",
      ["--version"],
      expect.objectContaining({ timeoutMs: 10_000 }),
    );
  });
});

describe("QR-backed Zalo channels", () => {
  it("does not infer Zalo ClawBot setup from an enabled channel without an account", async () => {
    await fs.writeFile(
      CONFIG_PATH,
      JSON.stringify({ channels: { "openclaw-zaloclawbot": { enabled: true } } }),
      "utf8",
    );

    await expect(clawbot.getClawBotConfig()).resolves.toEqual({
      configured: false,
      enabled: false,
      accountIds: [],
    });
    await expect(clawbot.getClawBotStatus()).resolves.toMatchObject({
      state: "not_configured",
      configured: false,
      connected: false,
      running: false,
    });
  });

  it("reports a successfully logged-in Zalo ClawBot account in the connected state", async () => {
    const stateDir = path.join(OPENCLAW_HOME, "openclaw-zaloclawbot");
    await fs.mkdir(path.join(stateDir, "accounts"), { recursive: true });
    await fs.writeFile(path.join(stateDir, "accounts.json"), JSON.stringify(["clawbot-test"]), "utf8");
    await fs.writeFile(
      path.join(stateDir, "accounts", "clawbot-test.json"),
      JSON.stringify({ botToken: "zalo-clawbot-secret" }),
      "utf8",
    );
    await fs.writeFile(
      CONFIG_PATH,
      JSON.stringify({ channels: { "openclaw-zaloclawbot": { enabled: true } } }),
      "utf8",
    );

    await expect(clawbot.getClawBotStatus()).resolves.toMatchObject({
      state: "connected",
      configured: true,
      enabled: true,
      connected: true,
      running: true,
      accountIds: ["clawbot-test"],
    });
  });

  it("does not report a saved WeChat account as connected when the channel is disabled", async () => {
    const accountsDir = path.join(OPENCLAW_HOME, "openclaw-weixin", "accounts");
    await fs.mkdir(accountsDir, { recursive: true });
    await fs.writeFile(
      path.join(accountsDir, "ilink_bot.json"),
      JSON.stringify({ token: "wechat-account-token" }),
      "utf8",
    );
    await fs.writeFile(
      CONFIG_PATH,
      JSON.stringify({ channels: { "openclaw-weixin": { enabled: false } } }),
      "utf8",
    );

    await expect(openclawConfig.getWechatConfig()).resolves.toMatchObject({
      enabled: false,
      connected: false,
      accountIds: ["ilink_bot"],
    });
  });

  it("keeps the Zalo Personal risk acknowledgement out of the strict OpenClaw schema", async () => {
    const view = await zalouser.saveZaloPersonalConfig({ enabled: false, riskAccepted: true });
    const openclaw = JSON.parse(await fs.readFile(CONFIG_PATH, "utf8"));
    const setup = JSON.parse(await fs.readFile(SETUP_CONFIG_PATH, "utf8"));

    expect(openclaw.channels.zalouser).toEqual({ enabled: false, dmPolicy: "pairing" });
    expect(openclaw.channels.zalouser).not.toHaveProperty("riskAccepted");
    expect(setup.zalouser_risk_accepted).toBe(true);
    expect(view).toMatchObject({ configured: false, enabled: false, riskAccepted: true });
  });

  it("reads a delayed Zalo Personal QR image and removes only the trusted temp artifact", async () => {
    const qrPath = path.join(
      os.tmpdir(),
      `openclaw-zalouser-qr-test-${process.pid}-${Date.now()}.png`,
    );
    const delayedWrite = new Promise<void>((resolve, reject) => {
      setTimeout(() => {
        fs.writeFile(qrPath, Buffer.from("small-qr-image")).then(resolve, reject);
      }, 150);
    });

    await expect(qr.parsePngPathOutput(`Scan QR image: ${qrPath}\n`)).resolves.toMatch(
      /^data:image\/png;base64,/,
    );
    await delayedWrite;
    await qr.cleanupPngPathOutput(`Scan QR image: ${qrPath}\n`);
    await expect(fs.stat(qrPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("extracts only the official plugin's fallback login URL", () => {
    const url = "https://bot.zaloplatforms.com/agent/login?zbsk=temporary";
    expect(clawbot.CLAWBOT_PLUGIN_SPEC).toBe("@zalo-platforms/openclaw-zaloclawbot@0.1.4");
    expect(qr.parseClawBotLoginUrl(`If the QR didn't render, open this URL: ${url}`)).toBe(url);
    expect(
      qr.parseClawBotLoginUrl(
        `\u001b[2KIf the QR didn't render, open this URL in Zalo:\n${url}\u001b[0m`,
      ),
    ).toBe(url);
    expect(qr.parseClawBotLoginUrl("Connected to Zalo. account clawbot-1")).toBeNull();
  });

  it("reuses an installed and enabled pinned ClawBot plugin without CLI discovery", async () => {
    const projectDir = path.join(
      OPENCLAW_HOME,
      "npm",
      "projects",
      "zalo-platforms-openclaw-zaloclawbot-0.1.4",
      "node_modules",
      "@zalo-platforms",
      "openclaw-zaloclawbot",
    );
    await fs.mkdir(projectDir, { recursive: true });
    await fs.writeFile(
      path.join(projectDir, "package.json"),
      JSON.stringify({ name: "@zalo-platforms/openclaw-zaloclawbot", version: "0.1.4" }),
    );
    await fs.writeFile(
      CONFIG_PATH,
      JSON.stringify({ plugins: { entries: { "openclaw-zaloclawbot": { enabled: true } } } }),
    );

    const runOpenClaw = vi.spyOn(runtime, "runOpenClaw");
    await clawbot.prepareClawBotPlugin();
    expect(runOpenClaw).not.toHaveBeenCalled();
    runOpenClaw.mockRestore();
  });

  it("requests the ClawBot QR directly and cancels its status polling", async () => {
    const loginUrl = "https://bot.zaloplatforms.com/agent/login?zbsk=test-session";
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/agent/request-login")) {
        return new Response(JSON.stringify({ ok: true, result: { loginUrl, zbsk: "test-session" } }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true, result: {} }), { status: 202 });
    });
    vi.stubGlobal("fetch", fetcher);

    const started = await clawbot.startClawBotQrLogin();
    await vi.waitFor(() => {
      expect(clawbot.getClawBotQrLogin(started.sessionId, started.ownerToken)?.qrData).toBe(loginUrl);
    });
    expect(fetcher).toHaveBeenCalledWith(`${"https://bot.zaloplatforms.com"}/agent/request-login`, expect.anything());
    expect(clawbot.cancelClawBotQrLogin(started.sessionId, started.ownerToken)).toBe(true);
    vi.unstubAllGlobals();
  });
});

describe("runtime evidence", () => {
  const configured = { gatewayReachable: true, channelAccounts: { discord: [{ running: true, connected: false }] } };

  it("does not call a merely running account connected without a successful probe", () => {
    expect(runtime.parseRuntimeChannelStatus(configured, "discord")).toMatchObject({ state: "configured", running: true, connected: false });
  });

  it("requires explicit connected or running plus a successful probe", () => {
    expect(runtime.parseRuntimeChannelStatus({ gatewayReachable: true, channelAccounts: { discord: [{ running: true, probe: { ok: true } }] } }, "discord")).toMatchObject({ state: "connected", connected: true });
  });

  it("treats a running Zalo ClawBot account without a probe payload as connected", () => {
    expect(runtime.parseRuntimeChannelStatus({ gatewayReachable: true, channelAccounts: { "openclaw-zaloclawbot": [{ running: true, lastError: null }] } }, "openclaw-zaloclawbot")).toMatchObject({ state: "connected", connected: true });
  });

  it("redacts QR links and token-shaped values from command errors", () => {
    const sanitized = runtime.sanitizeChannelOutput("failed sgnl://linkdevice?uuid=secret 123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ");
    expect(sanitized).not.toContain("uuid=secret");
    expect(sanitized).not.toContain("ABCDEFGHIJKLMNOPQRSTUVWXYZ");
  });
});

describe("channel setup UI", () => {
  it("contains all five new channels, official help links, bilingual copy, and QR routes", async () => {
    const source = await fs.readFile(path.join(process.cwd(), "src/components/ChannelSetupExtras.tsx"), "utf8");
    for (const label of ["Discord", "Zalo Bot", "Zalo ClawBot", "Zalo Personal", "Signal"]) expect(source).toContain(label);
    expect(source).toContain("https://discord.com/developers/applications");
    expect(source).toContain("https://bot.zaloplatforms.com");
    expect(source).toContain('<ChannelProxySettings channelId="zalo" />');
    expect(source).toContain('body: JSON.stringify({ botToken: zaloToken.trim() || undefined, enabled: true })');
    expect(source).toContain('<ChannelProxySettings channelId="openclaw-zaloclawbot" />');
    expect(source).toContain('<ChannelProxySettings channelId="zalouser" />');
    expect(source).toContain("/setup-api/channels/zalo-clawbot/login-status");
    expect(source).toContain("/setup-api/channels/zalouser/login-status");
    expect(source).toContain("/setup-api/channels/signal/login-status");
    expect(source).toContain('locale === "zh-CN"');
    expect(source).toContain("Unofficial personal-account automation");
  });
});
