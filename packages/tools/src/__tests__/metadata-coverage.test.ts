/**
 * Gate test — every built-in tool must have a metadata entry.
 *
 * This is the brainstorm-side equivalent of BrainstormRouter's
 * `_no-inline-routes.test.ts` gate. The lockstep promise is: once a tool
 * gets added to `createDefaultToolRegistry()`, it MUST also appear in
 * `builtin/_metadata.ts` (or declare its category/headlessSafe inline).
 * That's how docs/tool-catalog.json, MCP wrappers, and headless-runner
 * gates stay coherent without anyone hand-syncing N tables.
 *
 * Failure modes this test catches:
 *   1. Adding a tool to the registry without an `_metadata.ts` entry
 *   2. A tool whose category is left as the fallback "other"
 *   3. A tool whose headless-safety is undeclared (both inline and in
 *      the central table) — important because the headless runner
 *      treats this as a deadlock-risk signal
 */

import { describe, it, expect } from "vitest";
import { createDefaultToolRegistry } from "../index.js";
import {
  resolveToolMetadata,
  BUILTIN_TOOL_METADATA,
} from "../builtin/_metadata.js";
import { toMCPTool } from "../mcp-generator.js";

describe("built-in tool metadata coverage", () => {
  it("every registered tool has a resolvable metadata entry", () => {
    const registry = createDefaultToolRegistry({ daemon: true });
    const missing: string[] = [];

    for (const tool of registry.getAll()) {
      const meta = resolveToolMetadata(tool.name, {
        category: tool.category,
        headlessSafe: tool.headlessSafe,
        protocol: tool.protocol,
        tags: tool.tags,
      });
      if (!meta) {
        missing.push(tool.name);
      }
    }

    if (missing.length > 0) {
      throw new Error(
        `Tools missing metadata (add entries to packages/tools/src/builtin/_metadata.ts):\n  - ${missing.join("\n  - ")}`,
      );
    }
    expect(missing).toEqual([]);
  });

  it("every registered tool has a non-fallback category", () => {
    const registry = createDefaultToolRegistry({ daemon: true });
    const fallback: string[] = [];

    for (const tool of registry.getAll()) {
      const meta = resolveToolMetadata(tool.name, {
        category: tool.category,
        headlessSafe: tool.headlessSafe,
        protocol: tool.protocol,
        tags: tool.tags,
      });
      // `meta?.category === "other"` only happens if resolveToolMetadata
      // returned undefined and the export-catalog fallback ran. Anything
      // explicitly listed must be a real category.
      if (!meta || meta.category === "other") {
        fallback.push(tool.name);
      }
    }

    expect(fallback).toEqual([]);
  });

  it("headlessSafe is declared (not just defaulted) for every tool", () => {
    // If a tool is in the registry but neither inline nor BUILTIN_TOOL_METADATA
    // declares headlessSafe, the runner can't tell whether it's safe to invoke
    // from `brainstorm run`. Force the declaration.
    const registry = createDefaultToolRegistry({ daemon: true });
    const undeclared: string[] = [];

    for (const tool of registry.getAll()) {
      const inlineDeclared = typeof tool.headlessSafe === "boolean";
      const centralDeclared =
        typeof BUILTIN_TOOL_METADATA[tool.name]?.headlessSafe === "boolean";
      if (!inlineDeclared && !centralDeclared) {
        undeclared.push(tool.name);
      }
    }

    if (undeclared.length > 0) {
      throw new Error(
        `Tools without explicit headlessSafe declaration:\n  - ${undeclared.join("\n  - ")}`,
      );
    }
    expect(undeclared).toEqual([]);
  });

  it("toMCPTool produces a registration shape for every tool", () => {
    // The MCP generator is the canonical path for exposing local tools
    // via MCP. If it throws on any registered tool, that's a structural
    // regression — even tools that aren't currently exposed via MCP should
    // be expressible through this generator.
    const registry = createDefaultToolRegistry({ daemon: true });
    const failures: Array<{ name: string; error: string }> = [];

    for (const tool of registry.getAll()) {
      try {
        const mcp = toMCPTool(tool);
        expect(mcp.name).toMatch(/^[a-z0-9_]+$/);
        expect(mcp.description.length).toBeGreaterThan(0);
        expect(typeof mcp.paramShape).toBe("object");
      } catch (err) {
        failures.push({
          name: tool.name,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    expect(failures).toEqual([]);
  });
});
