import { NextResponse } from "next/server";
import { setMany } from "@/lib/config-store";
import { getWeComConfig, probeWeComChannel } from "@/lib/channels/wecom";
import { sanitizeChannelOutput } from "@/lib/channels/openclaw-runtime";

export const dynamic = "force-dynamic";

export async function GET(request?: Request) {
  try {
    const force = request?.url ? new URL(request.url).searchParams.get("force") === "1" : false;
    const status = await probeWeComChannel(force ? { force: true } : undefined);
    if (status.connected || status.state === "disabled" || status.state === "not_configured") {
      await setMany({ wecom_last_error: undefined }).catch(() => {});
    }
    return NextResponse.json(status, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = sanitizeChannelOutput(
      error instanceof Error ? error.message : "Failed to check WeCom status.",
    );
    await setMany({ wecom_last_error: message }).catch(() => {});
    const config = await getWeComConfig().catch(() => ({
      configured: false,
      enabled: false,
      hasSecret: false,
      botId: null,
      connectionMode: "websocket" as const,
    }));
    return NextResponse.json(
      {
        ...config,
        state: "error",
        connected: false,
        running: false,
        probeOk: false,
        lastError: message,
      },
      { status: 502, headers: { "Cache-Control": "no-store" } },
    );
  }
}
