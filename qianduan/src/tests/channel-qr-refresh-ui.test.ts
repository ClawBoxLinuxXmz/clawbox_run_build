import fs from "fs/promises";
import path from "path";
import { describe, expect, it } from "vitest";

async function readChannelSetupSource(): Promise<string> {
  return fs.readFile(
    path.join(process.cwd(), "src/components/ChannelSetupExtras.tsx"),
    "utf-8",
  );
}

function sectionBetween(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  expect(start, `missing source marker: ${startMarker}`).toBeGreaterThanOrEqual(0);
  expect(end, `missing source marker: ${endMarker}`).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe("channel QR refresh UI", () => {
  it("renders an explicit refresh action that calls the QR session start callback", async () => {
    const source = await readChannelSetupSource();
    const panel = sectionBetween(source, "function QrPanel(", "export default function ChannelSetupExtras");

    expect(panel).toContain('t("Refresh QR")');
    expect(panel).toMatch(/onClick=\{\s*onRefresh\s*\}/);

    for (const channel of ["clawbot", "personal", "signal"]) {
      expect(source).toMatch(
        new RegExp(
          `onRefresh=\\{\\(\\) =>[\\s\\S]{0,160}${channel}Qr\\.start`,
        ),
      );
    }
  });

  it("starts a fresh polling loop whenever QR login is refreshed", async () => {
    const source = await readChannelSetupSource();
    const hook = sectionBetween(source, "function useQrSession(", "function QrPanel(");

    expect(hook).toContain("const start = useCallback");
    expect(hook).toContain("stopPolling();");
    expect(hook).toContain("requestJson<QrSession>(startPath");
    expect(hook).toContain("timerRef.current = setInterval(async () =>");
    expect(hook).toContain("requestJson<QrSession>(statusPath");
    expect(hook).toContain("stopPolling();");
  });
});
