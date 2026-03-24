import { execFileSync } from 'node:child_process';

/** Default 1Password vault name for key lookups. */
const OP_VAULT = 'Dev Keys';

/** Check if `op` CLI is available and authenticated. */
export function isOpAvailable(): boolean {
  if (!process.env.OP_SERVICE_ACCOUNT_TOKEN) return false;
  try {
    execFileSync('op', ['--version'], { timeout: 3000, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Read a credential from 1Password via `op read`.
 * Maps key names to 1Password item paths:
 *   BRAINSTORM_API_KEY → op://Dev Keys/BRAINSTORM_API_KEY/credential
 */
export function opRead(keyName: string): string | null {
  if (!isOpAvailable()) return null;
  try {
    const ref = `op://${OP_VAULT}/${keyName}/credential`;
    const value = execFileSync('op', ['read', ref], {
      timeout: 10000,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    }).toString().trim();
    return value || null;
  } catch {
    return null;
  }
}
