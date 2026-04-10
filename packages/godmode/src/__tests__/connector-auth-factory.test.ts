import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { connectGodMode } from "../connector-registry.js";
import { createProductConnectors } from "../product-factory.js";
import { resolveApiKey, validateCredentials } from "../auth.js";
import type {
  GodModeConnector,
  GodModeConfig,
  ConnectorConfig,
  HealthResult,
} from "../types.js";
import { defineTool } from "@brainst0rm/tools";
import { z } from "zod";
import {
  getChangeSetTools,
  rejectChangeSet,
  createChangeSet,
  approveChangeSet,
  registerExecutor,
} from "../changeset.js";

// ── Auth Tests ───────────────────────────────────────────────────

describe("Auth credential resolution", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("resolves API key with _GM_ prefix priority", () => {
    process.env["_GM_TEST_KEY"] = "prefixed-key";
    process.env["api_key_name"] = "fallback-key";

    const config: ConnectorConfig = {
      enabled: true,
      baseUrl: "https://test.com",
      apiKeyName: "api_key_name",
    };

    const key = resolveApiKey("test", config);
    expect(key).toBe("prefixed-key");
  });

  it("falls back to apiKeyName when _GM_ prefix not set", () => {
    delete process.env["_GM_TEST_KEY"];
    process.env["api_key_name"] = "fallback-key";

    const config: ConnectorConfig = {
      enabled: true,
      baseUrl: "https://test.com",
      apiKeyName: "api_key_name",
    };

    const key = resolveApiKey("test", config);
    expect(key).toBe("fallback-key");
  });

  it("returns null when no key is available", () => {
    delete process.env["_GM_TEST_KEY"];
    delete process.env["api_key_name"];

    const config: ConnectorConfig = {
      enabled: true,
      baseUrl: "https://test.com",
      apiKeyName: "api_key_name",
    };

    const key = resolveApiKey("test", config);
    expect(key).toBeNull();
  });

  it("validates credentials across multiple connectors", () => {
    process.env["_GM_VALID_KEY"] = "valid-key";
    // Missing key for "invalid" connector

    const connectors = [
      {
        name: "valid",
        config: {
          enabled: true,
          baseUrl: "https://valid.com",
          apiKeyName: "_GM_VALID_KEY",
        } as ConnectorConfig,
      },
      {
        name: "invalid",
        config: {
          enabled: true,
          baseUrl: "https://invalid.com",
          apiKeyName: "MISSING_KEY",
        } as ConnectorConfig,
      },
    ];

    const result = validateCredentials(connectors);

    expect(result.valid).toEqual(["valid"]);
    expect(result.missing).toHaveLength(1);
    expect(result.missing[0]).toEqual({
      name: "invalid",
      keyName: "MISSING_KEY",
    });
  });

  it("returns empty arrays when no connectors provided", () => {
    const result = validateCredentials([]);
    expect(result.valid).toEqual([]);
    expect(result.missing).toEqual([]);
  });
});

// ── Product Factory Tests ────────────────────────────────────────

describe("Product Factory", () => {
  it("filters out disabled connectors", async () => {
    const config: GodModeConfig = {
      enabled: true,
      autoApproveRiskThreshold: 50,
      connectors: {
        enabled: {
          enabled: true,
          baseUrl: "https://enabled.com",
          apiKeyName: "KEY",
        },
        disabled: {
          enabled: false,
          baseUrl: "https://disabled.com",
          apiKeyName: "KEY",
        },
      },
    };

    // Mock fetch to avoid network calls
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          status: "healthy",
          tools: [],
        }),
      text: () => Promise.resolve(""),
    } as Response);

    // Set up API key in env
    process.env["KEY"] = "test-key";

    const connectors = await createProductConnectors(config);

    // Should only have the enabled connector
    expect(connectors).toHaveLength(1);
    expect(connectors[0].name).toBe("enabled");
  });

  it("returns empty array when no connectors configured", async () => {
    const config: GodModeConfig = {
      enabled: true,
      autoApproveRiskThreshold: 50,
      connectors: {},
    };

    const connectors = await createProductConnectors(config);
    expect(connectors).toEqual([]);
  });

  it("returns empty array when connectors property is undefined", async () => {
    const config: GodModeConfig = {
      enabled: true,
      autoApproveRiskThreshold: 50,
      connectors: undefined as any,
    };

    const connectors = await createProductConnectors(config);
    expect(connectors).toEqual([]);
  });
});

// ── Connector Registry Tests ─────────────────────────────────────

describe("Connector Registry", () => {
  const createMockConnector = (
    name: string,
    healthResult: HealthResult,
    hasPrompt = false,
  ): GodModeConnector => ({
    name,
    displayName: `Test ${name}`,
    capabilities: ["endpoint-management"],
    getTools: () => [
      defineTool({
        name: `${name}_tool`,
        description: `Tool for ${name}`,
        permission: "auto",
        readonly: true,
        inputSchema: z.object({}),
        execute: async () => ({ result: "ok" }),
      }),
    ],
    healthCheck: vi.fn().mockResolvedValue(healthResult),
    ...(hasPrompt ? { getPrompt: () => `${name} prompt segment` } : {}),
  });

  it("handles connectors with failing health checks", async () => {
    const registry = { register: vi.fn() };
    const config: GodModeConfig = {
      enabled: true,
      autoApproveRiskThreshold: 50,
      connectors: {},
    };

    const healthyConnector = createMockConnector("healthy", {
      ok: true,
      latencyMs: 50,
    });

    const unhealthyConnector = createMockConnector("unhealthy", {
      ok: false,
      latencyMs: 100,
      message: "Connection refused",
    });

    const result = await connectGodMode(registry as any, config, [
      healthyConnector,
      unhealthyConnector,
    ]);

    expect(result.connectedSystems).toHaveLength(1);
    expect(result.connectedSystems[0].name).toBe("healthy");
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toEqual({
      name: "unhealthy",
      error: "Connection refused",
    });
  });

  it("handles health check timeouts", async () => {
    const registry = { register: vi.fn() };
    const config: GodModeConfig = {
      enabled: true,
      autoApproveRiskThreshold: 50,
      connectors: {},
    };

    // Create connector that rejects immediately (simulating timeout behavior)
    const slowConnector: GodModeConnector = {
      name: "slow",
      displayName: "Slow Connector",
      capabilities: ["endpoint-management"],
      getTools: () => [],
      healthCheck: vi.fn().mockRejectedValue(new Error("Timeout")),
    };

    const result = await connectGodMode(registry as any, config, [
      slowConnector,
    ]);

    // The connector is rejected due to timeout
    expect(result.connectedSystems).toHaveLength(0);
    // Connector with rejected promise is skipped without adding to errors array
    // (see line 66 in connector-registry.ts: "if (result.status === 'rejected') continue")
  }, 1000);

  it("appends connector-specific prompt segments when available", async () => {
    const registry = { register: vi.fn() };
    const config: GodModeConfig = {
      enabled: true,
      autoApproveRiskThreshold: 50,
      connectors: {},
    };

    const connectorWithPrompt = createMockConnector(
      "smart",
      { ok: true, latencyMs: 50 },
      true,
    );

    const result = await connectGodMode(registry as any, config, [
      connectorWithPrompt,
    ]);

    expect(result.promptSegment.text).toContain("smart prompt segment");
  });

  it("registers ChangeSet tools regardless of connector health", async () => {
    const registry = { register: vi.fn() };
    const config: GodModeConfig = {
      enabled: true,
      autoApproveRiskThreshold: 50,
      connectors: {},
    };

    // No connectors provided
    const result = await connectGodMode(registry as any, config, []);

    // ChangeSet tools should still be registered (3 tools: list, approve, reject)
    const csTools = getChangeSetTools();
    expect(registry.register).toHaveBeenCalledTimes(csTools.length);
    expect(result.totalTools).toBe(csTools.length);
  });

  it("correctly counts total tools across connectors", async () => {
    const registry = { register: vi.fn() };
    const config: GodModeConfig = {
      enabled: true,
      autoApproveRiskThreshold: 50,
      connectors: {},
    };

    const connector1 = createMockConnector("c1", { ok: true, latencyMs: 50 });
    const connector2 = createMockConnector("c2", { ok: true, latencyMs: 50 });

    const result = await connectGodMode(registry as any, config, [
      connector1,
      connector2,
    ]);

    // Each connector has 1 tool + ChangeSet tools (3)
    expect(result.totalTools).toBe(5);
  });
});

// ── ChangeSet Additional State Machine Tests ─────────────────────

describe("ChangeSet State Machine - Additional Paths", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("rejects a draft changeset and removes it from active list", () => {
    const changeset = createChangeSet({
      connector: "test",
      action: "test-action",
      description: "Test changeset",
      changes: [
        {
          system: "test",
          entity: "test:entity",
          operation: "update",
          before: { status: "old" },
          after: { status: "new" },
        },
      ],
      simulation: {
        success: true,
        statePreview: {},
        cascades: [],
        constraints: [],
        estimatedDuration: "1s",
      },
    });

    const result = rejectChangeSet(changeset.id);

    expect(result.success).toBe(true);
    expect(result.message).toContain("rejected");
  });

  it("returns error when rejecting non-existent changeset", () => {
    const result = rejectChangeSet("non-existent-id");

    expect(result.success).toBe(false);
    expect(result.message).toContain("not found");
  });

  it("transitions draft to expired when TTL is exceeded", async () => {
    const changeset = createChangeSet({
      connector: "test",
      action: "test-action",
      description: "Test changeset",
      changes: [],
      simulation: {
        success: true,
        statePreview: {},
        cascades: [],
        constraints: [],
        estimatedDuration: "1s",
      },
    });

    // Advance time past the 5-minute TTL
    vi.advanceTimersByTime(6 * 60 * 1000);

    const result = await approveChangeSet(changeset.id);

    expect(result.success).toBe(false);
    expect(result.message).toContain("expired");
    expect(result.changeset.status).toBe("expired");
  });

  it("prevents approval of already-approved changeset", async () => {
    const action = `double-approve-${Math.random()}`;
    registerExecutor(action, async () => ({
      success: true,
      message: "Executed",
    }));

    const changeset = createChangeSet({
      connector: "test",
      action,
      description: "Test changeset",
      changes: [],
      simulation: {
        success: true,
        statePreview: {},
        cascades: [],
        constraints: [],
        estimatedDuration: "1s",
      },
    });

    // First approval succeeds
    const firstResult = await approveChangeSet(changeset.id);
    expect(firstResult.success).toBe(true);

    // Second approval should fail
    const secondResult = await approveChangeSet(changeset.id);
    expect(secondResult.success).toBe(false);
    expect(secondResult.message).toContain("not draft");
  });

  it("keeps changeset as draft when executor throws exception", async () => {
    const action = `failing-exec-${Math.random()}`;
    registerExecutor(action, async () => {
      throw new Error("Executor crashed");
    });

    const changeset = createChangeSet({
      connector: "test",
      action,
      description: "Test changeset",
      changes: [],
      simulation: {
        success: true,
        statePreview: {},
        cascades: [],
        constraints: [],
        estimatedDuration: "1s",
      },
    });

    const result = await approveChangeSet(changeset.id);

    expect(result.success).toBe(false);
    expect(result.message).toContain("Execution failed");
    expect(result.changeset.status).toBe("draft");
  });

  it("keeps changeset as draft when executor returns failure", async () => {
    const action = `failing-result-${Math.random()}`;
    registerExecutor(action, async () => ({
      success: false,
      message: "Business logic validation failed",
    }));

    const changeset = createChangeSet({
      connector: "test",
      action,
      description: "Test changeset",
      changes: [],
      simulation: {
        success: true,
        statePreview: {},
        cascades: [],
        constraints: [],
        estimatedDuration: "1s",
      },
    });

    const result = await approveChangeSet(changeset.id);

    expect(result.success).toBe(false);
    expect(result.message).toContain("Business logic validation failed");
    expect(result.changeset.status).toBe("draft");
  });

  it("expands stale drafts when creating new changeset", async () => {
    // Create first changeset
    const changeset1 = createChangeSet({
      connector: "test",
      action: "test-action",
      description: "First changeset",
      changes: [],
      simulation: {
        success: true,
        statePreview: {},
        cascades: [],
        constraints: [],
        estimatedDuration: "1s",
      },
    });

    // Advance time past TTL
    vi.advanceTimersByTime(6 * 60 * 1000);

    // Create second changeset - should trigger expiration of first
    const changeset2 = createChangeSet({
      connector: "test",
      action: "test-action-2",
      description: "Second changeset",
      changes: [],
      simulation: {
        success: true,
        statePreview: {},
        cascades: [],
        constraints: [],
        estimatedDuration: "1s",
      },
    });

    // First changeset should be expired, second should be draft
    expect(changeset1.status).toBe("expired");
    expect(changeset2.status).toBe("draft");
  });
});
