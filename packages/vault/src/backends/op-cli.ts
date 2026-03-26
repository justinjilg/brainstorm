import { execFileSync } from "node:child_process";

/** Default 1Password vault name. Override via config: vault.op_vault_name */
const DEFAULT_OP_VAULT = "Personal";

/** Cached result of op availability check (stable for process lifetime). */
let opAvailableCache: boolean | null = null;

/** Check if `op` CLI binary is available and a service account token is set. */
export function isOpAvailable(): boolean {
  if (opAvailableCache !== null) return opAvailableCache;
  if (!process.env.OP_SERVICE_ACCOUNT_TOKEN) {
    opAvailableCache = false;
    return false;
  }
  try {
    execFileSync("op", ["--version"], { timeout: 3000, stdio: "pipe" });
    opAvailableCache = true;
  } catch {
    opAvailableCache = false;
  }
  return opAvailableCache;
}

/** TTL cache for op read results — avoids shelling out on every call. */
const OP_CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes
const opCache = new Map<string, { value: string | null; fetchedAt: number }>();

/**
 * Read a credential from 1Password via `op read`.
 * Maps key names to 1Password item paths:
 *   BRAINSTORM_API_KEY → op://vaultName/BRAINSTORM_API_KEY/credential
 *
 * Results are cached for 30 minutes to avoid repeated subprocess calls.
 */
export function opRead(keyName: string, vaultName?: string): string | null {
  if (!isOpAvailable()) return null;

  const cacheKey = `${vaultName ?? "_default"}:${keyName}`;
  const cached = opCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < OP_CACHE_TTL_MS) {
    return cached.value;
  }

  try {
    const vault =
      vaultName ?? process.env.BRAINSTORM_OP_VAULT ?? DEFAULT_OP_VAULT;
    const ref = `op://${vault}/${keyName}/credential`;
    const value = execFileSync("op", ["read", ref], {
      timeout: 10000,
      stdio: ["pipe", "pipe", "pipe"],
    })
      .toString()
      .trim();
    const result = value || null;
    opCache.set(cacheKey, { value: result, fetchedAt: Date.now() });
    return result;
  } catch {
    opCache.set(cacheKey, { value: null, fetchedAt: Date.now() });
    return null;
  }
}
