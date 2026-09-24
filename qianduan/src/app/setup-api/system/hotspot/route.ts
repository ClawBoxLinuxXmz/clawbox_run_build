import { NextResponse } from "next/server";
import fs from "fs/promises";
import { execFile } from "child_process";
import { promisify } from "util";
import path from "path";
import { get, setMany, getAll } from "@/lib/config-store";

const execFileAsync = promisify(execFile);

export const dynamic = "force-dynamic";

const HOTSPOT_ENV_PATH = path.join(
  process.env.CLAWBOX_ROOT || "/home/clawbox/clawbox",
  "data",
  "hotspot.env"
);

function isHotspotBody(
  value: unknown,
): value is { ssid?: string; password?: string; enabled?: boolean } {
  return typeof value === "object" && value !== null;
}

export async function GET() {
  const config = await getAll();
  const ssid = (config.hotspot_ssid as string) || "ClawBox-Setup";
  const hasPassword = !!config.hotspot_password;
  const enabled = config.hotspot_enabled !== false;
  return NextResponse.json({ ssid, hasPassword, enabled });
}

export async function POST(request: Request) {
  try {
    let body: { ssid?: string; password?: string; enabled?: boolean };
    try {
      const payload: unknown = await request.json();
      if (!isHotspotBody(payload)) {
        return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
      }
      body = payload;
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    const { ssid, password, enabled } = body;

    if (!ssid || !ssid.trim()) {
      return NextResponse.json(
        { error: "Hotspot name is required" },
        { status: 400 }
      );
    }

    if (ssid.length > 32) {
      return NextResponse.json(
        { error: "Hotspot name must be 32 characters or less" },
        { status: 400 }
      );
    }

    if (password && password.length < 8) {
      return NextResponse.json(
        { error: "Hotspot password must be at least 8 characters" },
        { status: 400 }
      );
    }

    if (password && password.length > 63) {
      return NextResponse.json(
        { error: "Hotspot password must be 63 characters or less" },
        { status: 400 }
      );
    }

    const updates: Record<string, unknown> = {
      hotspot_ssid: ssid.trim(),
      hotspot_password: password || undefined,
    };
    if (typeof enabled === "boolean") {
      updates.hotspot_enabled = enabled;
    }
    await setMany(updates);

    const isEnabled = typeof enabled === "boolean" ? enabled : (await get("hotspot_enabled")) !== false;

    // Write shell-sourceable env file for start-ap.sh
    const envLines = [`HOTSPOT_SSID=${shellQuote(ssid.trim())}`];
    if (password) {
      envLines.push(`HOTSPOT_PASSWORD=${shellQuote(password)}`);
    }
    if (!isEnabled) {
      envLines.push(`HOTSPOT_DISABLED=1`);
    }
    await fs.mkdir(path.dirname(HOTSPOT_ENV_PATH), { recursive: true });
    await fs.writeFile(HOTSPOT_ENV_PATH, envLines.join("\n") + "\n", {
      mode: 0o600,
    });

    // Start or stop the AP service based on enabled state
    try {
      if (isEnabled) {
        await execFileAsync("systemctl", ["restart", "clawbox-ap.service"], {
          timeout: 15_000,
        });
      } else {
        await execFileAsync("systemctl", ["stop", "clawbox-ap.service"], {
          timeout: 15_000,
        });
      }
    } catch (apErr) {
      console.warn("[hotspot] Failed to toggle AP:", apErr);
      // Non-fatal: settings are saved for next AP start
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    return NextResponse.json(
      {
        error: err instanceof Error ? err.message : "Failed to save hotspot settings",
      },
      { status: 500 }
    );
  }
}

/** Safely quote a value for shell assignment */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
