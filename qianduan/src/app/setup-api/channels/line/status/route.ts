import { NextResponse } from "next/server";
import { getAll, setMany } from "@/lib/config-store";
import {
  buildLinePublicWebhookUrl,
  getLineConfig,
  normalizeLinePublicBaseUrl,
  probeLineChannel,
} from "@/lib/channels/line";

export const dynamic = "force-dynamic";

function publicWebhookView(setup: Record<string, unknown>) {
  const stored = setup.line_public_base_url;
  let publicBaseUrl: string | null = null;
  if (typeof stored === "string") {
    try {
      publicBaseUrl = normalizeLinePublicBaseUrl(stored) || null;
    } catch {
      publicBaseUrl = null;
    }
  }
  return {
    publicBaseUrl,
    publicWebhookUrl: buildLinePublicWebhookUrl(publicBaseUrl),
  };
}

export async function GET(request?: Request) {
  try {
    const force = request?.url ? new URL(request.url).searchParams.get("force") === "1" : false;
    const [status, setup] = await Promise.all([probeLineChannel(force ? { force: true } : undefined), getAll()]);
    if (
      status.state === "disabled" ||
      status.state === "not_configured" ||
      (status.running && status.probe?.ok === true)
    ) {
      await setMany({ line_last_error: undefined }).catch(() => {});
    }
    return NextResponse.json({ ...status, ...publicWebhookView(setup) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to check LINE status.";
    await setMany({ line_last_error: message }).catch(() => {});
    const config = await getLineConfig().catch(() => ({
      configured: true,
      enabled: true,
      hasChannelAccessToken: true,
      hasChannelSecret: true,
      dmPolicy: "pairing" as const,
      groupPolicy: "disabled" as const,
      webhookPath: "/line/webhook" as const,
    }));
    return NextResponse.json(
      {
        ...config,
        state: "error",
        running: false,
        probe: null,
        lastInboundAt: null,
        lastError: message,
      },
      { status: 502, headers: { "Cache-Control": "no-store" } },
    );
  }
}
