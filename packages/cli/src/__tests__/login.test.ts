import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateKeyPairSync, sign } from "node:crypto";
import { __test } from "../commands/login.js";

const {
  buildSession,
  decodeJwtClaims,
  verifyKeycloakAccessToken,
  verifyLoginTokenResponse,
} = __test;

const ISSUER = "https://auth.example/realms/brainstorm";
const CLIENT_ID = "brainstorm-cli";

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
});

const publicJwk = publicKey.export({ format: "jwk" }) as any;

function jwt(
  payload: Record<string, unknown>,
  opts: {
    alg?: string;
    kid?: string;
    key?: typeof privateKey;
    signature?: string;
  } = {},
): string {
  const header = {
    alg: opts.alg ?? "RS256",
    kid: opts.kid ?? "test-kid",
    typ: "JWT",
  };
  const headerB64 = Buffer.from(JSON.stringify(header)).toString("base64url");
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signingInput = `${headerB64}.${payloadB64}`;
  const signature =
    opts.signature ??
    sign(
      "RSA-SHA256",
      Buffer.from(signingInput),
      opts.key ?? privateKey,
    ).toString("base64url");
  return `${signingInput}.${signature}`;
}

function validClaims(overrides: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: ISSUER,
    azp: CLIENT_ID,
    exp: now + 3600,
    iat: now,
    sub: "user-123",
    did: "did:bvm:tenant:user-123",
    email: "operator@example.com",
    ...overrides,
  };
}

function jwks(kid = "test-kid") {
  return {
    keys: [
      {
        ...publicJwk,
        kid,
        alg: "RS256",
        use: "sig",
      },
    ],
  };
}

describe("brainstorm login token verification", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = originalFetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("verifies a Keycloak RS256 access token before claims are trusted", () => {
    const token = jwt(validClaims());
    const claims = verifyKeycloakAccessToken(token, {
      issuer: ISSUER,
      clientId: CLIENT_ID,
      jwks: jwks(),
    });
    expect(claims.sub).toBe("user-123");
    expect(claims.did).toBe("did:bvm:tenant:user-123");
    expect(claims.email).toBe("operator@example.com");
  });

  it("accepts client binding through aud when azp is absent", () => {
    const token = jwt(validClaims({ azp: undefined, aud: [CLIENT_ID] }));
    const claims = verifyKeycloakAccessToken(token, {
      issuer: ISSUER,
      clientId: CLIENT_ID,
      jwks: jwks(),
    });
    expect(claims.aud).toEqual([CLIENT_ID]);
  });

  it("rejects alg:none and never treats unsigned claims as authoritative", () => {
    const unsigned = jwt(validClaims({ sub: "attacker" }), {
      alg: "none",
      signature: "",
    });
    expect(() =>
      verifyKeycloakAccessToken(unsigned, {
        issuer: ISSUER,
        clientId: CLIENT_ID,
        jwks: jwks(),
      }),
    ).toThrow(/unsupported access token algorithm/);
  });

  it("rejects wrong signatures", () => {
    const otherKey = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const token = jwt(validClaims(), {
      key: otherKey.privateKey,
    });
    expect(() =>
      verifyKeycloakAccessToken(token, {
        issuer: ISSUER,
        clientId: CLIENT_ID,
        jwks: jwks(),
      }),
    ).toThrow(/signature verification failed/);
  });

  it("rejects issuer mismatches", () => {
    const token = jwt(validClaims({ iss: "https://evil.example/realm" }));
    expect(() =>
      verifyKeycloakAccessToken(token, {
        issuer: ISSUER,
        clientId: CLIENT_ID,
        jwks: jwks(),
      }),
    ).toThrow(/issuer mismatch/);
  });

  it("rejects tokens not bound to the CLI client", () => {
    const token = jwt(validClaims({ azp: "other-client", aud: "account" }));
    expect(() =>
      verifyKeycloakAccessToken(token, {
        issuer: ISSUER,
        clientId: CLIENT_ID,
        jwks: jwks(),
      }),
    ).toThrow(/not bound to client/);
  });

  it("builds the persisted identity from verified claims, not decoded token claims", () => {
    const maliciousToken = jwt(
      validClaims({
        did: "did:bvm:tenant:attacker",
        email: "attacker@example.com",
      }),
    );
    expect(decodeJwtClaims(maliciousToken)?.email).toBe("attacker@example.com");

    const session = buildSession(
      {
        access_token: maliciousToken,
        refresh_token: "refresh-token",
        expires_in: 3600,
        token_type: "Bearer",
      },
      ISSUER,
      validClaims({
        did: "did:bvm:tenant:verified-user",
        email: "verified@example.com",
      }),
    );

    expect(session.did).toBe("did:bvm:tenant:verified-user");
    expect(session.email).toBe("verified@example.com");
  });

  it("verifies token responses through OIDC discovery and JWKS fetch", async () => {
    const token = jwt(validClaims());
    const urls: string[] = [];
    globalThis.fetch = (async (url: any) => {
      urls.push(String(url));
      if (String(url).endsWith("/.well-known/openid-configuration")) {
        return new Response(
          JSON.stringify({
            issuer: ISSUER,
            jwks_uri: `${ISSUER}/protocol/openid-connect/certs`,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(JSON.stringify(jwks()), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof globalThis.fetch;

    const claims = await verifyLoginTokenResponse(
      {
        access_token: token,
        refresh_token: "refresh-token",
        expires_in: 3600,
        token_type: "Bearer",
      },
      ISSUER,
      CLIENT_ID,
    );

    expect(claims.sub).toBe("user-123");
    expect(urls).toEqual([
      `${ISSUER}/.well-known/openid-configuration`,
      `${ISSUER}/protocol/openid-connect/certs`,
    ]);
  });
});
