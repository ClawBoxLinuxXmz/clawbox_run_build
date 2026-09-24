import { NextResponse } from "next/server";
import { disableZaloPersonalConfig, getZaloPersonalConfig, saveZaloPersonalConfig } from "@/lib/channels/zalouser";
import { restartGateway } from "@/lib/openclaw-config";
export const dynamic = "force-dynamic";
export async function GET() { try { return NextResponse.json(await getZaloPersonalConfig()); } catch (e) { return NextResponse.json({ error: e instanceof Error ? e.message : "Failed to read Zalo Personal config." }, { status: 500 }); } }
export async function POST(request: Request) {
  let body: { enabled?: unknown; riskAccepted?: unknown };
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  if (typeof body.enabled !== "boolean" || typeof body.riskAccepted !== "boolean") return NextResponse.json({ error: "enabled and riskAccepted must be booleans" }, { status: 400 });
  try {
    const saved = await saveZaloPersonalConfig({ enabled: body.enabled, riskAccepted: body.riskAccepted });
    await restartGateway();
    return NextResponse.json({ success: true, ...saved });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed to save Zalo Personal config." }, { status: 502 });
  }
}
export async function PATCH() {
  try {
    const saved = await disableZaloPersonalConfig();
    await restartGateway();
    return NextResponse.json({ success: true, ...saved });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed to disable Zalo Personal config." }, { status: 502 });
  }
}
