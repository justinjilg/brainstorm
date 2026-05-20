/**
 * JWT verification for the Brainstorm control plane.
 *
 * Verifies legacy Supabase-issued HS256 JWTs and v0.5 Keycloak RS256/JWKS
 * access tokens. Extracts platform_tenant_id and product roles from claims.
 */

import {
  createHmac,
  createPublicKey,
  timingSafeEqual,
  verify,
  type JsonWebKey as NodeJsonWebKey,
} from "node:crypto";

export interface JWTPayload {
  sub: string;
  email?: string;
  role?: string;
  platform_tenant_id?: string;
  platform_role?: string;
  products?: Record<string, { enabled: boolean; role: string }>;
  iat?: number;
  exp?: number;
  aud?: string | string[];
  azp?: string;
  iss?: string;
  nbf?: number;
}

export interface AuthResult {
  authenticated: boolean;
  payload?: JWTPayload;
  error?: string;
}

export interface KeycloakVerifyOptions {
  issuer: string;
  audience: string;
  jwksUrl?: string;
  fetchImpl?: typeof fetch;
}

interface JWTHeader {
  alg?: string;
  kid?: string;
  typ?: string;
}

interface KeycloakJwk extends NodeJsonWebKey {
  kid?: string;
  kty?: string;
  use?: string;
  alg?: string;
  n?: string;
  e?: string;
}

function decodeJwtPart<T>(value: string): T {
  return JSON.parse(Buffer.from(value, "base64url").toString("utf-8")) as T;
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
    payload = decodeJwtPart<JWTPayload>(payloadB64);
  } catch {
    return { authenticated: false, error: "Invalid payload encoding" };
  }

  // Check header algorithm
  try {
    const header = decodeJwtPart<JWTHeader>(headerB64);
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

export async function verifyKeycloakJWT(
  token: string,
  opts: KeycloakVerifyOptions,
): Promise<AuthResult> {
  const parts = token.split(".");
  if (parts.length !== 3) {
    return { authenticated: false, error: "Malformed JWT" };
  }

  const [headerB64, payloadB64, signatureB64] = parts;
  let header: JWTHeader;
  let payload: JWTPayload;
  try {
    header = decodeJwtPart<JWTHeader>(headerB64);
    payload = decodeJwtPart<JWTPayload>(payloadB64);
  } catch {
    return { authenticated: false, error: "Invalid JWT encoding" };
  }

  if (header.alg !== "RS256") {
    return {
      authenticated: false,
      error: `Unsupported algorithm: ${header.alg}`,
    };
  }
  if (!header.kid) {
    return { authenticated: false, error: "Missing JWT key id" };
  }

  const expectedIssuer = opts.issuer.replace(/\/$/, "");
  const jwksUrl =
    opts.jwksUrl ?? `${expectedIssuer}/protocol/openid-connect/certs`;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const jwksResponse = await fetchImpl(jwksUrl, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!jwksResponse.ok) {
    return {
      authenticated: false,
      error: `JWKS fetch failed: HTTP ${jwksResponse.status}`,
    };
  }

  const jwks = (await jwksResponse.json()) as { keys?: KeycloakJwk[] };
  const jwk = jwks.keys?.find((key) => key.kid === header.kid);
  if (!jwk) {
    return { authenticated: false, error: "JWT signing key not found" };
  }
  if (jwk.kty !== "RSA" || jwk.use !== "sig" || jwk.alg !== "RS256") {
    return {
      authenticated: false,
      error: "JWT signing key is not an RS256 signature key",
    };
  }

  const signingInput = `${headerB64}.${payloadB64}`;
  const signature = Buffer.from(signatureB64, "base64url");
  const publicKey = createPublicKey({ key: jwk, format: "jwk" });
  const signatureOk = verify(
    "RSA-SHA256",
    Buffer.from(signingInput),
    publicKey,
    signature,
  );
  if (!signatureOk) {
    return { authenticated: false, error: "Invalid signature" };
  }

  const now = Math.floor(Date.now() / 1000);
  if (payload.iss !== expectedIssuer) {
    return { authenticated: false, error: "Issuer mismatch" };
  }
  if (!payload.exp) {
    return { authenticated: false, error: "Token missing expiration claim" };
  }
  if (payload.exp < now) {
    return { authenticated: false, error: "Token expired" };
  }
  if (payload.nbf !== undefined && payload.nbf > now) {
    return { authenticated: false, error: "Token not yet valid" };
  }

  const audiences = Array.isArray(payload.aud)
    ? payload.aud
    : payload.aud
      ? [payload.aud]
      : [];
  if (payload.azp !== opts.audience && !audiences.includes(opts.audience)) {
    return {
      authenticated: false,
      error: "Token is not issued for this client",
    };
  }

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
