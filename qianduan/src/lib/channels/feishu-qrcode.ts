import { randomUUID } from "node:crypto";
import { registerApp } from "@larksuiteoapi/node-sdk";
import { setMany } from "@/lib/config-store";
import { restartGateway } from "@/lib/openclaw-config";
import {
  saveFeishuConfig,
  waitForFeishuConnected,
  type FeishuDomain,
} from "@/lib/channels/feishu";

export type FeishuQrSessionStatus =
  | "pending"
  | "saving"
  | "connected"
  | "expired"
  | "error"
  | "cancelled";

export type FeishuQrErrorCode =
  | "qr_session_conflict"
  | "qr_session_mismatch"
  | "qr_session_busy"
  | "manual_config_busy"
  | "qr_start_failed"
  | "qr_start_timeout"
  | "qr_invalid_url"
  | "qr_authorization_denied"
  | "qr_authorization_failed"
  | "qr_expired"
  | "qr_credentials_missing"
  | "qr_save_failed"
  | "gateway_restart_failed"
  | "channel_connect_failed";

export interface FeishuQrSessionView {
  sessionId: string;
  status: FeishuQrSessionStatus;
  qrUrl: string | null;
  expiresAt: number | null;
  domain: FeishuDomain | null;
  connected: boolean;
  errorCode: FeishuQrErrorCode | null;
  error: string | null;
}

interface FeishuQrSession extends FeishuQrSessionView {
  owner: string;
  controller: AbortController;
  ready: Promise<void>;
  releaseReady: () => void;
  finalizedAt: number | null;
}

const DEFAULT_QR_LIFETIME_SECONDS = 600;
const QR_START_TIMEOUT_MS = 15_000;
const TERMINAL_RETENTION_MS = 5 * 60 * 1000;
const ACTIVE_STATUSES: readonly FeishuQrSessionStatus[] = [
  "pending",
  "expired",
  "saving",
];

let currentSession: FeishuQrSession | null = null;
let manualConfigInProgress = false;

export class FeishuQrSessionError extends Error {
  constructor(
    public readonly errorCode: FeishuQrErrorCode,
    message: string,
    public readonly httpStatus: number,
    public readonly session: FeishuQrSessionView | null = null,
  ) {
    super(message);
    this.name = "FeishuQrSessionError";
  }
}

function publicView(session: FeishuQrSession): FeishuQrSessionView {
  return {
    sessionId: session.sessionId,
    status: session.status,
    qrUrl: session.qrUrl,
    expiresAt: session.expiresAt,
    domain: session.domain,
    connected: session.connected,
    errorCode: session.errorCode,
    error: session.error,
  };
}

function createSession(owner: string): FeishuQrSession {
  let releaseReady = () => {};
  const ready = new Promise<void>((resolve) => {
    releaseReady = resolve;
  });
  return {
    sessionId: randomUUID(),
    owner,
    status: "pending",
    qrUrl: null,
    expiresAt: null,
    domain: null,
    connected: false,
    errorCode: null,
    error: null,
    controller: new AbortController(),
    ready,
    releaseReady,
    finalizedAt: null,
  };
}

function isCurrent(session: FeishuQrSession): boolean {
  return currentSession === session;
}

function isActive(session: FeishuQrSession): boolean {
  return ACTIVE_STATUSES.includes(session.status);
}

function finishSession(
  session: FeishuQrSession,
  status: Exclude<FeishuQrSessionStatus, "pending" | "saving">,
  errorCode: FeishuQrErrorCode | null,
  error: string | null,
): void {
  session.status = status;
  session.qrUrl = null;
  session.expiresAt = null;
  session.connected = status === "connected";
  session.errorCode = errorCode;
  session.error = error;
  session.finalizedAt = Date.now();
  session.releaseReady();
}

function cancelSession(session: FeishuQrSession): void {
  session.controller.abort();
  if (session.status === "pending" || session.status === "expired") {
    finishSession(session, "cancelled", null, null);
  }
}

function registrationErrorCode(error: unknown): string | null {
  if (!error || typeof error !== "object" || !("code" in error)) return null;
  return typeof error.code === "string" ? error.code : null;
}

function normalizeQrUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Feishu returned an invalid QR code URL.");
  }
  if (url.protocol !== "https:") {
    throw new Error("Feishu returned an insecure QR code URL.");
  }
  return url.toString();
}

async function recordLastError(message: string | undefined): Promise<void> {
  await setMany({ feishu_last_error: message }).catch(() => {});
}

async function handleRegistrationError(
  session: FeishuQrSession,
  error: unknown,
): Promise<void> {
  if (!isCurrent(session)) return;
  const code = registrationErrorCode(error);
  if (code === "abort") {
    if (session.status === "pending") {
      finishSession(session, "cancelled", null, null);
    }
    return;
  }
  if (code === "expired_token") {
    const message = "The Feishu QR code expired. Generate a new one.";
    finishSession(session, "expired", "qr_expired", message);
    await recordLastError(message);
    return;
  }
  const denied = code === "access_denied";
  const message = denied
    ? "Feishu authorization was declined."
    : "Failed to complete Feishu QR authorization.";
  finishSession(
    session,
    "error",
    denied ? "qr_authorization_denied" : "qr_authorization_failed",
    message,
  );
  await recordLastError(message);
}

async function finishConfiguration(
  session: FeishuQrSession,
  credentials: {
    client_id: string;
    client_secret: string;
    user_info?: {
      tenant_brand?: "feishu" | "lark";
      open_id?: string;
    };
  },
): Promise<void> {
  if (!isCurrent(session) || session.controller.signal.aborted) return;
  const tenantBrand = credentials.user_info?.tenant_brand;
  const domain: FeishuDomain =
    tenantBrand === "lark"
      ? "lark"
      : tenantBrand === "feishu"
        ? "feishu"
        : session.domain === "lark"
          ? "lark"
          : "feishu";
  session.status = "saving";
  session.qrUrl = null;
  session.expiresAt = null;
  session.domain = domain;
  session.errorCode = null;
  session.error = null;

  try {
    await saveFeishuConfig({
      appId: credentials.client_id,
      appSecret: credentials.client_secret,
      domain,
      enabled: true,
      ownerOpenId: credentials.user_info?.open_id,
    });
  } catch {
    if (!isCurrent(session)) return;
    const message = "Failed to save credentials received from Feishu.";
    finishSession(session, "error", "qr_save_failed", message);
    await recordLastError(message);
    return;
  }
  if (!isCurrent(session)) return;

  try {
    await restartGateway();
  } catch {
    if (!isCurrent(session)) return;
    const message =
      "Feishu credentials were saved, but OpenClaw Gateway restart failed.";
    finishSession(session, "error", "gateway_restart_failed", message);
    await recordLastError(message);
    return;
  }
  if (!isCurrent(session)) return;

  try {
    const status = await waitForFeishuConnected();
    if (!status.connected) {
      throw new Error("Feishu did not report a connected state.");
    }
  } catch {
    if (!isCurrent(session)) return;
    const message =
      "Feishu credentials were saved, but the channel did not become online.";
    finishSession(session, "error", "channel_connect_failed", message);
    await recordLastError(message);
    return;
  }
  if (!isCurrent(session)) return;

  finishSession(session, "connected", null, null);
  await recordLastError(undefined);
}

async function runRegistration(session: FeishuQrSession): Promise<void> {
  try {
    const credentials = await registerApp({
      source: "clawbox",
      signal: session.controller.signal,
      createOnly: true,
      appPreset: {
        name: "ClawBox",
        desc: "ClawBox AI assistant",
      },
      onStatusChange(info) {
        if (!isCurrent(session) || session.status !== "pending") return;
        if (info.status === "domain_switched") session.domain = "lark";
      },
      onQRCodeReady(info) {
        if (!isCurrent(session) || session.controller.signal.aborted) return;
        let qrUrl: string;
        try {
          qrUrl = normalizeQrUrl(info.url);
        } catch {
          const message = "Feishu returned an invalid QR code URL.";
          finishSession(session, "error", "qr_invalid_url", message);
          session.controller.abort();
          void recordLastError(message);
          return;
        }
        const lifetimeSeconds =
          Number.isFinite(info.expireIn) && info.expireIn > 0
            ? info.expireIn
            : DEFAULT_QR_LIFETIME_SECONDS;
        session.qrUrl = qrUrl;
        session.expiresAt = Date.now() + lifetimeSeconds * 1000;
        session.errorCode = null;
        session.error = null;
        session.finalizedAt = null;
        session.releaseReady();
      },
    });
    if (
      typeof credentials.client_id !== "string" ||
      typeof credentials.client_secret !== "string" ||
      !credentials.client_id ||
      !credentials.client_secret
    ) {
      const message = "Feishu did not return application credentials.";
      finishSession(session, "error", "qr_credentials_missing", message);
      await recordLastError(message);
      return;
    }
    await finishConfiguration(session, credentials);
  } catch (error) {
    await handleRegistrationError(session, error);
  }
}

function expireIfNeeded(session: FeishuQrSession): void {
  if (
    session.status !== "pending" ||
    !session.expiresAt ||
    session.expiresAt > Date.now()
  ) {
    return;
  }
  const message = "The Feishu QR code expired. Generate a new one.";
  finishSession(session, "expired", "qr_expired", message);
  session.controller.abort();
  void recordLastError(message);
}

function currentSessionForAccess(): FeishuQrSession | null {
  if (!currentSession) return null;
  expireIfNeeded(currentSession);
  if (
    currentSession.finalizedAt !== null &&
    Date.now() - currentSession.finalizedAt > TERMINAL_RETENTION_MS
  ) {
    currentSession = null;
  }
  return currentSession;
}

function mismatchError(): FeishuQrSessionError {
  return new FeishuQrSessionError(
    "qr_session_mismatch",
    "The Feishu QR session does not match this request.",
    409,
  );
}

export async function startFeishuQrSession(
  owner: string,
  expectedSessionId?: string,
): Promise<FeishuQrSessionView> {
  const existing = currentSessionForAccess();
  if (
    expectedSessionId &&
    (!existing ||
      existing.owner !== owner ||
      existing.sessionId !== expectedSessionId)
  ) {
    throw mismatchError();
  }
  if (manualConfigInProgress) {
    throw new FeishuQrSessionError(
      "manual_config_busy",
      "Feishu manual configuration is in progress.",
      409,
    );
  }
  if (existing && isActive(existing)) {
    if (existing.owner !== owner) {
      throw new FeishuQrSessionError(
        "qr_session_conflict",
        "Another browser tab is configuring Feishu with a QR code.",
        409,
      );
    }
    if (existing.status === "saving") {
      throw new FeishuQrSessionError(
        "qr_session_busy",
        "Feishu credentials are being saved. Wait for setup to finish.",
        409,
        publicView(existing),
      );
    }
    cancelSession(existing);
  }

  const session = createSession(owner);
  currentSession = session;
  void runRegistration(session);
  const startTimeout = setTimeout(() => {
    if (!isCurrent(session) || session.status !== "pending" || session.qrUrl) {
      return;
    }
    const message = "Timed out while generating the Feishu QR code.";
    finishSession(session, "error", "qr_start_timeout", message);
    session.controller.abort();
    void recordLastError(message);
  }, QR_START_TIMEOUT_MS);
  try {
    await session.ready;
  } finally {
    clearTimeout(startTimeout);
  }

  const sessionView = publicView(session);
  if (sessionView.status === "pending" && sessionView.qrUrl) {
    return sessionView;
  }
  const httpStatus = sessionView.status === "expired" ? 410 : 502;
  throw new FeishuQrSessionError(
    sessionView.errorCode || "qr_start_failed",
    sessionView.error || "Feishu QR registration did not start.",
    httpStatus,
    sessionView,
  );
}

export function getFeishuQrSession(
  owner: string,
  expectedSessionId?: string,
): FeishuQrSessionView | null {
  const session = currentSessionForAccess();
  if (!session) {
    if (expectedSessionId) throw mismatchError();
    return null;
  }
  if (session.owner !== owner) {
    if (expectedSessionId) throw mismatchError();
    return null;
  }
  if (expectedSessionId && session.sessionId !== expectedSessionId) {
    throw mismatchError();
  }
  return publicView(session);
}

export function cancelFeishuQrSession(
  owner: string,
  sessionId: string,
): FeishuQrSessionView {
  const session = currentSessionForAccess();
  if (
    !session ||
    session.owner !== owner ||
    session.sessionId !== sessionId
  ) {
    throw mismatchError();
  }
  if (session.status === "saving") {
    throw new FeishuQrSessionError(
      "qr_session_busy",
      "Feishu credentials are being saved and cannot be cancelled.",
      409,
      publicView(session),
    );
  }
  if (session.status === "pending" || session.status === "expired") {
    cancelSession(session);
  }
  return publicView(session);
}

export function beginFeishuManualConfig(): () => void {
  const session = currentSessionForAccess();
  if (session && isActive(session)) {
    throw new FeishuQrSessionError(
      "qr_session_busy",
      "Finish or cancel the active Feishu QR setup before saving manually.",
      409,
    );
  }
  if (manualConfigInProgress) {
    throw new FeishuQrSessionError(
      "manual_config_busy",
      "Another Feishu manual configuration is already in progress.",
      409,
    );
  }
  manualConfigInProgress = true;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    manualConfigInProgress = false;
  };
}

