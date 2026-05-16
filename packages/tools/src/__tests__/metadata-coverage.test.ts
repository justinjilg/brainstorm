/**
 * Gate test — every built-in tool must have a metadata entry in the
 * canonical table, and inline declarations on built-ins must agree
 * with the canonical entry.
 *
 * This is the brainstorm-side equivalent of BrainstormRouter's
 * `_no-inline-routes.test.ts` gate. The lockstep promise is: once a
 * tool gets added to `createDefaultToolRegistry()`, it MUST also
 * appear in `BUILTIN_TOOL_METADATA` — inline-only metadata bypasses
 * the central source of truth and re-creates the drift the table
 * exists to prevent. (Plugin tools, which are not in
 * `createDefaultToolRegistry`, are free to declare inline; they're
 * not the lockstep target.)
 *
 * Failure modes caught:
 *   1. Adding a tool to the registry without an `_metadata.ts` entry
 *      (regardless of whether `defineTool` got inline metadata).
 *   2. A built-in tool inline-declaring a value that DISAGREES with
 *      the canonical table (silent override).
 *   3. A tool whose category is the fallback `"other"`.
 *   4. A tool whose headlessSafe declaration is missing entirely.
 *   5. A tool whose schema can't be expressed through `toMCPTool`.
 */

import { describe, it, expect } from "vitest";
import { createDefaultToolRegistry } from "../index.js";
import {
  resolveToolMetadata,
  BUILTIN_TOOL_METADATA,
  BUILTIN_TOOL_NAMES,
} from "../builtin/_metadata.js";
import { toMCPTool } from "../mcp-generator.js";

describe("built-in tool metadata coverage", () => {
  it("every registered built-in tool name appears in BUILTIN_TOOL_METADATA", () => {
    const registry = createDefaultToolRegistry({ daemon: true });
    const missing: string[] = [];

    for (const tool of registry.getAll()) {
      if (!BUILTIN_TOOL_NAMES.has(tool.name)) {
        missing.push(tool.name);
      }
    }

    if (missing.length > 0) {
      throw new Error(
        `Built-in tools missing from BUILTIN_TOOL_METADATA (add entries to packages/tools/src/builtin/_metadata.ts):\n  - ${missing.join("\n  - ")}`,
      );
    }
    expect(missing).toEqual([]);
  });

  it("inline metadata declarations on built-ins agree with canonical table", () => {
    // Catches silent overrides — e.g., a tool that declares
    // `headlessSafe: true` inline while the canonical entry says false.
    // resolveToolMetadata returns the conflicts; this test fails if any
    // surface.
    const registry = createDefaultToolRegistry({ daemon: true });
    const conflicts: string[] = [];

    for (const tool of registry.getAll()) {
      const resolved = resolveToolMetadata(tool.name, {
        category: tool.category,
        headlessSafe: tool.headlessSafe,
        protocol: tool.protocol,
        tags: tool.tags,
      });
      if (!resolved) continue;
      for (const c of resolved.conflicts) {
        conflicts.push(
          `${tool.name}.${c.field}: inline=${JSON.stringify(c.inline)} canonical=${JSON.stringify(c.canonical)}`,
        );
      }
    }

    if (conflicts.length > 0) {
      throw new Error(
        `Built-in tools with inline/canonical metadata conflicts:\n  - ${conflicts.join("\n  - ")}\n\n` +
          `Either remove the inline override or update the canonical entry. Built-ins must not drift.`,
      );
    }
    expect(conflicts).toEqual([]);
  });

  it("every registered tool has a non-fallback category", () => {
    // A category of "other" is the resolveToolMetadata fallback. It
    // means metadata exists but the category field was left
    // unspecified — which silently buckets the tool in docs and the
    // catalog. Built-in tools must declare a real category.
    const registry = createDefaultToolRegistry({ daemon: true });
    const fallback: string[] = [];

    for (const tool of registry.getAll()) {
      const resolved = resolveToolMetadata(tool.name, {
        category: tool.category,
        headlessSafe: tool.headlessSafe,
        protocol: tool.protocol,
        tags: tool.tags,
      });
      if (!resolved || resolved.metadata.category === "other") {
        fallback.push(tool.name);
      }
    }

    expect(fallback).toEqual([]);
  });

  it("headlessSafe is declared (not just defaulted) for every tool", () => {
    // If a tool is in the registry but neither inline nor
    // BUILTIN_TOOL_METADATA declares headlessSafe, the runner can't
    // tell whether it's safe to invoke from `brainstorm run`. The
    // resolveToolMetadata fallback is fail-CLOSED (false), but that
    // would silently quarantine the tool from headless mode — also
    // bad. Force the declaration.
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

  it("toMCPTool produces a registration shape for every non-deferred tool", () => {
    // Deferred tools (those resolved at runtime via tool_search) carry
    // a placeholder schema until resolution; toMCPTool can't produce a
    // shape for them. Skip them in the gate but verify all eager tools
    // round-trip.
    const registry = createDefaultToolRegistry({ daemon: true });
    const failures: Array<{ name: string; error: string }> = [];

    for (const tool of registry.getAll()) {
      if (tool.deferred) continue;
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
