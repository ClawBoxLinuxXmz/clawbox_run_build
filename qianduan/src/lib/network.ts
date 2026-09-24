import { execFile } from "child_process";
import { promisify } from "util";
import { getDeviceAccessInfo } from "@/lib/device-identity";

const exec = promisify(execFile);
const DEFAULT_WIFI_IFACE = process.env.NETWORK_INTERFACE || "wlan0";
const NETWORK_TIMEOUT = Number(process.env.NETWORK_COMMAND_TIMEOUT) || 60000;
const WIFI_DHCP_WAIT_MS = Math.max(
  5_000,
  Number(process.env.WIFI_DHCP_WAIT_MS) || 45_000,
);
const WIFI_DHCP_POLL_MS = Math.max(
  500,
  Number(process.env.WIFI_DHCP_POLL_MS) || 1_500,
);
/** 停热点后等待接口/驱动就绪再发起 STA 关联（毫秒），避免 AP→STA 切换过快导致关联失败 */
const AP_DOWN_SETTLE_MS = Math.max(
  0,
  Number(process.env.WIFI_AP_DOWN_SETTLE_MS) || 1500,
);
const AP_START_SCRIPT =
  process.env.AP_START_SCRIPT || "/home/clawbox/clawbox/scripts/start-ap.sh";
const AP_STOP_SCRIPT =
  process.env.AP_STOP_SCRIPT || "/home/clawbox/clawbox/scripts/stop-ap.sh";

// Mutex to serialize concurrent scanWifi calls
let scanLock: Promise<void> = Promise.resolve();

// Cache scan results so retry requests after AP restore don't trigger another teardown
let cachedScan: { networks: WifiNetwork[]; timestamp: number } | null = null;
const SCAN_CACHE_TTL = 30_000; // 30 seconds
const WIFI_SCAN_TIMEOUT_MS = Math.max(
  10_000,
  Number(process.env.WIFI_SCAN_TIMEOUT_MS) || 35_000,
);

// Background scan state
let scanInProgress = false;
let lastScanError: string | null = null;

export interface WifiNetwork {
  ssid: string;
  signal: number;
  security: string;
  freq: string;
}

export interface WifiStatus {
  mode: "ap" | "client" | "disconnected" | "unknown";
  connected: boolean;
  ssid: string | null;
  interface: string;
  ipv4: string | null;
  gateway: string | null;
  hostname: string;
  mdnsHost: string;
  accessUrl: string;
  localDnsAlias: string | null;
  mdnsReady: boolean;
  pending: boolean;
  targetSsid: string | null;
  lastError: string | null;
}

export interface WifiRuntimeState {
  mode: WifiStatus["mode"];
  connected: boolean;
  ssid: string | null;
  ipv4: string | null;
  hotspotActive: boolean;
}

let cachedIface: string = DEFAULT_WIFI_IFACE;
let cachedIfaceAt = 0;
const IFACE_CACHE_TTL_MS = 10_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function forceApEnv(): NodeJS.ProcessEnv {
  return { ...process.env, CLAWBOX_FORCE_AP: "1", NETWORK_INTERFACE: cachedIface };
}

async function resolveWifiInterface(force = false): Promise<string> {
  const now = Date.now();
  if (!force && cachedIface && now - cachedIfaceAt < IFACE_CACHE_TTL_MS) {
    return cachedIface;
  }

  const preferred = process.env.NETWORK_INTERFACE?.trim();
  if (preferred) {
    try {
      const { stdout } = await exec(
        "nmcli",
        ["-t", "-f", "GENERAL.TYPE", "device", "show", preferred],
        { timeout: NETWORK_TIMEOUT },
      );
      if (stdout.trim() === "GENERAL.TYPE:wifi") {
        cachedIface = preferred;
        cachedIfaceAt = now;
        return cachedIface;
      }
    } catch {
      // fall through
    }
  }

  try {
    const { stdout } = await exec("nmcli", ["-t", "-f", "DEVICE,TYPE", "device", "status"], {
      timeout: NETWORK_TIMEOUT,
    });
    const detected = stdout
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.endsWith(":wifi"))
      ?.split(":")[0]
      ?.trim();

    if (detected) {
      cachedIface = detected;
      cachedIfaceAt = now;
      return cachedIface;
    }
  } catch {
    // fall through
  }

  cachedIface = DEFAULT_WIFI_IFACE;
  cachedIfaceAt = now;
  return cachedIface;
}

async function ensureWifiDeviceReady(): Promise<string> {
  const iface = await resolveWifiInterface();
  await exec("rfkill", ["unblock", "wifi"], { timeout: NETWORK_TIMEOUT }).catch(() => {});
  await exec("nmcli", ["radio", "wifi", "on"], { timeout: NETWORK_TIMEOUT }).catch(() => {});
  await exec("nmcli", ["device", "set", iface, "managed", "yes"], {
    timeout: NETWORK_TIMEOUT,
  }).catch(() => {});
  await exec("ip", ["link", "set", iface, "up"], { timeout: NETWORK_TIMEOUT }).catch(() => {});
  return iface;
}

function stripCidr(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.split("/")[0] || null;
}

function isConnectedState(state: string | undefined): boolean {
  if (!state) return false;
  return state.includes("(connected)") || state === "connected";
}

function toErrorMessage(err: unknown): string {
  if (err instanceof Error && err.message.trim()) {
    return err.message;
  }
  return String(err || "Unknown scan error");
}

async function isAPMode(iface?: string): Promise<boolean> {
  const target = iface ?? (await resolveWifiInterface());
  try {
    const { stdout } = await exec("iw", ["dev", target, "info"], { timeout: NETWORK_TIMEOUT });
    return stdout.includes("type AP");
  } catch {
    return false;
  }
}

async function isMdnsReady(): Promise<boolean> {
  try {
    const [avahi, serviceFile] = await Promise.all([
      exec("systemctl", ["is-active", "avahi-daemon"], { timeout: NETWORK_TIMEOUT }),
      exec("test", ["-f", "/etc/avahi/services/clawbox-http.service"], {
        timeout: NETWORK_TIMEOUT,
      }),
    ]);
    return avahi.stdout.trim() === "active" && serviceFile.stderr === "";
  } catch {
    return false;
  }
}

async function bringAPUp(): Promise<void> {
  const iface = await resolveWifiInterface(true);
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await exec("bash", [AP_START_SCRIPT], {
        timeout: NETWORK_TIMEOUT,
        env: { ...forceApEnv(), NETWORK_INTERFACE: iface },
      });
      const apUp = await isAPMode(iface);
      if (apUp) {
        console.log(`[WiFi] AP restored on ${iface} (attempt ${attempt})`);
        return;
      }
      console.warn(`[WiFi] AP start returned success but AP not detected (attempt ${attempt})`);
    } catch (err) {
      console.error(
        `[WiFi] Failed to restore AP (attempt ${attempt}/3):`,
        err instanceof Error ? err.message : err
      );
    }
    if (attempt < 3) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
  throw new Error("[WiFi] All AP restore attempts failed");
}

async function readWifiStatus(): Promise<WifiStatus> {
  const accessInfo = await getDeviceAccessInfo();
  const iface = await resolveWifiInterface();

  try {
    const [apMode, deviceInfo, mdnsReady] = await Promise.all([
      isAPMode(iface),
      exec(
        "nmcli",
        [
          "-t",
          "-f",
          "GENERAL.STATE,GENERAL.CONNECTION,IP4.ADDRESS,IP4.GATEWAY",
          "device",
          "show",
          iface,
        ],
        { timeout: NETWORK_TIMEOUT },
      ),
      isMdnsReady(),
    ]);

    const details: Record<string, string> = {};
    let firstIpv4: string | null = null;

    for (const line of deviceInfo.stdout.split("\n")) {
      const idx = line.indexOf(":");
      if (idx < 0) continue;

      const key = line.slice(0, idx).trim();
      const value = line.slice(idx + 1).trim();
      if (!value) continue;

      if (key.startsWith("IP4.ADDRESS")) {
        firstIpv4 ??= value;
        continue;
      }

      details[key] = value;
    }

    const connection = details["GENERAL.CONNECTION"];
    const state = details["GENERAL.STATE"];
    const ssid =
      connection && connection !== "--" && connection !== "ClawBox-Setup"
        ? connection
        : null;
    const ipv4 = stripCidr(firstIpv4);
    const gateway = stripCidr(details["IP4.GATEWAY"]);

    let mode: WifiStatus["mode"] = "unknown";
    let connected = false;

    if (apMode || connection === "ClawBox-Setup") {
      mode = "ap";
    } else if (ssid) {
      mode = "client";
      connected = isConnectedState(state) && !!ipv4;
    } else if (state) {
      mode = "disconnected";
    }

    return {
      mode,
      connected,
      ssid,
      interface: iface,
      ipv4,
      gateway,
      hostname: accessInfo.hostname,
      mdnsHost: accessInfo.mdnsHost,
      accessUrl: accessInfo.accessUrl,
      localDnsAlias: accessInfo.localDnsAlias,
      mdnsReady,
      pending: false,
      targetSsid: null,
      lastError: null,
    };
  } catch {
    const mdnsReady = await isMdnsReady().catch(() => false);
    return {
      mode: "unknown",
      connected: false,
      ssid: null,
      interface: iface,
      ipv4: null,
      gateway: null,
      hostname: accessInfo.hostname,
      mdnsHost: accessInfo.mdnsHost,
      accessUrl: accessInfo.accessUrl,
      localDnsAlias: accessInfo.localDnsAlias,
      mdnsReady,
      pending: false,
      targetSsid: null,
      lastError: null,
    };
  }
}

async function waitForClientLease(expectedSsid: string): Promise<WifiStatus> {
  const deadline = Date.now() + WIFI_DHCP_WAIT_MS;
  let lastStatus = await readWifiStatus();

  while (Date.now() < deadline) {
    lastStatus = await readWifiStatus();
    if (
      lastStatus.mode === "client" &&
      lastStatus.connected &&
      lastStatus.ssid === expectedSsid &&
      lastStatus.ipv4
    ) {
      return lastStatus;
    }
    await sleep(WIFI_DHCP_POLL_MS);
  }

  const suffix =
    lastStatus.ssid && lastStatus.ssid !== expectedSsid
      ? ` (currently associated with "${lastStatus.ssid}")`
      : "";
  throw new Error(
    `[WiFi] Connected to "${expectedSsid}" but DHCP did not provide an IPv4 lease within ${WIFI_DHCP_WAIT_MS}ms${suffix}`,
  );
}

export async function scanWifi(): Promise<WifiNetwork[]> {
  // Return cached results if fresh (avoids tearing down AP again on retry)
  if (cachedScan && (Date.now() - cachedScan.timestamp) < SCAN_CACHE_TTL) {
    return cachedScan.networks;
  }

  // Serialize concurrent scan requests
  let resolve: () => void;
  const prev = scanLock;
  scanLock = new Promise<void>((r) => { resolve = r; });
  await prev;

  // Check cache again after acquiring lock (another request may have just scanned)
  if (cachedScan && (Date.now() - cachedScan.timestamp) < SCAN_CACHE_TTL) {
    resolve!();
    return cachedScan.networks;
  }

  try {
    const networks = await doScan();
    cachedScan = { networks, timestamp: Date.now() };
    lastScanError = null;
    return networks;
  } catch (err) {
    lastScanError = toErrorMessage(err);
    throw err;
  } finally {
    resolve!();
  }
}

/** Fire-and-forget: kicks off a scan in the background. Returns immediately. */
export function triggerBackgroundScan(): void {
  if (scanInProgress) return;
  if (cachedScan && (Date.now() - cachedScan.timestamp) < SCAN_CACHE_TTL) return;

  scanInProgress = true;
  lastScanError = null;
  scanWifi()
    .catch((err) => console.error("[WiFi] Background scan failed:", err instanceof Error ? err.message : err))
    .finally(() => { scanInProgress = false; });
}

/** Returns current scan state for polling. */
export function getScanStatus(): {
  scanning: boolean;
  networks: WifiNetwork[] | null;
  error: string | null;
} {
  if (scanInProgress) {
    return { scanning: true, networks: null, error: null };
  }
  if (cachedScan) {
    return { scanning: false, networks: cachedScan.networks, error: lastScanError };
  }
  return { scanning: false, networks: null, error: lastScanError };
}

function parseWifiList(stdout: string): WifiNetwork[] {
  const networks = stdout
    .trim()
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => {
      // nmcli terse mode uses ':' as delimiter; SSID could contain ':'
      // but SIGNAL, SECURITY, FREQ are at the end - parse from right
      const parts = line.split(":");
      if (parts.length < 4) {
        console.warn("[WiFi] Dropping malformed nmcli line:", line);
        return null;
      }
      const freq = parts.pop()!;
      const security = parts.pop()!;
      const signal = parts.pop()!;
      const ssid = parts.join(":"); // rejoin in case SSID had ':'
      if (!ssid) {
        console.warn("[WiFi] Dropping line with empty SSID:", line);
        return null;
      }
      const signalNum = parseInt(signal, 10);
      if (Number.isNaN(signalNum)) {
        console.warn("[WiFi] Dropping line with non-numeric signal:", line);
        return null;
      }
      return { ssid, signal: signalNum, security, freq };
    })
    .filter(
      (n): n is WifiNetwork => n !== null && n.ssid !== "ClawBox-Setup"
    );

  // Deduplicate by SSID, keep strongest signal
  const deduped = new Map<string, WifiNetwork>();
  for (const n of networks) {
    if (!deduped.has(n.ssid) || deduped.get(n.ssid)!.signal < n.signal) {
      deduped.set(n.ssid, n);
    }
  }

  return Array.from(deduped.values()).sort((a, b) => b.signal - a.signal);
}

async function doScan(): Promise<WifiNetwork[]> {
  const iface = await ensureWifiDeviceReady();
  const wasAP = await isAPMode(iface);

  if (wasAP) {
    // Disconnect AP so the interface can scan in station mode
    await exec("nmcli", ["connection", "down", "ClawBox-Setup"], { timeout: NETWORK_TIMEOUT }).catch(
      () => {}
    );
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  try {
    // Trigger a fresh scan
    await exec("nmcli", ["device", "wifi", "rescan", "ifname", iface], { timeout: NETWORK_TIMEOUT }).catch(
      () => {}
    );
    await sleep(3000);

    try {
      const { stdout } = await exec("nmcli", [
        "-t",
        "-f",
        "SSID,SIGNAL,SECURITY,FREQ",
        "device",
        "wifi",
        "list",
        "ifname",
        iface,
      ], { timeout: WIFI_SCAN_TIMEOUT_MS });
      return parseWifiList(stdout);
    } catch (primaryErr) {
      console.warn("[WiFi] Primary scan failed, trying fallback list:", toErrorMessage(primaryErr));
      const { stdout } = await exec("nmcli", [
        "-t",
        "-f",
        "SSID,SIGNAL,SECURITY,FREQ",
        "device",
        "wifi",
        "list",
      ], { timeout: Math.min(WIFI_SCAN_TIMEOUT_MS, NETWORK_TIMEOUT) });
      return parseWifiList(stdout);
    }
  } finally {
    if (wasAP) {
      try {
        await bringAPUp();
      } catch (err) {
        console.error("[WiFi] Failed to restore AP after scan:", err instanceof Error ? err.message : err);
      }
    }
  }
}

export async function switchToClient(
  ssid: string,
  password?: string
): Promise<{ message: string; status: WifiStatus }> {
  console.log(`[WiFi] Switching to client mode, connecting to: ${ssid}`);

  const iface = await ensureWifiDeviceReady();

  // Stop the AP
  await exec("bash", [AP_STOP_SCRIPT], { timeout: NETWORK_TIMEOUT });

  if (AP_DOWN_SETTLE_MS > 0) {
    console.log(`[WiFi] Waiting ${AP_DOWN_SETTLE_MS}ms after AP down before STA connect`);
    await new Promise((resolve) => setTimeout(resolve, AP_DOWN_SETTLE_MS));
  }

  // Build args conditionally instead of splicing
  const args = password
    ? ["device", "wifi", "connect", ssid, "password", password, "ifname", iface]
    : ["device", "wifi", "connect", ssid, "ifname", iface];

  try {
    const { stdout } = await exec("nmcli", args, { timeout: NETWORK_TIMEOUT });
    console.log(`[WiFi] Associated: ${stdout.trim()}`);
    const status = await waitForClientLease(ssid);
    console.log(`[WiFi] DHCP ready: ${status.ipv4 ?? "unknown IP"}`);
    return {
      message: `Connected to ${ssid}. Open ${status.accessUrl} on the same Wi‑Fi. If mDNS is unavailable on this device, use ${status.ipv4 ?? "the IP shown on the screen"}.`,
      status,
    };
  } catch (err) {
    console.error("[WiFi] Connection failed, restoring AP:", err instanceof Error ? err.message : err);

    const AP_RESTORE_RETRIES = 3;
    const AP_RESTORE_BACKOFF = 3000;
    let apRestored = false;

    for (let attempt = 1; attempt <= AP_RESTORE_RETRIES; attempt++) {
      try {
        await exec("bash", [AP_START_SCRIPT], {
          timeout: NETWORK_TIMEOUT,
          env: { ...forceApEnv(), NETWORK_INTERFACE: iface },
        });
        // Verify AP is actually up
        const apUp = await isAPMode(iface);
        if (apUp) {
          console.log(`[WiFi] AP restored after connect failure (attempt ${attempt})`);
          apRestored = true;
          break;
        }
        console.warn(`[WiFi] AP start returned success but AP not detected (attempt ${attempt})`);
      } catch (apErr) {
        console.error(
          `[WiFi] Failed to restore AP (attempt ${attempt}/${AP_RESTORE_RETRIES}):`,
          apErr instanceof Error ? apErr.message : apErr
        );
      }
      if (attempt < AP_RESTORE_RETRIES) {
        await new Promise((resolve) => setTimeout(resolve, AP_RESTORE_BACKOFF * attempt));
      }
    }

    if (!apRestored) {
      console.error("[WiFi] All AP restore attempts failed after connect failure. Device may be unreachable.");
      // Last resort: try nmcli directly
      try {
        await exec("nmcli", ["connection", "up", "ClawBox-Setup"], { timeout: NETWORK_TIMEOUT });
        console.log("[WiFi] AP restored via direct nmcli fallback");
      } catch (fallbackErr) {
        console.error("[WiFi] Direct nmcli fallback also failed:", fallbackErr instanceof Error ? fallbackErr.message : fallbackErr);
      }
    }

    throw err;
  }
}

export async function restartAP(): Promise<void> {
  console.log("[WiFi] Restarting access point...");
  const iface = await ensureWifiDeviceReady();
  await exec("bash", [AP_START_SCRIPT], {
    timeout: NETWORK_TIMEOUT,
    env: { ...forceApEnv(), NETWORK_INTERFACE: iface },
  });
}

export async function getWifiStatus(): Promise<WifiStatus> {
  return readWifiStatus();
}

export async function getWifiRuntimeState(): Promise<WifiRuntimeState> {
  const status = await readWifiStatus();
  return {
    mode: status.mode,
    connected: status.mode === "client" && status.connected && !!status.ipv4,
    ssid: status.ssid,
    ipv4: status.ipv4,
    hotspotActive: status.mode === "ap",
  };
}
