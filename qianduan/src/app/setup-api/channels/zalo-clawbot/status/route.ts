import { NextResponse } from "next/server";
import { getClawBotStatus } from "@/lib/channels/zalo-clawbot";

export const dynamic = "force-dynamic";

export async function GET(request?: Request) {
  try {
    const force = request?.url ? new URL(request.url).searchParams.get("force") === "1" : false;
    return NextResponse.json(await getClawBotStatus(force ? { force: true } : undefined), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return NextResponse.json(
      {
        state: "error",
        connected: false,
        running: false,
        lastError: error instanceof Error ? error.message : "Failed to check Zalo ClawBot status.",
      },
      { status: 502, headers: { "Cache-Control": "no-store" } },
    );
  }
}
