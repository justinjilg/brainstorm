/**
 * ACP-lite — External Agent Invocation.
 *
 * CLI-to-CLI bridge: invoke Claude Code, Codex CLI, or other AI assistants
 * as external agents. Budget-guarded child process execution.
 *
 * Inspired by DeerFlow RFC #1296 and Augment Intent BYOA.
 */

import { execFileSync } from "node:child_process";

export interface ExternalAgentConfig {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  timeout?: number;
}

export interface ExternalAgentResult {
  output: string;
  exitCode: number;
  durationMs: number;
}

/**
 * Invoke an external agent CLI with a task prompt.
 * The prompt is passed as the last argument.
 */
export function invokeExternalAgent(
  config: ExternalAgentConfig,
  task: string,
): ExternalAgentResult {
  const start = Date.now();
  const args = [...(config.args ?? []), task];
  const timeout = config.timeout ?? 120_000;

  try {
    const output = execFileSync(config.command, args, {
      encoding: "utf-8",
      timeout,
      env: { ...process.env, ...config.env },
      stdio: ["ignore", "pipe", "pipe"],
      cwd: process.cwd(),
    });

    return {
      output: output.trim(),
      exitCode: 0,
      durationMs: Date.now() - start,
    };
  } catch (err: any) {
    return {
      output: err.stdout?.toString() ?? err.message,
      exitCode: err.status ?? 1,
      durationMs: Date.now() - start,
    };
  }
}
