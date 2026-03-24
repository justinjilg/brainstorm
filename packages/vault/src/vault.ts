import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { deriveKey, generateSalt, encrypt, decrypt, KDF_PARAMS } from './crypto.js';
import type { VaultFile, VaultPayload } from './types.js';

export class BrainstormVault {
  private keys: Map<string, string> | null = null;
  private derivedKey: Buffer | null = null;
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

    const payload: VaultPayload = {
      keys: {},
      metadata: {
        created_at: new Date().toISOString(),
        last_accessed: new Date().toISOString(),
        key_count: 0,
      },
    };

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

    mkdirSync(dirname(this.vaultPath), { recursive: true });
    writeFileSync(this.vaultPath, JSON.stringify(vaultFile, null, 2), 'utf-8');

    this.derivedKey = key;
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
    this.keys = new Map(Object.entries(payload.keys));
    this.lastAccessAt = Date.now();
  }

  /** Write encrypted vault to disk and clear keys from memory. */
  seal(): void {
    if (!this.keys || !this.derivedKey) return;

    const payload: VaultPayload = {
      keys: Object.fromEntries(this.keys),
      metadata: {
        created_at: this.readCreatedAt(),
        last_accessed: new Date().toISOString(),
        key_count: this.keys.size,
      },
    };

    const plaintext = Buffer.from(JSON.stringify(payload), 'utf-8');
    const salt = this.readSalt();
    const { nonce, ciphertext, tag } = encrypt(this.derivedKey, plaintext);

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

    writeFileSync(this.vaultPath, JSON.stringify(vaultFile, null, 2), 'utf-8');
    this.lock();
  }

  /** Get a key value. Returns null if not found or vault is locked/expired. */
  get(name: string): string | null {
    if (!this.isOpen()) return null;
    this.lastAccessAt = Date.now();
    return this.keys!.get(name) ?? null;
  }

  /** Set a key and write the vault to disk. */
  set(name: string, value: string): void {
    if (!this.keys || !this.derivedKey) throw new Error('Vault is locked');
    this.keys.set(name, value);
    this.lastAccessAt = Date.now();
    this.writeToDisk();
  }

  /** Delete a key and write the vault to disk. */
  delete(name: string): boolean {
    if (!this.keys || !this.derivedKey) throw new Error('Vault is locked');
    const existed = this.keys.delete(name);
    if (existed) this.writeToDisk();
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

  /** True if vault exists but keys are not in memory. */
  isLocked(): boolean {
    return this.exists() && !this.isOpen();
  }

  /** Re-encrypt vault with a new password. Vault must be open. */
  rotate(newPassword: string): void {
    if (!this.keys) throw new Error('Vault must be open to rotate');

    const salt = generateSalt();
    const key = deriveKey(newPassword, salt);

    const payload: VaultPayload = {
      keys: Object.fromEntries(this.keys),
      metadata: {
        created_at: this.readCreatedAt(),
        last_accessed: new Date().toISOString(),
        key_count: this.keys.size,
      },
    };

    const plaintext = Buffer.from(JSON.stringify(payload), 'utf-8');
    const { nonce, ciphertext, tag: authTag } = encrypt(key, plaintext);

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
      tag: authTag.toString('base64'),
    };

    writeFileSync(this.vaultPath, JSON.stringify(vaultFile, null, 2), 'utf-8');

    if (this.derivedKey) this.derivedKey.fill(0);
    this.derivedKey = key;
    this.lastAccessAt = Date.now();
  }

  /** Write current in-memory keys to disk without locking. */
  private writeToDisk(): void {
    if (!this.keys || !this.derivedKey) return;

    const payload: VaultPayload = {
      keys: Object.fromEntries(this.keys),
      metadata: {
        created_at: this.readCreatedAt(),
        last_accessed: new Date().toISOString(),
        key_count: this.keys.size,
      },
    };

    const plaintext = Buffer.from(JSON.stringify(payload), 'utf-8');
    const { nonce, ciphertext, tag } = encrypt(this.derivedKey, plaintext);

    const raw = readFileSync(this.vaultPath, 'utf-8');
    const existing: VaultFile = JSON.parse(raw);

    existing.nonce = nonce.toString('base64');
    existing.ciphertext = ciphertext.toString('base64');
    existing.tag = tag.toString('base64');

    writeFileSync(this.vaultPath, JSON.stringify(existing, null, 2), 'utf-8');
  }

  /** Read the salt from the on-disk vault file. */
  private readSalt(): Buffer {
    const raw = readFileSync(this.vaultPath, 'utf-8');
    const vaultFile: VaultFile = JSON.parse(raw);
    return Buffer.from(vaultFile.salt, 'base64');
  }

  /** Read created_at from the current vault (re-decrypt or use cached). */
  private readCreatedAt(): string {
    try {
      const raw = readFileSync(this.vaultPath, 'utf-8');
      const vaultFile: VaultFile = JSON.parse(raw);
      if (this.derivedKey) {
        const nonce = Buffer.from(vaultFile.nonce, 'base64');
        const ct = Buffer.from(vaultFile.ciphertext, 'base64');
        const tag = Buffer.from(vaultFile.tag, 'base64');
        const pt = decrypt(this.derivedKey, nonce, ct, tag);
        const payload: VaultPayload = JSON.parse(pt.toString('utf-8'));
        return payload.metadata.created_at;
      }
    } catch { /* fall through */ }
    return new Date().toISOString();
  }
}
