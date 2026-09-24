import { NextResponse } from "next/server";
import { approveFeishuPairing, getFeishuConfig, listFeishuPairingRequests } from "@/lib/channels/feishu";

export const dynamic = "force-dynamic";

async function blocked(): Promise<Response | null> {
  const config = await getFeishuConfig();
  return config.configured && config.enabled ? null : NextResponse.json({ error: "Enable and connect Feishu before approving a user." }, { status: 409 });
}

export async function GET() {
  try {
    const response = await blocked(); if (response) return response;
    return NextResponse.json({ requests: await listFeishuPairingRequests() });
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Failed to list Feishu pairing requests." }, { status: 502 }); }
}

export async function POST(request: Request) {
  try { const response = await blocked(); if (response) return response; }
  catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Failed to read Feishu config." }, { status: 500 }); }
  let body: { code?: unknown };
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  if (typeof body.code !== "string" || !body.code.trim()) return NextResponse.json({ error: "Feishu pairing code is required." }, { status: 400 });
  try { await approveFeishuPairing(body.code); return NextResponse.json({ success: true, approved: true }); }
  catch (error) {
    const invalid = error && typeof error === "object" && "code" in error && error.code === "invalid_pairing_code";
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed to approve Feishu pairing." }, { status: invalid ? 400 : 502 });
  }
}
