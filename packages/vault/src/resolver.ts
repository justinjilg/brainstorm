import type { BrainstormVault } from './vault.js';
import { opRead, isOpAvailable } from './backends/op-cli.js';
import { envRead } from './backends/env.js';

export type PasswordPrompt = () => Promise<string>;

/**
 * Key resolver — tries vault → 1Password → env vars in order.
 * Lazy unlock: prompts for vault password on first access, not at startup.
 */
export class KeyResolver {
  private vault: BrainstormVault | null;
  private promptPassword: PasswordPrompt | null;
  private unlockAttempted = false;

  constructor(vault: BrainstormVault | null, promptPassword?: PasswordPrompt) {
    this.vault = vault;
    this.promptPassword = promptPassword ?? null;
  }

  /**
   * Get a key by name. Tries each backend in priority order:
   * 1. Local encrypted vault (lazy unlock on first access)
   * 2. 1Password CLI (if op available)
   * 3. Environment variables
   */
  async get(name: string): Promise<string | null> {
    // 1. Vault — lazy unlock
    if (this.vault?.exists()) {
      if (!this.vault.isOpen() && !this.unlockAttempted && this.promptPassword) {
        this.unlockAttempted = true;
        try {
          const password = await this.promptPassword();
          this.vault.open(password);
        } catch {
          // Wrong password or user cancelled — fall through to other backends
        }
      }
      if (this.vault.isOpen()) {
        const value = this.vault.get(name);
        if (value) return value;
      }
    }

    // 2. 1Password CLI
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
      const sources = ['vault', isOpAvailable() ? '1Password' : null, 'environment'].filter(Boolean).join(', ');
      throw new Error(`Key "${name}" not found in ${sources}`);
    }
    return value;
  }

  /** Report which backends are available. */
  status(): { vault: string; op: string; env: string } {
    const vaultStatus = !this.vault?.exists()
      ? 'not initialized'
      : this.vault.isOpen()
        ? `unlocked (${this.vault.list().length} keys)`
        : 'locked';

    return {
      vault: vaultStatus,
      op: isOpAvailable() ? 'available' : 'not available',
      env: 'always available',
    };
  }
}
