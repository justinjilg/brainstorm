/**
 * SWE-bench Scorer — run FAIL_TO_PASS tests against generated patches
 * using the official per-instance Docker images.
 *
 * Each SWE-bench Lite instance has a pre-built image with:
 *   - /testbed: repo pre-checked-out at baseCommit
 *   - /opt/miniconda3/envs/testbed: conda env with all deps installed
 *   - pytest available via `python -m pytest`
 *
 * Image naming:
 *   instance_id "pytest-dev__pytest-11143"
 *     → "swebench/sweb.eval.x86_64.pytest-dev_1776_pytest-11143:latest"
 *   (Docker tags cannot contain double-underscore, so `__` → `_1776_`.)
 *
 * Flow:
 *   1. Resolve image tag from instance_id, pull if missing.
 *   2. Write prediction patch + gold test patch to a temp dir.
 *   3. Run container with patches dir mounted at /patches.
 *   4. Inside container: activate testbed env, git apply both patches,
 *      run pytest on FAIL_TO_PASS tests.
 *   5. Parse pytest output and return score.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { SWEBenchInstance, SWEBenchPatch } from "./runner.js";

export interface SWEBenchScore {
  instanceId: string;
  passed: boolean;
  testsRun: number;
  testsPassed: number;
  testsFailed: number;
  error?: string;
}

export interface SWEBenchScorecard {
  total: number;
  passed: number;
  failed: number;
  errored: number;
  passRate: number;
  totalCost: number;
  avgLatencyMs: number;
  scores: SWEBenchScore[];
}

const IMAGE_PREFIX = "swebench/sweb.eval.x86_64.";
const PULL_TIMEOUT_MS = 600_000; // 10 min — first pull of a 2GB image can be slow
const RUN_TIMEOUT_MS = 900_000; // 15 min — FAIL_TO_PASS subsets usually finish in <5 min

/** Convert a SWE-bench instance_id to its official Docker image tag. */
export function instanceIdToImage(instanceId: string): string {
  // Double underscore cannot appear in Docker tags — SWE-bench substitutes _1776_
  const mangled = instanceId.replace(/__/g, "_1776_");
  return `${IMAGE_PREFIX}${mangled}:latest`;
}

/**
 * Score a patch by applying it inside the official SWE-bench image and
 * running the FAIL_TO_PASS tests.
 *
 * Falls back to heuristic scoring if Docker is unavailable.
 */
export function scorePatch(
  instance: SWEBenchInstance,
  patch: SWEBenchPatch,
): SWEBenchScore {
  if (!patch.patch || patch.patch.length === 0) {
    return {
      instanceId: instance.instanceId,
      passed: false,
      testsRun: 0,
      testsPassed: 0,
      testsFailed: 0,
      error: "No patch generated",
    };
  }

  if (!isDockerAvailable()) {
    return {
      instanceId: instance.instanceId,
      passed: patch.success && patch.patch.length > 0,
      testsRun: 0,
      testsPassed: 0,
      testsFailed: 0,
      error: "Docker unavailable — heuristic scoring only",
    };
  }

  return scorePatchWithDocker(instance, patch);
}

function scorePatchWithDocker(
  instance: SWEBenchInstance,
  patch: SWEBenchPatch,
): SWEBenchScore {
  const image = instanceIdToImage(instance.instanceId);

  // Ensure image is available locally. Pull if missing.
  if (!imageExistsLocally(image)) {
    try {
      execFileSync("docker", ["pull", image], {
        timeout: PULL_TIMEOUT_MS,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e: any) {
      return {
        instanceId: instance.instanceId,
        passed: false,
        testsRun: 0,
        testsPassed: 0,
        testsFailed: 0,
        error: `Docker pull failed for ${image}: ${(e.stderr?.toString() || e.message || "").slice(0, 300)}`,
      };
    }
  }

  // Stage patches in a temp dir to mount into the container.
  const patchDir = mkdtempSync(join(tmpdir(), "swe-bench-patches-"));
  try {
    writeFileSync(join(patchDir, "pred.patch"), patch.patch, "utf-8");
    writeFileSync(join(patchDir, "test.patch"), instance.testPatch, "utf-8");

    const containerName = `swe-bench-${instance.instanceId
      .replace(/[^a-z0-9-]/gi, "-")
      .slice(0, 50)}-${Date.now()}`;

    const script = buildContainerScript(instance);

    try {
      const output = execFileSync(
        "docker",
        [
          "run",
          "--rm",
          "--name",
          containerName,
          "--platform",
          "linux/amd64",
          "-v",
          `${patchDir}:/patches:ro`,
          "--memory",
          "4g",
          "--cpus",
          "2",
          image,
          "bash",
          "-c",
          script,
        ],
        {
          timeout: RUN_TIMEOUT_MS,
          encoding: "utf-8",
          stdio: ["ignore", "pipe", "pipe"],
          maxBuffer: 10 * 1024 * 1024,
        },
      );

      return parseTestOutput(instance, output);
    } catch (e: any) {
      const out = (e.stdout?.toString() ?? "") as string;
      const err = (e.stderr?.toString() ?? "") as string;
      const combined = out + "\n" + err;

      // Distinguish patch-apply failures from test failures.
      if (combined.includes("BRAINSTORM_PATCH_APPLY_FAILED")) {
        return {
          instanceId: instance.instanceId,
          passed: false,
          testsRun: 0,
          testsPassed: 0,
          testsFailed: 0,
          error: "Prediction patch failed to apply to /testbed",
        };
      }
      if (combined.includes("BRAINSTORM_TEST_PATCH_FAILED")) {
        return {
          instanceId: instance.instanceId,
          passed: false,
          testsRun: 0,
          testsPassed: 0,
          testsFailed: 0,
          error:
            "Gold test patch failed to apply (likely conflicts with prediction)",
        };
      }

      // Pytest/unittest exit non-zero when tests fail. That's still a valid
      // scored result if we can extract counts from the output.
      if (
        /\d+ (passed|failed|error)/.test(combined) ||
        /Ran \d+ tests?/.test(combined)
      ) {
        return parseTestOutput(instance, combined);
      }

      return {
        instanceId: instance.instanceId,
        passed: false,
        testsRun: 0,
        testsPassed: 0,
        testsFailed: 0,
        error: `Test execution failed: ${(err || e.message || "").slice(0, 800)}`,
      };
    }
  } finally {
    try {
      rmSync(patchDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
}

/**
 * Build the bash script that runs inside the SWE-bench image.
 *
 * Uses sentinel markers (BRAINSTORM_PATCH_APPLY_FAILED,
 * BRAINSTORM_TEST_PATCH_FAILED) so we can distinguish patch-apply failures
 * from genuine test failures when parsing output.
 */
function buildContainerScript(instance: SWEBenchInstance): string {
  const testCommand = buildTestCommand(instance);

  // No `git clean` / `git reset` here — the `--rm` flag means each run gets a
  // fresh container, and `git clean -fdx` would nuke gitignored generated
  // files like setuptools_scm version stubs that the repo needs to import.
  return [
    `source /opt/miniconda3/etc/profile.d/conda.sh`,
    `conda activate testbed`,
    `cd /testbed`,
    `(git apply -v /patches/pred.patch 2>&1 || (echo BRAINSTORM_PATCH_APPLY_FAILED; exit 2))`,
    `(git apply -v /patches/test.patch 2>&1 || (echo BRAINSTORM_TEST_PATCH_FAILED; exit 3))`,
    `${testCommand} 2>&1`,
  ].join(" && ");
}

/**
 * Resolve the right test command for a SWE-bench instance.
 *
 * Different repos use different test runners. The 12 SWE-bench Lite repos
 * fall into three groups:
 *
 *   1. Django uses its own ./tests/runtests.py with dotted test paths.
 *      Test IDs in FAIL_TO_PASS look like
 *      "method (full.dotted.Class.method)" — we extract the dotted path.
 *
 *   2. Sympy uses its bin/test runner with file paths.
 *
 *   3. Everything else (astropy, sphinx, requests, pytest, pylint, seaborn,
 *      scikit-learn, matplotlib, flask, xarray) uses pytest with the test
 *      paths in standard pytest format.
 */
function buildTestCommand(instance: SWEBenchInstance): string {
  const repo = instance.repo;
  const tests = instance.failToPass ?? [];

  if (repo === "django/django") {
    // Django test IDs come as "name (full.dotted.path.name)"; extract the
    // dotted path so the runner accepts it. Fall back to the raw ID if no
    // parenthetical group is present.
    const dotted = tests.map((t) => {
      const m = t.match(/\(([^)]+)\)/);
      return m ? m[1] : t;
    });
    const args = dotted.map((t) => `'${t.replace(/'/g, "'\\''")}'`).join(" ");
    if (!args) {
      return `./tests/runtests.py --verbosity 2 --settings=test_sqlite --parallel 1`;
    }
    return `./tests/runtests.py --verbosity 2 --settings=test_sqlite --parallel 1 ${args}`;
  }

  if (repo === "sympy/sympy") {
    // Sympy's bin/test takes file paths, not test IDs. Strip ::TestClass::test
    // suffixes and de-dupe to get the file list.
    const files = Array.from(
      new Set(tests.map((t) => t.split("::")[0]).filter(Boolean)),
    );
    const args = files.map((f) => `'${f.replace(/'/g, "'\\''")}'`).join(" ");
    if (!args) return `bin/test -C --verbose`;
    return `bin/test -C --verbose ${args}`;
  }

  // Default: pytest. Most SWE-bench repos use this, including astropy, sphinx,
  // requests, pytest, pylint, seaborn, scikit-learn, matplotlib, flask, xarray.
  if (tests.length === 0) {
    return `python -m pytest --tb=short -q`;
  }
  const testIds = tests.map((t) => `'${t.replace(/'/g, "'\\''")}'`).join(" ");
  return `python -m pytest --tb=short -v ${testIds}`;
}

function parseTestOutput(
  instance: SWEBenchInstance,
  output: string,
): SWEBenchScore {
  const instanceId = instance.instanceId;
  let testsRun = 0;
  let testsPassed = 0;
  let testsFailed = 0;

  const lastMatch = (pattern: string): number => {
    const g = new RegExp(pattern, "g");
    let match: RegExpExecArray | null;
    let last = 0;
    while ((match = g.exec(output)) !== null) last = parseInt(match[1], 10);
    return last;
  };

  // Django unittest output: "Ran N tests in X.Ys" + "OK" or "FAILED (failures=N, errors=M)"
  if (instance.repo === "django/django") {
    const ranMatch = lastMatch("Ran (\\d+) tests?");
    if (ranMatch > 0) {
      testsRun = ranMatch;
      const failures = lastMatch("failures=(\\d+)");
      const errors = lastMatch("errors=(\\d+)");
      testsFailed = failures + errors;
      testsPassed = testsRun - testsFailed;
      const passed = /^OK\b/m.test(output) && testsFailed === 0;
      return { instanceId, passed, testsRun, testsPassed, testsFailed };
    }
  }

  // Sympy bin/test output: "tests finished: N passed, M failed"
  if (instance.repo === "sympy/sympy") {
    const passedSym = lastMatch("(\\d+) passed");
    const failedSym = lastMatch("(\\d+) failed");
    if (passedSym > 0 || failedSym > 0) {
      testsPassed = passedSym;
      testsFailed = failedSym;
      testsRun = testsPassed + testsFailed;
      return {
        instanceId,
        passed: testsRun > 0 && testsFailed === 0,
        testsRun,
        testsPassed,
        testsFailed,
      };
    }
  }

  // Default: pytest summary line. Use LAST occurrence so earlier warnings
  // or partial reruns don't skew numbers.
  testsPassed = lastMatch("(\\d+) passed");
  const failed = lastMatch("(\\d+) failed");
  const errored = lastMatch("(\\d+) error");
  testsFailed = failed + errored;
  testsRun = testsPassed + testsFailed;

  // Jest/Vitest fallback (SWE-bench is ~all Python but keep as safety net)
  if (testsRun === 0) {
    const jestTotal = output.match(/Tests:\s+.*?(\d+) total/);
    const jestPassed = output.match(/Tests:\s+.*?(\d+) passed/);
    const jestFailed = output.match(/Tests:\s+.*?(\d+) failed/);
    if (jestTotal) {
      testsRun = parseInt(jestTotal[1], 10);
      testsPassed = jestPassed ? parseInt(jestPassed[1], 10) : 0;
      testsFailed = jestFailed ? parseInt(jestFailed[1], 10) : 0;
    }
  }

  const passed = testsRun > 0 && testsFailed === 0;
  return { instanceId, passed, testsRun, testsPassed, testsFailed };
}

function imageExistsLocally(image: string): boolean {
  try {
    execFileSync("docker", ["image", "inspect", image], {
      timeout: 10_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return true;
  } catch {
    return false;
  }
}

function isDockerAvailable(): boolean {
  try {
    execFileSync("docker", ["info"], {
      timeout: 5000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Generate a scorecard from evaluation results.
 */
export function generateScorecard(
  patches: SWEBenchPatch[],
  scores: SWEBenchScore[],
): SWEBenchScorecard {
  const passed = scores.filter((s) => s.passed).length;
  const failed = scores.filter((s) => !s.passed && !s.error).length;
  const errored = scores.filter((s) => s.error).length;

  const totalCost = patches.reduce((sum, p) => sum + p.cost, 0);
  const avgLatency =
    patches.length > 0
      ? patches.reduce((sum, p) => sum + p.latencyMs, 0) / patches.length
      : 0;

  return {
    total: scores.length,
    passed,
    failed,
    errored,
    passRate: scores.length > 0 ? passed / scores.length : 0,
    totalCost,
    avgLatencyMs: Math.round(avgLatency),
    scores,
  };
}
