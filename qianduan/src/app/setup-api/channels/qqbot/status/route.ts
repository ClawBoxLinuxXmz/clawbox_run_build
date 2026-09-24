import { NextResponse } from "next/server";
import { setMany } from "@/lib/config-store";
import { probeQQBotChannel } from "@/lib/channels/qqbot";

export const dynamic = "force-dynamic";

export async function GET(request?: Request) {
  try {
    const force = request?.url ? new URL(request.url).searchParams.get("force") === "1" : false;
    const status = await probeQQBotChannel(force ? { force: true } : undefined);
    if (
      status.connected ||
      status.state === "disabled" ||
      status.state === "not_configured"
    ) {
      await setMany({ qqbot_last_error: undefined }).catch(() => {});
    }
    return NextResponse.json(status, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to check QQ Bot status.";
    await setMany({ qqbot_last_error: message }).catch(() => {});
    return NextResponse.json(
      {
        state: "error",
        configured: true,
        enabled: true,
        hasClientSecret: true,
        appId: null,
        connected: false,
        running: false,
        lastError: message,
      },
      { status: 502, headers: { "Cache-Control": "no-store" } },
    );
  }
}
