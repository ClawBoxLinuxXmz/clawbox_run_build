import { getAll } from "@/lib/config-store";
import {
  getWhatsAppConfig,
  startWhatsAppQrLogin,
} from "@/lib/channels/whatsapp";
import { notifyQrIfChanged } from "@/lib/notify-daemon";
import {
  noStoreJson,
  whatsappErrorMessage,
  whatsappErrorStatus,
} from "../response";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  let setup: Awaited<ReturnType<typeof getAll>>;
  let config: Awaited<ReturnType<typeof getWhatsAppConfig>>;
  try {
    [setup, config] = await Promise.all([getAll(), getWhatsAppConfig()]);
  } catch (error) {
    return noStoreJson(
      {
        error: whatsappErrorMessage(
          error,
          "Failed to read WhatsApp setup state.",
        ),
      },
      { status: 500 },
    );
  }
  if (!setup.ai_model_configured) {
    return noStoreJson(
      { error: "Configure your AI provider before setting up WhatsApp." },
      { status: 409 },
    );
  }
  if (!config.configured || !config.enabled) {
    return noStoreJson(
      { error: "Prepare and enable WhatsApp before generating a QR code." },
      { status: 409 },
    );
  }

  let body: { force?: unknown; accountId?: unknown; timeoutMs?: unknown };
  try {
    body = await request.json();
  } catch {
    return noStoreJson({ error: "Invalid JSON" }, { status: 400 });
  }
  if (body.force !== undefined && typeof body.force !== "boolean") {
    return noStoreJson(
      { error: "force must be a boolean" },
      { status: 400 },
    );
  }
  if (body.accountId !== undefined && typeof body.accountId !== "string") {
    return noStoreJson(
      { error: "accountId must be a string" },
      { status: 400 },
    );
  }
  if (body.timeoutMs !== undefined && typeof body.timeoutMs !== "number") {
    return noStoreJson(
      { error: "timeoutMs must be a number" },
      { status: 400 },
    );
  }

  try {
    const result = await startWhatsAppQrLogin({
      force: body.force === true,
      accountId:
        typeof body.accountId === "string" ? body.accountId : undefined,
      timeoutMs:
        typeof body.timeoutMs === "number" ? body.timeoutMs : undefined,
    });
    // WhatsApp 二维码是 data:image 图片, 墨水屏图片直显 (qr_type="image")
    notifyQrIfChanged("whatsapp", result.qrDataUrl, "image");
    return noStoreJson({ success: true, ...result });
  } catch (error) {
    return noStoreJson(
      {
        error: whatsappErrorMessage(
          error,
          "Failed to generate a WhatsApp QR code.",
        ),
      },
      { status: whatsappErrorStatus(error) },
    );
  }
}
