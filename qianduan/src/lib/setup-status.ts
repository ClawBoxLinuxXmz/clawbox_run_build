import { getAll, setMany } from "@/lib/config-store";
import { getWifiRuntimeState } from "@/lib/network";

export interface SetupStatus {
  setup_complete: boolean;
  password_configured: boolean;
  wifi_configured: boolean;
  wifi_mode: "ap" | "client" | "disconnected" | "unknown";
  hotspot_active: boolean;
  ai_model_configured: boolean;
  ai_model_provider?: string;
  wifi_connecting: boolean;
  wifi_target_ssid: string | null;
  wifi_last_error: string | null;
  ai_model_last_error: string | null;
}

const WIFI_CONNECT_PENDING_TTL_MS = Math.max(
  30_000,
  Number(process.env.WIFI_CONNECT_PENDING_TTL_MS) || 180_000,
);

const WIFI_PENDING_TIMEOUT_MESSAGE =
  "WiFi command was sent, but status is still pending. Reconnect to the setup hotspot and try again.";
const WIFI_AP_FALLBACK_MESSAGE =
  "Connection failed and the setup hotspot is active again. Check the WiFi password and try again.";

function getString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function parseIsoMs(value: unknown): number | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

export async function getSetupStatus(): Promise<SetupStatus> {
  const [config, runtime] = await Promise.all([getAll(), getWifiRuntimeState()]);

  const runtimeWifiConfigured =
    runtime.mode === "client" && runtime.connected && !!runtime.ipv4;
  const storedWifiConfigured = !!config.wifi_configured;
  const wifiTargetSsid = getString(config.wifi_target_ssid) ?? runtime.ssid ?? null;
  const storedWifiSsid = getString(config.wifi_ssid);
  const hasWifiTarget = !!(wifiTargetSsid || storedWifiSsid);
  const hotspotActive = runtime.hotspotActive || runtime.mode === "ap";
  const runtimeRequiresWifiSetup = hotspotActive && hasWifiTarget;
  const wifiConfigured = runtimeWifiConfigured || (storedWifiConfigured && !runtimeRequiresWifiSetup);

  const wifiAttemptMs = parseIsoMs(config.wifi_last_attempt_at);
  const staleWifiPending =
    !!config.wifi_connecting &&
    !runtimeWifiConfigured &&
    wifiAttemptMs !== null &&
    Date.now() - wifiAttemptMs > WIFI_CONNECT_PENDING_TTL_MS;
  const failedBackToHotspot =
    !!config.wifi_connecting &&
    !runtimeWifiConfigured &&
    hotspotActive &&
    hasWifiTarget;

  let wifiConnecting =
    !!config.wifi_connecting && !runtimeWifiConfigured && !failedBackToHotspot;
  let wifiLastError = runtimeWifiConfigured ? null : getString(config.wifi_last_error);
  const aiModelLastError = getString(config.ai_model_last_error);

  if (failedBackToHotspot && !wifiLastError) {
    wifiLastError = WIFI_AP_FALLBACK_MESSAGE;
  }

  if (staleWifiPending) {
    wifiConnecting = false;
    if (!wifiLastError) {
      wifiLastError = WIFI_PENDING_TIMEOUT_MESSAGE;
    }
  }

  if (runtimeWifiConfigured && (!storedWifiConfigured || !!config.wifi_connecting || wifiLastError)) {
    await setMany({
      wifi_configured: true,
      hotspot_enabled: false,
      wifi_connecting: false,
      wifi_target_ssid: runtime.ssid ?? wifiTargetSsid ?? undefined,
      wifi_last_error: undefined,
    }).catch(() => {});
  } else if (failedBackToHotspot || staleWifiPending) {
    await setMany({
      wifi_connecting: false,
      wifi_last_error:
        wifiLastError ??
        (failedBackToHotspot
          ? WIFI_AP_FALLBACK_MESSAGE
          : WIFI_PENDING_TIMEOUT_MESSAGE),
    }).catch(() => {});
  }

  return {
    setup_complete: !!config.setup_complete,
    password_configured: !!config.password_configured,
    wifi_configured: wifiConfigured,
    wifi_mode: runtime.mode,
    hotspot_active: hotspotActive,
    ai_model_configured: !!config.ai_model_configured,
    ai_model_provider:
      typeof config.ai_model_provider === "string"
        ? config.ai_model_provider
        : undefined,
    wifi_connecting: wifiConnecting,
    wifi_target_ssid: wifiTargetSsid,
    wifi_last_error: wifiLastError,
    ai_model_last_error: aiModelLastError,
  };
}
