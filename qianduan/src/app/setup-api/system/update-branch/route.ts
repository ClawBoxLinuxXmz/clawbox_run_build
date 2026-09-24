import { NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import { CONFIG_ROOT } from "@/lib/config-store";

export const dynamic = "force-dynamic";

const UPDATE_BRANCH_FILE = path.join(CONFIG_ROOT, ".update-branch");
const SAFE_BRANCH = /^[A-Za-z0-9._\-/]+$/;

export async function GET() {
  try {
    let branch: string | null = null;
    try {
      const raw = (await fs.readFile(UPDATE_BRANCH_FILE, "utf-8")).trim();
      if (raw && SAFE_BRANCH.test(raw)) branch = raw;
    } catch {
      /* no file */
    }
    return NextResponse.json({ branch });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to read branch" },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  try {
    let body: { branch?: string | null };
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }
    const branch = body.branch;
    if (branch === null || branch === undefined || branch === "") {
      await fs.unlink(UPDATE_BRANCH_FILE).catch(() => {});
      return NextResponse.json({ branch: null });
    }
    if (typeof branch !== "string" || !SAFE_BRANCH.test(branch)) {
      return NextResponse.json({ error: "Invalid branch name" }, { status: 400 });
    }
    await fs.mkdir(path.dirname(UPDATE_BRANCH_FILE), { recursive: true });
    const tmp = UPDATE_BRANCH_FILE + ".tmp";
    await fs.writeFile(tmp, branch + "\n", "utf-8");
    await fs.rename(tmp, UPDATE_BRANCH_FILE);
    return NextResponse.json({ branch });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to save branch" },
      { status: 500 },
    );
  }
}
