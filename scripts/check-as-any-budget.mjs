#!/usr/bin/env node
/**
 * check-as-any-budget — cap the number of `as any` escape hatches in
 * production code so the type system keeps telling the truth.
 *
 * Why this exists: the v9 stochastic assessment (docs/assessment-*.md)
 * had 8 of 10 agents flag `as any` growth as the top consensus risk.
 * Raw counts between rounds had varied (274 / 295 / 309 depending on
 * who ran which grep with which filters), so no one could tell whether
 * the trend was drift or genuine type-safety erosion. This script
 * gives a fixed, reproducible count and a committed ceiling.
 *
 * The budget (AS_ANY_BUDGET below) is NOT a target — it's a ratchet.
 * When you legitimately need to reduce it, bump the constant down AND
 * land the code that let you do so in the same PR. CI fails if the
 * current count exceeds the budget, so you can't silently regress.
 *
 * Not a substitute for an AST-aware lint rule (ts-prune, ts-unused,
 * or a custom ESLint rule against TSAsExpression with `any`). But
 * cheap, fast, and catches the exact shape the assessment round
 * flagged.
 */

import { execFileSync } from "node:child_process";

const AS_ANY_BUDGET = 285;
// 2026-04-18 (post-v9): raw count was 291 with gratuitous Zod-enum
// casts in packages/cli/src/bin/brainstorm.ts removed to reach 285.
// v8 baseline was 274 (3 days earlier). The +11 delta is the combined
// drift of reliability passes 16–21; the categorized audit is at
// docs/as-any-audit.md. Do NOT raise this without a commit that
// justifies each new escape hatch.

// grep is available on every dev + CI box; avoids pulling a parser
// dep just to count lines. --exclude-dir guards against the
// accidental `node_modules` hit the v9 Auditor caught.
function count() {
  try {
    const out = execFileSync(
      "grep",
      [
        "-rn",
        "as any",
        "packages/",
        "apps/",
        "--include=*.ts",
        "--include=*.tsx",
        "--exclude-dir=node_modules",
        "--exclude-dir=dist",
      ],
      { encoding: "utf-8" },
    );
    // Strip test + spec files. Production surface only — test code can
    // legitimately use `as any` to coerce mocks or exercise invalid
    // payloads, and policing that would be noise.
    const lines = out.split("\n").filter((line) => {
      if (!line) return false;
      if (line.includes(".test.")) return false;
      if (line.includes(".spec.")) return false;
      return true;
    });
    return lines.length;
  } catch (err) {
    // grep exits 1 when no match found — count is 0.
    if (err.status === 1) return 0;
    throw err;
  }
}

const actual = count();
if (actual > AS_ANY_BUDGET) {
  console.error(
    `as-any budget exceeded: ${actual} > ${AS_ANY_BUDGET}.\n` +
      `Either fix ${actual - AS_ANY_BUDGET} escape hatch(es) or, if the new\n` +
      `casts are legitimate, raise AS_ANY_BUDGET in scripts/check-as-any-budget.mjs\n` +
      `and document the reason in the commit.`,
  );
  process.exit(1);
}
// Log the slack so it's visible in CI output — lets us notice
// asymmetric trends without a failure.
const slack = AS_ANY_BUDGET - actual;
console.log(
  `as-any budget: ${actual}/${AS_ANY_BUDGET} (${slack} under budget)`,
);
