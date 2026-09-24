import { NextResponse } from "next/server";
import {
  approveLinePairing,
  getLineConfig,
  listLinePairingRequests,
  type LineErrorCode,
} from "@/lib/channels/line";

export const dynamic = "force-dynamic";

function errorCode(error: unknown): LineErrorCode | null {
  if (!error || typeof error !== "object" || !("code" in error)) return null;
  return typeof error.code === "string"
    ? (error.code as LineErrorCode)
    : null;
}

async function requireLineConfigured(): Promise<Response | null> {
  const config = await getLineConfig();
  if (config.configured && config.enabled) return null;
  return NextResponse.json(
    { error: "Enable LINE before approving a user." },
    { status: 409 },
  );
}

export async function GET() {
  try {
    const blocked = await requireLineConfigured();
    if (blocked) return blocked;
    return NextResponse.json({ requests: await listLinePairingRequests() });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to list LINE pairing requests.",
      },
      { status: 502 },
    );
  }
}

export async function POST(request: Request) {
  try {
    const blocked = await requireLineConfigured();
    if (blocked) return blocked;
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to read LINE config.",
      },
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
      { error: "LINE pairing code is required." },
      { status: 400 },
    );
  }

  try {
    await approveLinePairing(body.code);
    return NextResponse.json({ success: true, approved: true });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to approve LINE pairing.",
      },
      { status: errorCode(error) === "invalid_pairing_code" ? 400 : 502 },
    );
  }
}
