import { NextResponse } from "next/server";
import { setMany } from "@/lib/config-store";
import { probeTelegramChannel } from "@/lib/channels/telegram";

export const dynamic = "force-dynamic";

export async function GET(request?: Request) {
  try {
    const force = request?.url ? new URL(request.url).searchParams.get("force") === "1" : false;
    const status = await probeTelegramChannel(force ? { force: true } : undefined);
    if (status.connected || status.state === "disabled" || status.state === "not_configured") {
      await setMany({ telegram_last_error: undefined }).catch(() => {});
    }
    return NextResponse.json(status, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to check Telegram status.";
    await setMany({ telegram_last_error: message }).catch(() => {});
    return NextResponse.json(
      {
        state: "error",
        configured: true,
        enabled: true,
        connected: false,
        running: false,
        probeOk: false,
        botId: null,
        botUsername: null,
        lastError: message,
      },
      { status: 502, headers: { "Cache-Control": "no-store" } },
    );
  }
}
