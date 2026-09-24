import { NextResponse } from "next/server";
import { getAll, setMany } from "@/lib/config-store";
import { restartGateway } from "@/lib/openclaw-config";
import {
  getQQBotConfig,
  getQQBotCredentials,
  saveQQBotConfig,
  validateQQBotCredentials,
  waitForQQBotConnected,
} from "@/lib/channels/qqbot";
import { beginQQBotManualConfig, QQBotQrSetupError } from "@/lib/channels/qqbot-qr";

export const dynamic = "force-dynamic";

function message(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function status(error: unknown): number {
  return error &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "invalid_credentials"
    ? 400
    : 502;
}

export async function GET() {
  try {
    const [config, setup] = await Promise.all([getQQBotConfig(), getAll()]);
    return NextResponse.json({
      ...config,
      lastError:
        typeof setup.qqbot_last_error === "string"
          ? setup.qqbot_last_error
          : null,
    });
  } catch (error) {
    return NextResponse.json(
      { error: message(error, "Failed to read QQ Bot config.") },
      { status: 500 },
    );
  }
}

async function saveQQBotManualRequest(request: Request) {
  const setup = await getAll();
  if (!setup.ai_model_configured) {
    return NextResponse.json(
      { error: "Configure your AI provider before setting up QQ Bot." },
      { status: 409 },
    );
  }

  let body: {
    appId?: unknown;
    clientSecret?: unknown;
    enabled?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (body.enabled !== undefined && typeof body.enabled !== "boolean") {
    return NextResponse.json(
      { error: "enabled must be a boolean" },
      { status: 400 },
    );
  }
  if (body.appId !== undefined && typeof body.appId !== "string") {
    return NextResponse.json(
      { error: "appId must be a string" },
      { status: 400 },
    );
  }
  if (
    body.clientSecret !== undefined &&
    typeof body.clientSecret !== "string"
  ) {
    return NextResponse.json(
      { error: "clientSecret must be a string" },
      { status: 400 },
    );
  }

  const enabled = body.enabled !== false;
  const incomingAppId =
    typeof body.appId === "string" && body.appId.trim()
      ? body.appId.trim()
      : undefined;
  const incomingClientSecret =
    typeof body.clientSecret === "string" && body.clientSecret.trim()
      ? body.clientSecret.trim()
      : undefined;
  const existing = await getQQBotCredentials();
  const appId = incomingAppId || existing?.appId;
  const clientSecret = incomingClientSecret || existing?.clientSecret;

  if (enabled && (!appId || !clientSecret)) {
    return NextResponse.json(
      { error: "QQ Bot AppID and AppSecret are required." },
      { status: 400 },
    );
  }

  if ((incomingAppId || incomingClientSecret) && appId && clientSecret) {
    try {
      await validateQQBotCredentials({ appId, clientSecret });
    } catch (error) {
      const errorMessage = message(
        error,
        "QQ Bot credential validation failed.",
      );
      await setMany({ qqbot_last_error: errorMessage }).catch(() => {});
      return NextResponse.json(
        { error: errorMessage, saved: false },
        { status: status(error) },
      );
    }
  }

  let saved: Awaited<ReturnType<typeof saveQQBotConfig>>;
  try {
    saved = await saveQQBotConfig({
      appId: incomingAppId,
      clientSecret: incomingClientSecret,
      enabled,
    });
  } catch (error) {
    const errorMessage = message(error, "Failed to save QQ Bot config.");
    await setMany({ qqbot_last_error: errorMessage }).catch(() => {});
    return NextResponse.json(
      { error: errorMessage, saved: false },
      { status: status(error) },
    );
  }

  try {
    await restartGateway();
  } catch (error) {
    const errorMessage = `QQ Bot config was saved, but OpenClaw Gateway restart failed: ${message(error, "unknown error")}`;
    await setMany({ qqbot_last_error: errorMessage }).catch(() => {});
    return NextResponse.json(
      { error: errorMessage, saved: true, ...saved },
      { status: 502 },
    );
  }

  if (!enabled) {
    await setMany({ qqbot_last_error: undefined }).catch(() => {});
    return NextResponse.json({
      success: true,
      saved: true,
      state: "disabled",
      connected: false,
      ...saved,
    });
  }

  try {
    const live = await waitForQQBotConnected();
    await setMany({ qqbot_last_error: undefined }).catch(() => {});
    return NextResponse.json({ success: true, saved: true, ...live });
  } catch (error) {
    const errorMessage = message(
      error,
      "QQ Bot config was saved, but the channel did not become online.",
    );
    await setMany({ qqbot_last_error: errorMessage }).catch(() => {});
    return NextResponse.json(
      { error: errorMessage, saved: true, ...saved },
      { status: 502 },
    );
  }
}

export async function POST(request: Request) {
  let release: (() => void) | null = null;
  try {
    release = beginQQBotManualConfig();
  } catch (error) {
    if (error instanceof QQBotQrSetupError) {
      return NextResponse.json(
        { errorCode: error.errorCode, error: error.message },
        { status: error.httpStatus },
      );
    }
    return NextResponse.json(
      { error: "Unable to lock QQ Bot configuration." },
      { status: 500 },
    );
  }
  try {
    return await saveQQBotManualRequest(request);
  } finally {
    release();
  }
}
