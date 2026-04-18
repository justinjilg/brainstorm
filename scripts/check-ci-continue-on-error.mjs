#!/usr/bin/env node
/**
 * check-ci-continue-on-error — cap `continue-on-error: true` in the
 * workflow so soft-fail debt doesn't accrue silently.
 *
 * Why this exists: the `continue-on-error: true` mechanism in GitHub
 * Actions turns a failing step into a passing one. Useful in rare,
 * well-documented cases (known-flaky external dependencies, optional
 * post-merge artifacts). Toxic when used as a cover story for bugs
 * no one is investigating — and that's exactly what happened here.
 *
 * In the 5 rounds leading up to 711e1cd, THREE independent steps
 * carried `continue-on-error: true`:
 *   1. "Run core tests" — rationale: "known CI env issue with
 *      memory paths" (turned out to be a myth — the step was being
 *      SKIPPED every run because an earlier step had failed; core
 *      tests were never actually running).
 *   2. "Run vault tests" — rationale: "slow Argon2id in CI" (also
 *      unverified — 5/5 tests passed the moment the step actually ran).
 *   3. "Verify tool catalog freshness" — rationale: "tool catalog
 *      drifts" (the check was literally impossible to pass because
 *      the generator wrote a timestamp on every run and the CI step
 *      used a non-normalizing diff).
 *
 * All three were real bugs hiding behind soft-fail. The lesson:
 * `continue-on-error: true` is a bug-concealment mechanism if no one
 * follows up. This ratchet makes it visible.
 *
 * Current budget: 0. Adding one requires bumping the budget in this
 * script AND documenting the specific failure mode AND providing a
 * planned-fix date. If you can't commit to all three, don't add the
 * soft-fail — fix the step.
 *
 * Running:
 *   node scripts/check-ci-continue-on-error.mjs
 */

import { readFileSync } from "node:fs";

const CI_YML_PATH = ".github/workflows/ci.yml";
const CONTINUE_ON_ERROR_BUDGET = 0;

const ci = readFileSync(CI_YML_PATH, "utf-8");

// Match "continue-on-error: true" (any indentation). Commented lines
// don't count — a line whose non-whitespace prefix is `#` is free to
// discuss the directive. The match is anchored to a line start to
// avoid catching the word inside another string.
const lines = ci.split("\n");
const violations = [];
for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  const stripped = line.trim();
  if (stripped.startsWith("#")) continue;
  if (/^continue-on-error:\s*true\b/.test(stripped)) {
    violations.push({ lineNum: i + 1, content: line });
  }
}

if (violations.length > CONTINUE_ON_ERROR_BUDGET) {
  console.error(
    `ci continue-on-error budget exceeded: ${violations.length} > ${CONTINUE_ON_ERROR_BUDGET}.`,
  );
  console.error(
    `\nSoft-fail steps hide bugs. Found ${violations.length} use(s) of\n` +
      `'continue-on-error: true' in ${CI_YML_PATH}:\n`,
  );
  for (const v of violations) {
    console.error(`  ${CI_YML_PATH}:${v.lineNum}  ${v.content.trim()}`);
  }
  console.error(
    `\nIf a soft-fail is genuinely required:\n` +
      `  1. Raise CONTINUE_ON_ERROR_BUDGET in scripts/check-ci-continue-on-error.mjs\n` +
      `  2. Document the failure mode + planned fix in the step's surrounding comment\n` +
      `  3. Cite the commit SHA where the soft-fail was added\n`,
  );
  process.exit(1);
}

const slack = CONTINUE_ON_ERROR_BUDGET - violations.length;
console.log(
  `ci continue-on-error budget: ${violations.length}/${CONTINUE_ON_ERROR_BUDGET} ` +
    `(${slack} under budget)`,
);
