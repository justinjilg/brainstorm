/**
 * Platform contract snapshot gate (Stage-2 lockstep).
 *
 * Re-runs the contract compiler and asserts its outputs match the
 * committed vitest snapshot file. Without this gate, a schema change
 * in `packages/godmode/src/contract/schemas.ts` could land without
 * the corresponding snapshot regeneration — the test suite catches
 * it, but the build (which the preflight gates) does not, until
 * someone runs `npm test`.
 *
 * The gate is structural, not a literal snapshot diff: vitest
 * snapshots have their own format. Instead we:
 *   1. Run `compileContract()` to produce the current outputs.
 *   2. Assert each generator emitted the expected number of
 *      artifacts and that core invariants hold (endpoint registry
 *      stable, no empty markdown sections, JSON Schema has every
 *      endpoint, validator plan has the right shape).
 *
 * The vitest snapshot test remains the source of truth for exact
 * content; this gate is the structural floor that ships with the
 * build.
 */

import { existsSync } from "node:fs";
import * as path from "node:path";

export async function check({ repoRoot }) {
  const issues = [];

  const distEntry = path.join(repoRoot, "packages/godmode/dist/index.js");
  if (!existsSync(distEntry)) {
    return {
      name: "contract-snapshots",
      ok: false,
      issues: [
        `@brainst0rm/godmode dist missing — run \`npx turbo run build --filter=@brainst0rm/godmode\` first.`,
      ],
    };
  }

  const godmode = await import(distEntry);
  const { compileContract, PLATFORM_ENDPOINTS } = godmode;
  if (typeof compileContract !== "function") {
    return {
      name: "contract-snapshots",
      ok: false,
      issues: [
        "@brainst0rm/godmode does not export `compileContract`. Stage-2 regression.",
      ],
    };
  }

  const output = compileContract();
  const endpointIds = new Set(PLATFORM_ENDPOINTS.map((e) => e.id));

  // Invariant 1: every endpoint produces a markdown section.
  if (output.markdown.length !== PLATFORM_ENDPOINTS.length) {
    issues.push(
      `markdown generator emitted ${output.markdown.length} sections for ${PLATFORM_ENDPOINTS.length} endpoints.`,
    );
  }
  for (const section of output.markdown) {
    if (!section.markdown || section.markdown.length === 0) {
      issues.push(`markdown section for ${section.id} is empty.`);
    }
    if (!endpointIds.has(section.id)) {
      issues.push(`markdown section ${section.id} has no matching endpoint.`);
    }
  }

  // Invariant 2: JSON Schema bundle has every endpoint.
  for (const ep of PLATFORM_ENDPOINTS) {
    if (!output.jsonSchema.endpoints[ep.id]) {
      issues.push(`JSON Schema bundle missing endpoint "${ep.id}".`);
    }
  }

  // Invariant 3: validator plan covers every endpoint with sane shape.
  if (output.validator.length !== PLATFORM_ENDPOINTS.length) {
    issues.push(
      `validator emitted ${output.validator.length} plans for ${PLATFORM_ENDPOINTS.length} endpoints.`,
    );
  }
  for (const plan of output.validator) {
    if (!plan.acceptStatuses || plan.acceptStatuses.length === 0) {
      issues.push(`validator plan ${plan.id} has empty acceptStatuses.`);
    }
    if (typeof plan.validateResponseBody !== "function") {
      issues.push(`validator plan ${plan.id} has no validateResponseBody.`);
    }
  }

  // Invariant 4: pydantic + go stubs exist (architecture wired even
  // though emission is deferred to Stage-2b).
  if (!output.pydantic || output.pydantic.length === 0) {
    issues.push("pydantic generator returned no files (architecture broken).");
  }
  if (!output.go || output.go.length === 0) {
    issues.push("go generator returned no files (architecture broken).");
  }

  return {
    name: "contract-snapshots",
    ok: issues.length === 0,
    issues,
    note: `${PLATFORM_ENDPOINTS.length} endpoints, ${output.markdown.length} markdown + ${Object.keys(output.jsonSchema.endpoints).length} json-schema + ${output.validator.length} validator plans`,
  };
}
