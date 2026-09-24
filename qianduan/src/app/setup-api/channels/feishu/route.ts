import { NextResponse } from "next/server";
import { getAll, setMany } from "@/lib/config-store";
import { restartGateway } from "@/lib/openclaw-config";
import { getFeishuConfig, getFeishuCredentials, saveFeishuConfig, validateFeishuCredentials, waitForFeishuConnected, type FeishuDomain } from "@/lib/channels/feishu";
import { beginFeishuManualConfig, FeishuQrSessionError } from "@/lib/channels/feishu-qrcode";

export const dynamic = "force-dynamic";

function message(error: unknown, fallback: string): string { return error instanceof Error ? error.message : fallback; }
function status(error: unknown): number { return error && typeof error === "object" && "code" in error && error.code === "invalid_credentials" ? 400 : 502; }

export async function GET() {
  try {
    const [config, setup] = await Promise.all([getFeishuConfig(), getAll()]);
    return NextResponse.json({ ...config, lastError: typeof setup.feishu_last_error === "string" ? setup.feishu_last_error : null });
  } catch (error) {
    return NextResponse.json({ error: message(error, "Failed to read Feishu config.") }, { status: 500 });
  }
}

async function saveFeishuManualRequest(request: Request) {
  const setup = await getAll();
  if (!setup.ai_model_configured) return NextResponse.json({ error: "Configure your AI provider before setting up Feishu." }, { status: 409 });
  let body: { appId?: unknown; appSecret?: unknown; domain?: unknown; enabled?: unknown };
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  if (body.enabled !== undefined && typeof body.enabled !== "boolean") return NextResponse.json({ error: "enabled must be a boolean" }, { status: 400 });
  if (body.appId !== undefined && typeof body.appId !== "string") return NextResponse.json({ error: "appId must be a string" }, { status: 400 });
  if (body.appSecret !== undefined && typeof body.appSecret !== "string") return NextResponse.json({ error: "appSecret must be a string" }, { status: 400 });
  if (body.domain !== undefined && body.domain !== "feishu" && body.domain !== "lark") return NextResponse.json({ error: "domain must be feishu or lark" }, { status: 400 });

  const enabled = body.enabled !== false;
  const domain: FeishuDomain = body.domain === "lark" ? "lark" : "feishu";
  const incomingAppId = typeof body.appId === "string" && body.appId.trim() ? body.appId.trim() : undefined;
  const incomingSecret = typeof body.appSecret === "string" && body.appSecret.trim() ? body.appSecret.trim() : undefined;
  const existing = await getFeishuCredentials();
  const appId = incomingAppId || existing?.appId;
  const appSecret = incomingSecret || existing?.appSecret;
  if (enabled && (!appId || !appSecret)) return NextResponse.json({ error: "Feishu App ID and App Secret are required." }, { status: 400 });
  if ((incomingAppId || incomingSecret || (existing && existing.domain !== domain)) && appId && appSecret) {
    try { await validateFeishuCredentials({ appId, appSecret, domain }); }
    catch (error) {
      const errorMessage = message(error, "Feishu credential validation failed.");
      await setMany({ feishu_last_error: errorMessage }).catch(() => {});
      return NextResponse.json({ error: errorMessage, saved: false }, { status: status(error) });
    }
  }

  let saved: Awaited<ReturnType<typeof saveFeishuConfig>>;
  try { saved = await saveFeishuConfig({ appId: incomingAppId, appSecret: incomingSecret, domain, enabled }); }
  catch (error) {
    const errorMessage = message(error, "Failed to save Feishu config.");
    await setMany({ feishu_last_error: errorMessage }).catch(() => {});
    return NextResponse.json({ error: errorMessage, saved: false }, { status: status(error) });
  }
  try { await restartGateway(); }
  catch (error) {
    const errorMessage = `Feishu config was saved, but OpenClaw Gateway restart failed: ${message(error, "unknown error")}`;
    await setMany({ feishu_last_error: errorMessage }).catch(() => {});
    return NextResponse.json({ error: errorMessage, saved: true, ...saved }, { status: 502 });
  }
  if (!enabled) {
    await setMany({ feishu_last_error: undefined }).catch(() => {});
    return NextResponse.json({ success: true, saved: true, state: "disabled", connected: false, ...saved });
  }
  try {
    const live = await waitForFeishuConnected();
    await setMany({ feishu_last_error: undefined }).catch(() => {});
    return NextResponse.json({ success: true, saved: true, ...live });
  } catch (error) {
    const errorMessage = message(error, "Feishu config was saved, but the channel did not become online.");
    await setMany({ feishu_last_error: errorMessage }).catch(() => {});
    return NextResponse.json({ error: errorMessage, saved: true, ...saved }, { status: 502 });
  }
}

export async function POST(request: Request) {
  let release: (() => void) | null = null;
  try {
    release = beginFeishuManualConfig();
  } catch (error) {
    if (error instanceof FeishuQrSessionError) {
      return NextResponse.json(
        { errorCode: error.errorCode, error: error.message },
        { status: error.httpStatus },
      );
    }
    return NextResponse.json(
      { error: "Unable to lock Feishu configuration." },
      { status: 500 },
    );
  }
  try {
    return await saveFeishuManualRequest(request);
  } finally {
    release();
  }
}
