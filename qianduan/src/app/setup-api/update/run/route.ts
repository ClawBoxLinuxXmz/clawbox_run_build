import { NextResponse } from "next/server";
import { startUpdate } from "@/lib/updater";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    let body: { force?: boolean } = {};
    try {
      body = await request.json();
    } catch {
      body = {};
    }
    void body.force;
    const result = startUpdate();
    if (!result.started) {
      return NextResponse.json({ error: result.error || "Update already running" }, { status: 409 });
    }
    return NextResponse.json({ success: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to start update" },
      { status: 500 },
    );
  }
}
