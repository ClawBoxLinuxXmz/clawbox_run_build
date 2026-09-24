import { logoutWhatsApp } from "@/lib/channels/whatsapp";
import {
  noStoreJson,
  whatsappErrorMessage,
  whatsappErrorStatus,
} from "../response";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  let body: { accountId?: unknown };
  try {
    body = await request.json();
  } catch {
    return noStoreJson({ error: "Invalid JSON" }, { status: 400 });
  }
  if (body.accountId !== undefined && typeof body.accountId !== "string") {
    return noStoreJson(
      { error: "accountId must be a string" },
      { status: 400 },
    );
  }

  try {
    const result = await logoutWhatsApp(
      typeof body.accountId === "string" ? body.accountId : undefined,
    );
    return noStoreJson({ success: true, ...result });
  } catch (error) {
    return noStoreJson(
      { error: whatsappErrorMessage(error, "Failed to log out WhatsApp.") },
      { status: whatsappErrorStatus(error) },
    );
  }
}
