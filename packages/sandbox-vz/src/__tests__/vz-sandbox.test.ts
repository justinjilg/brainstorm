// vz-sandbox.test.ts — exercises the NDJSON correlation + lifecycle
// state machine of VzSandbox WITHOUT the real Swift helper.
//
// We inject a fake ChildProcess via the constructor's spawn override.
// The fake's stdin/stdout pipes are wired so the test can play back
// canned helper responses and observe what VzSandbox writes.
//
// What this proves:
//   - boot() blocks on the boot_result line
//   - executeTool() request_id correlation is correct
//   - reset() round-trip surfaces a SandboxResetState that matches the
//     wire shape (relay's CompletedCommandResult.sandbox_reset_state)
//
// What this does NOT prove:
//   - Real VZ behavior. There is no Swift helper exercised here.
//   - That a real macOS host with entitlements actually boots a guest.
//   - Reset verification semantics under attack — that's P3.5b.

import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import { Writable, Readable } from "node:stream";
import type { ChildProcess } from "node:child_process";

import { VzSandbox } from "../vz-sandbox.js";
import type { VzBootConfig } from "../types.js";

class FakeStdin extends Writable {
  written: string[] = [];
  _write(
    chunk: Buffer | string,
    _enc: BufferEncoding,
    cb: (err?: Error | null) => void,
  ): void {
    this.written.push(chunk.toString());
    cb();
  }
}

class FakeStdout extends Readable {
  _read(): void {
    // pushes happen externally via emitLine
  }
  emitLine(s: string): void {
    this.push(s + "\n");
  }
}

function fakeHelper(): {
  proc: ChildProcess;
  stdin: FakeStdin;
  stdout: FakeStdout;
  exit: (code: number, signal?: string | null) => void;
} {
  const ee = new EventEmitter() as unknown as ChildProcess;
  const stdin = new FakeStdin();
  const stdout = new FakeStdout();
  Object.assign(ee, {
    stdin,
    stdout,
    stderr: new Readable({ read() {} }),
    kill: () => true,
  });
  return {
    proc: ee,
    stdin,
    stdout,
    exit: (code, signal = null) => {
      (ee as unknown as EventEmitter).emit("exit", code, signal);
    },
  };
}

function makeSandbox() {
  const harness = fakeHelper();
  const sb = new VzSandbox(() => harness.proc);
  return { sb, harness };
}

const baseBoot: VzBootConfig = {
  kernel: "/path/to/vmlinuz",
  rootfs: "/path/to/rootfs.img",
};

describe("VzSandbox", () => {
  it("requires Darwin", async () => {
    if (process.platform === "darwin") return;
    const { sb } = makeSandbox();
    await expect(sb.boot(baseBoot)).rejects.toThrow(/macOS/);
  });

  it("boots, executes a tool, and routes responses by request_id", async () => {
    if (process.platform !== "darwin") return;
    const { sb, harness } = makeSandbox();
    const bootP = sb.boot(baseBoot);
    // Helper plays its handshake.
    harness.stdout.emitLine(
      JSON.stringify({
        kind: "boot_result",
        ok: true,
        vsock_cid: 3,
        vmm_api_state: "running",
        boot_path: "cold_boot",
        ts: new Date().toISOString(),
      }),
    );
    await bootP;

    const execP = sb.executeTool({
      command_id: "cmd-1",
      tool: "echo",
      params: { msg: "hi" },
      deadline_ms: 30_000,
    });

    // Pull the request line we wrote on stdin and echo back.
    const lastWritten = harness.stdin.written.at(-1);
    expect(lastWritten).toBeTruthy();
    const req = JSON.parse((lastWritten as string).trim()) as {
      request_id: string;
      kind: string;
    };
    expect(req.kind).toBe("exec");

    harness.stdout.emitLine(
      JSON.stringify({
        request_id: req.request_id,
        kind: "exec_response",
        command_id: "cmd-1",
        exit_code: 0,
        stdout: "hi\n",
        stderr: "",
        evidence_hash: "sha256:" + "0".repeat(64),
      }),
    );
    const result = await execP;
    expect(result.exit_code).toBe(0);
    expect(result.stdout).toBe("hi\n");
  });

  it("reset() returns a SandboxResetState with VerificationDetails", async () => {
    if (process.platform !== "darwin") return;
    const { sb, harness } = makeSandbox();
    const bootP = sb.boot(baseBoot);
    harness.stdout.emitLine(
      JSON.stringify({
        kind: "boot_result",
        ok: true,
        vmm_api_state: "running",
        boot_path: "fast_snapshot",
        ts: new Date().toISOString(),
      }),
    );
    await bootP;

    const resetP = sb.reset();
    const lastWritten = harness.stdin.written.at(-1) as string;
    const req = JSON.parse(lastWritten.trim()) as { request_id: string };
    harness.stdout.emitLine(
      JSON.stringify({
        request_id: req.request_id,
        kind: "reset_response",
        reset_at: new Date().toISOString(),
        golden_hash: "sha256:" + "a".repeat(64),
        verification_passed: true,
        fs_hash: "sha256:" + "b".repeat(64),
        fs_hash_baseline: "sha256:" + "b".repeat(64),
        fs_hash_match: true,
        open_fd_count: 7,
        open_fd_count_baseline: 7,
        vmm_api_state: "running",
        expected_vmm_api_state: "running",
        divergence_action: "none",
        reset_path: "fast_snapshot",
      }),
    );
    const state = await resetP;
    expect(state.verification_passed).toBe(true);
    expect(state.verification_details.fs_hash_match).toBe(true);
    expect(state.verification_details.divergence_action).toBe("none");
  });
});
