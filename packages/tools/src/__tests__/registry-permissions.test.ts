import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineTool } from "../base.js";
import { ToolRegistry } from "../registry.js";

describe("ToolRegistry permission wrapper", () => {
  it("rejects duplicate tool names unless override is explicit", async () => {
    const registry = new ToolRegistry();
    const first = defineTool({
      name: "shell",
      description: "Original shell",
      permission: "confirm",
      inputSchema: z.object({}),
      async execute() {
        return { value: "first" };
      },
    });
    const shadow = defineTool({
      name: "shell",
      description: "Shadow shell",
      permission: "auto",
      inputSchema: z.object({}),
      async execute() {
        return { value: "shadow" };
      },
    });

    registry.register(first);

    expect(() => registry.register(shadow)).toThrow(/already registered/);

    registry.register(shadow, { override: true });
    expect(registry.get("shell")).toBe(shadow);
  });

  it("does not execute confirm-class tools without explicit approval", async () => {
    const registry = new ToolRegistry();
    let executed = false;

    registry.register(
      defineTool({
        name: "dangerous_write",
        description: "Dangerous write",
        permission: "confirm",
        inputSchema: z.object({}),
        async execute() {
          executed = true;
          return { success: true };
        },
      }),
    );

    const tools = registry.toAISDKToolsWithPermissions(() => "confirm");
    const result = await (tools.dangerous_write as any).execute({}, {});

    expect(executed).toBe(false);
    expect(result.ok).toBe(false);
    expect(result.blocked).toBe(true);
    expect(result.needsConfirmation).toBe(true);
    expect(result.permissionDecision).toBe("confirm");
  });

  it("does not execute MCP-style tools that return confirm", async () => {
    const registry = new ToolRegistry();
    let executed = false;

    registry.register({
      name: "mcp_dangerous_write",
      description: "MCP dangerous write",
      permission: "confirm",
      execute: async () => {
        executed = true;
        return { success: true };
      },
      toAISDKTool: () =>
        ({
          description: "MCP dangerous write",
          execute: async () => {
            executed = true;
            return { success: true };
          },
        }) as any,
    } as any);

    const tools = registry.toAISDKToolsWithPermissions(() => "confirm");
    const result = await (tools.mcp_dangerous_write as any).execute({}, {});

    expect(executed).toBe(false);
    expect(result.ok).toBe(false);
    expect(result.blocked).toBe(true);
    expect(result.needsConfirmation).toBe(true);
  });

  it("executes auto tools when permission check allows them", async () => {
    const registry = new ToolRegistry();
    let executed = false;

    registry.register(
      defineTool({
        name: "safe_read",
        description: "Safe read",
        permission: "auto",
        inputSchema: z.object({}),
        async execute() {
          executed = true;
          return { value: "ok" };
        },
      }),
    );

    const tools = registry.toAISDKToolsWithPermissions(() => "allow");
    const result = await (tools.safe_read as any).execute({}, {});

    expect(executed).toBe(true);
    expect(result.ok).toBe(true);
    expect(result.value).toBe("ok");
  });
});
