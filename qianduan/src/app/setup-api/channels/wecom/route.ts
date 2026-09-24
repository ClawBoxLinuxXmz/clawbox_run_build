import { NextResponse } from "next/server";
import { getAll, setMany } from "@/lib/config-store";
import { getWeComConfig, getWeComCredentials } from "@/lib/channels/wecom";
import { setChannelConfig } from "@/lib/channels-config";

export const dynamic = "force-dynamic";

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export async function GET() {
  try {
    const [config, setup] = await Promise.all([getWeComConfig(), getAll()]);
    return NextResponse.json({
      ...config,
      lastError: typeof setup.wecom_last_error === "string" ? setup.wecom_last_error : null,
    });
  } catch (error) {
    return NextResponse.json(
      { error: errorMessage(error, "Failed to read WeCom config.") },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  const setup = await getAll();
  if (!setup.ai_model_configured) {
    return NextResponse.json(
      { error: "Configure your AI provider before setting up WeCom." },
      { status: 409 },
    );
  }

  let body: { botId?: unknown; secret?: unknown; enabled?: unknown };
  try {
    body = await request.json() as { botId?: unknown; secret?: unknown; enabled?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (body.enabled !== undefined && typeof body.enabled !== "boolean") {
    return NextResponse.json({ error: "enabled must be a boolean" }, { status: 400 });
  }
  if (body.botId !== undefined && typeof body.botId !== "string") {
    return NextResponse.json({ error: "botId must be a string" }, { status: 400 });
  }
  if (body.secret !== undefined && typeof body.secret !== "string") {
    return NextResponse.json({ error: "secret must be a string" }, { status: 400 });
  }

  const enabled = body.enabled !== false;
  const incomingBotId = typeof body.botId === "string" && body.botId.trim()
    ? body.botId.trim()
    : undefined;
  const incomingSecret = typeof body.secret === "string" && body.secret.trim()
    ? body.secret.trim()
    : undefined;
  const existing = await getWeComCredentials();

  if (enabled && !incomingBotId && !existing.botId) {
    return NextResponse.json({ error: "WeCom Bot ID is required." }, { status: 400 });
  }
  if (enabled && !incomingSecret && !existing.secret) {
    return NextResponse.json({ error: "WeCom Secret is required." }, { status: 400 });
  }

  const incoming: Record<string, unknown> = {
    enabled,
    connectionMode: "websocket",
    ...(incomingBotId ? { botId: incomingBotId } : {}),
    ...(incomingSecret ? { secret: incomingSecret } : {}),
  };

  try {
    await setChannelConfig("wecom", incoming);
    await setMany({ wecom_last_error: undefined }).catch(() => {});
    const config = await getWeComConfig();
    return NextResponse.json({
      success: true,
      saved: true,
      state: config.enabled ? "configured" : "disabled",
      connected: false,
      ...config,
    });
  } catch (error) {
    const message = errorMessage(error, "Failed to save WeCom config.");
    await setMany({ wecom_last_error: message }).catch(() => {});
    return NextResponse.json({ error: message, saved: false }, { status: 502 });
  }
}
