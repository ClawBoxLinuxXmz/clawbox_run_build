import { NextResponse } from "next/server";
import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import { randomUUID } from "crypto";
import { getAll, setMany } from "@/lib/config-store";
import { notifyDaemonChatQr } from "@/lib/notify-daemon";

export const dynamic = "force-dynamic";

const OPENCLAW_BIN = "/home/clawbox/.npm-global/bin/openclaw";
const OPENCLAW_HOME = "/home/clawbox";
const QR_URL_RE = /https:\/\/liteapp\.weixin\.qq\.com\/\S+/g;
const QR_REUSE_TTL_MS = 120_000;
const PROCESS_MAX_LIFETIME_MS = 240_000;

function stripAnsi(input: string): string {
  return input.replace(/\u001B\[[0-9;]*[A-Za-z]/g, "");
}

function extractQrUrl(text: string): string | null {
  const clean = stripAnsi(text);
  const all = clean.match(QR_URL_RE);
  if (!all || all.length === 0) return null;
  return all[all.length - 1] ?? null;
}

type LoginProcState = {
  child: ChildProcessWithoutNullStreams;
  sessionId: string;
  startedAt: number;
  output: string;
  qrUrl?: string;
  qrExpiresAt?: number;
  done: boolean;
  connected: boolean;
  accountId?: string;
  message?: string;
};

let loginProc: LoginProcState | null = null;

type LoginRequest = {
  sessionId?: string;
  refresh?: boolean;
};

function parseConnected(state: LoginProcState) {
  const clean = stripAnsi(state.output);
  if (/已将此\s*OpenClaw\s*连接到微信/.test(clean) || /Login confirmed!/i.test(clean)) {
    state.connected = true;
    state.done = true;
  }
  const m = clean.match(/ilink_bot_id=([A-Za-z0-9_-]+)/);
  if (m?.[1]) state.accountId = m[1];
}

function stopLoginProcess(state: LoginProcState, message?: string): void {
  if (!state.done && !state.child.killed) state.child.kill("SIGTERM");
  state.done = true;
  if (message && !state.message) state.message = message;
}

function startLoginProcess(): LoginProcState {
  const child = spawn(
    OPENCLAW_BIN,
    ["channels", "login", "--channel", "openclaw-weixin", "--verbose"],
    {
      cwd: OPENCLAW_HOME,
      env: {
        ...process.env,
        HOME: OPENCLAW_HOME,
        PATH: `/home/clawbox/.npm-global/bin:${process.env.PATH ?? ""}`,
      },
    },
  );

  const state: LoginProcState = {
    child,
    sessionId: randomUUID(),
    startedAt: Date.now(),
    output: "",
    done: false,
    connected: false,
  };

  const onChunk = (buf: Buffer) => {
    const text = buf.toString("utf8");
    state.output += text;
    if (!state.qrUrl) {
      const qr = extractQrUrl(state.output);
      if (qr) {
        state.qrUrl = qr;
        state.qrExpiresAt = Date.now() + QR_REUSE_TTL_MS;
        // 二维码一出现就通知墨水屏刷新 (守护进程检测 chat-qr.json mtime)
        void notifyDaemonChatQr("wechat", qr);
      }
    }
    parseConnected(state);
  };

  child.stdout.on("data", onChunk);
  child.stderr.on("data", onChunk);
  child.on("error", (err) => {
    state.done = true;
    state.message = err.message;
  });
  child.on("close", () => {
    state.done = true;
    parseConnected(state);
  });

  // hard-stop stale process
  setTimeout(() => {
    if (!state.done && !child.killed) {
      child.kill("SIGTERM");
    }
  }, PROCESS_MAX_LIFETIME_MS).unref();

  return state;
}

function hasReusableQr(state: LoginProcState): boolean {
  return Boolean(
    !state.done &&
      state.qrUrl &&
      state.qrExpiresAt &&
      state.qrExpiresAt > Date.now(),
  );
}

function getOrStartLoginProcess(forceRefresh: boolean): LoginProcState {
  if (forceRefresh && loginProc && !loginProc.done) {
    stopLoginProcess(loginProc, "Replaced by a newer WeChat QR login session.");
  }

  if (!loginProc || loginProc.done || (!hasReusableQr(loginProc) && loginProc.qrUrl)) {
    if (loginProc && !loginProc.done) {
      stopLoginProcess(loginProc, "WeChat QR login session expired.");
    }
    loginProc = startLoginProcess();
  }

  return loginProc;
}

async function parseRequestBody(request: Request): Promise<LoginRequest> {
  const text = await request.text();
  if (!text.trim()) return {};

  const value: unknown = JSON.parse(text);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Request body must be an object.");
  }

  const body = value as Record<string, unknown>;
  if (body.sessionId !== undefined && typeof body.sessionId !== "string") {
    throw new Error("sessionId must be a string.");
  }
  if (body.refresh !== undefined && typeof body.refresh !== "boolean") {
    throw new Error("refresh must be a boolean.");
  }

  return {
    sessionId: typeof body.sessionId === "string" ? body.sessionId : undefined,
    refresh: body.refresh === true,
  };
}

function getLoginStatus(sessionId: string):
  | { status: 200; body: Record<string, unknown> }
  | { status: 404 | 410 | 502; body: Record<string, unknown> } {
  if (!loginProc || loginProc.sessionId !== sessionId) {
    return { status: 404, body: { error: "WeChat QR login session not found." } };
  }

  const state = loginProc;
  if (state.qrUrl && state.qrExpiresAt && state.qrExpiresAt <= Date.now()) {
    stopLoginProcess(state, "WeChat QR login session expired.");
    return {
      status: 410,
      body: {
        state: "expired",
        sessionId: state.sessionId,
        error: state.message,
      },
    };
  }

  if (state.qrUrl && !state.done) {
    return {
      status: 200,
      body: {
        success: true,
        state: "ready",
        sessionId: state.sessionId,
        qrUrl: state.qrUrl,
        expiresAt: state.qrExpiresAt,
        connected: state.connected,
        accountId: state.accountId,
        message: "QR code generated. Scan in WeChat and keep this page open until status turns connected.",
      },
    };
  }

  if (state.connected && state.qrUrl) {
    return {
      status: 200,
      body: {
        success: true,
        state: "connected",
        sessionId: state.sessionId,
        qrUrl: state.qrUrl,
        expiresAt: state.qrExpiresAt,
        connected: true,
        accountId: state.accountId,
      },
    };
  }

  if (state.done) {
    const tail = stripAnsi(state.output).slice(-1200);
    return {
      status: 502,
      body: {
        state: "failed",
        sessionId: state.sessionId,
        error: state.message || `Failed to generate WeChat QR code. output_tail=${tail}`,
      },
    };
  }

  return {
    status: 200,
    body: {
      pending: true,
      state: "starting",
      sessionId: state.sessionId,
      message: "Login is still starting. The page will check again shortly.",
    },
  };
}

export async function POST(request: Request) {
  let body: LoginRequest;
  try {
    body = await parseRequestBody(request);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Invalid JSON" },
      { status: 400 },
    );
  }

  if (body.sessionId) {
    const result = getLoginStatus(body.sessionId);
    return NextResponse.json(result.body, {
      status: result.status,
      headers: { "Cache-Control": "no-store" },
    });
  }

  const config = await getAll();
  if (!config.ai_model_configured) {
    return NextResponse.json(
      { error: "Configure your AI provider before setting up WeChat." },
      { status: 409 },
    );
  }

  try {
    const forceRefresh =
      body.refresh === true || new URL(request.url).searchParams.get("refresh") === "1";
    const state = getOrStartLoginProcess(forceRefresh);

    if (state.qrUrl && hasReusableQr(state)) {
      await setMany({ wechat_last_error: undefined }).catch(() => {});
      return NextResponse.json(
        {
          success: true,
          state: "ready",
          sessionId: state.sessionId,
          qrUrl: state.qrUrl,
          expiresAt: state.qrExpiresAt,
          connected: state.connected,
          accountId: state.accountId,
          message: "QR code generated. Scan in WeChat and keep this page open until status turns connected.",
        },
        { headers: { "Cache-Control": "no-store" } },
      );
    }

    return NextResponse.json({
      pending: true,
      state: "starting",
      sessionId: state.sessionId,
      message: "Login is starting. The page will check again shortly.",
    }, { status: 202, headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to generate QR code";
    await setMany({ wechat_last_error: message }).catch(() => {});
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
