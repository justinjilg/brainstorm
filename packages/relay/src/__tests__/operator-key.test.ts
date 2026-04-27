import { describe, it, expect } from "vitest";
import { deriveOperatorHmacKey } from "../operator-key.js";
import { constantTimeEqual } from "../signing.js";

describe("deriveOperatorHmacKey", () => {
  it("returns a 32-byte key", () => {
    const k = deriveOperatorHmacKey({
      apiKey: "secret-api-key",
      operatorId: "user@example.com",
      tenantId: "00000000-0000-0000-0000-000000000000",
    });
    expect(k.length).toBe(32);
  });

  it("is deterministic — same inputs produce identical key bytes", () => {
    const a = deriveOperatorHmacKey({
      apiKey: "secret",
      operatorId: "alice",
      tenantId: "tenant-1",
    });
    const b = deriveOperatorHmacKey({
      apiKey: "secret",
      operatorId: "alice",
      tenantId: "tenant-1",
    });
    expect(constantTimeEqual(a, b)).toBe(true);
  });

  it("differs across operator_id (info parameter changes)", () => {
    const a = deriveOperatorHmacKey({
      apiKey: "secret",
      operatorId: "alice",
      tenantId: "tenant-1",
    });
    const b = deriveOperatorHmacKey({
      apiKey: "secret",
      operatorId: "bob",
      tenantId: "tenant-1",
    });
    expect(constantTimeEqual(a, b)).toBe(false);
  });

  it("differs across tenant_id", () => {
    const a = deriveOperatorHmacKey({
      apiKey: "secret",
      operatorId: "alice",
      tenantId: "tenant-1",
    });
    const b = deriveOperatorHmacKey({
      apiKey: "secret",
      operatorId: "alice",
      tenantId: "tenant-2",
    });
    expect(constantTimeEqual(a, b)).toBe(false);
  });

  it("differs across apiKey (ikm)", () => {
    const a = deriveOperatorHmacKey({
      apiKey: "secret-1",
      operatorId: "alice",
      tenantId: "tenant-1",
    });
    const b = deriveOperatorHmacKey({
      apiKey: "secret-2",
      operatorId: "alice",
      tenantId: "tenant-1",
    });
    expect(constantTimeEqual(a, b)).toBe(false);
  });

  it("accepts Uint8Array apiKey too", () => {
    const ka = deriveOperatorHmacKey({
      apiKey: "abc",
      operatorId: "alice",
      tenantId: "tenant-1",
    });
    const kb = deriveOperatorHmacKey({
      apiKey: new TextEncoder().encode("abc"),
      operatorId: "alice",
      tenantId: "tenant-1",
    });
    expect(constantTimeEqual(ka, kb)).toBe(true);
  });
});
