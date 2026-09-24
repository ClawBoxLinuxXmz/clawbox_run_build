import { NextResponse } from "next/server";
import { getAll } from "@/lib/config-store";
import { getZaloPersonalConfig, startZaloPersonalQrLogin } from "@/lib/channels/zalouser";
export const dynamic = "force-dynamic";
export async function POST() { const setup = await getAll(); if (!setup.ai_model_configured) return NextResponse.json({ error: "Configure your AI provider before setting up Zalo Personal." }, { status: 409 }); const config = await getZaloPersonalConfig(); if (!config.riskAccepted) return NextResponse.json({ error: "Confirm the unofficial Zalo Personal account automation risk first." }, { status: 409 }); try { return NextResponse.json({ success: true, ...(await startZaloPersonalQrLogin()) }, { headers: { "Cache-Control": "no-store" } }); } catch (e) { return NextResponse.json({ error: e instanceof Error ? e.message : "Failed to start Zalo Personal QR login." }, { status: 502 }); } }
