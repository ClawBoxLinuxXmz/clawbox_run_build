import { NextResponse } from "next/server";
import { getAll, setMany } from "@/lib/config-store";
import {
  MANAGED_CHANNELS,
  getChannelsConfig,
  setChannelConfig,
  type ManagedChannel,
} from "@/lib/channels-config";

export const dynamic = "force-dynamic";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function GET() {
  try {
    return NextResponse.json({ channels: await getChannelsConfig() });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to get channel config" },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  let setup: Awaited<ReturnType<typeof getAll>>;
  try {
    setup = await getAll();
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to read setup state" },
      { status: 500 },
    );
  }
  if (!setup.ai_model_configured) {
    return NextResponse.json(
      { error: "Configure your AI provider before setting up chat channels." },
      { status: 409 },
    );
  }

  let body: { channel?: unknown; config?: unknown };
  try {
    body = await request.json() as { channel?: unknown; config?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (
    typeof body.channel !== "string" ||
    !(MANAGED_CHANNELS as readonly string[]).includes(body.channel)
  ) {
    return NextResponse.json(
      { error: `Unknown channel. Allowed: ${MANAGED_CHANNELS.join(", ")}` },
      { status: 400 },
    );
  }
  if (!isRecord(body.config)) {
    return NextResponse.json({ error: "Missing config object" }, { status: 400 });
  }

  const channel = body.channel as ManagedChannel;
  const incoming = body.config;
  if (
    channel === "feishu" &&
    incoming.enabled !== false &&
    incoming.connectionMode !== "qr"
  ) {
    const existingChannels = await getChannelsConfig().catch(
      () => ({}) as Record<string, Record<string, unknown>>,
    );
    const existing = existingChannels.feishu ?? {};
    const hasAppId =
      (typeof incoming.appId === "string" && incoming.appId.trim().length > 0) ||
      typeof existing.appId === "string";
    const hasAppSecret =
      (typeof incoming.appSecret === "string" && incoming.appSecret.trim().length > 0) ||
      existing.has_appSecret === true;
    if (!hasAppId) {
      return NextResponse.json({ error: "Feishu App ID is required" }, { status: 400 });
    }
    if (!hasAppSecret) {
      return NextResponse.json({ error: "Feishu App Secret is required" }, { status: 400 });
    }
  }

  try {
    await setChannelConfig(channel, incoming);
    await setMany({ channels_last_error: undefined }).catch(() => {});
    const safeChannels = await getChannelsConfig();
    return NextResponse.json({
      success: true,
      message: `${channel} config updated, gateway restarted`,
      channel,
      config: safeChannels[channel] ?? {},
    });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Failed to save or restart gateway after channel update";
    await setMany({ channels_last_error: message }).catch(() => {});
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
