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
 * Gate logic:
 *   1. Walk packages/server/src/server.ts for every
 *      `path === "X" && method === "Y"` literal.
 *   2. Diff against `api-route-registry.json`.
 *   3. Fail on any unregistered route or stale registry entry.
 *
 * Note: this gate is brittle by design — it depends on the exact
 * `path === "X" && method === "Y"` shape. If the routing layer ever
 * adopts a real router framework, this regex becomes obsolete and
 * the gate needs to walk the framework's route table instead.
 */

import { readFileSync } from "node:fs";
import * as path from "node:path";

const ROUTE_RE = /path === "([^"]+)" && method === "([A-Z]+)"/g;

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

  // Build source-of-truth from source. Using matchAll for the global
  // iteration — avoids the brittleness of stateful regex iteration.
  const sourceRoutes = new Set();
  for (const m of serverSrc.matchAll(ROUTE_RE)) {
    sourceRoutes.add(`${m[2]} ${m[1]}`);
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
    note: `${sourceRoutes.size} source routes · ${registeredRoutes.size} registered`,
  };
}
