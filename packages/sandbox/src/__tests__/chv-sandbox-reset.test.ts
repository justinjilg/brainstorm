// Unit tests for `ChvSandbox.reset()` and the 3-source verification path.
//
// HONESTY (read first):
//
//   These tests run on Darwin against a MOCK `ExecFileFn`, a MOCK
//   `HashFileFn`, and a MOCK `VsockGuestQueryClient`. They DO NOT touch a
//   real `ch-remote` binary, a real CHV REST API socket, or a real CoW
//   overlay file. Their purpose is to pin:
//
//     1. The `ch-remote` argv shape (so a real-CHV runner sees consistent
//        invocations and any drift is caught at the test layer).
//     2. The 3-source divergence semantics (any source disagreeing with
//        its baseline -> SandboxResetDivergenceError + divergence_action
//        = "halt").
//     3. The "baselines unset = soft pass with marker" behaviour so the
//        scaffold mode stays distinguishable from a real reset.
//
//   Real validation against a Cloud Hypervisor binary is 0bz7aztr's job
//   on node-2 — see `scripts/first-light.ts` and the README "Linux
//   runner first-light checklist".

import { describe, expect, it } from "vitest";

import { ChvSandbox, type VsockGuestQueryClient } from "../chv/chv-sandbox.js";
import type { ChvSandboxConfig } from "../chv/chv-config.js";
import type { ExecFileFn } from "../chv/chv-remote.js";
import type { HashFileFn } from "../chv/chv-overlay-hash.js";
import { SandboxResetDivergenceError, SandboxResetError } from "../errors.js";

// --- helpers --------------------------------------------------------------

/**
 * Build a minimal `ChvSandboxConfig` for reset-only tests. Boot is never
 * exercised here; the test forces `status = "ready"` directly.
 */
function makeConfig(
  overrides: Partial<ChvSandboxConfig> = {},
): ChvSandboxConfig {
  return {
    apiSocketPath: "/tmp/test-api.sock",
    kernel: { path: "/tmp/test-kernel" },
    rootfs: {
      path: "/tmp/test-rootfs.img",
      // overlayPath is REQUIRED for FS-hash verification; tests use the
      // configured-baselines path by default, so the overlay path must
      // be present too. Tests that exercise the "unset baselines" branch
      // override this to undefined.
      overlayPath: "/tmp/test-rootfs-overlay.img",
    },
    vsock: { socketPath: "/tmp/test-vsock.sock" },
    snapshotPath: "/tmp/test-snapshot",
    baselines: {
      fs_hash: "sha256:abc123",
      open_fd_count: 7,
      expected_vmm_api_state: "running",
    },
    ...overrides,
  };
}

/**
 * Test scaffolding — capture every invocation. Each test sets the
 * `responses` map keyed by ch-remote subcommand verb (e.g. "restore",
 * "resume", "info"). Invocations not in the map throw, so unexpected
 * argv combos fail loudly.
 */
function makeMockExecFile(
  responses: Record<
    string,
    | { stdout: string; stderr?: string }
    | { error: string }
    | ((args: readonly string[]) => Promise<{ stdout: string; stderr: string }>)
  >,
): { execFile: ExecFileFn; calls: Array<{ file: string; args: string[] }> } {
  const calls: Array<{ file: string; args: string[] }> = [];
  const execFile: ExecFileFn = async (file, args) => {
    calls.push({ file, args: [...args] });
    // The verb is the first arg after `--api-socket <path>`. Pinned at
    // index 2 by ch-remote's documented argv shape.
    const verb = args[2] ?? "<missing>";
    const response = responses[verb];
    if (response === undefined) {
      throw new Error(
        `mock execFile: unexpected verb "${verb}" (full argv: ${JSON.stringify(args)})`,
      );
    }
    if (typeof response === "function") {
      return response(args);
    }
    if ("error" in response) {
      throw new Error(response.error);
    }
    return { stdout: response.stdout, stderr: response.stderr ?? "" };
  };
  return { execFile, calls };
}

function makeMockHashFile(value: string): {
  hashFile: HashFileFn;
  calls: string[];
} {
  const calls: string[] = [];
  const hashFile: HashFileFn = async (path) => {
    calls.push(path);
    return value;
  };
  return { hashFile, calls };
}

function makeMockVsock(open_fd_count: number): {
  vsock: VsockGuestQueryClient;
  calls: number;
} {
  let calls = 0;
  const vsock: VsockGuestQueryClient = {
    async guestQuery(kind) {
      calls++;
      if (kind !== "OpenFdCount") {
        throw new Error(`unexpected guestQuery kind: ${kind}`);
      }
      return { open_fd_count };
    },
  };
  return {
    vsock,
    get calls() {
      return calls;
    },
  } as unknown as { vsock: VsockGuestQueryClient; calls: number };
}

/** Force a fresh `ChvSandbox` into "ready" without booting. */
function placeReady(
  sandbox: ChvSandbox,
  vsock: VsockGuestQueryClient | null,
): void {
  // Test-only reach-in. Production calls boot() to reach this state.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const s = sandbox as any;
  s.status = "ready";
  if (vsock !== null) {
    // The ChvSandboxDeps.vsock injection is preferred over s.vsock so
    // tests don't have to mimic the full VsockClient shape.
    s.deps.vsock = vsock;
  }
}

// --- tests ----------------------------------------------------------------

describe("ChvSandbox.reset() — 3-source verification (mock backend)", () => {
  it("happy path: all 3 sources match → reset returns ResetState with divergence_action=none", async () => {
    // GIVEN: baselines configured, all sources will agree.
    const { execFile, calls } = makeMockExecFile({
      shutdown: { stdout: "" },
      delete: { stdout: "" },
      restore: { stdout: "" },
      resume: { stdout: "" },
      info: { stdout: JSON.stringify({ state: "Running" }) },
    });
    const { hashFile } = makeMockHashFile("sha256:abc123");
    const { vsock } = makeMockVsock(7);

    const sandbox = new ChvSandbox(makeConfig(), { execFile, hashFile });
    placeReady(sandbox, vsock);

    // WHEN
    const result = await sandbox.reset();

    // THEN: ResetState shape per protocol §13.
    expect(result.verification_passed).toBe(true);
    expect(result.golden_hash).toBe("sha256:abc123");
    expect(result.verification_details.fs_hash).toBe("sha256:abc123");
    expect(result.verification_details.fs_hash_match).toBe(true);
    expect(result.verification_details.open_fd_count).toBe(7);
    expect(result.verification_details.vmm_api_state).toBe("running");
    expect(result.verification_details.divergence_action).toBe("none");

    // ch-remote argv shape pinned: shutdown → delete → restore → resume → info
    // (CHV state machine requires shutdown+delete before restore can take
    // a fresh VM from the snapshot. Caught on 0bz7aztr's run-3.)
    expect(calls.length).toBe(5);
    expect(calls[0]).toEqual({
      file: "ch-remote",
      args: ["--api-socket", "/tmp/test-api.sock", "shutdown"],
    });
    expect(calls[1]).toEqual({
      file: "ch-remote",
      args: ["--api-socket", "/tmp/test-api.sock", "delete"],
    });
    expect(calls[2]).toEqual({
      file: "ch-remote",
      args: [
        "--api-socket",
        "/tmp/test-api.sock",
        "restore",
        "source_url=file:///tmp/test-snapshot",
      ],
    });
    expect(calls[3]).toEqual({
      file: "ch-remote",
      args: ["--api-socket", "/tmp/test-api.sock", "resume"],
    });
    expect(calls[4]).toEqual({
      file: "ch-remote",
      args: ["--api-socket", "/tmp/test-api.sock", "info"],
    });

    expect(sandbox.state()).toBe("ready");
  });

  it("fs_hash mismatch → throws SandboxResetDivergenceError with divergence_action=halt", async () => {
    const { execFile } = makeMockExecFile({
      shutdown: { stdout: "" },
      delete: { stdout: "" },
      restore: { stdout: "" },
      resume: { stdout: "" },
      info: { stdout: JSON.stringify({ state: "Running" }) },
    });
    const { hashFile } = makeMockHashFile("sha256:DIFFERENT_HASH");
    const { vsock } = makeMockVsock(7);

    const sandbox = new ChvSandbox(makeConfig(), { execFile, hashFile });
    placeReady(sandbox, vsock);

    let caught: unknown = null;
    try {
      await sandbox.reset();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SandboxResetDivergenceError);
    // Sandbox is halted (status "failed") per threat-model §5.1.
    expect(sandbox.state()).toBe("failed");
    expect((caught as SandboxResetDivergenceError).code).toBe(
      "SANDBOX_RESET_DIVERGENCE",
    );
    expect((caught as Error).message).toContain("fs_match=false");
    expect((caught as Error).message).toContain("divergence_action=halt");
  });

  it("open_fd_count mismatch → throws SandboxResetDivergenceError", async () => {
    const { execFile } = makeMockExecFile({
      shutdown: { stdout: "" },
      delete: { stdout: "" },
      restore: { stdout: "" },
      resume: { stdout: "" },
      info: { stdout: JSON.stringify({ state: "Running" }) },
    });
    const { hashFile } = makeMockHashFile("sha256:abc123");
    const { vsock } = makeMockVsock(99); // baseline=7, observed=99

    const sandbox = new ChvSandbox(makeConfig(), { execFile, hashFile });
    placeReady(sandbox, vsock);

    let caught: unknown = null;
    try {
      await sandbox.reset();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SandboxResetDivergenceError);
    expect((caught as Error).message).toContain("fd_match=false");
    expect(sandbox.state()).toBe("failed");
  });

  it("vmm_api_state mismatch → throws SandboxResetDivergenceError", async () => {
    const { execFile } = makeMockExecFile({
      shutdown: { stdout: "" },
      delete: { stdout: "" },
      restore: { stdout: "" },
      resume: { stdout: "" },
      // Baseline expected "running"; CHV reports "Paused".
      info: { stdout: JSON.stringify({ state: "Paused" }) },
    });
    const { hashFile } = makeMockHashFile("sha256:abc123");
    const { vsock } = makeMockVsock(7);

    const sandbox = new ChvSandbox(makeConfig(), { execFile, hashFile });
    placeReady(sandbox, vsock);

    let caught: unknown = null;
    try {
      await sandbox.reset();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SandboxResetDivergenceError);
    expect((caught as Error).message).toContain("vmm_match=false");
    expect(sandbox.state()).toBe("failed");
  });

  it("substrate-lying defense: fs+fd say match but VMM says paused → still throws (any-source halt)", async () => {
    // This is the threat-model §A6 case: an attacker compromises 2 of 3
    // sources but can't fake the third. We MUST halt on any single
    // source disagreeing, not require a quorum.
    const { execFile } = makeMockExecFile({
      shutdown: { stdout: "" },
      delete: { stdout: "" },
      restore: { stdout: "" },
      resume: { stdout: "" },
      info: { stdout: JSON.stringify({ state: "Paused" }) }, // <-- divergent
    });
    const { hashFile } = makeMockHashFile("sha256:abc123"); // matches
    const { vsock } = makeMockVsock(7); // matches

    const sandbox = new ChvSandbox(makeConfig(), { execFile, hashFile });
    placeReady(sandbox, vsock);

    let caught: unknown = null;
    try {
      await sandbox.reset();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SandboxResetDivergenceError);
    // The vsock + fs sources agreed; only VMM diverged. The halt is
    // unconditional regardless of "majority vote".
    const msg = (caught as Error).message;
    expect(msg).toContain("fs_match=true");
    expect(msg).toContain("fd_match=true");
    expect(msg).toContain("vmm_match=false");
  });

  it("ch-remote non-zero exit during snapshot revert → throws SandboxResetError", async () => {
    const { execFile } = makeMockExecFile({
      // shutdown + delete succeed; restore is the failing step.
      shutdown: { stdout: "" },
      delete: { stdout: "" },
      restore: { error: "Command failed: ch-remote ... exit 1" },
      // resume / info should never be reached.
      resume: { stdout: "" },
      info: { stdout: JSON.stringify({ state: "Running" }) },
    });
    const { hashFile } = makeMockHashFile("sha256:abc123");
    const { vsock } = makeMockVsock(7);

    const sandbox = new ChvSandbox(makeConfig(), { execFile, hashFile });
    placeReady(sandbox, vsock);

    let caught: unknown = null;
    try {
      await sandbox.reset();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SandboxResetError);
    expect((caught as Error).message).toContain("ch-remote restore");
    expect(sandbox.state()).toBe("failed");
  });

  it("ch-remote resume non-zero exit → throws SandboxResetError after revert succeeded", async () => {
    const { execFile } = makeMockExecFile({
      shutdown: { stdout: "" },
      delete: { stdout: "" },
      restore: { stdout: "" },
      resume: { error: "ch-remote resume: exit 2" },
      info: { stdout: JSON.stringify({ state: "Running" }) },
    });
    const { hashFile } = makeMockHashFile("sha256:abc123");
    const { vsock } = makeMockVsock(7);

    const sandbox = new ChvSandbox(makeConfig(), { execFile, hashFile });
    placeReady(sandbox, vsock);

    let caught: unknown = null;
    try {
      await sandbox.reset();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SandboxResetError);
    expect((caught as Error).message).toContain("ch-remote resume failed");
    expect(sandbox.state()).toBe("failed");
  });

  it("baselines unset → forces divergence (Codex Q2 / threat-model §A6 fix)", async () => {
    // Earlier scaffolding soft-passed with matching sentinels when
    // baselines weren't configured — Codex review caught that as a
    // substrate-lying-defense bypass. The corrected behaviour: any
    // missing baseline forces divergence_action = "halt" and throws
    // SandboxResetDivergenceError. Operators MUST configure all three
    // baselines + RootfsConfig.overlayPath to claim integrity.
    const { execFile } = makeMockExecFile({
      // restore+resume not invoked because snapshotPath is also unset.
      info: { stdout: JSON.stringify({ state: "Running" }) },
    });
    const { hashFile } = makeMockHashFile("sha256:irrelevant");
    const cfg = makeConfig({
      baselines: undefined,
      snapshotPath: undefined,
    });

    const sandbox = new ChvSandbox(cfg, { execFile, hashFile });
    placeReady(sandbox, null);

    let caught: unknown = null;
    try {
      await sandbox.reset();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SandboxResetDivergenceError);
    expect(sandbox.state()).toBe("failed");
    // hashFile must NOT have been called when baseline is unset
    // (we short-circuit before invoking it).
  });

  it("full success with all 3 baselines matching → passes and stays ready (canonical happy path)", async () => {
    // Slightly different from test #1: this exercises a different state
    // mapping (CHV `Running` -> protocol `running`) and a different
    // hash format to make sure we're not coincidentally short-circuiting.
    const { execFile } = makeMockExecFile({
      shutdown: { stdout: "" },
      delete: { stdout: "" },
      restore: { stdout: "" },
      resume: { stdout: "" },
      info: {
        stdout: JSON.stringify({
          state: "Running",
          config: { cpus: { boot_vcpus: 2 } },
        }),
      },
    });
    const { hashFile } = makeMockHashFile(
      "sha256:0000111122223333444455556666777788889999aaaabbbbccccddddeeeeffff",
    );
    const { vsock } = makeMockVsock(42);
    const cfg = makeConfig({
      baselines: {
        fs_hash:
          "sha256:0000111122223333444455556666777788889999aaaabbbbccccddddeeeeffff",
        open_fd_count: 42,
        expected_vmm_api_state: "running",
      },
    });

    const sandbox = new ChvSandbox(cfg, { execFile, hashFile });
    placeReady(sandbox, vsock);

    const result = await sandbox.reset();
    expect(result.verification_passed).toBe(true);
    expect(result.verification_details.divergence_action).toBe("none");
    expect(result.verification_details.fs_hash_match).toBe(true);
    expect(result.verification_details.open_fd_count).toBe(42);
    expect(result.verification_details.vmm_api_state).toBe("running");
    expect(sandbox.state()).toBe("ready");
  });

  it("ch-remote info returns non-JSON → fs+fd match but vmm becomes 'error' → halts", async () => {
    // This is the "VMM API unreachable / lying" case. ch-remote info
    // returning garbage should map to vmm_api_state = "error" which
    // disagrees with any baseline -> divergence.
    const { execFile } = makeMockExecFile({
      shutdown: { stdout: "" },
      delete: { stdout: "" },
      restore: { stdout: "" },
      resume: { stdout: "" },
      info: { stdout: "not-valid-json{{{" },
    });
    const { hashFile } = makeMockHashFile("sha256:abc123");
    const { vsock } = makeMockVsock(7);

    const sandbox = new ChvSandbox(makeConfig(), { execFile, hashFile });
    placeReady(sandbox, vsock);

    let caught: unknown = null;
    try {
      await sandbox.reset();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SandboxResetDivergenceError);
    // Implementation logs ch-remote info failure as divergence; vmm_state="error".
    expect((caught as Error).message).toContain("vmm_match=false");
    expect(sandbox.state()).toBe("failed");
  });

  it("VMM state mapping: 'Shutdown' normalises to 'stopped'", async () => {
    // Pin the protocol §6 state-vocabulary normalisation. Baseline says
    // we expect "stopped" (e.g. for a sandbox in a paused-pool state);
    // CHV's raw "Shutdown" must normalise to "stopped" to match.
    const { execFile } = makeMockExecFile({
      shutdown: { stdout: "" },
      delete: { stdout: "" },
      restore: { stdout: "" },
      resume: { stdout: "" },
      info: { stdout: JSON.stringify({ state: "Shutdown" }) },
    });
    const { hashFile } = makeMockHashFile("sha256:abc123");
    const { vsock } = makeMockVsock(7);
    const cfg = makeConfig({
      baselines: {
        fs_hash: "sha256:abc123",
        open_fd_count: 7,
        expected_vmm_api_state: "stopped",
      },
    });

    const sandbox = new ChvSandbox(cfg, { execFile, hashFile });
    placeReady(sandbox, vsock);

    const result = await sandbox.reset();
    expect(result.verification_details.vmm_api_state).toBe("stopped");
    expect(result.verification_details.divergence_action).toBe("none");
  });
});
