import { NextResponse } from "next/server";
import { getAll, setMany } from "@/lib/config-store";
import { setWechatConfig, getWechatConfig } from "@/lib/openclaw-config";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const config = await getAll();
  if (!config.ai_model_configured) {
    return NextResponse.json(
      { error: "Configure your AI provider before setting up WeChat." },
      { status: 409 },
    );
  }

  let body: { botToken?: unknown; enabled?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { botToken, enabled } = body;
  
  try {
    await setWechatConfig(
      typeof botToken === "string" ? botToken : undefined,
      typeof enabled === "boolean" ? enabled : undefined
    );

    await setMany({
      wechat_last_error: undefined,
    }).catch(() => {});

    const latest = await getWechatConfig();
    return NextResponse.json({ success: true, message: "WeChat config updated", ...latest });
  } catch (err) {
    const message =
      err instanceof Error
        ? err.message
        : "Failed to save or restart gateway after WeChat update";
    await setMany({
      wechat_last_error: message,
    }).catch(() => {});
    return NextResponse.json(
      { error: message },
      { status: 502 }
    );
  }
}

export async function GET() {
  try {
    const config = await getWechatConfig();
    return NextResponse.json(config);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to get config" },
      { status: 500 }
    );
  }
}
