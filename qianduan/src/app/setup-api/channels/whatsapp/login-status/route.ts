import { getWhatsAppConfig, waitForWhatsAppQrLogin } from "@/lib/channels/whatsapp";
import { notifyQrIfChanged } from "@/lib/notify-daemon";
import {
  noStoreJson,
  whatsappErrorMessage,
  whatsappErrorStatus,
} from "../response";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  let config: Awaited<ReturnType<typeof getWhatsAppConfig>>;
  try {
    config = await getWhatsAppConfig();
  } catch (error) {
    return noStoreJson(
      { error: whatsappErrorMessage(error, "Failed to read WhatsApp config.") },
      { status: 500 },
    );
  }
  if (!config.configured || !config.enabled) {
    return noStoreJson(
      { error: "Prepare and enable WhatsApp before waiting for QR login." },
      { status: 409 },
    );
  }

  let body: {
    accountId?: unknown;
    timeoutMs?: unknown;
    currentQrDataUrl?: unknown;
  };
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
  if (body.timeoutMs !== undefined && typeof body.timeoutMs !== "number") {
    return noStoreJson(
      { error: "timeoutMs must be a number" },
      { status: 400 },
    );
  }
  if (
    body.currentQrDataUrl !== undefined &&
    typeof body.currentQrDataUrl !== "string"
  ) {
    return noStoreJson(
      { error: "currentQrDataUrl must be a string" },
      { status: 400 },
    );
  }

  try {
    const result = await waitForWhatsAppQrLogin({
      accountId:
        typeof body.accountId === "string" ? body.accountId : undefined,
      timeoutMs:
        typeof body.timeoutMs === "number" ? body.timeoutMs : undefined,
      currentQrDataUrl:
        typeof body.currentQrDataUrl === "string"
          ? body.currentQrDataUrl
          : undefined,
    });
    // 轮询点: 二维码异步出现后由这里补通知 (变化检测避免重复写文件)
    notifyQrIfChanged("whatsapp", result.qrDataUrl, "image");
    return noStoreJson({ success: true, ...result });
  } catch (error) {
    return noStoreJson(
      {
        error: whatsappErrorMessage(
          error,
          "Failed to check WhatsApp QR login status.",
        ),
      },
      { status: whatsappErrorStatus(error) },
    );
  }
}
