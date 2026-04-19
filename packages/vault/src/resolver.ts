import type { BrainstormVault } from "./vault.js";
import { opRead, isOpAvailable } from "./backends/op-cli.js";
import { envRead } from "./backends/env.js";

export type PasswordPrompt = () => Promise<string>;

/**
 * Key resolver — tries vault → 1Password → env vars in order.
 * Lazy unlock: prompts for vault password on first access that needs a key.
 * Re-prompts on next access if the previous attempt failed (wrong password).
 */
export class KeyResolver {
  private vault: BrainstormVault | null;
  private promptPassword: PasswordPrompt | null;
  constructor(vault: BrainstormVault | null, promptPassword?: PasswordPrompt) {
    this.vault = vault;
    this.promptPassword = promptPassword ?? null;
  }

  /**
   * Get a key by name. Tries each backend in priority order:
   * 1. Local encrypted vault (lazy unlock on first access; re-prompts on failure)
   * 2. 1Password CLI (if op available)
   * 3. Environment variables
   */
  async get(name: string): Promise<string | null> {
    // 1. Vault — lazy unlock (re-prompts if previous attempt failed)
    if (this.vault?.exists()) {
      if (!this.vault.isOpen() && this.promptPassword) {
        try {
          const password = await this.promptPassword();
          this.vault.open(password);
        } catch (err: unknown) {
          // Preserve error type so user can distinguish wrong password from corrupt vault
          const msg = err instanceof Error ? err.message : String(err);
          process.stderr.write(
            `[vault] Unlock failed: ${msg} — falling back to 1Password/env for this key only\n`,
          );
        }
      }
      if (this.vault.isOpen()) {
        const value = this.vault.get(name);
        if (value) return value;
        // Key not in vault — safe to check other backends
      }
      // If vault exists but unlock failed, still try other backends
      // but the warning above makes the fallback visible
    }

    // 2. 1Password CLI (cached availability check)
    if (isOpAvailable()) {
      const value = opRead(name);
      if (value) return value;
    }

    // 3. Environment variables
    return envRead(name);
  }

  /** Get a key or throw if not found in any backend. */
  async getRequired(name: string): Promise<string> {
    const value = await this.get(name);
    if (!value) {
      const sources: string[] = [];
      if (this.vault?.exists()) sources.push("vault");
      if (isOpAvailable()) sources.push("1Password");
      sources.push("environment");
      throw new Error(`Key "${name}" not found in ${sources.join(", ")}`);
    }
    return value;
  }

  /** Report which backends are available. */
  status(): { vault: string; op: string; env: string } {
    const vaultStatus = !this.vault?.exists()
      ? "not initialized"
      : this.vault.isOpen()
        ? `unlocked (${this.vault.list().length} keys)`
        : "locked";

    return {
      vault: vaultStatus,
      op: isOpAvailable() ? "available" : "not available",
      env: "always available",
    };
  }
}
