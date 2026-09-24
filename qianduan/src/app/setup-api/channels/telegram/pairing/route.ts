import { NextResponse } from "next/server";
import {
  approveTelegramPairing,
  getTelegramConfig,
  listTelegramPairingRequests,
  type TelegramErrorCode,
} from "@/lib/channels/telegram";

export const dynamic = "force-dynamic";

function errorCode(error: unknown): TelegramErrorCode | null {
  if (!error || typeof error !== "object" || !("code" in error)) return null;
  return typeof error.code === "string"
    ? (error.code as TelegramErrorCode)
    : null;
}

async function requireTelegramConfigured(): Promise<Response | null> {
  const config = await getTelegramConfig();
  if (config.configured && config.enabled) return null;
  return NextResponse.json(
    { error: "Enable and connect Telegram before approving a user." },
    { status: 409 },
  );
}

export async function GET() {
  try {
    const blocked = await requireTelegramConfigured();
    if (blocked) return blocked;
    const requests = await listTelegramPairingRequests();
    return NextResponse.json({ requests });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to list Telegram pairing requests.",
      },
      { status: 502 },
    );
  }
}

export async function POST(request: Request) {
  try {
    const blocked = await requireTelegramConfigured();
    if (blocked) return blocked;
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to read Telegram config." },
      { status: 500 },
    );
  }

  let body: { code?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (typeof body.code !== "string" || !body.code.trim()) {
    return NextResponse.json(
      { error: "Telegram pairing code is required." },
      { status: 400 },
    );
  }

  try {
    await approveTelegramPairing(body.code);
    return NextResponse.json({ success: true, approved: true });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to approve Telegram pairing.",
      },
      { status: errorCode(error) === "invalid_pairing_code" ? 400 : 502 },
    );
  }
}
