// Standard mock tool handlers used by the probe battery against the
// MockSandbox. Each handler emulates the *defender* posture (deny the
// attack) so the probe expectations resolve to "passed".
//
// To verify the framework can also catch FAILURES, the test suite swaps
// in attacker-friendly handlers and asserts the runner records `passed:
// false` correctly.

import type { ToolExecution } from "@brainst0rm/sandbox";

import type { MockToolContext, MockToolHandler } from "./mock-sandbox.js";

/** Default defender posture: refuses everything except `noop`. */
export function defenderToolBattery(): Record<string, MockToolHandler> {
  return {
    noop: () => ok("", ""),
    "stdout.echo": (inv): ToolExecution => {
      // For the A7 probe: faithfully echo the requested content. This is
      // benign behaviour — emitting bytes is not the attack; promoting
      // those bytes to a protocol frame would be.
      const content =
        typeof inv.params.content === "string" ? inv.params.content : "";
      return ok(content, "");
    },
    "net.tcp_connect": (inv): ToolExecution => {
      return fail(
        13,
        "",
        `net.tcp_connect denied: host=${String(inv.params.host)} not on allowlist`,
      );
    },
    "fs.read": (inv): ToolExecution => {
      return fail(
        2,
        "",
        `fs.read denied: path=${String(inv.params.path)} not in mounted FS`,
      );
    },
    "proc.signal": (inv): ToolExecution => {
      return fail(
        1,
        "",
        `proc.signal denied: PID namespace isolation (target=${String(inv.params.pid)})`,
      );
    },
    "resource.alloc": (inv): ToolExecution => {
      const bytes = Number(inv.params.bytes ?? 0);
      // Cap at 64 MiB; anything larger gets refused.
      const CAP = 64 * 1024 * 1024;
      if (bytes > CAP) {
        return fail(
          137,
          "",
          `cgroup memory.max exceeded: requested=${bytes}B cap=${CAP}B (OOMKilled)`,
        );
      }
      return ok(`allocated ${bytes}B`, "");
    },
    "time.sleep": async (inv): Promise<ToolExecution> => {
      const ms = Number(inv.params.ms ?? 0);
      await new Promise((r) => setTimeout(r, ms));
      return ok(`slept ${ms}ms`, "");
    },
    "vsock.poison": (inv): ToolExecution => {
      const mode = String(inv.params.mode ?? "unknown");
      // Defender posture: every poison shape gets rejected with non-zero.
      return fail(2, "", `vsock framing rejected: mode=${mode}`);
    },
  };
}

/**
 * Attacker-friendly battery: makes EVERY probe's attack succeed. Used
 * exclusively in the test suite to prove the runner reports "failed"
 * outcomes faithfully.
 */
export function attackerToolBattery(): Record<string, MockToolHandler> {
  const noopFromCtx = (_inv: unknown, _ctx: MockToolContext): ToolExecution =>
    ok("", "");
  return {
    noop: noopFromCtx,
    "stdout.echo": (inv): ToolExecution => {
      // This handler "leaks" by promoting stdout to a structured field.
      const content =
        typeof inv.params.content === "string" ? inv.params.content : "";
      return {
        exit_code: 0,
        stdout: "", // forge dropped — bad
        stderr: "",
        // The test will assert this DOES NOT escape ToolExecution shape.
      } as ToolExecution & { type?: string; payload?: unknown };
    },
    "net.tcp_connect": () => ok("connected", ""),
    "fs.read": () => ok("BSM_HOST_SECRET_MARKER_DO_NOT_LEAK\n", ""),
    "proc.signal": () => ok("signaled pid 1", ""),
    "resource.alloc": () => ok("allocated", ""),
    "time.sleep": () => ok("done", ""),
    "vsock.poison": () => ok("accepted", ""),
  };
}

function ok(stdout: string, stderr: string): ToolExecution {
  return { exit_code: 0, stdout, stderr };
}

function fail(
  exit_code: number,
  stdout: string,
  stderr: string,
): ToolExecution {
  return { exit_code, stdout, stderr };
}
