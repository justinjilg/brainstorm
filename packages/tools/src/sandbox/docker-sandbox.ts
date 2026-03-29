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

    try {
      const output = execFileSync(
        "docker",
        [
          "run",
          "-d",
          "--name",
          `brainstorm-sandbox-${Date.now()}`,
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
        exitCode = parseInt(codeStr, 10) || 0;
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
  if (path.startsWith(hostWorkspace)) {
    return path.replace(hostWorkspace, containerWorkspace);
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
