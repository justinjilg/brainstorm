// Unit tests for the ch-remote argv shape and JSON parsing.
//
// HONESTY: these run against a mock `ExecFileFn`, never against a real
// `ch-remote` binary. They pin the argv shape we send so the integration
// runner on node-2 can detect drift via the test diff before booting.

import { describe, expect, it } from "vitest";

import {
  ChRemote,
  normaliseVmmState,
  type ExecFileFn,
} from "../chv/chv-remote.js";
import { SandboxResetError } from "../errors.js";

function recorder(): {
  execFile: ExecFileFn;
  calls: Array<{ file: string; args: string[] }>;
  responses: Map<
    string,
    { stdout: string; stderr?: string } | { error: string }
  >;
} {
  const calls: Array<{ file: string; args: string[] }> = [];
  const responses = new Map<
    string,
    { stdout: string; stderr?: string } | { error: string }
  >();
  const execFile: ExecFileFn = async (file, args) => {
    calls.push({ file, args: [...args] });
    const verb = args[2] ?? "";
    const r = responses.get(verb);
    if (r === undefined) {
      throw new Error(`mock execFile: no response for verb=${verb}`);
    }
    if ("error" in r) throw new Error(r.error);
    return { stdout: r.stdout, stderr: r.stderr ?? "" };
  };
  return { execFile, calls, responses };
}

describe("ChRemote.snapshotRevert", () => {
  it("sends shutdown → delete → restore → resume in that order (CHV state-machine fix)", async () => {
    const r = recorder();
    r.responses.set("shutdown", { stdout: "" });
    r.responses.set("delete", { stdout: "" });
    r.responses.set("restore", { stdout: "" });
    r.responses.set("resume", { stdout: "" });

    const cr = new ChRemote({
      apiSocketPath: "/run/chv-api.sock",
      execFile: r.execFile,
    });
    await cr.snapshotRevert("/var/lib/bsm/golden");

    expect(r.calls).toEqual([
      {
        file: "ch-remote",
        args: ["--api-socket", "/run/chv-api.sock", "shutdown"],
      },
      {
        file: "ch-remote",
        args: ["--api-socket", "/run/chv-api.sock", "delete"],
      },
      {
        file: "ch-remote",
        args: [
          "--api-socket",
          "/run/chv-api.sock",
          "restore",
          "source_url=file:///var/lib/bsm/golden",
        ],
      },
      {
        file: "ch-remote",
        args: ["--api-socket", "/run/chv-api.sock", "resume"],
      },
    ]);
  });

  it("wraps non-zero exit on shutdown in SandboxResetError", async () => {
    const r = recorder();
    r.responses.set("shutdown", { error: "exit code 1: VmNotRunning" });
    r.responses.set("delete", { stdout: "" });
    r.responses.set("restore", { stdout: "" });
    r.responses.set("resume", { stdout: "" });
    const cr = new ChRemote({
      apiSocketPath: "/run/chv-api.sock",
      execFile: r.execFile,
    });
    await expect(cr.snapshotRevert("/var/lib/bsm/golden")).rejects.toThrow(
      SandboxResetError,
    );
  });

  it("wraps non-zero exit on delete in SandboxResetError", async () => {
    const r = recorder();
    r.responses.set("shutdown", { stdout: "" });
    r.responses.set("delete", { error: "exit code 1: cleanup failed" });
    r.responses.set("restore", { stdout: "" });
    r.responses.set("resume", { stdout: "" });
    const cr = new ChRemote({
      apiSocketPath: "/run/chv-api.sock",
      execFile: r.execFile,
    });
    await expect(cr.snapshotRevert("/var/lib/bsm/golden")).rejects.toThrow(
      SandboxResetError,
    );
  });

  it("wraps non-zero exit on restore in SandboxResetError (preserves cause msg)", async () => {
    const r = recorder();
    r.responses.set("shutdown", { stdout: "" });
    r.responses.set("delete", { stdout: "" });
    r.responses.set("restore", { error: "exit code 1: snapshot conflict" });
    r.responses.set("resume", { stdout: "" });
    const cr = new ChRemote({
      apiSocketPath: "/run/chv-api.sock",
      execFile: r.execFile,
    });

    let caught: unknown = null;
    try {
      await cr.snapshotRevert("/var/lib/bsm/golden");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SandboxResetError);
    expect((caught as Error).message).toContain("ch-remote restore");
    expect((caught as Error).message).toContain("snapshot conflict");
  });

  it("wraps non-zero exit on resume in SandboxResetError", async () => {
    const r = recorder();
    r.responses.set("shutdown", { stdout: "" });
    r.responses.set("delete", { stdout: "" });
    r.responses.set("restore", { stdout: "" });
    r.responses.set("resume", { error: "exit code 2: VMM unreachable" });
    const cr = new ChRemote({
      apiSocketPath: "/run/chv-api.sock",
      execFile: r.execFile,
    });

    await expect(cr.snapshotRevert("/var/lib/bsm/golden")).rejects.toThrow(
      SandboxResetError,
    );
  });
});

describe("ChRemote.info", () => {
  it("parses JSON state field and normalises to canonical VmmApiState", async () => {
    const r = recorder();
    r.responses.set("info", {
      stdout: JSON.stringify({ state: "Running", config: {} }),
    });
    const cr = new ChRemote({
      apiSocketPath: "/run/chv-api.sock",
      execFile: r.execFile,
    });
    const result = await cr.info();
    expect(result.raw).toBe("Running");
    expect(result.state).toBe("running");
  });

  it("throws SandboxResetError on non-JSON stdout (substrate-lying defense)", async () => {
    const r = recorder();
    r.responses.set("info", { stdout: "<html>error</html>" });
    const cr = new ChRemote({
      apiSocketPath: "/run/chv-api.sock",
      execFile: r.execFile,
    });
    await expect(cr.info()).rejects.toThrow(SandboxResetError);
  });
});

describe("ChRemote.pause", () => {
  it("sends `pause` with --api-socket pinned (no source_url)", async () => {
    const r = recorder();
    r.responses.set("pause", { stdout: "" });
    const cr = new ChRemote({
      apiSocketPath: "/run/chv-api.sock",
      execFile: r.execFile,
    });
    await cr.pause();

    expect(r.calls).toEqual([
      {
        file: "ch-remote",
        args: ["--api-socket", "/run/chv-api.sock", "pause"],
      },
    ]);
  });

  it("wraps non-zero exit on pause in SandboxResetError (preserves cause msg)", async () => {
    const r = recorder();
    r.responses.set("pause", { error: "exit code 1: VmNotRunning" });
    const cr = new ChRemote({
      apiSocketPath: "/run/chv-api.sock",
      execFile: r.execFile,
    });

    let caught: unknown = null;
    try {
      await cr.pause();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SandboxResetError);
    expect((caught as Error).message).toContain("ch-remote pause");
    expect((caught as Error).message).toContain("VmNotRunning");
  });
});

describe("ChRemote.snapshotCreate", () => {
  it("sends `snapshot destination_url=file://<destDir>` with --api-socket pinned", async () => {
    const r = recorder();
    r.responses.set("snapshot", { stdout: "" });
    const cr = new ChRemote({
      apiSocketPath: "/run/chv-api.sock",
      execFile: r.execFile,
    });
    await cr.snapshotCreate("/var/lib/bsm/golden");

    expect(r.calls).toEqual([
      {
        file: "ch-remote",
        args: [
          "--api-socket",
          "/run/chv-api.sock",
          "snapshot",
          "file:///var/lib/bsm/golden",
        ],
      },
    ]);
  });

  it("wraps non-zero exit on snapshot in SandboxResetError (preserves cause msg)", async () => {
    const r = recorder();
    r.responses.set("snapshot", {
      error: "exit code 1: VmNotPaused — pause before snapshot",
    });
    const cr = new ChRemote({
      apiSocketPath: "/run/chv-api.sock",
      execFile: r.execFile,
    });

    let caught: unknown = null;
    try {
      await cr.snapshotCreate("/var/lib/bsm/golden");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SandboxResetError);
    expect((caught as Error).message).toContain("ch-remote snapshot");
    expect((caught as Error).message).toContain("VmNotPaused");
  });

  it("uses the provided binary override (custom chRemoteBin path)", async () => {
    const r = recorder();
    r.responses.set("snapshot", { stdout: "" });
    const cr = new ChRemote({
      binary: "/opt/cloud-hypervisor/bin/ch-remote",
      apiSocketPath: "/run/chv-api.sock",
      execFile: r.execFile,
    });
    await cr.snapshotCreate("/var/lib/bsm/golden");

    expect(r.calls[0].file).toBe("/opt/cloud-hypervisor/bin/ch-remote");
  });
});

describe("normaliseVmmState mapping", () => {
  it.each([
    ["Running", "running"],
    ["running", "running"],
    ["Paused", "paused"],
    ["PAUSED", "paused"],
    ["Shutdown", "stopped"],
    ["Stopped", "stopped"],
    ["Created", "stopped"],
    ["Crashed", "error"],
    ["", "error"],
    ["Frobnicated", "error"],
  ] as const)("`%s` -> `%s`", (input, expected) => {
    expect(normaliseVmmState(input)).toBe(expected);
  });
});
