import { NextRequest } from "next/server";
import { redirectToSetup } from "@/lib/redirect";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  return redirectToSetup(request);
}
