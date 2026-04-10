/**
 * Server authentication tests.
 *
 * Tests the JWT verification layer that protects /api/v1/god-mode/execute.
 * These are the first tests for the server package (previously 0 test files).
 */

import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";

// Import JWT functions from godmode package
import { verifyJWT, extractBearerToken } from "@brainst0rm/godmode";

// Test secret — never use in production
const TEST_SECRET = "test-jwt-secret-for-unit-tests-only";

function createTestJWT(
  payload: Record<string, unknown>,
  secret: string = TEST_SECRET,
  alg = "HS256",
): string {
  const header = Buffer.from(JSON.stringify({ alg, typ: "JWT" })).toString(
    "base64url",
  );
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signingInput = `${header}.${body}`;
  const sig = createHmac("sha256", secret).update(signingInput).digest();
  return `${header}.${body}.${sig.toString("base64url")}`;
}

describe("JWT Authentication", () => {
  const validPayload = {
    sub: "user-123",
    platform_tenant_id: "tenant-abc",
    exp: Math.floor(Date.now() / 1000) + 3600, // 1 hour from now
    iat: Math.floor(Date.now() / 1000),
  };

  describe("verifyJWT", () => {
    it("accepts a valid HS256 token", () => {
      const token = createTestJWT(validPayload);
      const result = verifyJWT(token, TEST_SECRET);
      expect(result.authenticated).toBe(true);
      expect(result.payload?.sub).toBe("user-123");
      expect(result.payload?.platform_tenant_id).toBe("tenant-abc");
    });

    it("rejects unauthenticated request (no token)", () => {
      const result = verifyJWT("", TEST_SECRET);
      expect(result.authenticated).toBe(false);
    });

    it("rejects malformed JWT (wrong number of parts)", () => {
      const result = verifyJWT("just.two", TEST_SECRET);
      expect(result.authenticated).toBe(false);
      expect(result.error).toBe("Malformed JWT");
    });

    it("rejects wrong signature (wrong secret)", () => {
      const token = createTestJWT(validPayload, "wrong-secret");
      const result = verifyJWT(token, TEST_SECRET);
      expect(result.authenticated).toBe(false);
      expect(result.error).toBe("Invalid signature");
    });

    it("rejects alg:none tokens", () => {
      // Create a token with alg:none — this is the classic JWT bypass attack
      const header = Buffer.from(
        JSON.stringify({ alg: "none", typ: "JWT" }),
      ).toString("base64url");
      const body = Buffer.from(JSON.stringify(validPayload)).toString(
        "base64url",
      );
      const token = `${header}.${body}.`;

      const result = verifyJWT(token, TEST_SECRET);
      expect(result.authenticated).toBe(false);
      // Should fail on signature check (empty sig != HMAC) before alg check
    });

    it("rejects expired tokens", () => {
      const expiredPayload = {
        ...validPayload,
        exp: Math.floor(Date.now() / 1000) - 60, // Expired 1 minute ago
      };
      const token = createTestJWT(expiredPayload);
      const result = verifyJWT(token, TEST_SECRET);
      expect(result.authenticated).toBe(false);
      expect(result.error).toBe("Token expired");
    });

    it("rejects tokens without expiration", () => {
      const { exp, ...noExpPayload } = validPayload;
      const token = createTestJWT(noExpPayload);
      const result = verifyJWT(token, TEST_SECRET);
      expect(result.authenticated).toBe(false);
      expect(result.error).toBe("Token missing expiration claim");
    });

    it("rejects tokens without sub or platform_tenant_id", () => {
      const { sub, platform_tenant_id, ...minimalPayload } = validPayload;
      const token = createTestJWT(minimalPayload);
      const result = verifyJWT(token, TEST_SECRET);
      expect(result.authenticated).toBe(false);
      expect(result.error).toContain("Missing subject");
    });

    it("rejects unsupported algorithm (RS256)", () => {
      // Even if we forge a valid HS256 sig, the header says RS256
      const token = createTestJWT(validPayload, TEST_SECRET, "RS256");
      const result = verifyJWT(token, TEST_SECRET);
      // Signature is valid HS256 but header claims RS256 — should reject
      expect(result.authenticated).toBe(false);
      expect(result.error).toContain("Unsupported algorithm");
    });
  });

  describe("extractBearerToken", () => {
    it("extracts token from Bearer header", () => {
      expect(extractBearerToken("Bearer abc123")).toBe("abc123");
    });

    it("returns null for missing header", () => {
      expect(extractBearerToken(undefined)).toBeNull();
    });

    it("returns null for non-Bearer header", () => {
      expect(extractBearerToken("Basic abc123")).toBeNull();
    });
  });
});
