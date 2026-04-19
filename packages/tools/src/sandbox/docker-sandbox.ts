/**
 * Docker Sandbox — isolated execution environment for shell commands.
 *
 * Routes shell commands to a Docker container instead of the host.
 * Path translation maps between host workspace and container /workspace/.
 *
 * Uses execFileSync exclusively (no shell injection risk).
 */

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

export interface SandboxConfig {
  image: string;
  hostWorkspace: string;
  containerWorkspace: string;
  timeout: number;
}

export interface SandboxExecResult {
  output: string;
  exitCode: number;
  durationMs: number;
}

const DEFAULT_CONFIG: Partial<SandboxConfig> = {
  image: "node:22-slim",
  containerWorkspace: "/workspace",
  timeout: 120000,
};

/** Generate per-invocation sentinel to prevent output spoofing. */
function makeSentinel(): string {
  return `,,BRAINSTORM_EXIT_${randomUUID().replace(/-/g, "")},,`;
}

export class DockerSandbox {
  private config: SandboxConfig;
  private containerId: string | null = null;

  constructor(config: Partial<SandboxConfig> & { hostWorkspace: string }) {
    this.config = { ...DEFAULT_CONFIG, ...config } as SandboxConfig;
  }

  static isAvailable(): boolean {
    try {
      execFileSync("docker", ["info"], {
        encoding: "utf-8",
        timeout: 5000,
        stdio: ["ignore", "pipe", "pipe"],
      });
      return true;
    } catch {
      return false;
    }
  }

  start(): void {
    if (this.containerId) return;

    // Hardening flags — see v9 assessment's Attacker finding. Pre-fix,
    // `container` mode spawned a privileged root container with bridge
    // networking and no resource limits, so a compromised agent inside
    // could (a) exfiltrate via any outbound protocol, (b) fork-bomb
    // the host, (c) trash files via root uid 0, (d) gain new
    // privileges through setuid binaries. Each flag below closes
    // exactly one of those paths; the bind mount is deliberately
    // kept read-write because workspace-editing IS the product and
    // the container is already trust-scoped to the user's own code.
    try {
      const output = execFileSync(
        "docker",
        [
          "run",
          "-d",
          "--name",
          // randomUUID over Date.now() kills the predictable-name
          // enumeration the v9 Attacker flagged.
          `brainstorm-sandbox-${randomUUID()}`,
          // No network by default. Agent-generated `curl`/`nc`/DNS
          // exfiltration can't leave the container. If a specific
          // workflow needs network (e.g. `npm install`), the caller
          // should explicitly construct a network-enabled sandbox
          // — not paper over a silent default.
          "--network=none",
          // Drop to unprivileged UID. Typical image has uid 1000
          // available; if not, the container fails fast (better than
          // silent root).
          "--user=1000:1000",
          // Drop every Linux capability. A shell doesn't need
          // CAP_NET_ADMIN, CAP_SYS_PTRACE, etc.
          "--cap-drop=ALL",
          // Block setuid/setgid privilege escalation via the kernel
          // no_new_privs bit.
          "--security-opt=no-new-privileges",
          // Hard ceilings for resource exhaustion. Values picked to
          // match a typical CI box — a real workload may need
          // tuning via DockerSandbox config.
          "--memory=2g",
          "--cpus=2",
          "--pids-limit=256",
          // Workspace mount stays read-write because file edits are
          // the core use case. A compromised agent still can't
          // escape the mount — everything outside /workspace is
          // inaccessible (thanks --cap-drop + --user + --read-only
          // elsewhere would close it entirely if writes ever move to
          // tmpfs).
          "-v",
          `${this.config.hostWorkspace}:${this.config.containerWorkspace}`,
          "-w",
          this.config.containerWorkspace,
          this.config.image,
          "tail",
          "-f",
          "/dev/null",
        ],
        {
          encoding: "utf-8",
          timeout: 30000,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );

      this.containerId = output.trim();
    } catch (err: any) {
      throw new Error(`Failed to start Docker sandbox: ${err.message}`);
    }
  }

  exec(command: string): SandboxExecResult {
    if (!this.containerId) {
      throw new Error("Sandbox not started. Call start() first.");
    }

    const start = Date.now();

    try {
      const sentinel = makeSentinel();
      const wrappedCommand = `${command}; echo "${sentinel}$?"`;

      const output = execFileSync(
        "docker",
        ["exec", this.containerId, "/bin/sh", "-c", wrappedCommand],
        {
          encoding: "utf-8",
          timeout: this.config.timeout,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );

      const durationMs = Date.now() - start;

      const sentinelIdx = output.lastIndexOf(sentinel);
      let exitCode = 0;
      let cleanOutput = output;

      if (sentinelIdx >= 0) {
        const codeStr = output.slice(sentinelIdx + sentinel.length).trim();
        const parsed = parseInt(codeStr, 10);
        exitCode = Number.isNaN(parsed) ? 1 : parsed;
        cleanOutput = output.slice(0, sentinelIdx).trimEnd();
      }

      cleanOutput = maskHostPaths(
        cleanOutput,
        this.config.hostWorkspace,
        this.config.containerWorkspace,
      );

      return { output: cleanOutput, exitCode, durationMs };
    } catch (err: any) {
      return {
        output: err.stderr ?? err.message,
        exitCode: err.status ?? 1,
        durationMs: Date.now() - start,
      };
    }
  }

  stop(): void {
    if (!this.containerId) return;

    try {
      execFileSync("docker", ["rm", "-f", this.containerId], {
        encoding: "utf-8",
        timeout: 10000,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      /* best effort */
    }

    this.containerId = null;
  }

  isRunning(): boolean {
    return this.containerId !== null;
  }

  getContainerId(): string | null {
    return this.containerId;
  }
}

const SAFE_COMMANDS = [
  /^cat\b/,
  /^head\b/,
  /^tail\b/,
  /^wc\b/,
  /^echo\b/,
  /^ls\b/,
  /^pwd\b/,
  /^which\b/,
  /^whoami\b/,
  /^grep\b/,
  /^rg\b/,
  /^find\b/,
  /^fd\b/,
  /^git\s+(status|diff|log|show|blame|branch)\b/,
  /^node\s+--version/,
  /^npm\s+--version/,
];

export function isSafeCommand(command: string): boolean {
  const trimmed = command.trim();
  return SAFE_COMMANDS.some((pattern) => pattern.test(trimmed));
}

export function translatePath(
  path: string,
  hostWorkspace: string,
  containerWorkspace: string,
): string {
  if (path.startsWith(hostWorkspace + "/") || path === hostWorkspace) {
    // Function-form replacement — containerWorkspace could
    // contain `$` and String.replace's string form would interpret
    // $1/$&/etc. as backreferences, corrupting the translated path.
    // Default container workspace is "/workspace" (no $), but the
    // constructor accepts overrides.
    return path.replace(hostWorkspace, () => containerWorkspace);
  }
  return path;
}

function maskHostPaths(
  output: string,
  hostWorkspace: string,
  containerWorkspace: string,
): string {
  return output.replaceAll(hostWorkspace, containerWorkspace);
}
