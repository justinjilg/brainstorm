import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createLogger } from '@brainstorm/shared';

const log = createLogger('eval:test-verify');

/**
 * Run a vitest test file and return pass/fail.
 */
export function runTestFile(testFilePath: string): { ok: boolean; error?: string } {
  if (!existsSync(testFilePath)) {
    return { ok: false, error: `Test file not found: ${testFilePath}` };
  }

  try {
    execFileSync('npx', ['vitest', 'run', testFilePath, '--reporter=silent'], {
      timeout: 30000,
      stdio: 'pipe',
    });
    return { ok: true };
  } catch (error: any) {
    const stderr = error.stderr?.toString() ?? '';
    const stdout = error.stdout?.toString() ?? '';
    const msg = stderr || stdout || error.message;
    log.debug({ testFilePath, error: msg }, 'Test execution failed');
    return { ok: false, error: msg.slice(0, 500) };
  }
}
