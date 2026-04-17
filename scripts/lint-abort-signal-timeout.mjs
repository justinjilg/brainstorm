#!/usr/bin/env node
/**
 * lint-abort-signal-timeout — fail the build when source code races
 * against `AbortSignal.timeout(...)` without cleanup.
 *
 * Pass 2 and Pass 3 of the quality scan both found multiple instances
 * of the same bug: `AbortSignal.timeout(ms)` is stored in a local,
 * wired to `addEventListener("abort", reject)`, and then the listener
 * is never removed — even after the race has been won by the other
 * promise in the `Promise.race`. Every win leaks a node in the
 * AbortSignal's internal listener list, which the GC can't reclaim
 * until the signal itself is collected (which for a long-lived signal
 * is effectively never).
 *
 * The safe patterns are either:
 *
 *   const signal = AbortSignal.timeout(ms);
 *   signal.addEventListener("abort", reject, { once: true });
 *
 * or, if you need to clean up a non-once listener explicitly:
 *
 *   const signal = AbortSignal.timeout(ms);
 *   const onAbort = () => reject(...);
 *   signal.addEventListener("abort", onAbort);
 *   try { ... } finally { signal.removeEventListener("abort", onAbort); }
 *
 * This script scans every .ts file under packages/** and apps/**, and
 * for each file that imports/uses `AbortSignal.timeout(` it checks that
 * the file also contains either `{ once: true }` or a matching
 * `removeEventListener(`. Exits non-zero if any file fails the check.
 *
 * Not a substitute for an AST-aware ESLint rule, but cheap, fast, and
 * catches the exact shape we've been regressing.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();
const SEARCH_DIRS = ["packages", "apps"];
const IGNORE_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  "coverage",
  "release",
  ".next",
  ".turbo",
]);

/** Walk a directory tree and yield every .ts / .tsx path (skipping tests). */
function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (IGNORE_DIRS.has(name)) continue;
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      yield* walk(full);
    } else if (st.isFile()) {
      if (!/\.tsx?$/.test(name)) continue;
      if (name.endsWith(".d.ts")) continue;
      if (/__tests__|\.test\.|\.spec\./.test(full)) continue;
      yield full;
    }
  }
}

const offenders = [];

for (const dir of SEARCH_DIRS) {
  const root = join(ROOT, dir);
  for (const file of walk(root)) {
    const src = readFileSync(file, "utf-8");
    if (!src.includes("AbortSignal.timeout(")) continue;

    // Only care about files that actually wire an addEventListener for
    // the "abort" event — passing an AbortSignal directly into fetch()
    // / request() / tool.execute() as a `signal:` option never leaks.
    // This is the specific leak shape: explicit listener + manual race.
    if (!/addEventListener\s*\(\s*["']abort["']/.test(src)) continue;

    // Normalize whitespace so the balanced-parens body of a multiline
    // addEventListener() call collapses to a single line for matching.
    // Without this, a listener arrow fn containing `)` breaks any
    // `[^)]*` lookahead.
    const collapsed = src.replace(/\s+/g, " ");

    // Fast accept: either { once: true } on the abort listener, or a
    // matching removeEventListener("abort", ...) pair, or the shared
    // onAbort() helper (which owns listener lifecycle internally).
    const usesOnceTrue =
      /addEventListener\s*\(\s*["']abort["'][\s\S]*?\{[\s\S]*?once\s*:\s*true[\s\S]*?\}/.test(
        collapsed,
      );
    const usesRemoveListener = /removeEventListener\s*\(\s*["']abort["']/.test(
      collapsed,
    );
    const usesSharedOnAbort =
      /\bonAbort\s*\(/.test(collapsed) && /@brainst0rm\/shared/.test(collapsed);

    if (usesOnceTrue || usesRemoveListener || usesSharedOnAbort) continue;

    offenders.push(relative(ROOT, file));
  }
}

if (offenders.length === 0) {
  console.log(
    "✓ lint-abort-signal-timeout: no leaked AbortSignal.timeout listeners.",
  );
  process.exit(0);
}

console.error(
  `\n✗ lint-abort-signal-timeout: ${offenders.length} file(s) race against AbortSignal.timeout(...) without cleanup.\n`,
);
console.error(
  "Each file below calls AbortSignal.timeout(ms) and addEventListener(\"abort\", …) but",
);
console.error(
  'has no { once: true } option and no removeEventListener("abort", …) pair.',
);
console.error("This is the same leak class Pass 2 and Pass 3 kept finding.");
console.error("\nOffending files:");
for (const f of offenders) console.error(`  - ${f}`);
console.error(
  "\nFix: add { once: true } to the addEventListener call, or pair it with a",
);
console.error(
  "removeEventListener call inside the settling handler. See the docblock in",
);
console.error("scripts/lint-abort-signal-timeout.mjs for the accepted patterns.");
process.exit(1);
