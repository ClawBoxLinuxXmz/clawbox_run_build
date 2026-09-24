import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  OPENCLAW_BIN,
  getOpenClawEnvironment,
  sanitizeChannelOutput,
} from "./openclaw-runtime";

export type QrSessionKind = "zalo-clawbot" | "zalouser" | "signal";
export type QrSessionState =
  | "starting"
  | "waiting"
  | "connected"
  | "expired"
  | "error"
  | "cancelled";

export interface QrSessionView {
  sessionId: string;
  ownerToken: string;
  kind: QrSessionKind;
  state: QrSessionState;
  qrData: string | null;
  message: string;
  expiresAt: number;
}

interface QrSession extends QrSessionView {
  process: ChildProcessWithoutNullStreams | null;
  abortController: AbortController;
  output: string;
  timer: ReturnType<typeof setTimeout> | null;
  finalizing: boolean;
  cleanupStarted: boolean;
  terminalCleanupTimer: ReturnType<typeof setTimeout> | null;
  cleanupOutput?: (output: string) => Promise<void>;
}

const sessions = new Map<string, QrSession>();
const SESSION_TTL_MS = 5 * 60_000;
const MIN_SESSION_TTL_MS = 3_000;
const MAX_OUTPUT = 256 * 1024;
const MAX_QR_DATA_LENGTH = 256 * 1024;
const MAX_QR_IMAGE_BYTES = 1024 * 1024;
const TERMINAL_RETENTION_MS = 60_000;
const TERMINAL_STATES = new Set<QrSessionState>([
  "connected",
  "expired",
  "error",
  "cancelled",
]);

function isTerminal(state: QrSessionState): boolean {
  return TERMINAL_STATES.has(state);
}

function view(session: QrSession): QrSessionView {
  return {
    sessionId: session.sessionId,
    ownerToken: session.ownerToken,
    kind: session.kind,
    state: session.state,
    qrData: session.qrData,
    message: session.message,
    expiresAt: session.expiresAt,
  };
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-?]*[ -\/]*[@-~]/g, "");
}

function dataUrlFromBuffer(buffer: Buffer, filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  const mime = extension === ".jpg" || extension === ".jpeg" ? "image/jpeg" : "image/png";
  return `data:${mime};base64,${buffer.toString("base64")}`;
}

function looksLikeImageDataUrl(value: string): boolean {
  return /^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/=_-]{32,}$/i.test(value);
}

function looksLikeSignalLink(value: string): boolean {
  return /^sgnl:\/\/linkdevice\?[^\s]+$/i.test(value);
}

function scheduleOutputCleanup(session: QrSession): void {
  if (session.cleanupStarted || !session.cleanupOutput) return;
  session.cleanupStarted = true;
  void session.cleanupOutput(session.output).catch(() => {});
}

function stopSessionResources(session: QrSession): void {
  if (session.timer) clearTimeout(session.timer);
  session.timer = null;

  const child = session.process;
  session.process = null;
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }, 2_000).unref();
  }
  session.abortController.abort();
  scheduleOutputCleanup(session);
}

function scheduleTerminalCleanup(session: QrSession): void {
  if (session.terminalCleanupTimer) return;
  session.terminalCleanupTimer = setTimeout(() => {
    if (sessions.get(session.sessionId) === session) sessions.delete(session.sessionId);
  }, TERMINAL_RETENTION_MS);
  session.terminalCleanupTimer.unref();
}

function setSessionError(session: QrSession, message: string): void {
  if (isTerminal(session.state)) return;
  session.state = "error";
  session.qrData = null;
  session.message = sanitizeChannelOutput(message) || "QR login failed.";
  stopSessionResources(session);
  scheduleTerminalCleanup(session);
}

function expire(sessionId: string): void {
  const session = sessions.get(sessionId);
  if (!session || isTerminal(session.state)) return;
  session.state = "expired";
  session.qrData = null;
  session.message = "QR session expired. Generate a new QR code and scan it promptly.";
  stopSessionResources(session);
  scheduleTerminalCleanup(session);
}

export function getQrSession(sessionId: string, ownerToken: string): QrSessionView | null {
  const session = sessions.get(sessionId);
  if (!session || session.ownerToken !== ownerToken) return null;
  if (Date.now() > session.expiresAt && !isTerminal(session.state)) expire(sessionId);
  const current = sessions.get(sessionId);
  return current ? view(current) : null;
}

export function cancelQrSession(sessionId: string, ownerToken: string): boolean {
  const session = sessions.get(sessionId);
  if (!session || session.ownerToken !== ownerToken) return false;
  if (isTerminal(session.state)) return session.state === "cancelled";
  session.state = "cancelled";
  session.qrData = null;
  session.message = "QR login cancelled.";
  stopSessionResources(session);
  scheduleTerminalCleanup(session);
  return true;
}

interface QrSessionRuntime {
  signal: AbortSignal;
  setWaiting: (message?: string) => void;
  setQrData: (qrData: string, message?: string) => void;
  setError: (message: string) => void;
  finishConnected: () => Promise<void>;
}

function createQrSession(input: {
  kind: QrSessionKind;
  timeoutMs?: number;
  onConnected?: (output: string) => Promise<void>;
  cleanupOutput?: (output: string) => Promise<void>;
  attach: (runtime: QrSessionRuntime, session: QrSession) => void;
}): QrSessionView {
  for (const existing of sessions.values()) {
    if (existing.kind === input.kind && !isTerminal(existing.state)) {
      existing.state = "cancelled";
      existing.qrData = null;
      existing.message = "Replaced by a newer QR login session.";
      stopSessionResources(existing);
      scheduleTerminalCleanup(existing);
    }
  }

  const sessionId = randomUUID();
  const ownerToken = randomUUID();
  const requestedTtl = Number.isFinite(input.timeoutMs) ? input.timeoutMs! : SESSION_TTL_MS;
  const ttl = Math.max(MIN_SESSION_TTL_MS, Math.min(requestedTtl, SESSION_TTL_MS));
  const expiresAt = Date.now() + ttl;
  const session: QrSession = {
    sessionId,
    ownerToken,
    kind: input.kind,
    state: "starting",
    qrData: null,
    message: "Starting QR login...",
    expiresAt,
    process: null,
    abortController: new AbortController(),
    output: "",
    timer: null,
    finalizing: false,
    cleanupStarted: false,
    terminalCleanupTimer: null,
    cleanupOutput: input.cleanupOutput,
  };
  sessions.set(sessionId, session);
  session.timer = setTimeout(() => expire(sessionId), ttl);
  session.timer.unref();

  const finishConnected = async (): Promise<void> => {
    if (isTerminal(session.state) || session.finalizing) return;
    session.finalizing = true;
    try {
      await input.onConnected?.(session.output);
      if (isTerminal(session.state)) return;
      session.state = "connected";
      session.qrData = null;
      session.message = "Login confirmed.";
      stopSessionResources(session);
      scheduleTerminalCleanup(session);
    } catch (error) {
      setSessionError(
        session,
        error instanceof Error ? error.message : "Login succeeded, but channel setup failed.",
      );
    } finally {
      session.finalizing = false;
    }
  };

  const runtime: QrSessionRuntime = {
    signal: session.abortController.signal,
    setWaiting: (message = "Waiting for QR login...") => {
      if (isTerminal(session.state)) return;
      session.state = "waiting";
      session.message = message;
    },
    setQrData: (qrData, message = "Scan the QR code with the mobile app, then keep this page open.") => {
      if (isTerminal(session.state)) return;
      if (qrData.length > MAX_QR_DATA_LENGTH) {
        setSessionError(session, "The generated QR code is unexpectedly large.");
        return;
      }
      session.state = "waiting";
      session.qrData = qrData;
      session.message = message;
    },
    setError: (message) => setSessionError(session, message),
    finishConnected,
  };

  try {
    input.attach(runtime, session);
  } catch (error) {
    setSessionError(session, error instanceof Error ? error.message : "Unable to start QR login process.");
  }

  return view(session);
}

export function createCliQrSession(input: {
  kind: QrSessionKind;
  executable?: string;
  args: readonly string[];
  timeoutMs?: number;
  parseOutput: (output: string) => Promise<string | null>;
  isConnected: (output: string) => boolean;
  onConnected?: (output: string) => Promise<void>;
  cleanupOutput?: (output: string) => Promise<void>;
}): QrSessionView {
  return createQrSession({
    kind: input.kind,
    timeoutMs: input.timeoutMs,
    onConnected: input.onConnected,
    cleanupOutput: input.cleanupOutput,
    attach: (runtime, session) => {
      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawn(input.executable || OPENCLAW_BIN, [...input.args], {
          env: getOpenClawEnvironment(),
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        });
      } catch (error) {
        runtime.setError(error instanceof Error ? error.message : "Unable to start QR login process.");
        return;
      }

      session.process = child;
      const onChunk = (chunk: Buffer): void => {
        if (isTerminal(session.state)) return;
        session.output = (session.output + chunk.toString("utf8")).slice(-MAX_OUTPUT);
        if (session.state === "starting") runtime.setWaiting();

        void input
          .parseOutput(session.output)
          .then((qrData) => {
            if (qrData && !isTerminal(session.state)) runtime.setQrData(qrData);
          })
          .catch(() => {});

        if (input.isConnected(session.output)) void runtime.finishConnected();
      };

      child.stdout.on("data", onChunk);
      child.stderr.on("data", onChunk);
      child.on("error", (error) => {
        if (!isTerminal(session.state)) runtime.setError(error.message);
      });
      child.on("exit", (code) => {
        if (isTerminal(session.state) || session.finalizing) return;
        if (code === 0 && input.isConnected(session.output)) {
          void runtime.finishConnected();
          return;
        }
        const detail = sanitizeChannelOutput(session.output).split(/\r?\n/).filter(Boolean).at(-1);
        runtime.setError(
          detail ||
            (code === 0
              ? "QR login ended before confirmation."
              : `QR login process exited with code ${String(code)}.`),
        );
      });
    },
  });
}

export function createAsyncQrSession(input: {
  kind: QrSessionKind;
  timeoutMs?: number;
  start: (runtime: QrSessionRuntime) => Promise<void>;
  onConnected?: () => Promise<void>;
}): QrSessionView {
  return createQrSession({
    kind: input.kind,
    timeoutMs: input.timeoutMs,
    onConnected: input.onConnected ? async () => input.onConnected?.() : undefined,
    attach: (runtime) => {
      void input.start(runtime).catch((error: unknown) => {
        if (!runtime.signal.aborted) {
          runtime.setError(error instanceof Error ? error.message : "QR login failed.");
        }
      });
    },
  });
}

export function extractPngPathOutput(output: string): string | null {
  const lines = stripAnsi(output).split(/\r?\n/).reverse();
  for (const line of lines) {
    const marker = line.match(/(?:Scan QR image|QR image saved to|QR image)\s*:\s*(.+)$/i);
    if (!marker?.[1]) continue;
    const raw = marker[1].trim();
    const quoted = raw.match(/^(?:"(.+?\.(?:png|jpe?g))"|'(.+?\.(?:png|jpe?g))')\s*$/i);
    if (quoted) return quoted[1] || quoted[2] || null;
    const plain = raw.match(/^(.+?\.(?:png|jpe?g))\s*$/i);
    if (plain?.[1]) return plain[1].trim();
  }
  return null;
}

export async function parsePngPathOutput(output: string): Promise<string | null> {
  const direct = stripAnsi(output).match(/data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/=_-]+/i)?.[0];
  if (direct && looksLikeImageDataUrl(direct)) return direct;

  const candidate = extractPngPathOutput(output);
  if (!candidate) return null;
  if (!isAllowedTempQrPath(candidate)) return null;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      const stat = await fs.stat(candidate);
      if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_QR_IMAGE_BYTES) return null;
      return dataUrlFromBuffer(await fs.readFile(candidate), candidate);
    } catch {
      if (attempt === 7) return null;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  return null;
}

function isAllowedTempQrPath(candidate: string): boolean {
  const absolute = path.resolve(candidate);
  const relative = path.relative(path.resolve(os.tmpdir()), absolute);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return false;
  return /^openclaw-zalouser-qr-[A-Za-z0-9_-]+\.png$/i.test(path.basename(absolute));
}

export async function cleanupPngPathOutput(output: string): Promise<void> {
  const candidate = extractPngPathOutput(output);
  if (!candidate) return;
  const absolute = path.resolve(candidate);
  if (!isAllowedTempQrPath(absolute)) return;
  await fs.unlink(absolute).catch((error: unknown) => {
    if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw error;
  });
}

export function parseSignalLinkOutput(output: string): string | null {
  const candidate = stripAnsi(output).match(/sgnl:\/\/linkdevice\?[^\s]+/i)?.[0];
  if (!candidate) return null;
  const normalized = candidate.replace(/[\]})>,"']+$/, "");
  return looksLikeSignalLink(normalized) ? normalized : null;
}

export function parseSignalLinkedAccount(output: string): string | null {
  return stripAnsi(output).match(/^Associated with:\s*(\+[1-9]\d{7,14})\s*$/im)?.[1] || null;
}

export function parseClawBotLoginUrl(output: string): string | null {
  const lines = stripAnsi(output).split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    const marker = /(?:open this URL(?: in Zalo)?|QR didn't render[^:]*):/i;
    if (!marker.test(line)) continue;

    const candidate = [line, lines[index + 1] || ""]
      .join(" ")
      .match(/https?:\/\/\S+/i)?.[0];
    if (!candidate) continue;
    try {
      const parsed = new URL(candidate.replace(/[\]})>,"']+$/, ""));
      if (parsed.protocol === "https:" || parsed.protocol === "http:") return parsed.toString();
    } catch {
      // Keep scanning older output in case a log line contained a malformed URL.
    }
  }
  return null;
}
