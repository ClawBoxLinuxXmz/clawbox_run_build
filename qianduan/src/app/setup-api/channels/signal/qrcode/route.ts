import { NextResponse } from "next/server";
import { getAll } from "@/lib/config-store";
import { getSignalConfig, startSignalQrLogin } from "@/lib/channels/signal";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  const setup = await getAll();
  if (!setup.ai_model_configured) {
    return NextResponse.json(
      { error: "Configure your AI provider before setting up Signal." },
      { status: 409 },
    );
  }
  let body: { cliPath?: unknown; timeoutMs?: unknown } = {};
  try {
    const text = await request.text();
    if (text.trim()) body = JSON.parse(text) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (body.cliPath !== undefined && typeof body.cliPath !== "string") return NextResponse.json({ error: "cliPath must be a string" }, { status: 400 });
  if (body.timeoutMs !== undefined && (typeof body.timeoutMs !== "number" || !Number.isFinite(body.timeoutMs) || body.timeoutMs < 3_000 || body.timeoutMs > 300_000)) return NextResponse.json({ error: "timeoutMs must be between 3000 and 300000" }, { status: 400 });
  try {
    const config = await getSignalConfig();
    return NextResponse.json(
      {
        success: true,
        ...(await startSignalQrLogin({
          cliPath: typeof body.cliPath === "string" && body.cliPath.trim() ? body.cliPath : config.cliPath,
          timeoutMs: typeof body.timeoutMs === "number" ? body.timeoutMs : undefined,
        })),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to start Signal QR login. Check that signal-cli is installed." },
      { status: 502 },
    );
  }
}
