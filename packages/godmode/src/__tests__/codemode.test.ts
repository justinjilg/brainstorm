import { describe, it, expect, vi } from "vitest";
import { connectGodMode } from "../connector-registry.js";
import type {
  GodModeConnector,
  GodModeConfig,
  HealthResult,
} from "../types.js";
import { defineTool, ToolRegistry } from "@brainst0rm/tools";
import { z } from "zod";
import { buildGodModePrompt } from "../prompt.js";

// ── Test Fixtures ────────────────────────────────────────────────

const healthyHealth: HealthResult = { ok: true, latencyMs: 25 };

function makeConnector(name: string, toolNames: string[]): GodModeConnector {
  return {
    name,
    displayName: `Test-${name}`,
    capabilities: ["endpoint-management"],
    getTools: () =>
      toolNames.map((tName) =>
        defineTool({
          name: tName,
          description: `Description for ${tName}`,
          permission: "auto",
          readonly: true,
          inputSchema: z.object({}),
          execute: async () => ({ result: "ok" }),
        }),
      ),
    healthCheck: vi.fn().mockResolvedValue(healthyHealth),
  };
}

// ── Connector tool deferral ──────────────────────────────────────

describe("Code Mode — connector tool deferral", () => {
  it("registers connector tools as not deferred when deferToolSchemas is false (default)", async () => {
    const registry = new ToolRegistry();
    const config: GodModeConfig = {
      enabled: true,
      autoApproveRiskThreshold: 20,
      connectors: {},
      // deferToolSchemas omitted → defaults to false
    };

    const conn = makeConnector("msp", ["msp_isolate", "msp_status"]);
    await connectGodMode(registry, config, [conn]);

    const isolate = registry.get("msp_isolate");
    const status = registry.get("msp_status");
    expect(isolate?.deferred).toBeFalsy();
    expect(status?.deferred).toBeFalsy();

    // Both should be visible to the model immediately
    const visible = registry.toAISDKTools();
    expect(Object.keys(visible)).toEqual(
      expect.arrayContaining(["msp_isolate", "msp_status"]),
    );
  });

  it("registers connector tools as deferred when deferToolSchemas is true", async () => {
    const registry = new ToolRegistry();
    const config: GodModeConfig = {
      enabled: true,
      autoApproveRiskThreshold: 20,
      connectors: {},
      deferToolSchemas: true,
    };

    const conn = makeConnector("msp", ["msp_isolate", "msp_status"]);
    await connectGodMode(registry, config, [conn]);

    const isolate = registry.get("msp_isolate");
    const status = registry.get("msp_status");
    expect(isolate?.deferred).toBe(true);
    expect(status?.deferred).toBe(true);

    // toAISDKTools must NOT include them — they're hidden until resolved
    const visible = registry.toAISDKTools();
    expect(visible["msp_isolate"]).toBeUndefined();
    expect(visible["msp_status"]).toBeUndefined();

    // listDeferred must surface them so tool_search can find them
    const deferred = registry.listDeferred();
    const names = deferred.map((d) => d.name);
    expect(names).toEqual(
      expect.arrayContaining(["msp_isolate", "msp_status"]),
    );
  });

  it("resolves a deferred connector tool via resolveDeferred", async () => {
    const registry = new ToolRegistry();
    const config: GodModeConfig = {
      enabled: true,
      autoApproveRiskThreshold: 20,
      connectors: {},
      deferToolSchemas: true,
    };

    await connectGodMode(registry, config, [
      makeConnector("vm", ["vm_create", "vm_destroy"]),
    ]);

    // Initially hidden
    expect(registry.toAISDKTools()["vm_create"]).toBeUndefined();

    // Resolve one of them
    const ok = registry.resolveDeferred("vm_create");
    expect(ok).toBe(true);

    // Now visible; the other stays hidden
    const visible = registry.toAISDKTools();
    expect(visible["vm_create"]).toBeDefined();
    expect(visible["vm_destroy"]).toBeUndefined();
  });

  it("ChangeSet meta-tools are always available (never deferred)", async () => {
    const registry = new ToolRegistry();
    const config: GodModeConfig = {
      enabled: true,
      autoApproveRiskThreshold: 20,
      connectors: {},
      deferToolSchemas: true,
    };

    await connectGodMode(registry, config, [
      makeConnector("msp", ["msp_isolate"]),
    ]);

    // Connector tool is hidden
    expect(registry.toAISDKTools()["msp_isolate"]).toBeUndefined();

    // ChangeSet tools are visible — they're registered after the deferral pass
    const visible = registry.toAISDKTools();
    expect(visible["gm_changeset_approve"]).toBeDefined();
    expect(visible["gm_changeset_reject"]).toBeDefined();
    expect(visible["gm_changeset_list"]).toBeDefined();
  });
});

// ── Prompt addendum ──────────────────────────────────────────────

describe("Code Mode — prompt addendum", () => {
  const connectedSystems = [
    {
      name: "msp",
      displayName: "BrainstormMSP",
      capabilities: ["endpoint-management" as const],
      latencyMs: 25,
      toolCount: 5,
    },
  ];

  it("does NOT mention tool_search when deferToolSchemas is false", () => {
    const config: GodModeConfig = {
      enabled: true,
      autoApproveRiskThreshold: 20,
      connectors: {},
    };
    const result = buildGodModePrompt(connectedSystems, config);
    expect(result.text).not.toContain("Tool Discovery");
    expect(result.text).not.toContain("tool_search");
  });

  it("instructs the model to use tool_search when deferToolSchemas is true", () => {
    const config: GodModeConfig = {
      enabled: true,
      autoApproveRiskThreshold: 20,
      connectors: {},
      deferToolSchemas: true,
    };
    const result = buildGodModePrompt(connectedSystems, config);
    expect(result.text).toContain("Tool Discovery");
    expect(result.text).toContain("tool_search");
    expect(result.text).toContain("gm_changeset_");
  });
});
