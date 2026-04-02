/**
 * God Mode Auth — secure credential resolution.
 *
 * Resolves API keys from the vault key resolver chain:
 * 1. Process env with _GM_ prefix (set by vault at session start)
 * 2. Process env with raw apiKeyName
 * 3. Returns null if not found (connector reports error)
 *
 * Also provides mTLS config helpers for BrainstormVM gRPC.
 */

import type { ConnectorConfig } from "./types.js";

/**
 * Resolve an API key for a connector.
 * The vault system puts resolved keys into process.env.
 */
export function resolveApiKey(
  connectorName: string,
  config: ConnectorConfig,
): string | null {
  return (
    process.env[`_GM_${connectorName.toUpperCase()}_KEY`] ??
    process.env[config.apiKeyName] ??
    null
  );
}

/**
 * Validate that all required credentials are available for a set of connectors.
 * Returns which connectors are missing credentials.
 */
export function validateCredentials(
  connectors: Array<{ name: string; config: ConnectorConfig }>,
): { valid: string[]; missing: Array<{ name: string; keyName: string }> } {
  const valid: string[] = [];
  const missing: Array<{ name: string; keyName: string }> = [];

  for (const { name, config } of connectors) {
    if (resolveApiKey(name, config)) {
      valid.push(name);
    } else {
      missing.push({ name, keyName: config.apiKeyName });
    }
  }

  return { valid, missing };
}
