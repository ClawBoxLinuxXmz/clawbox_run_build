import { NextResponse } from "next/server";
import { getSignalStatus } from "@/lib/channels/signal";
export const dynamic = "force-dynamic";
export async function GET(request?: Request) {
  try {
    const force = request?.url ? new URL(request.url).searchParams.get("force") === "1" : false;
    return NextResponse.json(await getSignalStatus(force ? { force: true } : undefined), { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return NextResponse.json({ state: "error", connected: false, running: false, lastError: e instanceof Error ? e.message : "Failed to check Signal status." }, { status: 502, headers: { "Cache-Control": "no-store" } });
  }
}
