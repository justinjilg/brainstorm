import { createSign, generateKeyPairSync, type KeyObject } from "node:crypto";
import { IncomingMessage } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrainstormServer } from "../server";

const ISSUER = "https://auth.brainstorm.co/realms/brainstorm";
const AUDIENCE = "brainstorm-cli";
const KID = "server-key";

const deps = {
  db: {} as any,
  config: {},
  registry: {} as any,
  router: {} as any,
  costTracker: {} as any,
  tools: {} as any,
  godmode: {} as any,
  memoryManager: {} as any,
  version: "test-version",
};

function base64urlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function signToken(privateKey: KeyObject): string {
  const headerB64 = base64urlJson({ alg: "RS256", typ: "JWT", kid: KID });
  const payloadB64 = base64urlJson({
    sub: "operator-1",
    iss: ISSUER,
    azp: AUDIENCE,
    platform_tenant_id: "tenant-1",
    exp: Math.floor(Date.now() / 1000) + 300,
  });
  const signingInput = `${headerB64}.${payloadB64}`;
  const signature = createSign("RSA-SHA256")
    .update(signingInput)
    .end()
    .sign(privateKey)
    .toString("base64url");
  return `${signingInput}.${signature}`;
}

describe("BrainstormServer Keycloak auth", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-20T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    globalThis.fetch = originalFetch;
  });

  it("verifies bearer tokens with Keycloak JWKS when jwtIssuer is configured", async () => {
    const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const jwk = {
      ...pair.publicKey.export({ format: "jwk" }),
      kid: KID,
      use: "sig",
      alg: "RS256",
    };
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ keys: [jwk] }),
    })) as unknown as typeof fetch;

    const server = new BrainstormServer(deps, {
      jwtIssuer: ISSUER,
      jwtAudience: AUDIENCE,
    });
    const req = {
      headers: { authorization: `Bearer ${signToken(pair.privateKey)}` },
    } as IncomingMessage;

    await expect((server as any).checkAuth(req)).resolves.toMatchObject({
      ok: true,
      payload: { sub: "operator-1", platform_tenant_id: "tenant-1" },
    });
  });
});
