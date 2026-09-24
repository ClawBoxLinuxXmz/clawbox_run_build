import { NextRequest, NextResponse } from "next/server";

function getRequestOrigin(request: NextRequest): string {
  const forwardedProto = request.headers.get("x-forwarded-proto");
  const forwardedHost = request.headers.get("x-forwarded-host");
  const host = forwardedHost || request.headers.get("host");
  const proto = forwardedProto || request.nextUrl.protocol.replace(":", "") || "http";

  if (host) {
    return `${proto}://${host}`;
  }

  return request.url;
}

export function redirectToSetup(request: NextRequest): NextResponse {
  return NextResponse.redirect(new URL("/setup", getRequestOrigin(request)), 302);
}
