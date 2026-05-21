import { describe, it, expect } from "vitest";
import {
  ChangeSetSchema,
  CreateChangeSetInputSchema,
  ChangeSetLifecycleEventSchema,
  BlastRadiusSchema,
  SimulationResultSchema,
} from "../schemas.js";

describe("CreateChangeSetInputSchema", () => {
  it("requires tenantId", () => {
    const input = {
      // tenantId intentionally missing
      connector: "msp",
      action: "msp.customer.create",
      description: "Create acme customer",
      changes: [
        {
          system: "msp",
          entity: "customer:acme",
          operation: "create" as const,
        },
      ],
      simulation: {
        success: true,
        statePreview: {},
        cascades: [],
        constraints: [],
        estimatedDuration: "~1s",
      },
    };
    const result = CreateChangeSetInputSchema.safeParse(input);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(["tenantId"]);
    }
  });

  it("accepts a minimal valid input", () => {
    const input = {
      tenantId: "acme",
      connector: "msp",
      action: "msp.customer.create",
      description: "Create acme customer",
      changes: [
        {
          system: "msp",
          entity: "customer:acme",
          operation: "create" as const,
        },
      ],
      simulation: {
        success: true,
        statePreview: {},
        cascades: [],
        constraints: [],
        estimatedDuration: "~1s",
      },
    };
    const result = CreateChangeSetInputSchema.safeParse(input);
    expect(result.success).toBe(true);
  });

  it("rejects empty-string tenantId (must be at least 1 char)", () => {
    const input = {
      tenantId: "",
      connector: "msp",
      action: "msp.customer.create",
      description: "x",
      changes: [],
      simulation: {
        success: true,
        statePreview: {},
        cascades: [],
        constraints: [],
        estimatedDuration: "~0s",
      },
    };
    const result = CreateChangeSetInputSchema.safeParse(input);
    expect(result.success).toBe(false);
  });
});

describe("ChangeSetSchema", () => {
  it("accepts a complete ChangeSet with optional fields", () => {
    const cs = {
      id: "abc12345",
      tenantId: "acme",
      connector: "vm",
      action: "vm.create",
      description: "Spawn forensic VM",
      status: "draft" as const,
      riskScore: 35,
      riskFactors: ["new-resource"],
      changes: [
        { system: "vm", entity: "vm:i-new", operation: "create" as const },
      ],
      simulation: {
        success: true,
        statePreview: {},
        cascades: [],
        constraints: [],
        estimatedDuration: "~30s",
      },
      createdAt: 1716000000000,
      expiresAt: 1716000300000,
      correlationId: "incident-2026-05-21-001",
      traceId: "abc123",
    };
    const result = ChangeSetSchema.safeParse(cs);
    expect(result.success).toBe(true);
  });

  it("rejects a ChangeSet without tenantId (v2 invariant)", () => {
    const cs = {
      id: "abc12345",
      connector: "vm",
      action: "vm.create",
      description: "x",
      status: "draft",
      riskScore: 0,
      riskFactors: [],
      changes: [],
      simulation: {
        success: true,
        statePreview: {},
        cascades: [],
        constraints: [],
        estimatedDuration: "~0s",
      },
      createdAt: 0,
      expiresAt: 0,
    };
    const result = ChangeSetSchema.safeParse(cs);
    expect(result.success).toBe(false);
  });
});

describe("BlastRadiusSchema", () => {
  it("requires code-structural fields (godmode back-compat)", () => {
    const br = {
      // missing required affectedSymbols/affectedCommunities/etc.
      reversibility: "instant" as const,
    };
    expect(BlastRadiusSchema.safeParse(br).success).toBe(false);
  });

  it("accepts code-structural only", () => {
    const br = {
      affectedSymbols: [{ name: "foo", file: "a.ts", depth: 1 }],
      affectedCommunities: [{ id: "c1", name: "core", tier: "critical" }],
      riskMultiplier: 1.5,
      totalAffected: 1,
    };
    expect(BlastRadiusSchema.safeParse(br).success).toBe(true);
  });

  it("accepts code-structural + operational together", () => {
    const br = {
      affectedSymbols: [],
      affectedCommunities: [],
      riskMultiplier: 1,
      totalAffected: 0,
      entitiesAffected: 47,
      productsTouched: ["msp", "vm"],
      tenantsTouched: ["acme"],
      dataClasses: ["pii", "config"] as const,
      reversibility: "manual" as const,
    };
    expect(BlastRadiusSchema.safeParse(br).success).toBe(true);
  });
});

describe("ChangeSetLifecycleEventSchema", () => {
  it("validates a changeset.executed event", () => {
    const event = {
      tenantId: "acme",
      ts: 1716220800000,
      changesetId: "cs_abc123",
      payload: {
        product: "msp",
        tool: "msp.customer.create",
        state: "executed" as const,
        executionResult: { customer_id: "cust_xyz" },
      },
    };
    expect(ChangeSetLifecycleEventSchema.safeParse(event).success).toBe(true);
  });

  it("rejects an event missing tenantId", () => {
    const event = {
      ts: 0,
      changesetId: "cs_abc",
      payload: { product: "msp", tool: "x", state: "draft" },
    };
    expect(ChangeSetLifecycleEventSchema.safeParse(event).success).toBe(false);
  });
});

describe("SimulationResultSchema", () => {
  it("accepts the minimal shape", () => {
    const sim = {
      success: true,
      statePreview: {},
      cascades: [],
      constraints: [],
      estimatedDuration: "~1s",
    };
    expect(SimulationResultSchema.safeParse(sim).success).toBe(true);
  });
});
