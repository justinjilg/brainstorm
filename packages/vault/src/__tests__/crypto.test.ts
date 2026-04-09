import { describe, it, expect } from "vitest";
import {
  deriveKey,
  generateSalt,
  encrypt,
  decrypt,
  KDF_PARAMS,
} from "../crypto.js";

describe("Key Derivation (Argon2id)", () => {
  it("derives a 32-byte key from password and salt", () => {
    const salt = generateSalt();
    const key = deriveKey("test-password", salt);
    expect(key).toBeInstanceOf(Buffer);
    expect(key.length).toBe(32);
  });

  it("same password + salt produces same key", () => {
    const salt = generateSalt();
    const key1 = deriveKey("same-password", salt);
    const key2 = deriveKey("same-password", salt);
    expect(key1.equals(key2)).toBe(true);
  });

  it("different passwords produce different keys", () => {
    const salt = generateSalt();
    const key1 = deriveKey("password-1", salt);
    const key2 = deriveKey("password-2", salt);
    expect(key1.equals(key2)).toBe(false);
  });

  it("different salts produce different keys", () => {
    const salt1 = generateSalt();
    const salt2 = generateSalt();
    const key1 = deriveKey("same-password", salt1);
    const key2 = deriveKey("same-password", salt2);
    expect(key1.equals(key2)).toBe(false);
  });

  it("KDF params match OWASP recommendations", () => {
    expect(KDF_PARAMS.memory).toBeGreaterThanOrEqual(65536);
    expect(KDF_PARAMS.iterations).toBeGreaterThanOrEqual(3);
    expect(KDF_PARAMS.keyLength).toBe(32);
  });
});

describe("generateSalt", () => {
  it("produces 32-byte buffer", () => {
    const salt = generateSalt();
    expect(salt).toBeInstanceOf(Buffer);
    expect(salt.length).toBe(32);
  });

  it("produces unique salts", () => {
    const salt1 = generateSalt();
    const salt2 = generateSalt();
    expect(salt1.equals(salt2)).toBe(false);
  });
});

describe("AES-256-GCM Encrypt/Decrypt", () => {
  it("encrypts and decrypts a message", () => {
    const key = deriveKey("test-password", generateSalt());
    const plaintext = Buffer.from("Hello, World!");
    const { nonce, ciphertext, tag } = encrypt(key, plaintext);
    const decrypted = decrypt(key, nonce, ciphertext, tag);
    expect(decrypted.toString()).toBe("Hello, World!");
  });

  it("ciphertext differs from plaintext", () => {
    const key = deriveKey("test-password", generateSalt());
    const plaintext = Buffer.from("secret data");
    const { ciphertext } = encrypt(key, plaintext);
    expect(ciphertext.equals(plaintext)).toBe(false);
  });

  it("nonce is 12 bytes", () => {
    const key = deriveKey("test-password", generateSalt());
    const { nonce } = encrypt(key, Buffer.from("test"));
    expect(nonce.length).toBe(12);
  });

  it("tag is 16 bytes", () => {
    const key = deriveKey("test-password", generateSalt());
    const { tag } = encrypt(key, Buffer.from("test"));
    expect(tag.length).toBe(16);
  });

  it("detects tampered ciphertext", () => {
    const key = deriveKey("test-password", generateSalt());
    const { nonce, ciphertext, tag } = encrypt(key, Buffer.from("test"));
    // Tamper with ciphertext
    ciphertext[0] ^= 0xff;
    expect(() => decrypt(key, nonce, ciphertext, tag)).toThrow();
  });

  it("detects tampered tag", () => {
    const key = deriveKey("test-password", generateSalt());
    const { nonce, ciphertext, tag } = encrypt(key, Buffer.from("test"));
    // Tamper with tag
    tag[0] ^= 0xff;
    expect(() => decrypt(key, nonce, ciphertext, tag)).toThrow();
  });

  it("wrong key fails to decrypt", () => {
    const salt = generateSalt();
    const key1 = deriveKey("right-password", salt);
    const key2 = deriveKey("wrong-password", salt);
    const { nonce, ciphertext, tag } = encrypt(key1, Buffer.from("secret"));
    expect(() => decrypt(key2, nonce, ciphertext, tag)).toThrow();
  });

  it("handles empty plaintext", () => {
    const key = deriveKey("test", generateSalt());
    const { nonce, ciphertext, tag } = encrypt(key, Buffer.from(""));
    const decrypted = decrypt(key, nonce, ciphertext, tag);
    expect(decrypted.toString()).toBe("");
  });

  it("handles large plaintext", () => {
    const key = deriveKey("test", generateSalt());
    const plaintext = Buffer.alloc(10000, "x");
    const { nonce, ciphertext, tag } = encrypt(key, plaintext);
    const decrypted = decrypt(key, nonce, ciphertext, tag);
    expect(decrypted.equals(plaintext)).toBe(true);
  });
});
