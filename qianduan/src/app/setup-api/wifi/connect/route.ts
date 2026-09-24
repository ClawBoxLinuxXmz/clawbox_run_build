import { NextResponse } from "next/server";
import { switchToClient } from "@/lib/network";
import { setMany } from "@/lib/config-store";
import { getDeviceAccessInfo } from "@/lib/device-identity";

const DEFERRED_CONNECT_LEAD_MS = Math.max(
  0,
  Number(process.env.WIFI_DEFERRED_CONNECT_LEAD_MS) || 800,
);

export const dynamic = "force-dynamic";

let pendingWifiSwitch: Promise<void> | null = null;

function isConnectBody(
  value: unknown,
): value is { ssid?: unknown; password?: unknown; skip?: unknown } {
  return typeof value === "object" && value !== null;
}

async function runWifiSwitch(
  ssid: string,
  passwordValue: string | undefined,
): Promise<void> {
  try {
    const result = await switchToClient(ssid, passwordValue);
    await setMany({
      wifi_configured: true,
      hotspot_enabled: false,
      wifi_connecting: false,
      wifi_target_ssid: result.status.ssid ?? ssid,
      wifi_last_error: undefined,
    });
    console.log("[wifi/connect] Device ready at:", result.status.accessUrl);
  } catch (err) {
    const message =
      err instanceof Error
        ? err.message
        : "Failed to join the selected WiFi network";
    console.error("[wifi/connect] Deferred WiFi switch failed:", err);
    await setMany({
      wifi_configured: false,
      wifi_connecting: false,
      wifi_last_error: message,
    }).catch(() => {});
  } finally {
    pendingWifiSwitch = null;
  }
}

export async function POST(request: Request) {
  let body: { ssid?: unknown; password?: unknown; skip?: unknown };
  try {
    const payload: unknown = await request.json();
    if (!isConnectBody(payload)) {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }
    body = payload;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (body.skip) {
    await setMany({
      wifi_ssid: undefined,
      wifi_configured: true,
      wifi_connecting: false,
      wifi_target_ssid: undefined,
      wifi_last_error: undefined,
    });
    const accessInfo = await getDeviceAccessInfo();
    return NextResponse.json({
      success: true,
      message: "WiFi skipped (Ethernet only)",
      mdnsHost: accessInfo.mdnsHost,
      nextUrlHint: accessInfo.accessUrl,
    });
  }

  const { ssid, password } = body;
  if (!ssid || typeof ssid !== "string" || !ssid.trim()) {
    return NextResponse.json({ error: "SSID is required" }, { status: 400 });
  }
  if (password !== undefined && typeof password !== "string") {
    return NextResponse.json(
      { error: "Password must be a string" },
      { status: 400 },
    );
  }

  const ssidTrimmed = ssid.trim();
  const passwordValue = password as string | undefined;

  try {
    await setMany({
      wifi_ssid: ssidTrimmed,
      wifi_configured: false,
      wifi_connecting: true,
      wifi_target_ssid: ssidTrimmed,
      wifi_last_attempt_at: new Date().toISOString(),
      wifi_last_error: undefined,
    });
    const accessInfo = await getDeviceAccessInfo();

    if (!pendingWifiSwitch) {
      pendingWifiSwitch = (async () => {
        if (DEFERRED_CONNECT_LEAD_MS > 0) {
          await new Promise((resolve) =>
            setTimeout(resolve, DEFERRED_CONNECT_LEAD_MS),
          );
        }
        await runWifiSwitch(ssidTrimmed, passwordValue);
      })();
    }

    return NextResponse.json({
      success: true,
      applying: true,
      mdnsHost: accessInfo.mdnsHost,
      nextUrlHint: accessInfo.accessUrl,
      message: `The device is switching to ${ssidTrimmed} and waiting for a DHCP address. Reconnect your phone to the same WiFi, then open ${accessInfo.accessUrl} in a system browser. If this client does not resolve .local names, use the IP shown on the device screen. If the connection fails, reconnect to the setup hotspot and try again.`,
    });
  } catch (err) {
    await setMany({
      wifi_configured: false,
      wifi_connecting: false,
      wifi_last_error:
        err instanceof Error
          ? err.message
          : "Connection failed before WiFi switch started",
    }).catch(() => {});

    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Connection failed" },
      { status: 500 },
    );
  }
}
