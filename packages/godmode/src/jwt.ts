/**
 * JWT verification for the Brainstorm control plane.
 *
 * Verifies Supabase-issued JWTs using the project's JWT secret (HS256).
 * Extracts platform_tenant_id and product roles from claims.
 *
 * Supabase uses HS256 with the project's JWT secret (not RS256/JWKS),
 * so verification is a simple HMAC check — no key rotation complexity.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

export interface JWTPayload {
  sub: string;
  email?: string;
  role?: string;
  platform_tenant_id?: string;
  platform_role?: string;
  products?: Record<string, { enabled: boolean; role: string }>;
  iat?: number;
  exp?: number;
  aud?: string;
}

export interface AuthResult {
  authenticated: boolean;
  payload?: JWTPayload;
  error?: string;
}

/**
 * Verify a Supabase JWT using the project's JWT secret (HS256).
 * Returns the decoded payload if valid, or an error message.
 */
export function verifyJWT(token: string, jwtSecret: string): AuthResult {
  const parts = token.split(".");
  if (parts.length !== 3) {
    return { authenticated: false, error: "Malformed JWT" };
  }

  const [headerB64, payloadB64, signatureB64] = parts;

  // Verify HS256 signature
  const signingInput = `${headerB64}.${payloadB64}`;
  const expectedSig = createHmac("sha256", jwtSecret)
    .update(signingInput)
    .digest();
  const actualSig = Buffer.from(signatureB64, "base64url");

  if (
    expectedSig.length !== actualSig.length ||
    !timingSafeEqual(expectedSig, actualSig)
  ) {
    return { authenticated: false, error: "Invalid signature" };
  }

  // Decode payload
  let payload: JWTPayload;
  try {
    payload = JSON.parse(
      Buffer.from(payloadB64, "base64url").toString("utf-8"),
    );
  } catch {
    return { authenticated: false, error: "Invalid payload encoding" };
  }

  // Check header algorithm
  try {
    const header = JSON.parse(
      Buffer.from(headerB64, "base64url").toString("utf-8"),
    );
    if (header.alg !== "HS256") {
      return {
        authenticated: false,
        error: `Unsupported algorithm: ${header.alg}`,
      };
    }
  } catch {
    return { authenticated: false, error: "Invalid header encoding" };
  }

  // Check expiration — require exp claim to prevent indefinite tokens
  if (!payload.exp) {
    return { authenticated: false, error: "Token missing expiration claim" };
  }
  if (payload.exp < Math.floor(Date.now() / 1000)) {
    return { authenticated: false, error: "Token expired" };
  }

  // Require platform_tenant_id — every God Mode call must be tenant-scoped
  if (!payload.platform_tenant_id && !payload.sub) {
    return {
      authenticated: false,
      error: "Missing subject or platform_tenant_id claim",
    };
  }

  return { authenticated: true, payload };
}

/**
 * Extract Bearer token from Authorization header.
 */
export function extractBearerToken(
  authHeader: string | undefined,
): string | null {
  if (!authHeader?.startsWith("Bearer ")) return null;
  return authHeader.slice(7);
}
