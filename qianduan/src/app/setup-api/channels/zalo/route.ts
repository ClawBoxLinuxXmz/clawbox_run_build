import { NextResponse } from "next/server";
import { getAll, setMany } from "@/lib/config-store";
import { getZaloBotToken, getZaloConfig, normalizeZaloProxy, prepareZaloPlugin, restartZaloGateway, saveZaloConfig, validateZaloBotToken } from "@/lib/channels/zalo";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const msg = (e: unknown, f: string) => e instanceof Error ? e.message : f;
const codeStatus = (e: unknown) => e && typeof e === "object" && "code" in e && (e.code === "invalid_token" || e.code === "invalid_proxy") ? 400 : 502;
export async function GET() { try { return NextResponse.json({ ...(await getZaloConfig()), lastError: null }); } catch (e) { return NextResponse.json({ error: msg(e, "Failed to read Zalo config.") }, { status: 500 }); } }
export async function POST(request: Request) {
  const setup = await getAll(); if (!setup.ai_model_configured) return NextResponse.json({ error: "Configure your AI provider before setting up Zalo Bot." }, { status: 409 });
  let body: { botToken?: unknown; enabled?: unknown; proxy?: unknown }; try { body = await request.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  if (body.enabled !== undefined && typeof body.enabled !== "boolean") return NextResponse.json({ error: "enabled must be a boolean" }, { status: 400 });
  if (body.botToken !== undefined && typeof body.botToken !== "string") return NextResponse.json({ error: "botToken must be a string" }, { status: 400 });
  if (body.proxy !== undefined && body.proxy !== null && typeof body.proxy !== "string") return NextResponse.json({ error: "proxy must be a string or null" }, { status: 400 });
  const incoming = typeof body.botToken === "string" && body.botToken.trim() ? body.botToken.trim() : undefined;
  let incomingProxy: string | null | undefined;
  try {
    incomingProxy = typeof body.proxy === "string" ? normalizeZaloProxy(body.proxy) : body.proxy === null ? null : undefined;
  } catch (error) {
    return NextResponse.json({ error: msg(error, "Enter a valid HTTP or HTTPS proxy URL.") }, { status: codeStatus(error) });
  }
  const existing = await getZaloBotToken();
  const enabled = body.enabled !== false;
  if (!enabled) {
    try {
      const config = await saveZaloConfig({ botToken: incoming, enabled: false, proxy: incomingProxy });
      await restartZaloGateway();
      await setMany({ zalo_last_error: undefined }).catch(() => {});
      return NextResponse.json({ success: true, saved: true, bot: null, ...config, connected: false, state: "disabled" });
    } catch (e) {
      const text = msg(e, "Failed to disable Zalo Bot.");
      await setMany({ zalo_last_error: text }).catch(() => {});
      return NextResponse.json({ error: text, saved: false }, { status: codeStatus(e) });
    }
  }
  if (enabled && !incoming && !existing) return NextResponse.json({ error: "Zalo Bot Token is required." }, { status: 400 });
  let bot: Awaited<ReturnType<typeof validateZaloBotToken>> | null = null;
  if (incoming) {
    try { bot = await validateZaloBotToken(incoming, fetch, incomingProxy || undefined); } catch (e) { const text = msg(e, "Zalo Bot Token validation failed."); await setMany({ zalo_last_error: text }).catch(() => {}); return NextResponse.json({ error: text, saved: false }, { status: codeStatus(e) }); }
  }
  try { await prepareZaloPlugin(); }
  catch (e) { const text = msg(e, "Failed to enable the Zalo plugin."); await setMany({ zalo_last_error: text }).catch(() => {}); return NextResponse.json({ error: text, saved: false }, { status: 502 }); }
  try { const config = await saveZaloConfig({ botToken: incoming, enabled, proxy: incomingProxy }); await restartZaloGateway(); await setMany({ zalo_last_error: undefined }).catch(() => {}); return NextResponse.json({ success: true, saved: true, bot, ...config, connected: false, state: enabled ? "configured" : "disabled" }); }
  catch (e) { const text = msg(e, "Failed to save Zalo config."); await setMany({ zalo_last_error: text }).catch(() => {}); return NextResponse.json({ error: text, saved: false }, { status: codeStatus(e) }); }
}
