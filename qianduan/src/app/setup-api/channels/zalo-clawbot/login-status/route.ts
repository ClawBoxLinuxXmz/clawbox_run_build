import { NextResponse } from "next/server";
import { getClawBotQrLogin } from "@/lib/channels/zalo-clawbot";
import { notifyQrIfChanged, qrTypeFor } from "@/lib/notify-daemon";
export const dynamic = "force-dynamic";
export async function POST(request: Request) { let body: { sessionId?: unknown; ownerToken?: unknown }; try { body = await request.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); } if (typeof body.sessionId !== "string" || typeof body.ownerToken !== "string") return NextResponse.json({ error: "sessionId and ownerToken are required" }, { status: 400 }); const result = getClawBotQrLogin(body.sessionId, body.ownerToken); if (!result) return NextResponse.json({ error: "QR session not found or expired." }, { status: 404 }); /* 轮询点: 二维码异步出现后通知墨水屏 */ notifyQrIfChanged("zalo-clawbot", result.qrData, qrTypeFor(result.qrData ?? "")); return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } }); }
