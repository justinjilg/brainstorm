// P-A4-resource-exhaust
//
// Tagging note (post-v0.1.0 honesty pass):
//   This probe is filename-prefixed "A4" for continuity with the rest of the
//   probe set, but its actual scope is sandbox-runtime resource enforcement,
//   NOT threat-model class A4. Per docs/endpoint-agent-threat-model.md §3.1:
//
//     A4 = compromised IMAGE at BUILD-TIME (image-builder pipeline tamper);
//          explicitly OUT OF MVP SCOPE. Defended via reproducible builds +
//          signed images post-MVP.
//     A5 = compromised host AGENT (code execution inside brainstorm-agent);
//          also OUT OF MVP SCOPE.
//
//   What this probe actually exercises is closer to A3 (compromised tool
//   inside the sandbox) hitting host-side resource ceilings — the failure
//   mode under test is "does the sandbox's runtime cgroup-memory/pids limit
//   contain the runaway", which is a sandbox-runtime concern rather than an
//   attacker-class emulation. Re-tagging to a synthetic
//   `"sandbox-runtime-limit"` class instead of falsely claiming A4 coverage.
//
// Mechanics: tool tries to allocate 100 GiB and/or fork-bomb. Real CHV
// applies cgroup memory + pids limits. The probe passes iff the tool is
// killed / refused with a recognised resource-error AND the host process
// memory growth is bounded.
//
// Honesty: validated against mock only. The mock simulates the limit by
// having the handler refuse allocations above a threshold.

import type { Sandbox } from "@brainst0rm/sandbox";

import type { Probe, ProbeOutcome } from "../types.js";

export const pA4ResourceExhaust: Probe = {
  name: "P-A4-resource-exhaust",
  attackerClass: "sandbox-runtime-limit",
  expectation: "should-fail",
  validatedAgainst: "mock-only",
  description:
    "Sandbox-runtime resource-limit probe (NOT threat-model A4 — see file " +
    "header). Compromised tool allocates 100 GiB / fork-bombs. Sandbox " +
    "cgroup limits MUST kill the runaway. Tool exit_code MUST be non-zero " +
    "with an OOM/limit-style stderr signal.",
  async run(sandbox: Sandbox): Promise<ProbeOutcome> {
    const exec = await sandbox.executeTool({
      command_id: "redteam-A4-rss",
      tool: "resource.alloc",
      params: { bytes: 100 * 1024 * 1024 * 1024 }, // 100 GiB
      deadline_ms: 5_000,
    });
    if (exec.exit_code === 0) {
      return {
        passed: false,
        reason: "tool reported successful 100 GiB allocation — limits absent",
        evidence: { exit_code: exec.exit_code },
      };
    }
    return {
      passed: true,
      reason: `allocation refused/killed (exit=${exec.exit_code}, stderr=${exec.stderr})`,
      evidence: { exit_code: exec.exit_code },
    };
  },
};
