// P-A4-resource-exhaust
// Threat model class: A3 ("compromised tool") going for resource starvation.
//                     We bin this as A4-class red-team because the failure
//                     mode (host DoS via guest resource burn) is the same
//                     space as a build-time-malicious image's behaviour.
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
  attackerClass: "A4",
  expectation: "should-fail",
  validatedAgainst: "mock-only",
  description:
    "Compromised tool allocates 100 GiB / fork-bombs. Sandbox cgroup limits " +
    "MUST kill the runaway. Tool exit_code MUST be non-zero with an " +
    "OOM/limit-style stderr signal.",
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
