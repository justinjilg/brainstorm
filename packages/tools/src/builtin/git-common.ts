/**
 * Shared git command helper used by all git tools.
 * Centralizes exec options and error handling.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const DEFAULT_TIMEOUT = 30_000;
const MAX_OUTPUT = 1_000_000; // 1MB max

export interface GitResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Run a git command with consistent options.
 * Returns structured result instead of throwing on non-zero exit.
 */
export async function runGit(
  args: string[],
  cwd?: string,
  timeout = DEFAULT_TIMEOUT,
): Promise<GitResult> {
  try {
    const { stdout, stderr } = await execFileAsync('git', args, {
      cwd: cwd ?? process.cwd(),
      timeout,
      maxBuffer: MAX_OUTPUT,
    });
    return { stdout, stderr, exitCode: 0 };
  } catch (err: any) {
    return {
      stdout: err.stdout ?? '',
      stderr: err.stderr ?? err.message,
      exitCode: err.code ?? 1,
    };
  }
}
