import { NextResponse } from "next/server";
import { getAll } from "@/lib/config-store";
import { getClawBotConfig, setClawBotEnabled, startClawBotQrLogin } from "@/lib/channels/zalo-clawbot";
export const dynamic = "force-dynamic";
export async function GET() {
  try {
    return NextResponse.json(await getClawBotConfig(), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to read Zalo ClawBot config." },
      { status: 500 },
    );
  }
}
export async function POST() { const setup = await getAll(); if (!setup.ai_model_configured) return NextResponse.json({ error: "Configure your AI provider before setting up Zalo ClawBot." }, { status: 409 }); try { return NextResponse.json({ success: true, ...(await startClawBotQrLogin()) }, { headers: { "Cache-Control": "no-store" } }); } catch (e) { return NextResponse.json({ error: e instanceof Error ? e.message : "Failed to start Zalo ClawBot QR login." }, { status: 502 }); } }

export async function PATCH(request: Request) {
  let body: { enabled?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (typeof body.enabled !== "boolean") {
    return NextResponse.json({ error: "enabled must be a boolean" }, { status: 400 });
  }
  try {
    return NextResponse.json({ success: true, saved: true, ...(await setClawBotEnabled(body.enabled)) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed to update Zalo ClawBot." }, { status: 502 });
  }
}
