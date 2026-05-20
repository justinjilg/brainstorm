import {
  createSign,
  generateKeyPairSync,
  type JsonWebKey,
  type KeyObject,
} from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { verifyKeycloakJWT, type JWTPayload } from "../jwt";

const ISSUER = "https://auth.brainstorm.co/realms/brainstorm";
const AUDIENCE = "brainstorm-cli";
const KID = "test-key";

function base64urlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function signToken(
  privateKey: KeyObject,
  payload: JWTPayload,
  header: Record<string, unknown> = { alg: "RS256", typ: "JWT", kid: KID },
): string {
  const headerB64 = base64urlJson(header);
  const payloadB64 = base64urlJson(payload);
  const signingInput = `${headerB64}.${payloadB64}`;
  const signature = createSign("RSA-SHA256")
    .update(signingInput)
    .end()
    .sign(privateKey)
    .toString("base64url");

  return `${signingInput}.${signature}`;
}

describe("verifyKeycloakJWT", () => {
  let privateKey: KeyObject;
  let publicJwk: JsonWebKey;
  let fetchImpl: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-20T12:00:00Z"));
    const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
    privateKey = pair.privateKey;
    publicJwk = {
      ...pair.publicKey.export({ format: "jwk" }),
      kid: KID,
      use: "sig",
      alg: "RS256",
    };
    fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ keys: [publicJwk] }),
    }));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function validPayload(overrides: Partial<JWTPayload> = {}): JWTPayload {
    return {
      sub: "user-1",
      email: "user@example.com",
      iss: ISSUER,
      azp: AUDIENCE,
      platform_tenant_id: "tenant-1",
      exp: Math.floor(Date.now() / 1000) + 300,
      ...overrides,
    };
  }

  it("verifies an RS256 Keycloak token with JWKS", async () => {
    const token = signToken(privateKey, validPayload());

    const result = await verifyKeycloakJWT(token, {
      issuer: ISSUER,
      audience: AUDIENCE,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result.authenticated).toBe(true);
    expect(result.payload).toMatchObject({
      sub: "user-1",
      platform_tenant_id: "tenant-1",
    });
  });

  it("accepts audience binding when azp is absent", async () => {
    const token = signToken(
      privateKey,
      validPayload({ azp: undefined, aud: [AUDIENCE] }),
    );

    const result = await verifyKeycloakJWT(token, {
      issuer: ISSUER,
      audience: AUDIENCE,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result.authenticated).toBe(true);
  });

  it("rejects unsigned or non-RS256 tokens", async () => {
    const token = signToken(privateKey, validPayload(), {
      alg: "none",
      typ: "JWT",
      kid: KID,
    });

    const result = await verifyKeycloakJWT(token, {
      issuer: ISSUER,
      audience: AUDIENCE,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result).toMatchObject({
      authenticated: false,
      error: "Unsupported algorithm: none",
    });
  });

  it("rejects issuer mismatch", async () => {
    const token = signToken(
      privateKey,
      validPayload({ iss: "https://evil.example/realms/brainstorm" }),
    );

    const result = await verifyKeycloakJWT(token, {
      issuer: ISSUER,
      audience: AUDIENCE,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result).toMatchObject({
      authenticated: false,
      error: "Issuer mismatch",
    });
  });

  it("rejects tokens not issued for this client", async () => {
    const token = signToken(privateKey, validPayload({ azp: "other-client" }));

    const result = await verifyKeycloakJWT(token, {
      issuer: ISSUER,
      audience: AUDIENCE,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result).toMatchObject({
      authenticated: false,
      error: "Token is not issued for this client",
    });
  });
});
