// P-A1-net-egress
// Threat model class: A3 (compromised tool inside sandbox) attempting
//                     A1-style outbound traffic — but the *sandbox* boundary
//                     is the defender (G3 in plan §2). We tag this probe
//                     against A1 because the captured intent is "outbound
//                     network egress" which in the threat model is the
//                     observable of an outsider-with-credentials class.
//
// Mechanics: the probe asks the sandbox to run a tool whose payload tries
// to open an arbitrary outbound TCP connection (to a non-allowlisted host).
// The defender posture is deny-by-default proxy-only. So:
//   - On a real sandbox: the in-guest TCP attempt MUST fail OR be visible
//     in the host-side audit log as a denied connect attempt.
//   - On the mock: the tool runs an in-process simulator that the test
//     harness configures to "fail closed" — we assert the simulator
//     refused to connect and the tool got a non-zero exit code.
//
// Honesty: validated against mock only. Real CHV egress block needs the
// in-guest seccomp-bpf + agent-mediated proxy machinery, none of which is
// in this checkout.

import type { Sandbox } from "@brainst0rm/sandbox";

import type { Probe, ProbeOutcome } from "../types.js";

export const pA1NetEgress: Probe = {
  name: "P-A1-net-egress",
  attackerClass: "A1",
  expectation: "should-fail",
  validatedAgainst: "mock-only",
  description:
    "Compromised tool attempts arbitrary outbound TCP. Sandbox boundary " +
    "should deny (G3 deny-by-default proxy). Tool exit_code MUST be non-zero " +
    "AND no host-observable connect should succeed.",
  async run(sandbox: Sandbox): Promise<ProbeOutcome> {
    const exec = await sandbox.executeTool({
      command_id: "redteam-A1-egress",
      tool: "net.tcp_connect",
      params: { host: "evil.example.invalid", port: 4242 },
      deadline_ms: 2_000,
    });
    if (exec.exit_code === 0) {
      return {
        passed: false,
        reason: `tool exited 0 — outbound TCP appears to have succeeded. stdout=${truncate(exec.stdout)}`,
        evidence: { exit_code: exec.exit_code, stdout: exec.stdout },
      };
    }
    return {
      passed: true,
      reason: `tool exit_code=${exec.exit_code}, stderr=${truncate(exec.stderr)}`,
      evidence: { exit_code: exec.exit_code, stderr: exec.stderr },
    };
  },
};

function truncate(s: string, n = 200): string {
  return s.length > n ? s.slice(0, n) + "..." : s;
}
