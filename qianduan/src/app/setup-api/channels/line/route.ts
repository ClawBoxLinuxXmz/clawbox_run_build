import { NextResponse } from "next/server";
import { getAll, setMany } from "@/lib/config-store";
import { restartGateway } from "@/lib/openclaw-config";
import {
  getLineConfig,
  getLineCredentials,
  buildLinePublicWebhookUrl,
  normalizeLinePublicBaseUrl,
  parseLineStatusPayload,
  saveLineConfig,
  validateLineChannelAccessToken,
  waitForLineReady,
  type LineErrorCode,
} from "@/lib/channels/line";

export const dynamic = "force-dynamic";
const LINE_PUBLIC_BASE_URL_KEY = "line_public_base_url";

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function errorCode(error: unknown): LineErrorCode | null {
  if (!error || typeof error !== "object" || !("code" in error)) return null;
  return typeof error.code === "string"
    ? (error.code as LineErrorCode)
    : null;
}

function statusForLineError(error: unknown): number {
  return errorCode(error) === "invalid_credentials" ? 400 : 502;
}

function storedPublicBaseUrl(setup: Record<string, unknown>): string | null {
  const value = setup[LINE_PUBLIC_BASE_URL_KEY];
  if (typeof value !== "string") return null;
  try {
    return normalizeLinePublicBaseUrl(value) || null;
  } catch {
    return null;
  }
}

function publicWebhookView(publicBaseUrl: string | null) {
  return {
    publicBaseUrl,
    publicWebhookUrl: buildLinePublicWebhookUrl(publicBaseUrl),
  };
}

export async function GET() {
  try {
    const [config, setup] = await Promise.all([getLineConfig(), getAll()]);
    return NextResponse.json({
      ...config,
      ...publicWebhookView(storedPublicBaseUrl(setup)),
      lastError:
        typeof setup.line_last_error === "string"
          ? setup.line_last_error
          : null,
    });
  } catch (error) {
    return NextResponse.json(
      { error: errorMessage(error, "Failed to read LINE config.") },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  const setup = await getAll();
  if (!setup.ai_model_configured) {
    return NextResponse.json(
      { error: "Configure your AI provider before setting up LINE." },
      { status: 409 },
    );
  }

  let body: {
    channelAccessToken?: unknown;
    channelSecret?: unknown;
    publicBaseUrl?: unknown;
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
  if (
    body.channelAccessToken !== undefined &&
    typeof body.channelAccessToken !== "string"
  ) {
    return NextResponse.json(
      { error: "channelAccessToken must be a string" },
      { status: 400 },
    );
  }
  if (
    body.channelSecret !== undefined &&
    typeof body.channelSecret !== "string"
  ) {
    return NextResponse.json(
      { error: "channelSecret must be a string" },
      { status: 400 },
    );
  }
  if (
    body.publicBaseUrl !== undefined &&
    typeof body.publicBaseUrl !== "string"
  ) {
    return NextResponse.json(
      { error: "publicBaseUrl must be a string" },
      { status: 400 },
    );
  }

  let publicBaseUrl = storedPublicBaseUrl(setup);
  if (typeof body.publicBaseUrl === "string") {
    try {
      publicBaseUrl = normalizeLinePublicBaseUrl(body.publicBaseUrl) || null;
    } catch (error) {
      return NextResponse.json(
        { error: errorMessage(error, "Invalid LINE public webhook URL.") },
        { status: 400 },
      );
    }
  }

  const enabled = body.enabled !== false;
  const incomingToken =
    typeof body.channelAccessToken === "string" &&
    body.channelAccessToken.trim()
      ? body.channelAccessToken.trim()
      : undefined;
  const incomingSecret =
    typeof body.channelSecret === "string" && body.channelSecret.trim()
      ? body.channelSecret.trim()
      : undefined;
  const existing = await getLineCredentials();
  const effectiveToken = incomingToken || existing.channelAccessToken;
  const effectiveSecret = incomingSecret || existing.channelSecret;

  if (enabled && (!effectiveToken || !effectiveSecret)) {
    return NextResponse.json(
      {
        error:
          "LINE Channel access token and Channel secret are required.",
      },
      { status: 400 },
    );
  }

  if (effectiveToken && (incomingToken || enabled)) {
    try {
      await validateLineChannelAccessToken(effectiveToken);
    } catch (error) {
      const message = errorMessage(
        error,
        "LINE Channel access token validation failed.",
      );
      await setMany({ line_last_error: message }).catch(() => {});
      return NextResponse.json(
        { error: message, saved: false },
        { status: statusForLineError(error) },
      );
    }
  }

  let saved: Awaited<ReturnType<typeof saveLineConfig>>;
  try {
    saved = await saveLineConfig({
      channelAccessToken: incomingToken,
      channelSecret: incomingSecret,
      enabled,
    });
  } catch (error) {
    const message = errorMessage(error, "Failed to save LINE config.");
    await setMany({ line_last_error: message }).catch(() => {});
    return NextResponse.json(
      { error: message, saved: false },
      { status: statusForLineError(error) },
    );
  }

  if (body.publicBaseUrl !== undefined) {
    try {
      await setMany({
        [LINE_PUBLIC_BASE_URL_KEY]: publicBaseUrl || undefined,
      });
    } catch (error) {
      return NextResponse.json(
        {
          error: errorMessage(
            error,
            "LINE credentials were saved, but the public webhook URL could not be saved.",
          ),
          saved: true,
          ...saved,
          ...publicWebhookView(publicBaseUrl),
        },
        { status: 500 },
      );
    }
  }

  try {
    await restartGateway();
  } catch (error) {
    const message = `LINE config was saved, but OpenClaw Gateway restart failed: ${errorMessage(error, "unknown error")}`;
    await setMany({ line_last_error: message }).catch(() => {});
    return NextResponse.json(
      {
        error: message,
        saved: true,
        ...saved,
        ...publicWebhookView(publicBaseUrl),
      },
      { status: 502 },
    );
  }

  if (!enabled) {
    await setMany({ line_last_error: undefined }).catch(() => {});
    return NextResponse.json({
      success: true,
      saved: true,
      ...parseLineStatusPayload(null, saved),
      ...publicWebhookView(publicBaseUrl),
    });
  }

  try {
    const status = await waitForLineReady();
    await setMany({ line_last_error: undefined }).catch(() => {});
    return NextResponse.json({
      success: true,
      saved: true,
      ...status,
      ...publicWebhookView(publicBaseUrl),
    });
  } catch (error) {
    const message = errorMessage(
      error,
      "LINE config was saved, but the local webhook listener did not become ready.",
    );
    await setMany({ line_last_error: message }).catch(() => {});
    return NextResponse.json(
      {
        error: message,
        saved: true,
        ...saved,
        ...publicWebhookView(publicBaseUrl),
      },
      { status: 502 },
    );
  }
}
