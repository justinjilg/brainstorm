import { describe, it, expect } from "vitest";
import { maskSecret } from "../../util/mask-secret.js";

describe("maskSecret", () => {
  it("never includes any byte of the original secret", () => {
    const secret = "sk-ant-api03-ABCdEFghIJKlmnOPqrsTUVwxyz-1234567890";
    const masked = maskSecret(secret);
    // Slide a 4-char window across the secret and assert no substring
    // longer than a coincidence shows up in the mask.
    for (let i = 0; i + 4 <= secret.length; i++) {
      expect(masked).not.toContain(secret.slice(i, i + 4));
    }
  });

  it("reports the length so the operator knows what kind of secret it is", () => {
    expect(maskSecret("a".repeat(103))).toMatch(/\b103\b/);
    expect(maskSecret("abcd")).toMatch(/\b4\b/);
  });

  it("handles empty input without throwing", () => {
    expect(maskSecret("")).toBe("[redacted, 0 chars]");
  });

  it("does not leak provider-identifying prefixes for short secrets", () => {
    // Pre-fix behavior echoed the first 8 chars — even a 6-char secret
    // would get its entire plaintext printed.
    expect(maskSecret("abcdef")).not.toContain("abcdef");
    expect(maskSecret("sk-1234")).not.toContain("sk-1234");
  });
});
