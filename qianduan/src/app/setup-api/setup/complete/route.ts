import { NextResponse } from "next/server";
import { set } from "@/lib/config-store";
import { getSetupStatus } from "@/lib/setup-status";

export async function POST() {
  try {
    const status = await getSetupStatus();
    if (!status.wifi_configured) {
      return NextResponse.json(
        { error: "Complete WiFi setup before finishing setup." },
        { status: 409 },
      );
    }

    if (!status.ai_model_configured) {
      return NextResponse.json(
        { error: "Configure your AI provider before finishing setup." },
        { status: 409 },
      );
    }

    const timestamp = new Date().toISOString();
    await set("setup_complete", true);
    await set("setup_completed_at", timestamp);
    return NextResponse.json({ success: true });
  } catch (err) {
    // Rollback on partial failure
    await set("setup_complete", undefined).catch(() => {});
    await set("setup_completed_at", undefined).catch(() => {});
    return NextResponse.json(
      {
        error:
          err instanceof Error ? err.message : "Failed to complete setup",
      },
      { status: 500 }
    );
  }
}
