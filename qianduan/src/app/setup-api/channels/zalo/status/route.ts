import { NextResponse } from "next/server";
import { getZaloStatus } from "@/lib/channels/zalo";
export const dynamic = "force-dynamic";
export async function GET(request?: Request) {
  try {
    const force = request?.url ? new URL(request.url).searchParams.get("force") === "1" : false;
    return NextResponse.json(await getZaloStatus(undefined, force ? { force: true } : undefined), { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return NextResponse.json({ state: "error", connected: false, running: false, lastError: e instanceof Error ? e.message : "Failed to check Zalo status." }, { status: 502, headers: { "Cache-Control": "no-store" } });
  }
}
