/**
 * Tool-name reference audit gate.
 *
 * The Stage-1 review (codex) flagged three hand-maintained
 * tool-name-keyed tables outside `BUILTIN_TOOL_METADATA` that all
 * encode subsets/groupings of the same canonical tool list:
 *
 *   - `packages/core/src/agent/context.ts` — `TOOL_CATEGORIES`
 *     (prompt-awareness grouping for the model)
 *   - `packages/core/src/plan/mode.ts` — `READ_ONLY_TOOLS`
 *     (plan-mode tool allowlist)
 *   - `packages/tools/src/progressive.ts` — `TIER_TOOLS`
 *     (minimal/standard/full tier inclusion)
 *
 * Drift mode they care about: a tool gets renamed or removed from
 * `BUILTIN_TOOL_METADATA`, but the hand-table still references the
 * old name. Plan mode silently loses access; prompt awareness silently
 * uncategorises; tier inclusion silently misses tools.
 *
 * The gate parses each table's tool-name array from source and
 * asserts every string is a known tool in `BUILTIN_TOOL_METADATA`.
 * It does NOT enforce the reverse direction (every tool in
 * BUILTIN_TOOL_METADATA must appear in every table) because the
 * tables are intentional subsets — e.g. `daemon_sleep` shouldn't
 * appear in prompt awareness, plan mode, or tier-minimal. The gate
 * surfaces uncovered tools as informational `note`, not failures.
 */

import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";

const REFERENCE_FILES = [
  {
    path: "packages/core/src/agent/context.ts",
    table: "TOOL_CATEGORIES",
    description: "prompt-awareness grouping",
  },
  {
    path: "packages/core/src/plan/mode.ts",
    table: "READ_ONLY_TOOLS",
    description: "plan-mode allowlist",
  },
  {
    path: "packages/tools/src/progressive.ts",
    table: "TIER_TOOLS",
    description: "minimal/standard/full tier inclusion",
  },
];

/**
 * Extract tool-name string literals from a TypeScript declaration
 * named `decl`. We don't try to parse JavaScript — we find the
 * declaration's `{`, then walk forward through balanced braces
 * accumulating every `"identifier"` and `'identifier'` string. Tool
 * names are simple lower-snake-case so we filter to that shape.
 */
function extractIdentifierStrings(src, decl) {
  const declIdx = src.indexOf(decl);
  if (declIdx === -1) return null;
  // Skip past the `=` sign so we don't lock onto a type annotation's
  // brackets (`Record<string, string[]>` contains `[`/`]` BEFORE the
  // actual value). Then find the next `{`, `[`, or `(`.
  const eqIdx = src.indexOf("=", declIdx);
  if (eqIdx === -1) return null;
  const openIdx = Math.min(
    ...["{", "[", "("]
      .map((c) => src.indexOf(c, eqIdx))
      .filter((i) => i !== -1),
  );
  if (!Number.isFinite(openIdx) || openIdx === -1) return null;

  // Walk forward maintaining a brace+bracket+paren depth counter.
  // Stop when depth returns to 0.
  const opener = src[openIdx];
  const closer = { "{": "}", "[": "]", "(": ")" }[opener];
  let depth = 1;
  let i = openIdx + 1;
  while (i < src.length && depth > 0) {
    const ch = src[i];
    if (ch === opener) depth++;
    else if (ch === closer) depth--;
    i++;
  }
  const body = src.slice(openIdx + 1, i - 1);

  // Extract every string literal in the body. Tool names are
  // lower-snake-case identifiers; anything else is metadata
  // (category labels like "Filesystem", error messages, etc.) and
  // safely ignored.
  const strings = [];
  for (const m of body.matchAll(/["']([a-z][a-z0-9_]*)["']/g)) {
    strings.push(m[1]);
  }
  return strings;
}

export async function check({ repoRoot }) {
  const issues = [];

  // Load BUILTIN_TOOL_METADATA from the built dist (same path the
  // Stage-1 gate uses).
  const distEntry = path.join(repoRoot, "packages/tools/dist/index.js");
  if (!existsSync(distEntry)) {
    return {
      name: "tool-name-references",
      ok: false,
      issues: [
        `@brainst0rm/tools dist missing — run \`npx turbo run build --filter=@brainst0rm/tools\` first.`,
      ],
    };
  }
  const { BUILTIN_TOOL_NAMES } = await import(distEntry);
  if (!BUILTIN_TOOL_NAMES) {
    return {
      name: "tool-name-references",
      ok: false,
      issues: [
        "@brainst0rm/tools does not export BUILTIN_TOOL_NAMES. Stage-1 regression.",
      ],
    };
  }

  const referencedTools = new Set();

  for (const ref of REFERENCE_FILES) {
    const abs = path.join(repoRoot, ref.path);
    if (!existsSync(abs)) {
      issues.push(`${ref.path}: file missing — cannot audit ${ref.table}.`);
      continue;
    }
    const src = readFileSync(abs, "utf8");
    const names = extractIdentifierStrings(src, ref.table);
    if (names === null) {
      issues.push(
        `${ref.path}: could not locate declaration "${ref.table}". ` +
          `Either rename the table back or update tool-name-references.mjs to track the new name.`,
      );
      continue;
    }

    // Filter out non-tool identifiers. The extractor is generous —
    // it picks up any lower-snake-case string. False positives like
    // `error`, `info`, `data` are common; we only assert that
    // strings matching the tool-name shape (contain `_` or are
    // multi-char) and that AREN'T already known to belong elsewhere
    // are valid tool names. Simple heuristic: a name is a tool name
    // candidate if it appears as a key in BUILTIN_TOOL_METADATA OR
    // if it doesn't match common non-tool words.
    // Strings that appear in the audited tables but aren't tool
    // names — primarily object keys (TIER_TOOLS uses minimal/
    // standard/full as keys) and stray identifiers from comments.
    const NON_TOOL_WORDS = new Set([
      // TIER_TOOLS object keys
      "minimal",
      "standard",
      "full",
      // Common stray identifiers that may show up in nearby strings
      "auto",
      "confirm",
      "deny",
    ]);

    // Tools that legitimately exist but aren't in
    // BUILTIN_TOOL_METADATA because they're dynamically registered
    // at runtime (subagent is wired only when the agent loop creates
    // a sub-agent; it doesn't appear in createDefaultToolRegistry).
    // The reference in TOOL_CATEGORIES is correct — the registry
    // just doesn't carry it. Add to this allowlist when introducing
    // another dynamically-registered tool that legitimately appears
    // in a reference table.
    const CONDITIONAL_TOOLS = new Set(["subagent"]);

    for (const name of names) {
      if (NON_TOOL_WORDS.has(name)) continue;
      referencedTools.add(name);

      if (
        !BUILTIN_TOOL_NAMES.has(name) &&
        !CONDITIONAL_TOOLS.has(name)
      ) {
        issues.push(
          `${ref.path}:${ref.table} references tool "${name}" but no such tool exists in BUILTIN_TOOL_METADATA. ` +
            `Either remove the reference (tool was deleted/renamed), add the tool to packages/tools/src/builtin/_metadata.ts, ` +
            `or — if the tool is dynamically registered at runtime — add it to CONDITIONAL_TOOLS in this gate.`,
        );
      }
    }
  }

  // Informational: tools that exist in BUILTIN_TOOL_METADATA but
  // aren't referenced by any of the audited tables. Not necessarily
  // wrong (daemon_sleep, code_*, br_health probably shouldn't appear
  // in prompt awareness or plan mode), but a useful telemetry signal.
  const orphans = [];
  for (const name of BUILTIN_TOOL_NAMES) {
    if (!referencedTools.has(name)) orphans.push(name);
  }

  return {
    name: "tool-name-references",
    ok: issues.length === 0,
    issues,
    note: `${REFERENCE_FILES.length} tables audited, ${referencedTools.size} tool refs, ${orphans.length} tools uncovered by any table`,
  };
}
