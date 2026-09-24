import { NextResponse } from "next/server";
import { cancelClawBotQrLogin } from "@/lib/channels/zalo-clawbot";
export const dynamic = "force-dynamic";
export async function POST(request: Request) { let body: { sessionId?: unknown; ownerToken?: unknown }; try { body = await request.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); } if (typeof body.sessionId !== "string" || typeof body.ownerToken !== "string") return NextResponse.json({ error: "sessionId and ownerToken are required" }, { status: 400 }); if (!cancelClawBotQrLogin(body.sessionId, body.ownerToken)) return NextResponse.json({ error: "QR session not found." }, { status: 404 }); return NextResponse.json({ success: true }); }
