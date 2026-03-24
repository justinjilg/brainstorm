import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createLogger } from '@brainstorm/shared';

const log = createLogger('eval:ts-verify');

/**
 * Check if a TypeScript file compiles without errors.
 * Uses tsc --noEmit with a minimal config.
 */
export function verifyTypeScriptCompiles(filePath: string): { ok: boolean; error?: string } {
  if (!existsSync(filePath)) {
    return { ok: false, error: `File not found: ${filePath}` };
  }

  try {
    execFileSync('npx', ['tsc', '--noEmit', '--strict', '--target', 'ES2022', '--module', 'ESNext', '--moduleResolution', 'bundler', filePath], {
      timeout: 15000,
      stdio: 'pipe',
    });
    return { ok: true };
  } catch (error: any) {
    const stderr = error.stderr?.toString() ?? '';
    const stdout = error.stdout?.toString() ?? '';
    const msg = stderr || stdout || error.message;
    log.debug({ filePath, error: msg }, 'TypeScript compilation failed');
    return { ok: false, error: msg.slice(0, 500) };
  }
}
