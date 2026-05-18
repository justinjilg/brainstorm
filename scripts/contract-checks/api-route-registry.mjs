/**
 * API route registry gate.
 *
 * The brainstorm IPC server (packages/server) exposes HTTP routes for
 * the desktop app and external clients. This is NOT the platform
 * contract — that lives in `packages/godmode/src/contract/schemas.ts`
 * and is enforced by `contract-snapshots.mjs` + `docs-drift.mjs`.
 * The IPC server has its own evolving surface; this gate locks it
 * down with the same pattern as the CLI subcommand registry.
 *
 * Routes in `server.ts` are declared in two syntactic shapes:
 *
 *   1. Literal paths:
 *      `if (path === "/api/v1/tools" && method === "GET")`
 *
 *   2. Parameterised paths (regex match):
 *      `const m = path.match(/^\/api\/v1\/changesets\/([^/]+)\/approve$/);
 *       if (m && method === "POST") ...`
 *
 * The Stage-3 review caught that this gate's original regex matched
 * only shape (1), so SEVEN production routes (changeset approve/
 * reject, conversation get/patch/delete/fork/handoff/sessions, memory
 * patch/delete) bypassed the gate entirely. Stage-3.5 extends
 * extraction to handle both shapes AND adds a counter-gate that
 * fails the build when a NEW shape appears in source that the
 * extractor doesn't recognise — drift-by-syntactic-novelty is no
 * longer free.
 */

import { readFileSync } from "node:fs";
import * as path from "node:path";

// Shape 1: literal path comparison.
const LITERAL_RE = /path === "([^"]+)" && method === "([A-Z]+)"/g;

// Shape 2: regex-matched path. Captures the OpenAPI-style path
// (parameter names from the variable name on the match line, e.g.
// `approveMatch` → segment named `id`). We canonicalise to
// `:param` form for the registry — names don't matter, positions do.
const PARAM_MATCH_RE =
  /const\s+(\w+)\s*=\s*path\.match\(\s*\/\^([^$]+?)\$\/[a-z]*\s*,?\s*\)?\s*;?\s*\n+\s*if\s*\(\s*\1\s*&&\s*method\s*===\s*"([A-Z]+)"\s*\)/g;

// Counter-gate: any `path.match(` or `path === ` occurrence that the
// two extractors above did NOT see. This is the "novelty alarm" — if
// someone adds a route via a helper or a different syntactic shape,
// this gate fails until either the extractor is extended or the
// new pattern is acknowledged.
const ANY_PATH_TEST_RE = /(?:path\.match\(|path === ")/g;

function escapeRegexToOpenApi(pattern) {
  // Convert `\/api\/v1\/things\/([^/]+)\/sub` → `/api/v1/things/:id/sub`.
  // Backslash-escaped slashes become literal slashes; capture groups
  // become `:id` (parameter name is irrelevant to route uniqueness).
  return pattern
    .replace(/\\\//g, "/")
    .replace(/\(\[\^\/\]\+\)/g, ":id")
    .replace(/\(\.\+\)/g, ":rest");
}

export async function check({ repoRoot }) {
  const issues = [];

  const serverPath = path.join(repoRoot, "packages/server/src/server.ts");
  const registryPath = path.join(
    repoRoot,
    "scripts/contract-checks/api-route-registry.json",
  );

  let serverSrc;
  try {
    serverSrc = readFileSync(serverPath, "utf8");
  } catch (err) {
    return {
      name: "api-route-registry",
      ok: false,
      issues: [
        `cannot read server source at ${serverPath}: ${err instanceof Error ? err.message : String(err)}`,
      ],
    };
  }

  let registry;
  try {
    registry = JSON.parse(readFileSync(registryPath, "utf8"));
  } catch (err) {
    return {
      name: "api-route-registry",
      ok: false,
      issues: [
        `cannot read registry at ${registryPath}: ${err instanceof Error ? err.message : String(err)}`,
      ],
    };
  }

  // Build source-of-truth from BOTH shapes.
  const sourceRoutes = new Set();
  const matchedSpans = []; // ranges of source consumed by an extractor

  for (const m of serverSrc.matchAll(LITERAL_RE)) {
    sourceRoutes.add(`${m[2]} ${m[1]}`);
    matchedSpans.push([m.index, m.index + m[0].length]);
  }

  for (const m of serverSrc.matchAll(PARAM_MATCH_RE)) {
    const openApiPath = escapeRegexToOpenApi(m[2]);
    sourceRoutes.add(`${m[3]} ${openApiPath}`);
    matchedSpans.push([m.index, m.index + m[0].length]);

    // A single match-statement can be followed by additional `if (m
    // && method === "OTHER")` lines for other verbs on the same
    // parameterised path. Walk forward up to ~10 lines looking for
    // those.
    const tail = serverSrc.slice(m.index + m[0].length, m.index + m[0].length + 1500);
    const additionalVerbRe = new RegExp(
      `if\\s*\\(\\s*${m[1]}\\s*&&\\s*method\\s*===\\s*"([A-Z]+)"\\s*\\)`,
      "g",
    );
    for (const v of tail.matchAll(additionalVerbRe)) {
      sourceRoutes.add(`${v[1]} ${openApiPath}`);
    }
  }

  // Counter-gate: every literal `path.match(` or `path === ` in
  // source should fall inside one of the matched spans. If a hit
  // falls OUTSIDE every extractor's range, we have an unrecognised
  // pattern.
  for (const m of serverSrc.matchAll(ANY_PATH_TEST_RE)) {
    const hit = m.index;
    const consumed = matchedSpans.some(([s, e]) => hit >= s && hit < e);
    if (!consumed) {
      // Find the line for diagnostics.
      const lineStart = serverSrc.lastIndexOf("\n", hit) + 1;
      const lineEnd = serverSrc.indexOf("\n", hit);
      const line = serverSrc.slice(lineStart, lineEnd === -1 ? undefined : lineEnd).trim();
      issues.push(
        `unrecognised path-test syntax in server.ts: "${line}". ` +
          `Extend api-route-registry.mjs's extractors to cover this shape.`,
      );
    }
  }

  const registeredRoutes = new Set(
    (registry.routes ?? []).map((r) => `${r.method} ${r.path}`),
  );
  const knownCategories = new Set(Object.keys(registry._categories ?? {}));

  for (const route of sourceRoutes) {
    if (!registeredRoutes.has(route)) {
      issues.push(
        `server.ts exposes route "${route}" but it's not in the registry. ` +
          `Add it to scripts/contract-checks/api-route-registry.json with a category.`,
      );
    }
  }

  for (const route of registeredRoutes) {
    if (!sourceRoutes.has(route)) {
      issues.push(
        `registry lists route "${route}" but no source declaration matches. ` +
          `Remove the registry entry or restore the route.`,
      );
    }
  }

  for (const r of registry.routes ?? []) {
    if (!r.category) {
      issues.push(
        `route "${r.method} ${r.path}" has no category field. Every route must be categorised.`,
      );
      continue;
    }
    if (!knownCategories.has(r.category)) {
      issues.push(
        `route "${r.method} ${r.path}" categorised as "${r.category}" but no such category is documented in _categories. ` +
          `Pick a known category or document this new one.`,
      );
    }
  }

  return {
    name: "api-route-registry",
    ok: issues.length === 0,
    issues,
    note: `${sourceRoutes.size} source routes (${[...sourceRoutes].filter((r) => r.includes(":")).length} parameterised) · ${registeredRoutes.size} registered`,
  };
}
