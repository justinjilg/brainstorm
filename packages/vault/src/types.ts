/** On-disk vault file format (JSON). */
export interface VaultFile {
  version: 1;
  kdf: 'argon2id';
  kdf_params: {
    memory: number;   // KiB (65536 = 64 MB)
    iterations: number;
    parallelism: number;
  };
  salt: string;       // base64, 32 bytes
  nonce: string;      // base64, 12 bytes
  ciphertext: string; // base64, encrypted JSON payload
  tag: string;        // base64, 16 bytes (GCM auth tag)
}

/** Decrypted vault payload. */
export interface VaultPayload {
  keys: Record<string, string>;
  metadata: {
    created_at: string;
    last_accessed: string;
    key_count: number;
  };
}

/** Vault configuration from config.toml. */
export interface VaultConfig {
  path: string;                // default: ~/.brainstorm/vault.enc
  auto_lock_minutes: number;   // default: 30, 0 = disabled
}

/** Result of an encrypt operation. */
export interface EncryptResult {
  nonce: Buffer;
  ciphertext: Buffer;
  tag: Buffer;
}
