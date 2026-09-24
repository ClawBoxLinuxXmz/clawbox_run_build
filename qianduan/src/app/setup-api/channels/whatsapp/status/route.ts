import { probeWhatsAppChannel } from "@/lib/channels/whatsapp";
import {
  noStoreJson,
  whatsappErrorCode,
  whatsappErrorMessage,
  whatsappErrorStatus,
} from "../response";

export const dynamic = "force-dynamic";

export async function GET(request?: Request) {
  try {
    const force = request?.url ? new URL(request.url).searchParams.get("force") === "1" : false;
    return noStoreJson(await probeWhatsAppChannel(undefined, force ? { force: true } : undefined));
  } catch (error) {
    const code = whatsappErrorCode(error);
    return noStoreJson(
      {
        state: "error",
        linked: false,
        connected: false,
        running: false,
        pluginAvailable: code === "plugin_unavailable" ? false : null,
        lastError: whatsappErrorMessage(
          error,
          "Failed to check WhatsApp status.",
        ),
        errorCode: code,
      },
      { status: whatsappErrorStatus(error) },
    );
  }
}
