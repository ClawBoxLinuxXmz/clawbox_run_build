import { NextResponse } from "next/server";
import { notifyDaemonLocale } from "@/lib/notify-daemon";

/**
 * 语言状态同步接口 —— 网页语言变化时调用。
 *
 * 只做形状校验 (BCP-47 风格, 长度上限), 不做语言白名单:
 * 韩语/俄语/任意语种都原样透传给守护进程, 由守护进程决定如何显示。
 */
const LOCALE_PATTERN = /^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})*$/;

export async function POST(request: Request) {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const locale =
    typeof payload === "object" &&
    payload !== null &&
    typeof (payload as { locale?: unknown }).locale === "string"
      ? (payload as { locale: string }).locale.trim()
      : "";

  if (!locale || locale.length > 32 || !LOCALE_PATTERN.test(locale)) {
    return NextResponse.json({ error: "Invalid locale" }, { status: 400 });
  }

  const ok = await notifyDaemonLocale(locale);
  return NextResponse.json({ success: ok, locale });
}