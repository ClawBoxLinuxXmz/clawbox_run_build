import fs from "fs/promises";
import os from "os";
import path from "path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const ROOT = path.join(
  os.tmpdir(),
  `clawbox-channel-concurrency-${process.pid}-${Date.now()}`,
);
const CONFIG_PATH = path.join(ROOT, "openclaw.json");
const originalConfigPath = process.env.OPENCLAW_CONFIG_PATH;

let feishu: typeof import("@/lib/channels/feishu");
let qqbot: typeof import("@/lib/channels/qqbot");

beforeAll(async () => {
  process.env.OPENCLAW_CONFIG_PATH = CONFIG_PATH;
  await fs.mkdir(ROOT, { recursive: true });
  vi.resetModules();
  [feishu, qqbot] = await Promise.all([
    import("@/lib/channels/feishu"),
    import("@/lib/channels/qqbot"),
  ]);
});

afterAll(async () => {
  if (originalConfigPath === undefined) delete process.env.OPENCLAW_CONFIG_PATH;
  else process.env.OPENCLAW_CONFIG_PATH = originalConfigPath;
  vi.resetModules();
  await fs.rm(ROOT, { recursive: true, force: true });
});

describe("OpenClaw channel config concurrency", () => {
  it("keeps both channels when they save concurrently", async () => {
    await fs.writeFile(
      CONFIG_PATH,
      JSON.stringify({ preserved: true, channels: {} }),
      "utf-8",
    );

    await Promise.all([
      feishu.saveFeishuConfig({
        appId: "cli_1234567890",
        appSecret: "abcdefghijklmnopqrstuvwxyz123456",
        domain: "feishu",
        enabled: true,
      }),
      qqbot.saveQQBotConfig({
        appId: "1023456789",
        clientSecret: "qq-client-secret-1234567890",
        enabled: true,
      }),
    ]);

    const stored = JSON.parse(await fs.readFile(CONFIG_PATH, "utf-8")) as {
      preserved?: boolean;
      channels?: Record<string, Record<string, unknown>>;
    };
    expect(stored).toMatchObject({
      preserved: true,
      channels: {
        feishu: {
          appId: "cli_1234567890",
          appSecret: "abcdefghijklmnopqrstuvwxyz123456",
          enabled: true,
        },
        qqbot: {
          appId: "1023456789",
          clientSecret: "qq-client-secret-1234567890",
          enabled: true,
        },
      },
    });
  });
});
