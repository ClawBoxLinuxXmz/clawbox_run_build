import { getAll } from "@/lib/config-store";
import {
  disableWhatsAppChannel,
  getWhatsAppConfig,
  prepareWhatsAppChannel,
  type WhatsAppSetupMode,
} from "@/lib/channels/whatsapp";
import {
  noStoreJson,
  whatsappErrorMessage,
  whatsappErrorSaved,
  whatsappErrorStatus,
} from "./response";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return noStoreJson(await getWhatsAppConfig());
  } catch (error) {
    return noStoreJson(
      { error: whatsappErrorMessage(error, "Failed to read WhatsApp config.") },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  let setup: Awaited<ReturnType<typeof getAll>>;
  try {
    setup = await getAll();
  } catch (error) {
    return noStoreJson(
      { error: whatsappErrorMessage(error, "Failed to read setup state.") },
      { status: 500 },
    );
  }
  if (!setup.ai_model_configured) {
    return noStoreJson(
      { error: "Configure your AI provider before setting up WhatsApp." },
      { status: 409 },
    );
  }

  let body: {
    enabled?: unknown;
    mode?: unknown;
    ownerNumber?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    return noStoreJson({ error: "Invalid JSON" }, { status: 400 });
  }
  if (body.enabled !== undefined && typeof body.enabled !== "boolean") {
    return noStoreJson(
      { error: "enabled must be a boolean" },
      { status: 400 },
    );
  }
  if (
    body.mode !== undefined &&
    body.mode !== "dedicated" &&
    body.mode !== "personal"
  ) {
    return noStoreJson(
      { error: "mode must be dedicated or personal" },
      { status: 400 },
    );
  }
  if (
    body.ownerNumber !== undefined &&
    typeof body.ownerNumber !== "string"
  ) {
    return noStoreJson(
      { error: "ownerNumber must be a string" },
      { status: 400 },
    );
  }

  try {
    if (body.enabled === false) {
      const result = await disableWhatsAppChannel();
      return noStoreJson({
        success: true,
        saved: true,
        state: "disabled",
        connected: false,
        ...result,
      });
    }

    const result = await prepareWhatsAppChannel({
      mode: body.mode as WhatsAppSetupMode | undefined,
      ownerNumber:
        typeof body.ownerNumber === "string"
          ? body.ownerNumber.trim()
          : undefined,
    });
    return noStoreJson({ success: true, saved: true, ...result });
  } catch (error) {
    return noStoreJson(
      {
        error: whatsappErrorMessage(
          error,
          "Failed to update WhatsApp configuration.",
        ),
        saved: whatsappErrorSaved(error),
      },
      { status: whatsappErrorStatus(error) },
    );
  }
}
