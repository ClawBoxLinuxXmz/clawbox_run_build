import { NextResponse } from "next/server";
import { resetUpdateState } from "@/lib/updater";
import { DATA_DIR, getAll, setMany } from "@/lib/config-store";
import { restartAP } from "@/lib/network";
import { execFile as execFileCb } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import path from "path";

const execFile = promisify(execFileCb);

export const dynamic = "force-dynamic";

const OPENCLAW_DIR = process.env.OPENCLAW_HOME || "/home/clawbox/.openclaw";
const DEFAULT_AP_SSID = "ClawBox-Setup";
const HOTSPOT_URL = "http://192.168.4.1/setup";

// Preserve hardware-specific files during factory reset.
const PRESERVE_FILES = new Set(["network.env", "device-hostname.env"]);

type ResetMode = "wifi" | "factory";

interface WifiCleanupResult {
  deleted: string[];
  failures: string[];
}

function isResetMode(value: unknown): value is ResetMode {
  return value === "wifi" || value === "factory";
}

async function readResetMode(request?: Request): Promise<{ mode: ResetMode } | { error: string }> {
  if (!request) return { mode: "factory" };

  const raw = await request.text().catch(() => "");
  if (!raw.trim()) return { mode: "factory" };

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return { error: "Invalid JSON body" };
  }

  if (typeof payload !== "object" || payload === null || !("mode" in payload)) {
    return { mode: "factory" };
  }

  const mode = (payload as { mode?: unknown }).mode;
  if (!isResetMode(mode)) {
    return { error: "Reset mode must be either 'wifi' or 'factory'." };
  }

  return { mode };
}

function parseConnectionLine(line: string): { name: string; type: string } | null {
  const idx = line.lastIndexOf(":");
  if (idx <= 0) return null;
  return {
    name: line.slice(0, idx).replace(/\\:/g, ":"),
    type: line.slice(idx + 1),
  };
}

function getConfiguredApSsid(config: Record<string, unknown>): string {
  return typeof config.hotspot_ssid === "string" && config.hotspot_ssid.trim()
    ? config.hotspot_ssid.trim()
    : DEFAULT_AP_SSID;
}

async function deleteWifiConnections(apSsid: string, preserveConfiguredAp = true): Promise<WifiCleanupResult> {
  const { stdout } = await execFile("nmcli", ["-t", "-f", "NAME,TYPE", "connection", "show"], {
    timeout: 10_000,
  });
  const preserveNames = new Set(
    [DEFAULT_AP_SSID, preserveConfiguredAp ? apSsid : ""].filter(Boolean),
  );
  const wifiNames = stdout
    .trim()
    .split("\n")
    .map(parseConnectionLine)
    .filter((connection): connection is { name: string; type: string } => {
      return !!connection && connection.type === "802-11-wireless" && !preserveNames.has(connection.name);
    })
    .map((connection) => connection.name);

  const failures: string[] = [];
  for (const name of wifiNames) {
    await execFile("nmcli", ["connection", "delete", name], { timeout: 10_000 }).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      failures.push(`${name}: ${message}`);
      console.warn(`[Reset] Failed to delete WiFi connection '${name}':`, message);
    });
  }
  if (wifiNames.length > 0) {
    console.log(`[Reset] Deleted ${wifiNames.length} saved WiFi connection(s)`);
  }

  return { deleted: wifiNames, failures };
}

async function removeDirectoryContents(dir: string, preserve = new Set<string>()): Promise<string[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch (err: unknown) {
    if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") return [];
    throw err;
  }

  const removableEntries = entries.filter((entry) => !preserve.has(entry));
  const results = await Promise.allSettled(
    removableEntries.map((entry) => fs.rm(path.join(dir, entry), { recursive: true, force: true })),
  );
  const failures = results
    .map((result, i) => result.status === "rejected" ? `${removableEntries[i]}: ${result.reason}` : null)
    .filter((failure): failure is string => failure !== null);
  if (failures.length > 0) {
    console.warn(`[Reset] Failed to remove ${failures.length} item(s) in ${dir}:`, failures);
  }
  return failures;
}

async function resetWifiOnly() {
  const config = await getAll();
  const apSsid = getConfiguredApSsid(config);
  const wifiCleanup = await deleteWifiConnections(apSsid);

  await setMany({
    setup_complete: false,
    wifi_configured: false,
    wifi_connecting: false,
    wifi_ssid: undefined,
    wifi_target_ssid: undefined,
    wifi_last_error: undefined,
    wifi_last_attempt_at: undefined,
    hotspot_enabled: true,
  });

  try {
    await restartAP();
  } catch (err) {
    return NextResponse.json(
      {
        error: err instanceof Error ? err.message : "WiFi reset saved, but hotspot restart failed",
        mode: "wifi",
        hotspotUrl: HOTSPOT_URL,
        wifiCleanup,
      },
      { status: 502 },
    );
  }

  return NextResponse.json({
    success: true,
    mode: "wifi",
    hotspotSsid: apSsid,
    hotspotUrl: HOTSPOT_URL,
    deletedWifiConnections: wifiCleanup.deleted,
    cleanupFailures: wifiCleanup.failures,
  });
}

async function requestReboot(): Promise<void> {
  try {
    await execFile("systemctl", ["start", "clawbox-root-update@reboot.service"], {
      timeout: 10_000,
    });
    return;
  } catch (err) {
    console.warn(
      "[Reset] Root reboot service failed, trying direct reboot:",
      err instanceof Error ? err.message : err,
    );
  }

  await execFile("systemctl", ["reboot"], { timeout: 10_000 });
}

async function resetFactory() {
  const config = await getAll();
  const apSsid = getConfiguredApSsid(config);

  try {
    resetUpdateState();

    const dataFailures = await removeDirectoryContents(DATA_DIR, PRESERVE_FILES);
    const openclawFailures = await removeDirectoryContents(OPENCLAW_DIR);
    const allFailures = [...dataFailures, ...openclawFailures];
    if (allFailures.length > 0) {
      console.warn(`[Reset] ${allFailures.length} file deletion(s) failed; not rebooting`);
    }

    const wifiCleanup = await deleteWifiConnections(apSsid, false).catch((err) => {
      console.error("[Reset] WiFi cleanup failed:", err instanceof Error ? err.message : err);
      return { deleted: [], failures: [err instanceof Error ? err.message : String(err)] };
    });

    await setMany({
      setup_complete: false,
      password_configured: false,
      wifi_configured: false,
      wifi_connecting: false,
      wifi_ssid: undefined,
      wifi_target_ssid: undefined,
      wifi_last_error: undefined,
      wifi_last_attempt_at: undefined,
      ai_model_configured: false,
      ai_model_provider: undefined,
      ai_model_last_error: undefined,
      hotspot_enabled: true,
    });

    if (allFailures.length > 0) {
      return NextResponse.json(
        {
          error: `Factory reset incomplete: ${allFailures.length} file deletion(s) failed`,
          failures: allFailures,
          wifiCleanup,
        },
        { status: 500 },
      );
    }

    setTimeout(async () => {
      try {
        await restartAP();
      } catch (err) {
        console.error("[Reset] Hotspot restore before reboot failed:", err instanceof Error ? err.message : err);
      }
      try {
        await requestReboot();
      } catch (err) {
        console.error("[Reset] Reboot failed:", err instanceof Error ? err.message : err);
      }
    }, 1_000);

    return NextResponse.json({ success: true, mode: "factory", hotspotUrl: HOTSPOT_URL, wifiCleanup });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Factory reset failed" },
      { status: 500 },
    );
  }
}

export async function POST(request?: Request) {
  const parsed = await readResetMode(request);
  if ("error" in parsed) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }

  if (parsed.mode === "wifi") {
    return resetWifiOnly();
  }

  return resetFactory();
}
