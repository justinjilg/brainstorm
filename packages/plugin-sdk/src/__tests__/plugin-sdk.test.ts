/**
 * Plugin SDK tests — validates plugin definition helpers.
 */

import { describe, it, expect } from "vitest";
import { defineBrainstormPlugin, definePluginTool } from "../define.js";
import { z } from "zod";

describe("Plugin SDK", () => {
  it("defines a valid plugin", () => {
    const plugin = defineBrainstormPlugin({
      name: "test-plugin",
      version: "1.0.0",
      description: "A test plugin",
      tools: [],
      hooks: [],
    });
    expect(plugin.name).toBe("test-plugin");
    expect(plugin.version).toBe("1.0.0");
  });

  it("defines a plugin tool with schema", () => {
    const tool = definePluginTool({
      name: "my_tool",
      description: "Does something",
      permission: "auto",
      inputSchema: z.object({
        query: z.string(),
      }),
      execute: async (input) => ({ result: input.query }),
    });
    expect(tool.name).toBe("my_tool");
    expect(tool.description).toBe("Does something");
  });

  it("rejects plugin with empty name", () => {
    expect(() =>
      defineBrainstormPlugin({
        name: "",
        version: "1.0.0",
        description: "Bad plugin",
        tools: [],
        hooks: [],
      }),
    ).toThrow();
  });
});
