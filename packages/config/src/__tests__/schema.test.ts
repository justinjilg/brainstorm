/**
 * Config Schema Tests — catches enum drift, type coercion, and merge bugs.
 *
 * These exist because:
 * - AgentRole enum had 14 values in shared/types.ts but only 8 in the schema (silent rejection)
 * - Workflow communication mode "parallel" was rejected by CHECK constraint
 * - Config docs referenced "permissionMode" but actual key is "defaultPermissionMode"
 */

import { describe, test, expect } from "vitest";
import { brainstormConfigSchema } from "../schema.js";
import type { AgentRole } from "@brainst0rm/shared";

// ── Exhaustive list from shared/types.ts ─────────────────────────
const ALL_AGENT_ROLES: AgentRole[] = [
  "architect",
  "coder",
  "reviewer",
  "debugger",
  "analyst",
  "orchestrator",
  "product-manager",
  "security-reviewer",
  "code-reviewer",
  "style-reviewer",
  "qa",
  "compliance",
  "devops",
  "custom",
];

describe("Config Schema", () => {
  test("accepts empty config with all defaults", () => {
    const result = brainstormConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.general.defaultStrategy).toBe("combined");
      expect(result.data.shell.sandbox).toBe("restricted");
      expect(result.data.budget.hardLimit).toBe(false);
    }
  });

  test("accepts all AgentRole variants from shared types", () => {
    for (const role of ALL_AGENT_ROLES) {
      const result = brainstormConfigSchema.safeParse({
        agents: [{ id: `test-${role}`, role, model: "test-model" }],
      });
      expect(result.success, `Role "${role}" should be accepted`).toBe(true);
    }
  });

  test("rejects unknown agent role", () => {
    const result = brainstormConfigSchema.safeParse({
      agents: [{ id: "test", role: "ninja", model: "test-model" }],
    });
    expect(result.success).toBe(false);
  });

  test("accepts all routing strategies", () => {
    for (const strategy of [
      "quality-first",
      "cost-first",
      "combined",
      "capability",
      "learned",
      "rule-based",
    ]) {
      const result = brainstormConfigSchema.safeParse({
        general: { defaultStrategy: strategy },
      });
      expect(result.success, `Strategy "${strategy}" should be accepted`).toBe(
        true,
      );
    }
  });

  test("accepts all permission modes", () => {
    for (const mode of ["auto", "confirm", "plan"]) {
      const result = brainstormConfigSchema.safeParse({
        general: { defaultPermissionMode: mode },
      });
      expect(
        result.success,
        `Permission mode "${mode}" should be accepted`,
      ).toBe(true);
    }
  });

  test("accepts all sandbox modes", () => {
    for (const sandbox of ["none", "restricted", "container"]) {
      const result = brainstormConfigSchema.safeParse({
        shell: { sandbox },
      });
      expect(result.success, `Sandbox "${sandbox}" should be accepted`).toBe(
        true,
      );
    }
  });

  test("budget values are numbers, not strings", () => {
    const result = brainstormConfigSchema.safeParse({
      budget: { daily: 50.0, monthly: 500.0 },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(typeof result.data.budget.daily).toBe("number");
      expect(typeof result.data.budget.monthly).toBe("number");
    }
  });

  test("rejects string budget values", () => {
    const result = brainstormConfigSchema.safeParse({
      budget: { daily: "50.00" },
    });
    expect(result.success).toBe(false);
  });

  test("godmode connector config validates", () => {
    const result = brainstormConfigSchema.safeParse({
      godmode: {
        enabled: true,
        autoApproveRiskThreshold: 20,
        connectors: {
          msp: {
            enabled: true,
            baseUrl: "https://brainstormmsp.ai",
            apiKeyName: "BRAINSTORM_MSP_API_KEY",
          },
        },
      },
    });
    expect(result.success).toBe(true);
  });

  test("workflow communication modes include parallel", () => {
    const result = brainstormConfigSchema.safeParse({
      workflows: [
        {
          id: "test",
          steps: [{ id: "step1", agentRole: "coder", outputArtifact: "code" }],
          communicationMode: "parallel",
        },
      ],
    });
    expect(result.success).toBe(true);
  });
});
