// P-A8-vsock-poison
// Threat model class: A8 (cross-endpoint replay) used as a stand-in for
//                     "malformed vsock framing"; the canonical class for
//                     this attack is "in-guest agent emits malicious
//                     frames to the host". Tagged A8 because the host's
//                     defense posture (reject without crashing) overlaps
//                     with the cross-endpoint reject path.
//
// Mechanics: drive the sandbox with three malformed payload classes:
//   1. Oversized result (10 MiB stdout) — must not OOM the host
//   2. Truncated frame (handled at the vsock-client layer) — modelled as
//      a tool that returns a "truncated" sentinel; the sandbox should
//      surface the truncation as an error rather than silently proceed
//   3. JSON-injection: stdout containing embedded null byte + JCS-breaking
//      characters — must not break canonicalisation
//
// On the real sandbox, malformed vsock frames must be rejected at the
// VsockClient layer; the host process MUST stay up. This probe asserts
// the sandbox reaches a recoverable state (executeTool can be called
// again successfully).
//
// Honesty: validated against mock only. Real vsock framing test requires
// the vsock-client.ts handshake to land first (currently throws
// SandboxNotAvailableError on Darwin per chv-sandbox.ts comment).

import type { Sandbox } from "@brainst0rm/sandbox";

import type { Probe, ProbeOutcome } from "../types.js";

export const pA8VsockPoison: Probe = {
  name: "P-A8-vsock-poison",
  attackerClass: "A8",
  expectation: "should-fail",
  validatedAgainst: "mock-only",
  description:
    "Sandbox receives malformed vsock frames (oversized, truncated, JSON-" +
    "injection). MUST reject without crashing; subsequent executeTool calls " +
    "MUST succeed.",
  async run(sandbox: Sandbox): Promise<ProbeOutcome> {
    const phases: { name: string; ok: boolean; detail: string }[] = [];

    // Phase 1: oversized
    try {
      const exec = await sandbox.executeTool({
        command_id: "redteam-A8-oversize",
        tool: "vsock.poison",
        params: { mode: "oversized", bytes: 10 * 1024 * 1024 },
        deadline_ms: 5_000,
      });
      phases.push({
        name: "oversized",
        ok: exec.exit_code !== 0 || exec.stdout.length < 10 * 1024 * 1024,
        detail: `exit=${exec.exit_code}, stdout_len=${exec.stdout.length}`,
      });
    } catch (e) {
      phases.push({
        name: "oversized",
        ok: true,
        detail: `rejected: ${(e as Error).message}`,
      });
    }

    // Phase 2: truncated
    try {
      const exec = await sandbox.executeTool({
        command_id: "redteam-A8-trunc",
        tool: "vsock.poison",
        params: { mode: "truncated" },
        deadline_ms: 2_000,
      });
      phases.push({
        name: "truncated",
        ok: exec.exit_code !== 0,
        detail: `exit=${exec.exit_code}`,
      });
    } catch (e) {
      phases.push({
        name: "truncated",
        ok: true,
        detail: `rejected: ${(e as Error).message}`,
      });
    }

    // Phase 3: JSON-injection
    try {
      const exec = await sandbox.executeTool({
        command_id: "redteam-A8-json",
        tool: "vsock.poison",
        params: { mode: "json-injection" },
        deadline_ms: 2_000,
      });
      phases.push({
        name: "json-injection",
        ok: exec.exit_code !== 0,
        detail: `exit=${exec.exit_code}, stdout=${truncate(exec.stdout)}`,
      });
    } catch (e) {
      phases.push({
        name: "json-injection",
        ok: true,
        detail: `rejected: ${(e as Error).message}`,
      });
    }

    // Recoverability: a benign call must succeed.
    let recovery_ok = false;
    try {
      const recover = await sandbox.executeTool({
        command_id: "redteam-A8-recover",
        tool: "noop",
        params: {},
        deadline_ms: 2_000,
      });
      recovery_ok = recover.exit_code === 0;
    } catch (e) {
      recovery_ok = false;
    }

    const allRejected = phases.every((p) => p.ok);
    const passed = allRejected && recovery_ok;
    return {
      passed,
      reason: passed
        ? "all 3 poisoned frames rejected and sandbox recovered"
        : `phases=${JSON.stringify(phases)} recovery_ok=${recovery_ok}`,
      evidence: { phases, recovery_ok },
    };
  },
};

function truncate(s: string, n = 100): string {
  return s.length > n ? s.slice(0, n) + "..." : s;
}
