import { NextRequest, NextResponse } from "next/server";
import { getAll } from "@/lib/config-store";
import { proxyToGateway } from "@/lib/gateway-proxy";
import { redirectToSetup } from "@/lib/redirect";

export const dynamic = "force-dynamic";
const ENABLE_GATEWAY_WEB_DEBUG = process.env.ENABLE_GATEWAY_WEB_DEBUG === "1";

async function handleGatewayRequest(
  request: NextRequest,
  context: { params: Promise<{ gateway?: string[] }> },
) {
  const config = await getAll().catch(() => ({}));
  if (!(config as any).setup_complete) {
    return redirectToSetup(request);
  }

  if (!ENABLE_GATEWAY_WEB_DEBUG) {
    return redirectToSetup(request);
  }

  const params = await context.params;
  const pathname = `/${(params.gateway || []).join("/")}`;
  return proxyToGateway(request, pathname);
}

export const GET = handleGatewayRequest;
export const POST = handleGatewayRequest;
export const PUT = handleGatewayRequest;
export const PATCH = handleGatewayRequest;
export const DELETE = handleGatewayRequest;
export const OPTIONS = handleGatewayRequest;
export const HEAD = handleGatewayRequest;
