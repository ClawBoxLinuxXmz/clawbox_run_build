import { NextResponse } from "next/server";
import { getAll } from "@/lib/config-store";
import {
  cancelFeishuQrSession,
  FeishuQrSessionError,
  getFeishuQrSession,
  startFeishuQrSession,
} from "@/lib/channels/feishu-qrcode";
import { notifyQrIfChanged } from "@/lib/notify-daemon";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const OWNER_HEADER = "x-clawbox-qr-owner";
const SESSION_HEADER = "x-clawbox-qr-session";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OPAQUE_OWNER_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;

interface QrHeaders {
  owner: string;
  sessionId?: string;
}

interface QrHeaderError {
  errorCode: "qr_owner_invalid" | "qr_session_required" | "qr_session_invalid";
  error: string;
}

function noStoreJson(body: unknown, init: ResponseInit = {}): NextResponse {
  const headers = new Headers(init.headers);
  headers.set("Cache-Control", "no-store, max-age=0");
  headers.set("Pragma", "no-cache");
  return NextResponse.json(body, { ...init, headers });
}

function readQrHeaders(
  request: Request,
  requireSession: boolean,
): QrHeaders | QrHeaderError {
  const owner = request.headers.get(OWNER_HEADER)?.trim() || "";
  if (!UUID_PATTERN.test(owner) && !OPAQUE_OWNER_PATTERN.test(owner)) {
    return {
      errorCode: "qr_owner_invalid",
      error: "A valid QR owner token is required.",
    };
  }
  const sessionId = request.headers.get(SESSION_HEADER)?.trim() || undefined;
  if (requireSession && !sessionId) {
    return {
      errorCode: "qr_session_required",
      error: "The QR session ID is required.",
    };
  }
  if (sessionId && !UUID_PATTERN.test(sessionId)) {
    return {
      errorCode: "qr_session_invalid",
      error: "The QR session ID is invalid.",
    };
  }
  return { owner, sessionId };
}

function isHeaderError(value: QrHeaders | QrHeaderError): value is QrHeaderError {
  return "errorCode" in value;
}

function sessionErrorResponse(error: unknown, fallback: string): NextResponse {
  if (error instanceof FeishuQrSessionError) {
    return noStoreJson(
      {
        errorCode: error.errorCode,
        error: error.message,
        ...(error.session ? { session: error.session } : {}),
      },
      { status: error.httpStatus },
    );
  }
  return noStoreJson(
    { errorCode: "qr_start_failed", error: fallback },
    { status: 502 },
  );
}

export async function POST(request: Request) {
  const qrHeaders = readQrHeaders(request, false);
  if (isHeaderError(qrHeaders)) {
    return noStoreJson(qrHeaders, { status: 400 });
  }

  let setup: Awaited<ReturnType<typeof getAll>>;
  try {
    setup = await getAll();
  } catch {
    return noStoreJson(
      {
        errorCode: "setup_state_failed",
        error: "Failed to read Feishu setup state.",
      },
      { status: 500 },
    );
  }
  if (!setup.ai_model_configured) {
    return noStoreJson(
      {
        errorCode: "ai_model_required",
        error: "Configure your AI provider before setting up Feishu.",
      },
      { status: 409 },
    );
  }

  try {
    const session = await startFeishuQrSession(
      qrHeaders.owner,
      qrHeaders.sessionId,
    );
    // 会话已就绪的二维码立即通知墨水屏; 未就绪的由 GET 轮询点补通知
    notifyQrIfChanged("feishu", session.qrUrl);
    return noStoreJson({ success: true, ...session });
  } catch (error) {
    return sessionErrorResponse(
      error,
      "Failed to start Feishu QR registration.",
    );
  }
}

export function GET(request: Request) {
  const qrHeaders = readQrHeaders(request, false);
  if (isHeaderError(qrHeaders)) {
    return noStoreJson(qrHeaders, { status: 400 });
  }
  try {
    const session = getFeishuQrSession(qrHeaders.owner, qrHeaders.sessionId);
    // 轮询点: 二维码异步出现后由这里补通知 (变化检测避免重复写文件)
    notifyQrIfChanged("feishu", session?.qrUrl);
    return noStoreJson({
      success: true,
      session,
    });
  } catch (error) {
    return sessionErrorResponse(error, "Failed to read Feishu QR status.");
  }
}

export function DELETE(request: Request) {
  const qrHeaders = readQrHeaders(request, true);
  if (isHeaderError(qrHeaders)) {
    return noStoreJson(qrHeaders, { status: 400 });
  }
  try {
    return noStoreJson({
      success: true,
      session: cancelFeishuQrSession(
        qrHeaders.owner,
        qrHeaders.sessionId as string,
      ),
    });
  } catch (error) {
    return sessionErrorResponse(error, "Failed to cancel Feishu QR setup.");
  }
}

