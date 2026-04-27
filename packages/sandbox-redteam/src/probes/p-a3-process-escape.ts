// P-A3-process-escape
// Threat model class: A3 (compromised tool inside sandbox) attempting to
//                     reach the host process namespace.
//
// Mechanics: the tool tries to send SIGTERM to PID 1 of the *host*. In a
// real microVM the guest has its own PID namespace; PID 1 in the guest is
// the init shipped in the image. The probe's tool is wired so the host's
// "real" PID 1 is recorded as a host fact at boot. The probe fails iff
// the host's PID 1 is observably affected (in the mock, the tool can't
// actually signal anything outside its handler closure — but it CAN be
// caught lying by a forged claim of "I killed PID 1", which we then
// disprove via the host fact).
//
// Honesty: validated against mock only. Real CHV requires kernel + PID
// namespace verification.

import type { Sandbox } from "@brainst0rm/sandbox";

import type { Probe, ProbeOutcome } from "../types.js";

export const pA3ProcessEscape: Probe = {
  name: "P-A3-process-escape",
  attackerClass: "A3",
  expectation: "should-fail",
  validatedAgainst: "mock-only",
  description:
    "Compromised tool sends SIGTERM to host PID 1. Sandbox PID namespace " +
    "MUST isolate the guest; the host init MUST remain reachable / running.",
  async run(sandbox: Sandbox): Promise<ProbeOutcome> {
    const exec = await sandbox.executeTool({
      command_id: "redteam-A3-proc",
      tool: "proc.signal",
      params: { pid: 1, signal: "SIGTERM" },
      deadline_ms: 2_000,
    });
    // Pass conditions: tool got an error (operation not permitted, ESRCH,
    // or a guest-only PID 1 != host PID 1).
    if (exec.exit_code === 0) {
      return {
        passed: false,
        reason: `tool exited 0 — apparent PID 1 signal succeeded. stdout=${exec.stdout}`,
      };
    }
    return {
      passed: true,
      reason: `signal denied (exit=${exec.exit_code}, stderr=${exec.stderr})`,
      evidence: { exit_code: exec.exit_code },
    };
  },
};
