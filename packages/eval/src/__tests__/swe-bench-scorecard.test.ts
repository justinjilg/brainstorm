import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildRunScorecard,
  formatRunScorecard,
  generateRunId,
  getRunDir,
  writeRunScorecard,
  type SWEBenchInstanceResult,
} from "../swe-bench/scorecard.js";

const sampleResults: SWEBenchInstanceResult[] = [
  {
    instanceId: "repo__repo-1",
    resolved: true,
    cost: 0.12,
    patchSizeBytes: 300,
  },
  {
    instanceId: "repo__repo-2",
    resolved: false,
    cost: 0.08,
    patchSizeBytes: 150,
    error: "timeout",
  },
  {
    instanceId: "repo__repo-3",
    resolved: true,
    cost: 0.2,
    patchSizeBytes: 500,
  },
];

describe("buildRunScorecard", () => {
  it("computes resolved%, totals, and averages", () => {
    const sc = buildRunScorecard("run-1", "verified", sampleResults);

    expect(sc.total).toBe(3);
    expect(sc.resolved).toBe(2);
    expect(sc.resolvedRate).toBeCloseTo(2 / 3);
    expect(sc.totalCost).toBeCloseTo(0.4);
    expect(sc.avgCost).toBeCloseTo(0.4 / 3);
    expect(sc.avgPatchSizeBytes).toBe(Math.round((300 + 150 + 500) / 3));
    expect(sc.results).toEqual(sampleResults);
    expect(sc.runId).toBe("run-1");
    expect(sc.split).toBe("verified");
  });

  it("handles zero instances without dividing by zero", () => {
    const sc = buildRunScorecard("run-empty", "verified", []);
    expect(sc.total).toBe(0);
    expect(sc.resolved).toBe(0);
    expect(sc.resolvedRate).toBe(0);
    expect(sc.totalCost).toBe(0);
    expect(sc.avgCost).toBe(0);
    expect(sc.avgPatchSizeBytes).toBe(0);
  });

  it("resolvedRate is 100% when everything is resolved", () => {
    const allPassed: SWEBenchInstanceResult[] = [
      { instanceId: "a", resolved: true, cost: 1, patchSizeBytes: 10 },
      { instanceId: "b", resolved: true, cost: 1, patchSizeBytes: 10 },
    ];
    const sc = buildRunScorecard("run-2", "verified", allPassed);
    expect(sc.resolvedRate).toBe(1);
  });
});

describe("formatRunScorecard", () => {
  it("includes a per-instance table with pass/fail status", () => {
    const sc = buildRunScorecard("run-1", "verified", sampleResults);
    const text = formatRunScorecard(sc);

    expect(text).toContain("run-1");
    expect(text).toContain("verified");
    expect(text).toContain("Resolved: 2 (66.7%)");
    expect(text).toContain("repo__repo-1");
    expect(text).toContain("PASS");
    expect(text).toContain("FAIL");
    expect(text).toContain("timeout");
  });
});

describe("generateRunId / getRunDir", () => {
  it("generates unique, filesystem-safe run ids", () => {
    const a = generateRunId();
    const b = generateRunId();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[\w-]+$/);
  });

  it("nests run directories under ~/.brainstorm/swebench/<runId>", () => {
    const runId = "example-run";
    const dir = getRunDir(runId);
    expect(dir.endsWith(join("swebench", runId))).toBe(true);
  });
});

describe("writeRunScorecard", () => {
  const writtenDirs: string[] = [];

  afterEach(() => {
    for (const dir of writtenDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes valid JSON + a human-readable summary to the run directory", () => {
    const sc = buildRunScorecard(
      `test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      "verified",
      sampleResults,
    );

    const { runDir, jsonPath, summaryPath } = writeRunScorecard(sc);
    writtenDirs.push(runDir);

    expect(existsSync(jsonPath)).toBe(true);
    expect(existsSync(summaryPath)).toBe(true);

    const parsed = JSON.parse(readFileSync(jsonPath, "utf-8"));
    expect(parsed.resolved).toBe(2);
    expect(parsed.total).toBe(3);
    expect(parsed.resolvedRate).toBeCloseTo(2 / 3);

    const summary = readFileSync(summaryPath, "utf-8");
    expect(summary).toContain("SWE-bench Run Scorecard");
    expect(summary).toContain("Resolved: 2");
  });
});
