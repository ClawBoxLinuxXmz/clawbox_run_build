import { NextResponse } from "next/server";
import { getWifiStatus } from "@/lib/network";
import { getAll } from "@/lib/config-store";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const [status, config] = await Promise.all([getWifiStatus(), getAll()]);
    return NextResponse.json({
      ...status,
      pending: !!config.wifi_connecting,
      targetSsid:
        typeof config.wifi_target_ssid === "string"
          ? config.wifi_target_ssid
          : status.targetSsid,
      lastError:
        typeof config.wifi_last_error === "string"
          ? config.wifi_last_error
          : status.lastError,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Status check failed" },
      { status: 500 }
    );
  }
}
