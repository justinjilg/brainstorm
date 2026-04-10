/**
 * SWE-bench Scorer — run gold tests against generated patches.
 *
 * Uses Docker for isolated execution:
 * 1. Clone repo at baseCommit
 * 2. Apply generated patch (git apply)
 * 3. Apply gold test patch
 * 4. Run test suite
 * 5. Parse results
 */

import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  writeFileSync,
  existsSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
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

/**
 * Score a patch by applying it and running the gold tests in Docker.
 *
 * If Docker is unavailable, falls back to heuristic scoring
 * (patch non-empty + agent reported success).
 */
export function scorePatch(
  instance: SWEBenchInstance,
  patch: SWEBenchPatch,
): SWEBenchScore {
  // No patch generated → automatic fail
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

  // Try Docker-based scoring
  if (isDockerAvailable()) {
    return scorePatchWithDocker(instance, patch);
  }

  // Fallback: heuristic scoring (patch exists + agent success signal)
  return {
    instanceId: instance.instanceId,
    passed: patch.success && patch.patch.length > 0,
    testsRun: 0,
    testsPassed: 0,
    testsFailed: 0,
    error: "Docker unavailable — heuristic scoring only",
  };
}

function scorePatchWithDocker(
  instance: SWEBenchInstance,
  patch: SWEBenchPatch,
): SWEBenchScore {
  const workDir = mkdtempSync(join(tmpdir(), "swe-bench-"));

  try {
    // 1. Clone repo — use --filter=blob:none + fetch since SWE-bench base
    // commits are often deeper than 100 commits and fail with --depth.
    execFileSync(
      "git",
      [
        "clone",
        "--filter=blob:none",
        "--no-checkout",
        `https://github.com/${instance.repo}.git`,
        "repo",
      ],
      {
        cwd: workDir,
        timeout: 180000,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    const repoDir = join(workDir, "repo");

    execFileSync("git", ["fetch", "origin", instance.baseCommit], {
      cwd: repoDir,
      timeout: 60000,
      stdio: ["ignore", "pipe", "pipe"],
    });

    execFileSync("git", ["checkout", instance.baseCommit], {
      cwd: repoDir,
      timeout: 30000,
      stdio: ["ignore", "pipe", "pipe"],
    });

    // 2. Apply the generated patch
    const patchFile = join(workDir, "prediction.patch");
    writeFileSync(patchFile, patch.patch, "utf-8");

    try {
      execFileSync("git", ["apply", "--allow-empty", patchFile], {
        cwd: repoDir,
        timeout: 30000,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e: any) {
      return {
        instanceId: instance.instanceId,
        passed: false,
        testsRun: 0,
        testsPassed: 0,
        testsFailed: 0,
        error: `Patch apply failed: ${e.message?.slice(0, 200)}`,
      };
    }

    // 3. Apply gold test patch
    const testPatchFile = join(workDir, "test.patch");
    writeFileSync(testPatchFile, instance.testPatch, "utf-8");

    try {
      execFileSync("git", ["apply", "--allow-empty", testPatchFile], {
        cwd: repoDir,
        timeout: 30000,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      // Gold test patch may not apply cleanly — that's a prediction failure
      return {
        instanceId: instance.instanceId,
        passed: false,
        testsRun: 0,
        testsPassed: 0,
        testsFailed: 0,
        error: "Gold test patch apply failed (prediction likely conflicts)",
      };
    }

    // 4. Run tests in Docker
    const image = detectTestImage(instance.repo);
    const containerName =
      `swe-bench-${instance.instanceId.replace(/[^a-z0-9-]/gi, "-")}`.slice(
        0,
        60,
      );

    try {
      // Note: network is enabled because SWE-bench repos require pip install
      // of their own dependencies. Without network, pip cannot fetch deps and
      // every run errors. For stricter isolation, use a prebuilt Docker image
      // per repo (the official SWE-bench approach) — that's a separate infra
      // task. For this simplified scorer, network:bridge + memory/cpu limits
      // + 10-minute timeout is the practical compromise.
      const output = execFileSync(
        "docker",
        [
          "run",
          "--rm",
          "--name",
          containerName,
          "-v",
          `${repoDir}:/workspace`,
          "-w",
          "/workspace",
          "--memory",
          "4g",
          "--cpus",
          "2",
          image,
          "bash",
          "-c",
          buildTestCommand(instance),
        ],
        {
          timeout: 600000, // 10 min max — astropy and similar need time to install
          encoding: "utf-8",
          stdio: ["ignore", "pipe", "pipe"],
        },
      );

      // 5. Parse test results
      return parseTestOutput(instance.instanceId, output);
    } catch (e: any) {
      const output = e.stdout?.toString() ?? "";
      const stderr = e.stderr?.toString() ?? "";

      // Tests may fail but still produce useful output
      if (output.includes("FAILED") || output.includes("failed")) {
        return parseTestOutput(instance.instanceId, output + "\n" + stderr);
      }

      return {
        instanceId: instance.instanceId,
        passed: false,
        testsRun: 0,
        testsPassed: 0,
        testsFailed: 0,
        error: `Test execution failed: ${(stderr || e.message || "").slice(0, 800)}`,
      };
    }
  } catch (e: any) {
    return {
      instanceId: instance.instanceId,
      passed: false,
      testsRun: 0,
      testsPassed: 0,
      testsFailed: 0,
      error: `Scoring error: ${e.message?.slice(0, 200)}`,
    };
  } finally {
    // Cleanup
    try {
      rmSync(workDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
}

function parseTestOutput(instanceId: string, output: string): SWEBenchScore {
  let testsRun = 0;
  let testsPassed = 0;
  let testsFailed = 0;

  // pytest output: "X passed, Y failed, Z error"
  const pytestMatch = output.match(/(\d+) passed/);
  const pytestFailed = output.match(/(\d+) failed/);
  const pytestError = output.match(/(\d+) error/);

  if (pytestMatch) {
    testsPassed = parseInt(pytestMatch[1]);
    testsFailed =
      (pytestFailed ? parseInt(pytestFailed[1]) : 0) +
      (pytestError ? parseInt(pytestError[1]) : 0);
    testsRun = testsPassed + testsFailed;
  }

  // Jest/Vitest: "Tests: X passed, Y failed, Z total"
  const jestTotal = output.match(/Tests:\s+.*?(\d+) total/);
  const jestPassed = output.match(/Tests:\s+.*?(\d+) passed/);
  const jestFailed = output.match(/Tests:\s+.*?(\d+) failed/);

  if (jestTotal) {
    testsRun = parseInt(jestTotal[1]);
    testsPassed = jestPassed ? parseInt(jestPassed[1]) : 0;
    testsFailed = jestFailed ? parseInt(jestFailed[1]) : 0;
  }

  const passed = testsRun > 0 && testsFailed === 0;

  return { instanceId, passed, testsRun, testsPassed, testsFailed };
}

function detectTestImage(repo: string): string {
  // Most SWE-bench instances are Python repos
  if (
    repo.includes("django") ||
    repo.includes("flask") ||
    repo.includes("scikit")
  ) {
    return "python:3.11-slim";
  }
  if (
    repo.includes("node") ||
    repo.includes("express") ||
    repo.includes("react")
  ) {
    return "node:22-slim";
  }
  return "python:3.11-slim"; // Default for SWE-bench (mostly Python)
}

/**
 * Build the test command for a SWE-bench instance. If FAIL_TO_PASS is
 * provided, run only those specific tests (proper SWE-bench scoring). Without
 * it, fall back to running the full test suite (coarse but useful signal).
 */
function buildTestCommand(instance: SWEBenchInstance): string {
  const install =
    'pip install -q -e ".[test,dev]" 2>&1 || pip install -q -e . 2>&1; pip install -q pytest 2>&1';

  if (instance.failToPass && instance.failToPass.length > 0) {
    // Run only the FAIL_TO_PASS tests. Pass each as a positional argument.
    // Escape single quotes in test IDs for shell safety.
    const testIds = instance.failToPass
      .map((t) => `'${t.replace(/'/g, "'\\''")}'`)
      .join(" ");
    return `${install}; python -m pytest --tb=short -v ${testIds} 2>&1`;
  }

  // Fallback: whole suite (legacy behavior)
  return `${install}; python -m pytest --tb=short -q 2>&1 || python -m unittest discover -s tests 2>&1`;
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
