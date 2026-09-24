import { NextResponse } from "next/server";
import type { WhatsAppErrorCode } from "@/lib/channels/whatsapp";

export function noStoreJson(
  body: unknown,
  init: ResponseInit = {},
): NextResponse {
  const headers = new Headers(init.headers);
  headers.set("Cache-Control", "no-store, max-age=0");
  headers.set("Pragma", "no-cache");
  return NextResponse.json(body, { ...init, headers });
}

export function whatsappErrorCode(error: unknown): WhatsAppErrorCode | null {
  if (!error || typeof error !== "object" || !("code" in error)) return null;
  return typeof error.code === "string"
    ? (error.code as WhatsAppErrorCode)
    : null;
}

export function whatsappErrorMessage(
  error: unknown,
  fallback: string,
): string {
  return error instanceof Error ? error.message : fallback;
}

export function whatsappErrorStatus(error: unknown): number {
  const code = whatsappErrorCode(error);
  if (
    code === "invalid_config" ||
    code === "invalid_owner_number" ||
    code === "invalid_pairing_code"
  ) {
    return 400;
  }
  if (code === "plugin_unavailable") return 503;
  return 502;
}

export function whatsappErrorSaved(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "saved" in error &&
      error.saved === true,
  );
}
