import {
  approveWhatsAppPairing,
  getWhatsAppConfig,
  listWhatsAppPairingRequests,
} from "@/lib/channels/whatsapp";
import {
  noStoreJson,
  whatsappErrorMessage,
  whatsappErrorStatus,
} from "../response";

export const dynamic = "force-dynamic";

async function requireWhatsAppEnabled(): Promise<Response | null> {
  const config = await getWhatsAppConfig();
  if (config.configured && config.enabled) return null;
  return noStoreJson(
    { error: "Enable and link WhatsApp before approving a user." },
    { status: 409 },
  );
}

export async function GET() {
  try {
    const blocked = await requireWhatsAppEnabled();
    if (blocked) return blocked;
    return noStoreJson({ requests: await listWhatsAppPairingRequests() });
  } catch (error) {
    return noStoreJson(
      {
        error: whatsappErrorMessage(
          error,
          "Failed to list WhatsApp pairing requests.",
        ),
      },
      { status: whatsappErrorStatus(error) },
    );
  }
}

export async function POST(request: Request) {
  try {
    const blocked = await requireWhatsAppEnabled();
    if (blocked) return blocked;
  } catch (error) {
    return noStoreJson(
      { error: whatsappErrorMessage(error, "Failed to read WhatsApp config.") },
      { status: 500 },
    );
  }

  let body: { code?: unknown };
  try {
    body = await request.json();
  } catch {
    return noStoreJson({ error: "Invalid JSON" }, { status: 400 });
  }
  if (typeof body.code !== "string" || !body.code.trim()) {
    return noStoreJson(
      { error: "WhatsApp pairing code is required." },
      { status: 400 },
    );
  }

  try {
    await approveWhatsAppPairing(body.code);
    return noStoreJson({ success: true, approved: true });
  } catch (error) {
    return noStoreJson(
      {
        error: whatsappErrorMessage(
          error,
          "Failed to approve WhatsApp pairing.",
        ),
      },
      { status: whatsappErrorStatus(error) },
    );
  }
}
