import { NextRequest, NextResponse } from "next/server";
import { proxyToGateway } from "@/lib/gateway-proxy";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function proxyLineWebhook(request: NextRequest): Promise<NextResponse> {
  const response = await proxyToGateway(request, "/line/webhook");
  response.headers.set("Cache-Control", "no-store");
  return response;
}

export const GET = proxyLineWebhook;
export const POST = proxyLineWebhook;
