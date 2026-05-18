/**
 * Tool metadata gate (Stage-1 lockstep).
 *
 * Mirrors `packages/tools/src/__tests__/metadata-coverage.test.ts` but
 * runs against the built dist so it works inside the contract
 * preflight (no vitest dependency).
 *
 * Failure modes caught:
 *   1. A tool is registered in `createDefaultToolRegistry()` but has
 *      no entry in `BUILTIN_TOOL_METADATA`.
 *   2. A built-in tool inline-declares metadata that conflicts with
 *      the canonical table (silent override).
 *   3. A tool resolves to category "other" (fallback bucket).
 *   4. `headlessSafe` is undeclared on any built-in tool.
 */

import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import * as path from "node:path";

export async function check({ repoRoot }) {
  const issues = [];

  // The built dist is what consumers see. If it doesn't exist, the
  // preflight is being run before `turbo run build` — that's expected
  // for the first build, but the metadata module is plain ESM and we
  // can still load it from source via tsx-style resolution. For now,
  // require the built dist; if missing, surface a clear "build me
  // first" hint instead of crashing.
  const distEntry = path.join(
    repoRoot,
    "packages/tools/dist/index.js",
  );
  if (!existsSync(distEntry)) {
    return {
      name: "tool-metadata",
      ok: false,
      issues: [
        `@brainst0rm/tools dist missing at ${distEntry}. Run \`npx turbo run build --filter=@brainst0rm/tools\` first.`,
      ],
    };
  }

  const toolsModule = await import(distEntry);
  const {
    createDefaultToolRegistry,
    BUILTIN_TOOL_METADATA,
    BUILTIN_TOOL_NAMES,
    resolveToolMetadata,
    toMCPTool,
  } = toolsModule;

  if (!createDefaultToolRegistry || !BUILTIN_TOOL_METADATA) {
    return {
      name: "tool-metadata",
      ok: false,
      issues: [
        "@brainst0rm/tools dist did not export the expected metadata surface. Stage-1 compiler regression?",
      ],
    };
  }

  const registry = createDefaultToolRegistry({ daemon: true });
  const tools = registry.getAll();

  // Gate 1: every registered tool name must appear in
  // BUILTIN_TOOL_METADATA. Inline declarations bypass the canonical
  // source-of-truth — that's the drift Stage-1's review caught.
  for (const tool of tools) {
    if (!BUILTIN_TOOL_NAMES.has(tool.name)) {
      issues.push(
        `${tool.name}: not in BUILTIN_TOOL_METADATA. Add an entry to packages/tools/src/builtin/_metadata.ts.`,
      );
    }
  }

  // Gate 2: inline declarations on built-ins must agree with the
  // canonical entry. The runtime resolver returns the conflict list.
  for (const tool of tools) {
    const resolved = resolveToolMetadata(tool.name, {
      category: tool.category,
      headlessSafe: tool.headlessSafe,
      protocol: tool.protocol,
      tags: tool.tags,
    });
    if (!resolved) continue;
    for (const c of resolved.conflicts) {
      issues.push(
        `${tool.name}.${c.field}: inline=${JSON.stringify(c.inline)} differs from canonical=${JSON.stringify(c.canonical)}.`,
      );
    }
  }

  // Gate 3: no tool may resolve to category "other".
  for (const tool of tools) {
    const resolved = resolveToolMetadata(tool.name, {
      category: tool.category,
      headlessSafe: tool.headlessSafe,
      protocol: tool.protocol,
      tags: tool.tags,
    });
    if (!resolved || resolved.metadata.category === "other") {
      issues.push(
        `${tool.name}: resolves to fallback category "other". Add a real category in _metadata.ts.`,
      );
    }
  }

  // Gate 4: headlessSafe must be explicitly declared (inline OR central).
  for (const tool of tools) {
    const inlineDeclared = typeof tool.headlessSafe === "boolean";
    const centralDeclared =
      typeof BUILTIN_TOOL_METADATA[tool.name]?.headlessSafe === "boolean";
    if (!inlineDeclared && !centralDeclared) {
      issues.push(
        `${tool.name}: no headlessSafe declaration. The runner can't tell whether this tool is safe to invoke from \`storm run\`.`,
      );
    }
  }

  // Gate 5: every non-deferred tool round-trips through toMCPTool.
  for (const tool of tools) {
    if (tool.deferred) continue;
    try {
      toMCPTool(tool);
    } catch (err) {
      issues.push(
        `${tool.name}: toMCPTool failed — ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return {
    name: "tool-metadata",
    ok: issues.length === 0,
    issues,
    note: `${tools.length} built-in tools checked`,
  };
}
