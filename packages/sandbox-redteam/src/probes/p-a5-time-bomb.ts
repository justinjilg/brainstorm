// P-A5-time-bomb
// Threat model class: A5 (compromised host agent) — the surface a runaway
//                     in-guest tool exercises in the host process is the
//                     same as a buggy/malicious agent failing to enforce
//                     deadline_ms. The defender posture (G2) is "hard
//                     deadline kill". This probe asserts that posture.
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
  attackerClass: "A5",
  expectation: "should-fail",
  validatedAgainst: "mock-only",
  description:
    "Tool runs longer than deadline_ms. Sandbox MUST throw " +
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
