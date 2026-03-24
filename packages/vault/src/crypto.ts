import { argon2id } from '@noble/hashes/argon2';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import type { EncryptResult } from './types.js';

/** Default Argon2id parameters — OWASP recommended for interactive login. */
export const KDF_PARAMS = {
  memory: 65536,    // 64 MB
  iterations: 3,
  parallelism: 4,
  keyLength: 32,    // 256 bits for AES-256
} as const;

/** Derive a 256-bit key from a password using Argon2id. */
export function deriveKey(password: string, salt: Uint8Array): Buffer {
  const derived = argon2id(new TextEncoder().encode(password), salt, {
    m: KDF_PARAMS.memory,
    t: KDF_PARAMS.iterations,
    p: KDF_PARAMS.parallelism,
    dkLen: KDF_PARAMS.keyLength,
  });
  return Buffer.from(derived);
}

/** Generate a cryptographically random salt (32 bytes). */
export function generateSalt(): Buffer {
  return randomBytes(32);
}

/** Encrypt plaintext with AES-256-GCM. */
export function encrypt(key: Buffer, plaintext: Buffer): EncryptResult {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { nonce, ciphertext, tag };
}

/** Decrypt ciphertext with AES-256-GCM. Throws on tampered data. */
export function decrypt(key: Buffer, nonce: Buffer, ciphertext: Buffer, tag: Buffer): Buffer {
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}
