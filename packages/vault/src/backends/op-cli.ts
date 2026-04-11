import { execFileSync } from "node:child_process";

/** Default 1Password vault name. Override via BRAINSTORM_OP_VAULT env var. */
const DEFAULT_OP_VAULT = "Dev Keys";

/**
 * Map env var names to 1Password item names.
 * Env vars use SCREAMING_SNAKE_CASE but 1Password items use human-readable names.
 */
const OP_ITEM_NAMES: Record<string, string> = {
  BRAINSTORM_API_KEY: "BrainstormRouter API Key",
  ANTHROPIC_API_KEY: "Anthropic API Key",
  OPENAI_API_KEY: "OpenAI API Key",
  GOOGLE_GENERATIVE_AI_API_KEY: "Gemini API Key",
  DEEPSEEK_API_KEY: "DeepSeek API Key",
  MOONSHOT_API_KEY: "Moonshot API Key",
  BRAINSTORM_ADMIN_KEY: "BrainstormRouter Admin Key",
  // God Mode connector keys
  BRAINSTORM_MSP_API_KEY: "BrainstormMSP God Mode Service Key",
};

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
const OP_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes (shorter to detect credential rotation faster)
const OP_FAILURE_TTL_MS = 60 * 1000; // 60 seconds for failed lookups (self-heal from transient errors)
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
  if (cached) {
    const ttl = cached.value === null ? OP_FAILURE_TTL_MS : OP_CACHE_TTL_MS;
    if (Date.now() - cached.fetchedAt < ttl) return cached.value;
  }

  try {
    const vault =
      vaultName ?? process.env.BRAINSTORM_OP_VAULT ?? DEFAULT_OP_VAULT;
    const itemName = OP_ITEM_NAMES[keyName] ?? keyName;
    const ref = `op://${vault}/${itemName}/credential`;
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
