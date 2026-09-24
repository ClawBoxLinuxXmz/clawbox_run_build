import { NextResponse } from "next/server";
import { restartGateway } from "@/lib/openclaw-config";
import {
  getProxyChannelView,
  getProxyConfig,
  PROXY_CHANNEL_IDS,
  saveProxySettings,
  type ProxyChannelId,
} from "@/lib/channels/proxy";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const isChannelId = (value: string): value is ProxyChannelId =>
  (PROXY_CHANNEL_IDS as readonly string[]).includes(value);

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Failed to save proxy settings.";
}

export async function GET(request: Request) {
  const requestedChannel = new URL(request.url).searchParams.get("channel");
  if (requestedChannel && !isChannelId(requestedChannel)) {
    return NextResponse.json({ error: "Unsupported proxy channel." }, { status: 400 });
  }
  const channelId = requestedChannel && isChannelId(requestedChannel) ? requestedChannel : null;
  try {
    const config = await getProxyConfig();
    const channel = channelId ? await getProxyChannelView(channelId) : null;
    return NextResponse.json({ config, channel }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: errorMessage(error) }, { status: 500 });
  }
}

export async function POST(request: Request) {
  let body: {
    channelId?: unknown;
    mode?: unknown;
    channelUrl?: unknown;
    globalEnabled?: unknown;
    globalUrl?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (body.channelId !== undefined && (typeof body.channelId !== "string" || !isChannelId(body.channelId))) {
    return NextResponse.json({ error: "Unsupported proxy channel." }, { status: 400 });
  }
  if (body.mode !== undefined && !["direct", "channel", "global"].includes(String(body.mode))) {
    return NextResponse.json({ error: "mode must be direct, channel, or global" }, { status: 400 });
  }
  for (const [key, value] of [["channelUrl", body.channelUrl], ["globalUrl", body.globalUrl]] as const) {
    if (value !== undefined && typeof value !== "string") {
      return NextResponse.json({ error: `${key} must be a string` }, { status: 400 });
    }
  }
  if (body.globalEnabled !== undefined && typeof body.globalEnabled !== "boolean") {
    return NextResponse.json({ error: "globalEnabled must be a boolean" }, { status: 400 });
  }

  try {
    const saved = await saveProxySettings({
      channelId: typeof body.channelId === "string" ? body.channelId : undefined,
      mode: body.mode,
      channelUrl: body.channelUrl,
      globalEnabled: body.globalEnabled,
      globalUrl: body.globalUrl,
    });
    await restartGateway();
    return NextResponse.json({ success: true, ...saved }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: errorMessage(error), saved: false }, { status: 400 });
  }
}
