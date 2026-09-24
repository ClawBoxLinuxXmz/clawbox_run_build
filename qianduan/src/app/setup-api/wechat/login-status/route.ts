import { NextResponse } from "next/server";
import { getWechatLoginStatus } from "@/lib/openclaw-config";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const status = await getWechatLoginStatus();
    return NextResponse.json(status);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to get WeChat login status" },
      { status: 500 },
    );
  }
}
