import fs from "fs/promises";
import path from "path";
import { describe, expect, it } from "vitest";

describe("system update UI contract", () => {
  it("starts the backend update with the handoff request shape", async () => {
    const source = await fs.readFile(
      path.join(process.cwd(), "src/components/DoneStep.tsx"),
      "utf-8",
    );

    expect(source).toContain('fetch("/setup-api/update/run"');
    expect(source).toContain('body: "{}"');
    expect(source).toContain("res.status === 409");
    expect(source).not.toContain('body: JSON.stringify({ force: true })');
  });

  it("polls every two seconds and handles both backend state protocols", async () => {
    const source = await fs.readFile(
      path.join(process.cwd(), "src/components/DoneStep.tsx"),
      "utf-8",
    );

    expect(source).toContain('fetch("/setup-api/update/status"');
    expect(source).toContain('cache: "no-store"');
    expect(source).toContain("setInterval(() => void poll(), 2000)");
    expect(source).toContain('data.state === "done"');
    expect(source).toContain('data.state === "updating"');
    expect(source).toContain('data.phase === "completed"');
    expect(source).toContain('data.phase === "running"');
  });

  it("keeps acknowledgement and request failures visible", async () => {
    const source = await fs.readFile(
      path.join(process.cwd(), "src/components/DoneStep.tsx"),
      "utf-8",
    );

    expect(source).toContain("Update request received. Waiting for the update service...");
    expect(source).toContain("The update service is restarting. Waiting for it to come back online...");
    expect(source).toContain("An update is already in progress.");
    expect(source).toContain("{updateStarted && (");
    expect(source).toContain("updateState?.phase === \"failed\" || updateError");
  });
});
