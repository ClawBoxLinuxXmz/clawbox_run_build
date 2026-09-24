import { NextResponse } from "next/server";
import { getAll, setMany } from "@/lib/config-store";
import { getDiscordConfig, getDiscordTokenFromConfig, restartDiscordGateway, saveDiscordConfig, validateDiscordBotToken } from "@/lib/channels/discord";
import { readConfig } from "@/lib/openclaw-config";

export const dynamic = "force-dynamic";
const message = (error: unknown, fallback: string) => error instanceof Error ? error.message : fallback;
const status = (error: unknown) => error && typeof error === "object" && "code" in error && (error.code === "invalid_token" || error.code === "invalid_id") ? 400 : 502;

export async function GET() {
  try { return NextResponse.json({ ...(await getDiscordConfig()), lastError: null }); }
  catch (error) { return NextResponse.json({ error: message(error, "Failed to read Discord config.") }, { status: 500 }); }
}

export async function POST(request: Request) {
  const setup = await getAll();
  if (!setup.ai_model_configured) return NextResponse.json({ error: "Configure your AI provider before setting up Discord." }, { status: 409 });
  let body: { token?: unknown; serverId?: unknown; userId?: unknown; enabled?: unknown };
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  if (body.enabled !== undefined && typeof body.enabled !== "boolean") return NextResponse.json({ error: "enabled must be a boolean" }, { status: 400 });
  for (const [key, value] of [["token", body.token], ["serverId", body.serverId], ["userId", body.userId]] as const) if (value !== undefined && typeof value !== "string") return NextResponse.json({ error: `${key} must be a string` }, { status: 400 });
  const incomingToken = typeof body.token === "string" && body.token.trim() ? body.token.trim() : undefined;
  const existingToken = getDiscordTokenFromConfig(await readConfig());
  const enabled = body.enabled !== false;
  if (!enabled) {
    try {
      const config = await saveDiscordConfig({ token: incomingToken, serverId: typeof body.serverId === "string" && body.serverId.trim() ? body.serverId : undefined, userId: typeof body.userId === "string" && body.userId.trim() ? body.userId : undefined, enabled: false });
      await restartDiscordGateway();
      await setMany({ discord_last_error: undefined }).catch(() => {});
      return NextResponse.json({ success: true, saved: true, bot: null, ...config, connected: false, state: "disabled" });
    } catch (error) {
      const errorText = message(error, "Failed to disable Discord.");
      await setMany({ discord_last_error: errorText }).catch(() => {});
      return NextResponse.json({ error: errorText, saved: false }, { status: status(error) });
    }
  }
  if (enabled && !incomingToken && !existingToken) return NextResponse.json({ error: "Discord Bot Token is required." }, { status: 400 });
  let bot = null;
  try { bot = await validateDiscordBotToken(incomingToken || existingToken || ""); }
  catch (error) { const errorText = message(error, "Discord Bot Token validation failed."); await setMany({ discord_last_error: errorText }).catch(() => {}); return NextResponse.json({ error: errorText, saved: false }, { status: status(error) }); }
  try {
    const config = await saveDiscordConfig({ token: incomingToken, serverId: typeof body.serverId === "string" && body.serverId.trim() ? body.serverId : undefined, userId: typeof body.userId === "string" && body.userId.trim() ? body.userId : undefined, enabled });
    await restartDiscordGateway();
    await setMany({ discord_last_error: undefined }).catch(() => {});
    return NextResponse.json({ success: true, saved: true, bot, ...config, connected: false, state: enabled ? "configured" : "disabled" });
  } catch (error) { const errorText = message(error, "Failed to save Discord config."); await setMany({ discord_last_error: errorText }).catch(() => {}); return NextResponse.json({ error: errorText, saved: false }, { status: status(error) }); }
}
