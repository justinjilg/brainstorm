import { keychainRead } from "./backends/keychain.js";

/** Keychain account name under which the vault master password is stored. */
export const VAULT_PASSWORD_ACCOUNT = "brainstorm-vault-master";

/**
 * Resolve the Brainstorm vault master password for NON-INTERACTIVE unlock
 * (desktop app, KAIROS daemon, CI) — no TTY, no `op`.
 *
 * Order:
 *   1. BRAINSTORM_VAULT_PASSWORD env var (explicit override / CI).
 *   2. macOS Keychain (the normal path — set once at bootstrap).
 *
 * Returns null when neither is present, so the caller can fall back to an
 * interactive prompt (only meaningful when a TTY exists).
 */
export function resolveVaultPassword(): string | null {
  const fromEnv = process.env.BRAINSTORM_VAULT_PASSWORD;
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  return keychainRead(VAULT_PASSWORD_ACCOUNT);
}
