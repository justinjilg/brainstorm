import { describe, it, expect, vi, beforeEach } from "vitest";
import { verifyJWT, extractBearerToken, type JWTPayload } from "../jwt";
import {
  parseManifest,
  validateManifestData,
  generateManifestTemplate,
} from "../manifest";
import {
  setAuditPersister,
  getAuditLog,
  getConnectorAuditLog,
  logChangeSet,
  GODMODE_MIGRATION_SQL,
} from "../audit";
import type { ChangeSet } from "../types";

describe("JWT Verification", () => {
  const JWT_SECRET = "test-jwt-secret-for-unit-tests";

  function createToken(
    payload: JWTPayload,
    secret: string = JWT_SECRET,
  ): string {
    const header = { alg: "HS256", typ: "JWT" };
    const headerB64 = Buffer.from(JSON.stringify(header)).toString("base64url");
    const payloadB64 = Buffer.from(JSON.stringify(payload)).toString(
      "base64url",
    );
    const signingInput = `${headerB64}.${payloadB64}`;

    const crypto = require("node:crypto");
    const signature = crypto
      .createHmac("sha256", secret)
      .update(signingInput)
      .digest("base64url");

    return `${headerB64}.${payloadB64}.${signature}`;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));
  });

  it("verifies a valid JWT with platform_tenant_id", () => {
    const payload: JWTPayload = {
      sub: "user-123",
      platform_tenant_id: "tenant-abc",
      exp: Math.floor(Date.now() / 1000) + 3600,
    };
    const token = createToken(payload);

    const result = verifyJWT(token, JWT_SECRET);

    expect(result.authenticated).toBe(true);
    expect(result.payload).toMatchObject({
      sub: "user-123",
      platform_tenant_id: "tenant-abc",
    });
  });

  it("verifies a valid JWT with only sub claim", () => {
    const payload: JWTPayload = {
      sub: "user-456",
      exp: Math.floor(Date.now() / 1000) + 3600,
    };
    const token = createToken(payload);

    const result = verifyJWT(token, JWT_SECRET);

    expect(result.authenticated).toBe(true);
    expect(result.payload?.sub).toBe("user-456");
  });

  it("rejects expired tokens", () => {
    const payload: JWTPayload = {
      sub: "user-123",
      exp: Math.floor(Date.now() / 1000) - 3600, // 1 hour ago
    };
    const token = createToken(payload);

    const result = verifyJWT(token, JWT_SECRET);

    expect(result.authenticated).toBe(false);
    expect(result.error).toBe("Token expired");
  });

  it("rejects tokens without expiration claim", () => {
    const payload: JWTPayload = {
      sub: "user-123",
      // No exp claim
    };
    const token = createToken(payload as any);

    const result = verifyJWT(token, JWT_SECRET);

    expect(result.authenticated).toBe(false);
    expect(result.error).toBe("Token missing expiration claim");
  });

  it("rejects tokens with invalid signature", () => {
    const payload: JWTPayload = {
      sub: "user-123",
      exp: Math.floor(Date.now() / 1000) + 3600,
    };
    const token = createToken(payload, "wrong-secret");

    const result = verifyJWT(token, JWT_SECRET);

    expect(result.authenticated).toBe(false);
    expect(result.error).toBe("Invalid signature");
  });

  it("rejects malformed JWT (not 3 parts)", () => {
    const result = verifyJWT("invalid.token", JWT_SECRET);

    expect(result.authenticated).toBe(false);
    expect(result.error).toBe("Malformed JWT");
  });

  it("rejects tokens with unsupported algorithm", () => {
    const header = { alg: "RS256", typ: "JWT" };
    const payload = {
      sub: "user-123",
      exp: Math.floor(Date.now() / 1000) + 3600,
    };
    const headerB64 = Buffer.from(JSON.stringify(header)).toString("base64url");
    const payloadB64 = Buffer.from(JSON.stringify(payload)).toString(
      "base64url",
    );

    const crypto = require("node:crypto");
    const signature = crypto
      .createHmac("sha256", JWT_SECRET)
      .update(`${headerB64}.${payloadB64}`)
      .digest("base64url");

    const token = `${headerB64}.${payloadB64}.${signature}`;
    const result = verifyJWT(token, JWT_SECRET);

    expect(result.authenticated).toBe(false);
    expect(result.error).toContain("Unsupported algorithm");
  });

  it("rejects tokens missing both sub and platform_tenant_id", () => {
    const payload: JWTPayload = {
      email: "test@example.com",
      exp: Math.floor(Date.now() / 1000) + 3600,
    };
    const token = createToken(payload);

    const result = verifyJWT(token, JWT_SECRET);

    expect(result.authenticated).toBe(false);
    expect(result.error).toBe("Missing subject or platform_tenant_id claim");
  });
});

describe("extractBearerToken", () => {
  it("extracts token from Bearer header", () => {
    const token = extractBearerToken("Bearer abc123");
    expect(token).toBe("abc123");
  });

  it("returns null for non-Bearer header", () => {
    expect(extractBearerToken("Basic abc123")).toBeNull();
    expect(extractBearerToken("Token abc123")).toBeNull();
  });

  it("returns null for undefined header", () => {
    expect(extractBearerToken(undefined)).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(extractBearerToken("")).toBeNull();
  });
});

describe("Manifest Parsing and Validation", () => {
  const validManifest = {
    product: {
      id: "test-product",
      name: "Test Product",
      version: "1.0.0",
    },
    security: {
      api_base: "https://api.example.com",
      health: "/health",
      auth: {
        human: "supabase-jwt",
        machine: "api-key",
        tenant_claim: "platform_tenant_id",
      },
      encryption: {
        credentials: "aes-256-gcm",
        evidence: "none",
      },
      audit: {
        signing: "hmac-sha256",
        retention: "7y",
      },
    },
    capabilities: [{ domain: "endpoint-management" }],
    events: {
      publishes: ["test.alert.created"],
      subscribes: [],
    },
    edge: {
      plugins: [],
    },
  };

  it("validates a correct manifest object", () => {
    const result = validateManifestData(validManifest);

    expect(result.ok).toBe(true);
    expect(result.manifest).toBeDefined();
    expect(result.manifest?.product.id).toBe("test-product");
  });

  it("rejects manifest with invalid product ID", () => {
    const invalidManifest = {
      ...validManifest,
      product: { ...validManifest.product, id: "Invalid_ID" },
    };

    const result = validateManifestData(invalidManifest);

    expect(result.ok).toBe(false);
    expect(result.errors?.some((e) => e.includes("Product ID"))).toBe(true);
  });

  it("rejects manifest with missing required fields", () => {
    const incompleteManifest = {
      product: { id: "test" }, // missing name, version
    };

    const result = validateManifestData(incompleteManifest);

    expect(result.ok).toBe(false);
    expect(result.errors?.length).toBeGreaterThan(0);
  });

  it("rejects manifest with invalid URL", () => {
    const invalidUrlManifest = {
      ...validManifest,
      security: { ...validManifest.security, api_base: "not-a-url" },
    };

    const result = validateManifestData(invalidUrlManifest);

    expect(result.ok).toBe(false);
    expect(result.errors?.some((e) => e.includes("url"))).toBe(true);
  });

  it("parses valid JSON manifest string", () => {
    const jsonString = JSON.stringify(validManifest);
    const result = parseManifest(jsonString);

    expect(result.ok).toBe(true);
    expect(result.manifest?.product.name).toBe("Test Product");
  });

  it("rejects invalid JSON in parseManifest", () => {
    const result = parseManifest("not valid json");

    expect(result.ok).toBe(false);
    expect(result.errors?.[0]).toContain("Invalid JSON");
  });

  it("generates manifest template with correct placeholders", () => {
    const template = generateManifestTemplate(
      "my-product",
      "My Product",
      "https://api.myproduct.com",
    );

    expect(template).toContain('id: "my-product"');
    expect(template).toContain('name: "My Product"');
    expect(template).toContain('api_base: "https://api.myproduct.com"');
    expect(template).toContain("product-manifest.yaml");
    expect(template).toContain("Brainstorm Platform Contract");
  });

  it("applies default values for optional fields", () => {
    const minimalManifest = {
      product: {
        id: "minimal",
        name: "Minimal",
        version: "0.1.0",
      },
      security: {
        api_base: "https://api.example.com",
      },
    };

    const result = validateManifestData(minimalManifest);

    expect(result.ok).toBe(true);
    expect(result.manifest?.security.health).toBe("/health");
    expect(result.manifest?.security.auth.human).toBe("supabase-jwt");
    expect(result.manifest?.capabilities).toEqual([]);
  });
});

describe("Audit Logging", () => {
  // Clear audit log between tests
  beforeEach(() => {
    // Reset by calling getAuditLog and clearing (auditLog is module-level)
    // Since we can't directly clear, we track counts
    setAuditPersister(null as any); // Reset persister
  });

  function createMockChangeSet(overrides: Partial<ChangeSet> = {}): ChangeSet {
    return {
      id: "test-123",
      connector: "test-connector",
      action: "test-action",
      description: "Test changeset",
      status: "executed",
      riskScore: 50,
      riskFactors: ["test factor"],
      changes: [],
      simulation: {
        success: true,
        statePreview: {},
        cascades: [],
        constraints: [],
        estimatedDuration: "1s",
      },
      createdAt: Date.now(),
      expiresAt: Date.now() + 3600000,
      executedAt: Date.now(),
      ...overrides,
    };
  }

  it("logs changeset to in-memory audit log", () => {
    const changeset = createMockChangeSet();
    const beforeCount = getAuditLog().length;

    const entry = logChangeSet(changeset);

    expect(entry.changesetId).toBe("test-123");
    expect(entry.connector).toBe("test-connector");
    expect(entry.action).toBe("test-action");
    expect(entry.status).toBe("executed");
    expect(entry.riskScore).toBe(50);
    expect(getAuditLog().length).toBe(beforeCount + 1);
  });

  it("calls registered persister when logging", () => {
    const persister = vi.fn();
    setAuditPersister(persister);

    const changeset = createMockChangeSet();
    logChangeSet(changeset);

    expect(persister).toHaveBeenCalledOnce();
    expect(persister).toHaveBeenCalledWith(
      expect.objectContaining({
        changesetId: "test-123",
        connector: "test-connector",
      }),
    );
  });

  it("continues logging even if persister throws", () => {
    const failingPersister = vi.fn().mockImplementation(() => {
      throw new Error("DB connection failed");
    });
    setAuditPersister(failingPersister);

    const changeset = createMockChangeSet();

    // Should not throw
    expect(() => logChangeSet(changeset)).not.toThrow();

    // Still in memory
    expect(getAuditLog().some((e) => e.changesetId === "test-123")).toBe(true);
  });

  it("filters audit log by connector", () => {
    const cs1 = createMockChangeSet({
      id: "cs-1",
      connector: "connector-a",
    });
    const cs2 = createMockChangeSet({
      id: "cs-2",
      connector: "connector-b",
    });
    const cs3 = createMockChangeSet({
      id: "cs-3",
      connector: "connector-a",
    });

    logChangeSet(cs1);
    logChangeSet(cs2);
    logChangeSet(cs3);

    const connectorALogs = getConnectorAuditLog("connector-a");

    expect(connectorALogs).toHaveLength(2);
    expect(connectorALogs.every((e) => e.connector === "connector-a")).toBe(
      true,
    );
    expect(connectorALogs.map((e) => e.changesetId)).toContain("cs-1");
    expect(connectorALogs.map((e) => e.changesetId)).toContain("cs-3");
  });

  it("returns empty array for non-existent connector", () => {
    const result = getConnectorAuditLog("non-existent");
    expect(result).toEqual([]);
  });

  it("serializes changes and simulation to JSON", () => {
    const changes = [
      { system: "test", entity: "e1", operation: "create" as const },
    ];
    const simulation = {
      success: true,
      statePreview: { count: 5 },
      cascades: ["effect-1"],
      constraints: [],
      estimatedDuration: "5s",
    };

    const changeset = createMockChangeSet({
      changes,
      simulation,
      rollbackData: { undo: "reverse" },
    });

    const entry = logChangeSet(changeset);

    expect(JSON.parse(entry.changesJson)).toEqual(changes);
    expect(JSON.parse(entry.simulationJson)).toEqual(simulation);
    expect(JSON.parse(entry.rollbackJson!)).toEqual({ undo: "reverse" });
  });

  it("exports migration SQL for SQLite", () => {
    expect(GODMODE_MIGRATION_SQL).toContain(
      "CREATE TABLE IF NOT EXISTS godmode_changeset_log",
    );
    expect(GODMODE_MIGRATION_SQL).toContain("changeset_id TEXT PRIMARY KEY");
    expect(GODMODE_MIGRATION_SQL).toContain("idx_gm_changeset_connector");
    expect(GODMODE_MIGRATION_SQL).toContain("idx_gm_changeset_status");
  });
});
