import { NextResponse } from "next/server";
import {
  checkContinuation,
  getUpdateState,
  getVersionInfo,
  isUpdateCompleted,
} from "@/lib/updater";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await checkContinuation();
    const state = getUpdateState();
    const completed = await isUpdateCompleted();
    let versions = null;
    try {
      versions = await getVersionInfo();
    } catch {
      // optional
    }
    return NextResponse.json({
      ...state,
      completed,
      ...(versions ? { versions } : {}),
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to read update status" },
      { status: 500 },
    );
  }
}
