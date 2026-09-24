import { NextRequest, NextResponse } from "next/server";

const DEFAULT_GATEWAY_URL = "http://127.0.0.1:18789";
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "content-length",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function getGatewayBaseUrl(): string {
  return process.env.GATEWAY_URL || DEFAULT_GATEWAY_URL;
}

function buildGatewayUrl(request: NextRequest, pathname: string): URL {
  const target = new URL(pathname, getGatewayBaseUrl());
  target.search = request.nextUrl.search;
  return target;
}

function copyRequestHeaders(request: NextRequest): Headers {
  const headers = new Headers();
  request.headers.forEach((value, key) => {
    if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase())) {
      headers.set(key, value);
    }
  });
  headers.set("x-forwarded-host", request.headers.get("host") || request.nextUrl.host);
  headers.set("x-forwarded-proto", request.nextUrl.protocol.replace(":", ""));
  headers.set("x-forwarded-for", request.headers.get("x-forwarded-for") || "127.0.0.1");

  const token = process.env.GATEWAY_TOKEN;
  if (token && !headers.has("authorization")) {
    headers.set("authorization", `Bearer ${token}`);
  }

  return headers;
}

function copyResponseHeaders(source: Headers): Headers {
  const headers = new Headers();
  source.forEach((value, key) => {
    if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase())) {
      headers.append(key, value);
    }
  });
  return headers;
}

export async function proxyToGateway(
  request: NextRequest,
  pathname: string,
): Promise<NextResponse> {
  const method = request.method.toUpperCase();
  const body: BodyInit | undefined =
    method === "GET" || method === "HEAD" ? undefined : await request.arrayBuffer();

  let upstream: Response;
  try {
    upstream = await fetch(buildGatewayUrl(request, pathname), {
      method,
      headers: copyRequestHeaders(request),
      body,
      redirect: "manual",
      cache: "no-store",
    });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? `Gateway unavailable: ${error.message}`
            : "Gateway unavailable",
      },
      { status: 502 },
    );
  }

  const responseHeaders = copyResponseHeaders(upstream.headers);
  const responseBody =
    method === "HEAD" ? null : new Uint8Array(await upstream.arrayBuffer());

  return new NextResponse(responseBody, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}
