import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.doUnmock("child_process");
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("restartGateway", () => {
  it("signals the systemd MainPID instead of requesting an interactive restart", async () => {
    const execFile = vi.fn(
      (
        _file: string,
        _args: string[],
        _options: object,
        callback: (error: null, result: { stdout: string; stderr: string }) => void,
      ) => callback(null, { stdout: "609\n", stderr: "" }),
    );
    vi.doMock("child_process", () => ({ execFile }));
    const kill = vi.spyOn(process, "kill").mockReturnValue(true);

    const { restartGateway } = await import("@/lib/openclaw-config");
    await restartGateway();

    expect(execFile).toHaveBeenCalledWith(
      "systemctl",
      ["show", "clawbox-gateway.service", "--property=MainPID", "--value", "--no-pager"],
      { timeout: 3_000 },
      expect.any(Function),
    );
    expect(kill).toHaveBeenCalledWith(609, "SIGUSR1");
  });

  it("rejects an invalid or stopped service PID", async () => {
    const execFile = vi.fn(
      (
        _file: string,
        _args: string[],
        _options: object,
        callback: (error: null, result: { stdout: string; stderr: string }) => void,
      ) => callback(null, { stdout: "0\n", stderr: "" }),
    );
    vi.doMock("child_process", () => ({ execFile }));
    const kill = vi.spyOn(process, "kill").mockReturnValue(true);

    const { restartGateway } = await import("@/lib/openclaw-config");
    await expect(restartGateway()).rejects.toThrow("clawbox-gateway is not running");
    expect(kill).not.toHaveBeenCalled();
  });

  it("waits through a transient PID gap while the Gateway supervisor is restarting", async () => {
    let calls = 0;
    const execFile = vi.fn(
      (
        _file: string,
        _args: string[],
        _options: object,
        callback: (error: null, result: { stdout: string; stderr: string }) => void,
      ) => {
        calls += 1;
        callback(null, { stdout: calls === 1 ? "0\n" : "731\n", stderr: "" });
      },
    );
    vi.doMock("child_process", () => ({ execFile }));
    const kill = vi.spyOn(process, "kill").mockReturnValue(true);

    const { restartGateway } = await import("@/lib/openclaw-config");
    await restartGateway();

    expect(execFile).toHaveBeenCalledTimes(2);
    expect(kill).toHaveBeenCalledWith(731, "SIGUSR1");
  });

  it("retries when the Gateway PID exits between lookup and signaling", async () => {
    let calls = 0;
    const execFile = vi.fn(
      (
        _file: string,
        _args: string[],
        _options: object,
        callback: (error: null, result: { stdout: string; stderr: string }) => void,
      ) => {
        calls += 1;
        callback(null, { stdout: "845\n", stderr: "" });
      },
    );
    vi.doMock("child_process", () => ({ execFile }));
    const kill = vi.spyOn(process, "kill");
    kill.mockImplementationOnce(() => {
      const error = new Error("process disappeared") as NodeJS.ErrnoException;
      error.code = "ESRCH";
      throw error;
    }).mockReturnValue(true);

    const { restartGateway } = await import("@/lib/openclaw-config");
    await restartGateway();

    expect(execFile).toHaveBeenCalledTimes(2);
    expect(kill).toHaveBeenNthCalledWith(1, 845, "SIGUSR1");
    expect(kill).toHaveBeenNthCalledWith(2, 845, "SIGUSR1");
  });

  it("keeps a full service restart available for environment changes", async () => {
    const execFile = vi.fn(
      (
        _file: string,
        _args: string[],
        _options: object,
        callback: (error: null, result: { stdout: string; stderr: string }) => void,
      ) => callback(null, { stdout: "", stderr: "" }),
    );
    vi.doMock("child_process", () => ({ execFile }));

    const { restartGatewayService } = await import("@/lib/openclaw-config");
    await restartGatewayService();

    expect(execFile).toHaveBeenCalledWith(
      "systemctl",
      ["restart", "clawbox-gateway.service"],
      { timeout: 15_000 },
      expect.any(Function),
    );
  });
});
