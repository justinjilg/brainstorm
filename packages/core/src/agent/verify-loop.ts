/**
 * In-loop verify / self-correction (Phase 3).
 *
 * After the agent completes an edit-producing turn, the loop runs a VERIFY
 * pass over the files that were changed THIS turn: typecheck always, and
 * (in "full" mode) the affected tests. On failure the diagnostics are fed
 * back into the agent loop as another turn so the model self-corrects within
 * the same run — the Cline/OpenHands single-agent analogue of the multi-agent
 * Judge's verifyWorktree gate.
 *
 * Design constraints (see loop.ts integration):
 *   - REUSE the established Judge verifyWorktree pattern: run build/test in a
 *     cwd via execFileSync, treat missing-deps as SKIP-not-fail (tri-state
 *     null), and never re-prompt the model over an environmental gap. The eval
 *     package's per-file verifiers (verifyTypeScriptCompiles / runTestFile)
 *     can't be imported here — @brainst0rm/eval depends on @brainst0rm/core,
 *     so importing them back would create a build cycle — but this module
 *     mirrors their execFileSync-with-timeout shape exactly.
 *   - DEGRADE GRACEFULLY: a verify pass that itself errors (tsc missing, no
 *     tsconfig, exec failure) logs and skips. It must never crash the turn.
 *   - Per-file tsc in isolation can't resolve monorepo path aliases / cross
 *     package `.js` ESM imports (false negatives), so the typecheck prefers a
 *     project-level `typecheck` script or a root tsconfig over per-file runs,
 *     and skips (rather than fails) when neither is available.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createLogger } from "@brainst0rm/shared";

const log = createLogger("agent-verify");

export type VerifyMode = "off" | "typecheck" | "full";

export interface VerifyContext {
  /** Workspace root — cwd for tsc/test invocations. */
  projectPath: string;
  /** Cancel in-flight verification when the user aborts the turn. */
  signal?: AbortSignal;
}

export interface VerifyOutcome {
  /**
   * Did verification actually execute? `false` when it was skipped — mode off,
   * no relevant files, missing deps, degraded error, or nothing to check. A
   * skipped pass never feeds diagnostics back and never fails the turn.
   */
  ran: boolean;
  /** True when everything that ran passed (or nothing needed to run). */
  ok: boolean;
  /** Human-readable diagnostics to feed back to the model when `!ok`. */
  diagnostics: string;
  /** Typecheck tri-state: true pass, false fail, null skipped. */
  typecheckPassed: boolean | null;
  /** Affected-test tri-state: true pass, false fail, null skipped. */
  testPassed: boolean | null;
  /** Why the pass was skipped (for logging/telemetry). */
  skipReason?: string;
}

/** Pluggable so the loop can inject a mock in tests. */
export type VerifyRunner = (
  files: string[],
  mode: VerifyMode,
  ctx: VerifyContext,
) => VerifyOutcome;

const TS_SOURCE = /\.(?:m|c)?tsx?$/;
const MAX_DIAGNOSTIC_CHARS = 2000;

function skip(reason: string): VerifyOutcome {
  return {
    ran: false,
    ok: true,
    diagnostics: "",
    typecheckPassed: null,
    testPassed: null,
    skipReason: reason,
  };
}

function truncate(s: string, n: number): string {
  const trimmed = s.trim();
  return trimmed.length > n ? trimmed.slice(0, n) + "\n… (truncated)" : trimmed;
}

/**
 * Entry point the agent loop calls. Filters to relevant files, guards on mode
 * and abort, and wraps the runner so a verifier that THROWS degrades to a skip
 * rather than crashing the turn.
 */
export function runVerifyPass(
  files: string[],
  mode: VerifyMode,
  ctx: VerifyContext,
  runner: VerifyRunner = defaultVerifyRunner,
): VerifyOutcome {
  if (mode === "off") return skip("mode=off");
  if (ctx.signal?.aborted) return skip("aborted");

  // Only TypeScript sources are verifiable here; ignore declaration files.
  const relevant = Array.from(
    new Set(files.filter((f) => TS_SOURCE.test(f) && !f.endsWith(".d.ts"))),
  );
  if (relevant.length === 0) return skip("no typescript source files changed");

  try {
    return runner(relevant, mode, ctx);
  } catch (err: any) {
    // A verify pass must NEVER crash the turn — log and skip (degraded).
    log.warn(
      { err: err?.message ?? String(err) },
      "verify pass errored — skipping (degraded, turn continues)",
    );
    return skip(`verify errored: ${err?.message ?? String(err)}`);
  }
}

/** Read package.json scripts, tolerating a missing/malformed file. */
function readScripts(projectPath: string): Record<string, string> {
  const pkgPath = join(projectPath, "package.json");
  if (!existsSync(pkgPath)) return {};
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    return (pkg.scripts ?? {}) as Record<string, string>;
  } catch {
    return {};
  }
}

/**
 * Distinguish an ENVIRONMENTAL exec failure (the verifier could not run) from a
 * genuine compile/test FAILURE (the verifier ran and reported errors). A normal
 * non-zero exit carries a numeric `status`; a missing binary (ENOENT), a
 * timeout/kill (`killed`/`signal`, `status === null`), or any exit without a
 * numeric code means the process never ran to a normal conclusion. Those must
 * SKIP (tri-state null), never feed a bogus diagnostic back to the model
 * (requirement #4 — degrade gracefully, don't burn a correction turn).
 */
function isEnvironmentalExecError(err: any): boolean {
  if (err?.code === "ENOENT") return true; // npx/tsc/vitest not installed
  if (err?.killed) return true; // timeout → execFileSync SIGTERM
  if (err?.signal) return true; // killed by signal
  // A genuine tsc/vitest failure sets status to a number (1/2); anything else
  // (null/undefined) means it never exited normally → environmental.
  return typeof err?.status !== "number";
}

/**
 * Scope raw tsc diagnostics to ONLY the files the model changed this turn. A
 * whole-project `tsc` surfaces every pre-existing error in the repo; feeding
 * those back would fail verify on untouched code and burn a correction turn on
 * something the model never wrote. We keep only diagnostic lines whose file
 * resolves to one of the changed files.
 */
function scopeDiagnosticsToChangedFiles(
  output: string,
  files: string[],
  projectPath: string,
): string[] {
  const changed = new Set(files.map((f) => resolve(projectPath, f)));
  // tsc (non-pretty, piped) emits: `path/file.ts(line,col): error TS####: msg`
  const lineRe =
    /^(\S.*?\.[cm]?tsx?)\((\d+),(\d+)\):\s+(?:error|warning)\s+TS\d+/;
  const matched: string[] = [];
  for (const line of output.split(/\r?\n/)) {
    const m = line.match(lineRe);
    if (!m) continue;
    if (changed.has(resolve(projectPath, m[1]))) matched.push(line.trim());
  }
  return matched;
}

function runTypecheck(
  files: string[],
  projectPath: string,
): {
  passed: boolean | null;
  output: string;
} {
  const scripts = readScripts(projectPath);

  let cmd: string;
  let args: string[];
  if (scripts.typecheck) {
    cmd = "npm";
    args = ["run", "-s", "typecheck"];
  } else if (existsSync(join(projectPath, "tsconfig.json"))) {
    // Project-level tsc resolves cross-package/path-alias imports that a
    // per-file compile cannot — avoids false negatives in the monorepo.
    cmd = "npx";
    args = ["tsc", "--noEmit", "-p", "tsconfig.json"];
  } else {
    // No governed way to typecheck — skip rather than emit false errors.
    return { passed: null, output: "" };
  }

  try {
    execFileSync(cmd, args, {
      cwd: projectPath,
      timeout: 120_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { passed: true, output: "" };
  } catch (err: any) {
    if (isEnvironmentalExecError(err)) {
      log.warn(
        { err: err?.message ?? String(err), cmd },
        "typecheck skipped — environmental error (compiler unavailable, timeout, or killed)",
      );
      return { passed: null, output: "" };
    }
    const out = (err.stdout?.toString() ?? "") + (err.stderr?.toString() ?? "");
    // Only report errors in the files the model actually changed this turn.
    const scoped = scopeDiagnosticsToChangedFiles(out, files, projectPath);
    if (scoped.length === 0) {
      // tsc failed, but every error is in code the model didn't touch (or the
      // failure is a fatal config error with no parseable diagnostics). Not the
      // model's regression — treat as pass rather than re-prompt over it.
      log.debug(
        "typecheck failed but no errors in changed files — not re-prompting",
      );
      return { passed: true, output: "" };
    }
    return {
      passed: false,
      output: truncate(scoped.join("\n"), MAX_DIAGNOSTIC_CHARS),
    };
  }
}

/**
 * Locate test files affected by the change: changed files that are themselves
 * tests, plus co-located `<name>.test.ts` / `.spec.ts` siblings of changed
 * sources. Returns null (skip) when none are found, so verify never re-prompts
 * over a change with no adjacent test surface.
 */
function findAffectedTests(files: string[]): string[] {
  const tests = new Set<string>();
  for (const f of files) {
    if (/\.(?:test|spec)\.(?:m|c)?tsx?$/.test(f)) {
      if (existsSync(f)) tests.add(f);
      continue;
    }
    const base = f.replace(TS_SOURCE, "");
    for (const suffix of [".test.ts", ".test.tsx", ".spec.ts", ".spec.tsx"]) {
      const candidate = base + suffix;
      if (existsSync(candidate)) tests.add(candidate);
    }
  }
  return Array.from(tests);
}

function runAffectedTests(
  files: string[],
  projectPath: string,
): { passed: boolean | null; output: string } {
  const tests = findAffectedTests(files);
  if (tests.length === 0) return { passed: null, output: "" };

  try {
    execFileSync("npx", ["vitest", "run", ...tests, "--reporter=silent"], {
      cwd: projectPath,
      timeout: 120_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { passed: true, output: "" };
  } catch (err: any) {
    if (isEnvironmentalExecError(err)) {
      log.warn(
        { err: err?.message ?? String(err) },
        "affected tests skipped — environmental error (vitest unavailable, timeout, or killed)",
      );
      return { passed: null, output: "" };
    }
    const out = (err.stdout?.toString() ?? "") + (err.stderr?.toString() ?? "");
    return {
      passed: false,
      output: truncate(
        out || err.message || "tests failed",
        MAX_DIAGNOSTIC_CHARS,
      ),
    };
  }
}

/**
 * Default verifier. Mirrors Judge verifyWorktree: missing node_modules ⇒ skip
 * (null, never fail); typecheck first; run affected tests only in "full" mode
 * and only if the typecheck did not fail.
 */
export const defaultVerifyRunner: VerifyRunner = (files, mode, ctx) => {
  const { projectPath } = ctx;

  // Missing deps is an ENVIRONMENTAL gap, not the model's fault — skip so we
  // never re-prompt the model over it (Judge verifyWorktree semantics).
  if (!existsSync(join(projectPath, "node_modules"))) {
    return skip("node_modules not installed — verification skipped");
  }

  const tc = runTypecheck(files, projectPath);

  let testPassed: boolean | null = null;
  let testOutput = "";
  if (mode === "full" && tc.passed !== false) {
    const t = runAffectedTests(files, projectPath);
    testPassed = t.passed;
    testOutput = t.output;
  }

  const ran = tc.passed !== null || testPassed !== null;
  if (!ran) return skip("no typecheck script/tsconfig and no affected tests");

  const ok = tc.passed !== false && testPassed !== false;
  const parts: string[] = [];
  if (tc.passed === false) {
    parts.push(`TypeScript compiler errors:\n${tc.output}`);
  }
  if (testPassed === false) {
    parts.push(`Failing tests:\n${testOutput}`);
  }

  return {
    ran: true,
    ok,
    diagnostics: parts.join("\n\n"),
    typecheckPassed: tc.passed,
    testPassed,
  };
};

/**
 * Format the corrective message pushed back onto the conversation when verify
 * fails, so the model self-corrects on the next turn.
 */
export function formatVerifyDiagnostic(
  outcome: VerifyOutcome,
  mode: VerifyMode,
  isFinalAttempt: boolean,
): string {
  const what =
    mode === "full"
      ? "the TypeScript compiler / affected tests"
      : "the TypeScript compiler";
  return (
    `[verify] Your edits did not pass ${what}:\n\n` +
    outcome.diagnostics +
    `\n\nFix these errors in the files you just changed.` +
    (isFinalAttempt ? " This is the final correction attempt." : "")
  );
}
