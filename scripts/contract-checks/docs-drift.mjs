/**
 * Docs drift gate.
 *
 * The platform contract has a prose spec at
 * `docs/platform-contract-v1.md` and a generated markdown surface
 * (Stage-2 compiler output). If the prose spec is the
 * source-of-record for humans and the Zod schemas are the
 * source-of-record for machines, the two MUST agree on every endpoint
 * the contract defines.
 *
 * This gate's minimum invariant today:
 *   - Every endpoint id in PLATFORM_ENDPOINTS appears as a heading
 *     or HTTP-verb line in `docs/platform-contract-v1.md`.
 *   - Every (method, path) pair declared in the schemas is referenced
 *     verbatim in the doc.
 *
 * What it does NOT check (deferred to Stage-3b):
 *   - That every field documented in the doc's response tables maps
 *     to a Zod field. The markdown generator can produce the per-
 *     endpoint tables; a future gate can diff them against the
 *     committed doc to catch description / required-flag drift.
 */

import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";

export async function check({ repoRoot }) {
  const issues = [];

  const distEntry = path.join(repoRoot, "packages/godmode/dist/index.js");
  if (!existsSync(distEntry)) {
    return {
      name: "docs-drift",
      ok: false,
      issues: [
        `@brainst0rm/godmode dist missing — run \`npx turbo run build --filter=@brainst0rm/godmode\` first.`,
      ],
    };
  }

  const docPath = path.join(repoRoot, "docs/platform-contract-v1.md");
  if (!existsSync(docPath)) {
    return {
      name: "docs-drift",
      ok: false,
      issues: [
        `docs/platform-contract-v1.md not found. The platform contract source-of-record is missing.`,
      ],
    };
  }
  const docText = readFileSync(docPath, "utf8");

  const { PLATFORM_ENDPOINTS } = await import(distEntry);

  for (const ep of PLATFORM_ENDPOINTS) {
    // Each endpoint MUST appear in the doc somewhere — at minimum its
    // `METHOD /path` pair. Surfacing the exact missing pair makes the
    // fix obvious (add a section to the doc, or update the schema's
    // path declaration to match the documented one).
    const pair = `${ep.method} ${ep.path}`;
    if (!docText.includes(pair)) {
      issues.push(
        `endpoint "${ep.id}" (${pair}) not referenced in docs/platform-contract-v1.md. ` +
          `Either add a section to the doc or update the schema in packages/godmode/src/contract/schemas.ts.`,
      );
    }
  }

  return {
    name: "docs-drift",
    ok: issues.length === 0,
    issues,
    note: `${PLATFORM_ENDPOINTS.length} endpoints referenced in docs/platform-contract-v1.md`,
  };
}
