import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { deriveKey, generateSalt, encrypt, decrypt, KDF_PARAMS } from './crypto.js';
import type { VaultFile, VaultPayload } from './types.js';

export class BrainstormVault {
  private keys: Map<string, string> | null = null;
  private derivedKey: Buffer | null = null;
  private cachedSalt: Buffer | null = null;
  private cachedCreatedAt: string | null = null;
  private lastAccessAt = 0;
  private autoLockMs: number;
  private readonly vaultPath: string;

  constructor(vaultPath: string, autoLockMinutes = 30) {
    this.vaultPath = vaultPath;
    this.autoLockMs = autoLockMinutes > 0 ? autoLockMinutes * 60 * 1000 : 0;
  }

  /** Check if a vault file exists on disk. */
  exists(): boolean {
    return existsSync(this.vaultPath);
  }

  /** Create a new vault with a master password. Throws if vault already exists. */
  async init(password: string): Promise<void> {
    if (this.exists()) throw new Error('Vault already exists. Use rotate to change password.');

    const salt = generateSalt();
    const key = deriveKey(password, salt);
    const createdAt = new Date().toISOString();

    const payload: VaultPayload = {
      keys: {},
      metadata: {
        created_at: createdAt,
        last_accessed: new Date().toISOString(),
        key_count: 0,
      },
    };

    mkdirSync(dirname(this.vaultPath), { recursive: true, mode: 0o700 });
    this.persistVaultFile(key, salt, payload);

    this.derivedKey = key;
    this.cachedSalt = salt;
    this.cachedCreatedAt = createdAt;
    this.keys = new Map(Object.entries(payload.keys));
    this.lastAccessAt = Date.now();
  }

  /** Decrypt the vault and hold keys in memory. */
  open(password: string): void {
    if (!this.exists()) throw new Error('No vault found. Run `brainstorm vault init` first.');

    const raw = readFileSync(this.vaultPath, 'utf-8');
    const vaultFile: VaultFile = JSON.parse(raw);

    if (vaultFile.version !== 1) throw new Error(`Unsupported vault version: ${vaultFile.version}`);

    const salt = Buffer.from(vaultFile.salt, 'base64');
    const key = deriveKey(password, salt);

    const nonce = Buffer.from(vaultFile.nonce, 'base64');
    const ciphertext = Buffer.from(vaultFile.ciphertext, 'base64');
    const tag = Buffer.from(vaultFile.tag, 'base64');

    const plaintext = decrypt(key, nonce, ciphertext, tag);
    const payload: VaultPayload = JSON.parse(plaintext.toString('utf-8'));

    this.derivedKey = key;
    this.cachedSalt = salt;
    this.cachedCreatedAt = payload.metadata.created_at;
    this.keys = new Map(Object.entries(payload.keys));
    this.lastAccessAt = Date.now();
  }

  /** Write encrypted vault to disk, then clear keys and derived key from memory. */
  seal(): void {
    if (!this.keys || !this.derivedKey || !this.cachedSalt) return;

    const payload: VaultPayload = {
      keys: Object.fromEntries(this.keys),
      metadata: {
        created_at: this.cachedCreatedAt ?? new Date().toISOString(),
        last_accessed: new Date().toISOString(),
        key_count: this.keys.size,
      },
    };

    this.persistVaultFile(this.derivedKey, this.cachedSalt, payload);
    this.lock();
  }

  /** Get a key value. Returns null if not found or vault is locked/auto-lock expired. */
  get(name: string): string | null {
    if (!this.isOpen()) return null;
    this.lastAccessAt = Date.now();
    return this.keys!.get(name) ?? null;
  }

  /** Set a key and write the vault to disk. */
  set(name: string, value: string): void {
    if (!this.keys || !this.derivedKey || !this.cachedSalt) throw new Error('Vault is locked');
    this.keys.set(name, value);
    this.lastAccessAt = Date.now();
    this.writePayload();
  }

  /** Delete a key and write the vault to disk. */
  delete(name: string): boolean {
    if (!this.keys || !this.derivedKey || !this.cachedSalt) throw new Error('Vault is locked');
    const existed = this.keys.delete(name);
    if (existed) this.writePayload();
    return existed;
  }

  /** List all key names (not values). */
  list(): string[] {
    if (!this.keys) return [];
    return Array.from(this.keys.keys());
  }

  /** Clear derived key and decrypted keys from memory. */
  lock(): void {
    if (this.derivedKey) this.derivedKey.fill(0);
    this.derivedKey = null;
    this.keys = null;
    this.cachedSalt = null;
    this.cachedCreatedAt = null;
    this.lastAccessAt = 0;
  }

  /** True if vault is decrypted and auto-lock hasn't expired. */
  isOpen(): boolean {
    if (!this.keys || !this.derivedKey) return false;
    if (this.autoLockMs > 0 && Date.now() - this.lastAccessAt > this.autoLockMs) {
      this.lock();
      return false;
    }
    return true;
  }

  /** True if vault file exists but keys are not in memory. */
  isLocked(): boolean {
    return this.exists() && !this.isOpen();
  }

  /** Re-encrypt vault with a new password and salt. Vault must be open. */
  rotate(newPassword: string): void {
    if (!this.keys) throw new Error('Vault must be open to rotate');

    const salt = generateSalt();
    const key = deriveKey(newPassword, salt);

    const payload: VaultPayload = {
      keys: Object.fromEntries(this.keys),
      metadata: {
        created_at: this.cachedCreatedAt ?? new Date().toISOString(),
        last_accessed: new Date().toISOString(),
        key_count: this.keys.size,
      },
    };

    this.persistVaultFile(key, salt, payload);

    if (this.derivedKey) this.derivedKey.fill(0);
    this.derivedKey = key;
    this.cachedSalt = salt;
    this.lastAccessAt = Date.now();
  }

  /**
   * Encrypt payload and write to disk atomically (write-to-temp-then-rename).
   * File permissions set to 0o600 (owner read/write only).
   */
  private persistVaultFile(key: Buffer, salt: Buffer, payload: VaultPayload): void {
    const plaintext = Buffer.from(JSON.stringify(payload), 'utf-8');
    const { nonce, ciphertext, tag } = encrypt(key, plaintext);

    const vaultFile: VaultFile = {
      version: 1,
      kdf: 'argon2id',
      kdf_params: {
        memory: KDF_PARAMS.memory,
        iterations: KDF_PARAMS.iterations,
        parallelism: KDF_PARAMS.parallelism,
      },
      salt: salt.toString('base64'),
      nonce: nonce.toString('base64'),
      ciphertext: ciphertext.toString('base64'),
      tag: tag.toString('base64'),
    };

    const tempPath = this.vaultPath + '.tmp';
    writeFileSync(tempPath, JSON.stringify(vaultFile, null, 2), { mode: 0o600 });
    renameSync(tempPath, this.vaultPath);
  }

  /** Write current in-memory keys to disk without locking. */
  private writePayload(): void {
    if (!this.keys || !this.derivedKey || !this.cachedSalt) return;

    const payload: VaultPayload = {
      keys: Object.fromEntries(this.keys),
      metadata: {
        created_at: this.cachedCreatedAt ?? new Date().toISOString(),
        last_accessed: new Date().toISOString(),
        key_count: this.keys.size,
      },
    };

    this.persistVaultFile(this.derivedKey, this.cachedSalt, payload);
  }
}
