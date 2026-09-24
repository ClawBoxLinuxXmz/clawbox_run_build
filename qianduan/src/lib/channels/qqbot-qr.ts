import { randomUUID } from "node:crypto";
import {
  startQrConnect,
  type QrConnectCredentials,
} from "@tencent-connect/qqbot-connector";
import { setMany } from "@/lib/config-store";
import { restartGateway } from "@/lib/openclaw-config";
import { saveQQBotConfig, waitForQQBotConnected } from "./qqbot";

const QR_START_TIMEOUT_MS = 20_000;
const QR_SESSION_LIFETIME_MS = 10 * 60 * 1000;
const TERMINAL_RETENTION_MS = 5 * 60 * 1000;

export type QQBotQrStatus =
  | "pending"
  | "saving"
  | "connected"
  | "expired"
  | "error"
  | "cancelled";

export type QQBotQrErrorCode =
  | "qr_session_conflict"
  | "qr_session_mismatch"
  | "qr_session_busy"
  | "manual_config_busy"
  | "qr_start_failed"
  | "qr_start_timeout"
  | "qr_invalid_url"
  | "qr_authorization_failed"
  | "qr_expired"
  | "qr_credentials_missing"
  | "qr_save_failed"
  | "gateway_restart_failed"
  | "channel_connect_failed";

export interface QQBotQrSessionView {
  sessionId: string;
  status: QQBotQrStatus;
  qrUrl: string | null;
  expiresAt: number | null;
  errorCode: QQBotQrErrorCode | null;
  error: string | null;
}

export class QQBotQrSetupError extends Error {
  constructor(
    public readonly errorCode: QQBotQrErrorCode,
    message: string,
    public readonly httpStatus: number,
    public readonly session: QQBotQrSessionView | null = null,
  ) {
    super(message);
    this.name = "QQBotQrSetupError";
  }
}

interface QQBotQrSession extends QQBotQrSessionView {
  owner: string;
  stop: (() => void) | null;
  startTimer: ReturnType<typeof setTimeout> | null;
  lifetimeTimer: ReturnType<typeof setTimeout> | null;
  settleStart: (() => void) | null;
  finalizedAt: number | null;
}

const ACTIVE_STATUSES: readonly QQBotQrStatus[] = [
  "pending",
  "expired",
  "saving",
];

let activeSession: QQBotQrSession | null = null;
let manualConfigInProgress = false;

function view(session: QQBotQrSession): QQBotQrSessionView {
  return {
    sessionId: session.sessionId,
    status: session.status,
    qrUrl: session.qrUrl,
    expiresAt: session.expiresAt,
    errorCode: session.errorCode,
    error: session.error,
  };
}

function isActive(session: QQBotQrSession): boolean {
  return ACTIVE_STATUSES.includes(session.status);
}

function canAcceptSdkCallback(
  session: QQBotQrSession,
  allowNaturalExpiry: boolean,
): boolean {
  if (activeSession !== session || session.expiresAt === null) return false;
  if (Date.now() >= session.expiresAt) return false;
  return (
    session.status === "pending" ||
    (allowNaturalExpiry && session.status === "expired")
  );
}

function clearStartTimer(session: QQBotQrSession): void {
  if (session.startTimer) clearTimeout(session.startTimer);
  session.startTimer = null;
}

function settleStart(session: QQBotQrSession): void {
  clearStartTimer(session);
  session.settleStart?.();
  session.settleStart = null;
}

function clearLifetimeTimer(session: QQBotQrSession): void {
  if (session.lifetimeTimer) clearTimeout(session.lifetimeTimer);
  session.lifetimeTimer = null;
}

function normalizeQrUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("QQ returned an invalid QR code URL.");
  }
  if (url.protocol !== "https:") {
    throw new Error("QQ returned an insecure QR code URL.");
  }
  return url.toString();
}

function finishSession(
  session: QQBotQrSession,
  status: Exclude<QQBotQrStatus, "pending" | "saving">,
  errorCode: QQBotQrErrorCode | null,
  error: string | null,
): void {
  session.status = status;
  session.qrUrl = null;
  session.expiresAt = null;
  session.errorCode = errorCode;
  session.error = error;
  session.finalizedAt = Date.now();
  clearLifetimeTimer(session);
  settleStart(session);
}

function failSession(
  session: QQBotQrSession,
  errorCode: QQBotQrErrorCode,
  message: string,
): void {
  if (activeSession !== session || session.status === "cancelled") return;
  finishSession(session, "error", errorCode, message);
  session.stop = null;
  void setMany({ qqbot_last_error: message }).catch(() => {});
}

function cancelSession(session: QQBotQrSession): void {
  const stop = session.stop;
  finishSession(session, "cancelled", null, null);
  session.stop = null;
  stop?.();
}

async function finishSetup(
  session: QQBotQrSession,
  credentials: QrConnectCredentials[],
): Promise<void> {
  if (!canAcceptSdkCallback(session, true)) return;
  const credential = credentials[0];
  if (!credential?.appId || !credential.appSecret) {
    failSession(
      session,
      "qr_credentials_missing",
      "QQ did not return bot credentials.",
    );
    return;
  }

  session.status = "saving";
  session.qrUrl = null;
  session.expiresAt = null;
  session.errorCode = null;
  session.error = null;
  session.stop = null;
  session.finalizedAt = null;
  clearLifetimeTimer(session);
  settleStart(session);

  try {
    await saveQQBotConfig({
      appId: credential.appId,
      clientSecret: credential.appSecret,
      enabled: true,
    });
  } catch {
    failSession(
      session,
      "qr_save_failed",
      "Failed to save credentials received from QQ.",
    );
    return;
  }
  if (activeSession !== session) return;

  try {
    await restartGateway();
  } catch {
    failSession(
      session,
      "gateway_restart_failed",
      "QQ credentials were saved, but OpenClaw Gateway restart failed.",
    );
    return;
  }
  if (activeSession !== session) return;

  try {
    const status = await waitForQQBotConnected();
    if (!status.connected) {
      throw new Error("QQ Bot did not report a connected state.");
    }
  } catch {
    failSession(
      session,
      "channel_connect_failed",
      "QQ credentials were saved, but the channel did not become online.",
    );
    return;
  }
  if (activeSession !== session) return;

  finishSession(session, "connected", null, null);
  await setMany({ qqbot_last_error: undefined }).catch(() => {});
}

function currentSessionForAccess(): QQBotQrSession | null {
  if (
    activeSession?.finalizedAt !== null &&
    activeSession?.finalizedAt !== undefined &&
    Date.now() - activeSession.finalizedAt > TERMINAL_RETENTION_MS
  ) {
    const stop = activeSession.stop;
    clearStartTimer(activeSession);
    clearLifetimeTimer(activeSession);
    activeSession = null;
    stop?.();
  }
  return activeSession;
}

function mismatchError(): QQBotQrSetupError {
  return new QQBotQrSetupError(
    "qr_session_mismatch",
    "The QQ Bot QR session does not match this request.",
    409,
  );
}

export function getQQBotQrSession(
  owner: string,
  expectedSessionId?: string,
): QQBotQrSessionView | null {
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
  return view(session);
}

export async function startQQBotQrSetup(
  owner: string,
  expectedSessionId?: string,
): Promise<QQBotQrSessionView> {
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
    throw new QQBotQrSetupError(
      "manual_config_busy",
      "QQ Bot manual configuration is in progress.",
      409,
    );
  }
  if (existing && isActive(existing)) {
    if (existing.owner !== owner) {
      throw new QQBotQrSetupError(
        "qr_session_conflict",
        "Another browser tab is configuring QQ Bot with a QR code.",
        409,
      );
    }
    if (existing.status === "saving") {
      throw new QQBotQrSetupError(
        "qr_session_busy",
        "QQ Bot credentials are being saved. Wait for setup to finish.",
        409,
        view(existing),
      );
    }
    cancelSession(existing);
  }

  let resolveStart: (() => void) | null = null;
  const startReady = new Promise<void>((resolve) => {
    resolveStart = resolve;
  });
  const session: QQBotQrSession = {
    sessionId: randomUUID(),
    owner,
    status: "pending",
    qrUrl: null,
    expiresAt: null,
    errorCode: null,
    error: null,
    stop: null,
    startTimer: null,
    lifetimeTimer: null,
    settleStart: resolveStart,
    finalizedAt: null,
  };
  activeSession = session;

  session.expiresAt = Date.now() + QR_SESSION_LIFETIME_MS;
  session.lifetimeTimer = setTimeout(() => {
    if (activeSession !== session || session.status === "saving") return;
    const message = "The QQ QR setup session expired. Generate a new one.";
    const stop = session.stop;
    finishSession(session, "expired", "qr_expired", message);
    session.stop = null;
    stop?.();
    void setMany({ qqbot_last_error: message }).catch(() => {});
  }, QR_SESSION_LIFETIME_MS);
  session.lifetimeTimer.unref?.();

  session.startTimer = setTimeout(() => {
    const stop = session.stop;
    failSession(
      session,
      "qr_start_timeout",
      "Timed out while requesting a QQ QR code.",
    );
    stop?.();
  }, QR_START_TIMEOUT_MS);
  session.startTimer.unref?.();

  try {
    const stop = startQrConnect(
      {
        onQrDisplayed(url) {
          if (!canAcceptSdkCallback(session, true)) return;
          try {
            session.qrUrl = normalizeQrUrl(url);
            session.status = "pending";
            session.errorCode = null;
            session.error = null;
            session.finalizedAt = null;
            settleStart(session);
          } catch {
            const currentStop = session.stop;
            failSession(
              session,
              "qr_invalid_url",
              "QQ returned an invalid QR code URL.",
            );
            currentStop?.();
          }
        },
        onQrExpired() {
          if (!canAcceptSdkCallback(session, false)) return;
          session.status = "expired";
          session.qrUrl = null;
          session.errorCode = "qr_expired";
          session.error = "The QQ QR code expired. Generate a new one.";
          session.finalizedAt = Date.now();
          settleStart(session);
        },
        onSuccess(credentials) {
          if (!canAcceptSdkCallback(session, true)) return;
          void finishSetup(session, credentials);
        },
        onFailure() {
          if (!canAcceptSdkCallback(session, false)) return;
          failSession(
            session,
            "qr_authorization_failed",
            "Unable to complete QQ Bot QR authorization.",
          );
        },
      },
      {
        displayQrCodeToConsole: false,
        source: "clawbox",
      },
    );
    if (
      activeSession === session &&
      (session.status === "pending" || session.status === "expired")
    ) {
      session.stop = stop;
    } else if (session.status === "error" || session.status === "cancelled") {
      stop();
    }
  } catch {
    failSession(
      session,
      "qr_start_failed",
      "Unable to start QQ Bot QR setup.",
    );
  }

  await startReady;
  const sessionView = view(session);
  if (sessionView.status === "error") {
    throw new QQBotQrSetupError(
      sessionView.errorCode || "qr_start_failed",
      sessionView.error || "Unable to start QQ Bot QR setup.",
      502,
      sessionView,
    );
  }
  return sessionView;
}

export function cancelQQBotQrSetup(
  owner: string,
  sessionId: string,
): QQBotQrSessionView {
  const session = currentSessionForAccess();
  if (
    !session ||
    session.owner !== owner ||
    session.sessionId !== sessionId
  ) {
    throw mismatchError();
  }
  if (session.status === "saving") {
    throw new QQBotQrSetupError(
      "qr_session_busy",
      "QQ Bot credentials are being saved and cannot be cancelled.",
      409,
      view(session),
    );
  }
  if (session.status === "pending" || session.status === "expired") {
    cancelSession(session);
  }
  return view(session);
}

export function beginQQBotManualConfig(): () => void {
  const session = currentSessionForAccess();
  if (session && isActive(session)) {
    throw new QQBotQrSetupError(
      "qr_session_busy",
      "Finish or cancel the active QQ Bot QR setup before saving manually.",
      409,
    );
  }
  if (manualConfigInProgress) {
    throw new QQBotQrSetupError(
      "manual_config_busy",
      "Another QQ Bot manual configuration is already in progress.",
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

