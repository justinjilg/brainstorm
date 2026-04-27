// P-A2-fs-escape
// Threat model class: A3 inside the sandbox trying to read host FS. We tag
//                     A2 because the observable behaviour ("path traversal
//                     to host secrets") is the network-style outsider's
//                     desired outcome.
//
// Mechanics: the tool tries to read /etc/shadow on the host. Real CHV
// gives the guest a private rootfs — host /etc/shadow simply isn't
// reachable. The probe passes iff the read fails (exit != 0) AND the
// returned stdout does not contain the magic host marker the harness
// embeds at "host /etc/shadow".
//
// Honesty: validated against mock only. The mock guarantees the marker
// is unreachable through the tool API. Real CHV semantics require a
// real rootfs separation test.

import type { Sandbox } from "@brainst0rm/sandbox";

import type { Probe, ProbeOutcome } from "../types.js";

export const HOST_SECRET_MARKER = "BSM_HOST_SECRET_MARKER_DO_NOT_LEAK";

export const pA2FsEscape: Probe = {
  name: "P-A2-fs-escape",
  attackerClass: "A2",
  expectation: "should-fail",
  validatedAgainst: "mock-only",
  description:
    "Compromised tool reads host /etc/shadow via path traversal. Sandbox " +
    "MUST present a private rootfs; host secret marker MUST NOT appear in " +
    "tool stdout/stderr.",
  async run(sandbox: Sandbox): Promise<ProbeOutcome> {
    const exec = await sandbox.executeTool({
      command_id: "redteam-A2-fs",
      tool: "fs.read",
      params: { path: "/etc/shadow" },
      deadline_ms: 2_000,
    });
    const leaked =
      exec.stdout.includes(HOST_SECRET_MARKER) ||
      exec.stderr.includes(HOST_SECRET_MARKER);
    if (leaked) {
      return {
        passed: false,
        reason: "host secret marker appeared in tool output — FS escape!",
        evidence: { exit_code: exec.exit_code, stdout: exec.stdout },
      };
    }
    if (exec.exit_code === 0) {
      return {
        passed: false,
        reason: `read succeeded with exit 0 (marker absent but read should not succeed)`,
        evidence: { exit_code: exec.exit_code, stdout: exec.stdout },
      };
    }
    return {
      passed: true,
      reason: `read denied (exit=${exec.exit_code}); marker not present`,
      evidence: { exit_code: exec.exit_code },
    };
  },
};
