export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { spawn } from "child_process";
import fs from "fs/promises";
import path from "path";
import { setMany } from "@/lib/config-store";
import { restartGateway } from "@/lib/openclaw-config";

const OPENCLAW_BIN = "/home/clawbox/.npm-global/bin/openclaw";
const AUTH_PROFILES_PATH =
  "/home/clawbox/.openclaw/agents/main/agent/auth-profiles.json";
const CLAWBOX_UID = process.getuid?.() ?? 1000;
const CLAWBOX_GID = process.getgid?.() ?? 1000;

interface ProviderConfig {
  defaultModel: string;
  profileKey: string;
  subscriptionOverride?: { defaultModel: string; profileKey: string };
}

const PROVIDERS: Record<string, ProviderConfig> = {
  anthropic: {
    defaultModel: "anthropic/claude-sonnet-4-6",
    profileKey: "anthropic:default",
  },
  openai: {
    defaultModel: "openai/gpt-4o",
    profileKey: "openai:default",
    subscriptionOverride: {
      defaultModel: "openai-codex/gpt-5.3-codex",
      profileKey: "openai-codex:default",
    },
  },
  google: {
    defaultModel: "google/gemini-2.0-flash",
    profileKey: "google:default",
    subscriptionOverride: {
      defaultModel: "google-gemini-cli/gemini-2.5-flash",
      profileKey: "google-gemini-cli:default",
    },
  },
  openrouter: {
    defaultModel: "openrouter/anthropic/claude-sonnet-4.5",
    profileKey: "openrouter:default",
  },
  deepseek: {
    defaultModel: "deepseek/deepseek-v4-flash",
    profileKey: "deepseek:default",
  },
};

const PROFILE_KEY_RE = /^[a-zA-Z0-9._-]+(?::[a-zA-Z0-9._-]+)*$/;
const COMMAND_TIMEOUT_MS = 30_000;

function runCommand(cmd: string, args: string[], timeoutMs = COMMAND_TIMEOUT_MS): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const child = spawn(cmd, args, {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: "/home/clawbox",
      uid: CLAWBOX_UID,
      gid: CLAWBOX_GID,
      env: { ...process.env, HOME: "/home/clawbox" },
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill("SIGKILL");
        reject(new Error(`${cmd} timed out after ${timeoutMs}ms`));
      }
    }, timeoutMs);

    child.on("error", (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(err);
      }
    });
    child.on("close", (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(stderr.trim() || `${cmd} exited with code ${code}`));
      }
    });
    child.stdin.end();
  });
}

export async function POST(request: Request) {
  try {
    let body: {
      provider?: string;
      apiKey?: string;
      authMode?: string;
      refreshToken?: string;
      expiresIn?: number;
      projectId?: string;
    };
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    const { provider, apiKey, authMode = "token", refreshToken, expiresIn, projectId } = body;
    if (!provider || !apiKey) {
      return NextResponse.json(
        { error: "Provider and API key are required (cloud providers only)" },
        { status: 400 },
      );
    }

    const baseConfig = PROVIDERS[provider];
    if (!baseConfig) {
      return NextResponse.json({ error: `Unknown provider: ${provider}` }, { status: 400 });
    }

    const config =
      authMode === "subscription" && baseConfig.subscriptionOverride
        ? { ...baseConfig.subscriptionOverride }
        : { ...baseConfig };
    const ocProvider = config.profileKey.split(":")[0];

    {
      let authProfiles: { version: number; profiles: Record<string, unknown> };
      try {
        const raw = await fs.readFile(AUTH_PROFILES_PATH, "utf-8");
        authProfiles = JSON.parse(raw) as { version: number; profiles: Record<string, unknown> };
      } catch {
        authProfiles = { version: 1, profiles: {} };
      }

      if (authMode === "subscription") {
        authProfiles.profiles[config.profileKey] = {
          type: "oauth",
          provider: ocProvider,
          access: apiKey,
          refresh: refreshToken || "",
          expires: expiresIn ? Date.now() + expiresIn * 1000 : Date.now() + 8 * 60 * 60 * 1000,
          ...(projectId ? { projectId } : {}),
        };
      } else {
        authProfiles.profiles[config.profileKey] = {
          type: "token",
          provider: ocProvider,
          token: apiKey,
        };
      }
      await fs.mkdir(path.dirname(AUTH_PROFILES_PATH), { recursive: true });
      const tmpPath = AUTH_PROFILES_PATH + `.tmp.${Date.now()}.${process.pid}`;
      await fs.writeFile(tmpPath, JSON.stringify(authProfiles, null, 2), {
        mode: 0o600,
      });
      await fs.rename(tmpPath, AUTH_PROFILES_PATH);
      await fs.chown(AUTH_PROFILES_PATH, CLAWBOX_UID, CLAWBOX_GID);
    }

    if (!PROFILE_KEY_RE.test(config.profileKey)) {
      return NextResponse.json({ error: "Invalid profile key format" }, { status: 400 });
    }

    await runCommand(OPENCLAW_BIN, [
      "config",
      "set",
      `auth.profiles.${config.profileKey}`,
      JSON.stringify({
        provider: ocProvider,
        mode: authMode === "subscription" ? "oauth" : "token",
      }),
      "--json",
    ]);

    await runCommand(OPENCLAW_BIN, [
      "config",
      "set",
      "agents.defaults.model.primary",
      config.defaultModel,
    ]);

    await runCommand(OPENCLAW_BIN, ["config", "set", "gateway.auth.mode", "none"]);
    await runCommand(OPENCLAW_BIN, [
      "config",
      "set",
      "gateway.controlUi.allowInsecureAuth",
      "true",
      "--json",
    ]);
    await runCommand(OPENCLAW_BIN, [
      "config",
      "set",
      "gateway.controlUi.dangerouslyDisableDeviceAuth",
      "true",
      "--json",
    ]);

    try {
      await runCommand(OPENCLAW_BIN, ["config", "set", "models.mode", "merge"]);
    } catch {
      // non-fatal
    }

    await Promise.all(
      ["openclaw.json", "openclaw.json.bak", "openclaw.json.bak.1", "openclaw.json.bak.2"].map((name) =>
        fs.chown(path.join("/home/clawbox/.openclaw", name), CLAWBOX_UID, CLAWBOX_GID).catch(() => {}),
      ),
    );

    try {
      await restartGateway();
    } catch (err) {
      console.error(
        "[configure] Gateway restart failed after configuring",
        ocProvider,
        ":",
        err instanceof Error ? err.message : err,
      );
      await setMany({
        ai_model_configured: false,
        ai_model_provider: provider,
        ai_model_last_error:
          err instanceof Error ? err.message : "Gateway restart failed after AI configuration",
      }).catch(() => {});
      return NextResponse.json(
        {
          error:
            "AI model configured but gateway failed to restart. Install OpenClaw and enable clawbox-gateway, or reboot.",
        },
        { status: 502 },
      );
    }

    await setMany({
      ai_model_configured: true,
      ai_model_provider: provider,
      ai_model_configured_at: new Date().toISOString(),
      ai_model_last_error: undefined,
    });

    return NextResponse.json({ success: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to configure AI model" },
      { status: 500 },
    );
  }
}
