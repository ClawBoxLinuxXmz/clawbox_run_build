import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const DASHBOARD_TARGET = "http://127.0.0.1:18789";

async function proxyRequest(request: NextRequest): Promise<NextResponse> {
  const url = new URL(request.url);
  const targetPath = url.pathname.replace(/^\/dashboard/, "") + url.search;
  const targetUrl = new URL(targetPath || "/", DASHBOARD_TARGET);
  const body = ["GET", "HEAD"].includes(request.method)
    ? undefined
    : await request.clone().arrayBuffer();

  const headers = new Headers(request.headers);
  headers.delete("host");
  headers.delete("origin");
  headers.delete("referer");

  try {
    const response = await fetch(targetUrl.toString(), {
      method: request.method,
      headers,
      body,
      redirect: "manual",
      // Next.js accepts duplex for streamed request bodies in the Node runtime.
      duplex: "half",
    } as RequestInit);
    const responseHeaders = new Headers(response.headers);
    responseHeaders.delete("transfer-encoding");
    responseHeaders.delete("content-encoding");
    return new NextResponse(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    });
  } catch (error) {
    console.error("[dashboard proxy] Error:", error);
    return new NextResponse("Dashboard proxy error", { status: 502 });
  }
}

export async function GET(request: NextRequest) { return proxyRequest(request); }
export async function POST(request: NextRequest) { return proxyRequest(request); }
export async function PUT(request: NextRequest) { return proxyRequest(request); }
export async function DELETE(request: NextRequest) { return proxyRequest(request); }
export async function PATCH(request: NextRequest) { return proxyRequest(request); }
export async function OPTIONS(request: NextRequest) { return proxyRequest(request); }
export async function HEAD(request: NextRequest) { return proxyRequest(request); }
