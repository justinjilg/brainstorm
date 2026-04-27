// P-A5-time-bomb
//
// Tagging note (post-v0.1.0 honesty pass):
//   This probe is filename-prefixed "A5" for continuity with the rest of the
//   probe set, but its actual scope is sandbox-runtime deadline enforcement,
//   NOT threat-model class A5. Per docs/endpoint-agent-threat-model.md §3.1:
//
//     A5 = compromised host AGENT (attacker has code execution inside the
//          brainstorm-agent process). HIGH severity, OUT OF MVP SCOPE,
//          defended post-MVP via hardware-rooted attestation.
//
//   What this probe actually exercises is the sandbox's `deadline_ms`
//   enforcement path — the surface a runaway in-guest tool exercises is
//   nominally an A3 ("compromised tool") concern, and the defender posture
//   under test is the runtime-limit guarantee (G2 / hard-deadline kill),
//   not an A5 host-agent compromise. Re-tagging to the synthetic
//   `"sandbox-runtime-limit"` class instead of falsely claiming A5 coverage.
//
// Mechanics: the tool sleeps for longer than `deadline_ms`. The Sandbox
// MUST throw `SandboxToolTimeoutError`. If the call returns a result, the
// deadline machinery is broken — red team wins.
//
// Honesty: validated against mock only. The mock implements deadline_ms
// via Promise.race; ChvSandbox is expected to enforce via vsock-side
// killing of the in-guest process. Real CHV not yet exercised here.

import { SandboxToolTimeoutError, type Sandbox } from "@brainst0rm/sandbox";

import type { Probe, ProbeOutcome } from "../types.js";

export const pA5TimeBomb: Probe = {
  name: "P-A5-time-bomb",
  attackerClass: "sandbox-runtime-limit",
  expectation: "should-fail",
  validatedAgainst: "mock-only",
  description:
    "Sandbox-runtime deadline-enforcement probe (NOT threat-model A5 — see " +
    "file header). Tool runs longer than deadline_ms. Sandbox MUST throw " +
    "SandboxToolTimeoutError, NOT return a delayed-but-successful result.",
  async run(sandbox: Sandbox): Promise<ProbeOutcome> {
    const deadlineMs = 50;
    try {
      const exec = await sandbox.executeTool({
        command_id: "redteam-A5-time",
        tool: "time.sleep",
        params: { ms: 5_000 },
        deadline_ms: deadlineMs,
      });
      return {
        passed: false,
        reason: `tool returned within deadline despite sleeping 5s — exit=${exec.exit_code}`,
        evidence: { exit_code: exec.exit_code },
      };
    } catch (e) {
      if (e instanceof SandboxToolTimeoutError) {
        return {
          passed: true,
          reason: `deadline enforced: ${(e as Error).message}`,
          evidence: { deadline_ms: deadlineMs },
        };
      }
      return {
        passed: false,
        reason: `unexpected error type: ${(e as Error).message}`,
      };
    }
  },
};
