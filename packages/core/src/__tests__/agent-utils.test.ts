import { describe, it, expect } from "vitest";
import type { TaskProfile, ModelEntry } from "@brainst0rm/shared";
import {
  predictTaskCost,
  formatCostPrediction,
  type CostPrediction,
} from "../agent/cost-predictor";
import {
  parseTestOutput,
  BuildStateTracker,
  type TestResult,
  type BuildStatus,
} from "../agent/build-state";
import {
  repoMapToContext,
  type RepoMap,
  type RepoMapEntry,
} from "../agent/repo-map";

describe("cost-predictor", () => {
  const mockModels: ModelEntry[] = [
    {
      id: "cheap-model",
      name: "Cheap",
      provider: "test",
      tier: "cheap",
      pricing: { inputPer1MTokens: 0.5, outputPer1MTokens: 1.0 },
    },
    {
      id: "balanced-model",
      name: "Balanced",
      provider: "test",
      tier: "balanced",
      pricing: { inputPer1MTokens: 3.0, outputPer1MTokens: 5.0 },
    },
    {
      id: "quality-model",
      name: "Quality",
      provider: "test",
      tier: "quality",
      pricing: { inputPer1MTokens: 10.0, outputPer1MTokens: 30.0 },
    },
  ];

  describe("predictTaskCost", () => {
    it("returns prediction with all tiers when models provided", () => {
      const taskProfile: TaskProfile = {
        type: "refactor",
        complexity: "moderate",
      };

      const result = predictTaskCost(taskProfile, mockModels);

      expect(result.taskType).toBe("refactor");
      expect(result.complexity).toBe("moderate");
      expect(result.tiers).toHaveLength(3);
      expect(result.tiers.map((t) => t.label)).toContain("Quality");
      expect(result.tiers.map((t) => t.label)).toContain("Balanced");
      expect(result.tiers.map((t) => t.label)).toContain("Budget");
    });

    it("uses balanced tier as primary estimate", () => {
      const taskProfile: TaskProfile = {
        type: "code-review",
        complexity: "simple",
      };

      const result = predictTaskCost(taskProfile, mockModels);
      const balancedTier = result.tiers.find((t) => t.label === "Balanced");

      expect(result.estimated).toBe(balancedTier?.estimatedCost);
    });

    it("calculates correct range from cheapest to most expensive", () => {
      const taskProfile: TaskProfile = {
        type: "documentation",
        complexity: "trivial",
      };

      const result = predictTaskCost(taskProfile, mockModels);

      expect(result.range[0]).toBeLessThan(result.range[1]);
      expect(result.range[0]).toBeGreaterThanOrEqual(0);
    });

    it("estimates higher costs for complex tasks", () => {
      const simpleTask: TaskProfile = {
        type: "refactor",
        complexity: "simple",
      };
      const complexTask: TaskProfile = {
        type: "refactor",
        complexity: "complex",
      };

      const simpleResult = predictTaskCost(simpleTask, mockModels);
      const complexResult = predictTaskCost(complexTask, mockModels);

      expect(complexResult.estimated).toBeGreaterThan(simpleResult.estimated);
    });

    it("estimates expert tasks as most expensive", () => {
      const expertTask: TaskProfile = {
        type: "architecture",
        complexity: "expert",
      };

      const result = predictTaskCost(expertTask, mockModels);

      expect(result.estimated).toBeGreaterThan(0.001);
      expect(result.tiers[0]?.estimatedTokens).toBeGreaterThan(80000);
    });

    it("handles empty model list gracefully", () => {
      const taskProfile: TaskProfile = { type: "test", complexity: "simple" };

      const result = predictTaskCost(taskProfile, []);

      expect(result.tiers).toHaveLength(0);
      expect(result.estimated).toBe(0);
      expect(result.range).toEqual([0, 0]);
    });

    it("includes latency estimates for each tier", () => {
      const taskProfile: TaskProfile = {
        type: "debug",
        complexity: "moderate",
      };

      const result = predictTaskCost(taskProfile, mockModels);

      for (const tier of result.tiers) {
        expect(tier.estimatedLatencyMs).toBeGreaterThan(0);
        expect(Number.isInteger(tier.estimatedLatencyMs)).toBe(true);
      }
    });
  });

  describe("formatCostPrediction", () => {
    it("formats prediction with all tiers", () => {
      const prediction: CostPrediction = {
        estimated: 0.015,
        range: [0.005, 0.03],
        tiers: [
          {
            label: "Quality",
            model: "gpt-4",
            estimatedCost: 0.03,
            estimatedTokens: 10000,
            estimatedLatencyMs: 5000,
          },
          {
            label: "Balanced",
            model: "claude-sonnet",
            estimatedCost: 0.015,
            estimatedTokens: 10000,
            estimatedLatencyMs: 3000,
          },
        ],
        taskType: "refactor",
        complexity: "moderate",
      };

      const formatted = formatCostPrediction(prediction);

      expect(formatted).toContain("moderate refactor");
      expect(formatted).toContain("Quality: $0.030");
      expect(formatted).toContain("Balanced: $0.015");
    });

    it("returns unavailable message for empty tiers", () => {
      const prediction: CostPrediction = {
        estimated: 0,
        range: [0, 0],
        tiers: [],
        taskType: "unknown",
        complexity: "simple",
      };

      const formatted = formatCostPrediction(prediction);

      expect(formatted).toBe("Cost estimate unavailable.");
    });

    it("formats costs with 3 decimal places", () => {
      const prediction: CostPrediction = {
        estimated: 0.123456,
        range: [0.1, 0.2],
        tiers: [
          {
            label: "Budget",
            model: "test",
            estimatedCost: 0.123456,
            estimatedTokens: 1000,
            estimatedLatencyMs: 1000,
          },
        ],
        taskType: "test",
        complexity: "simple",
      };

      const formatted = formatCostPrediction(prediction);

      expect(formatted).toContain("$0.123");
    });
  });
});

describe("build-state", () => {
  describe("parseTestOutput", () => {
    it("parses Vitest/Jest output format", () => {
      const output = "Tests: 3 failed, 42 passed, 2 skipped, 47 total";

      const result = parseTestOutput(output);

      expect(result).not.toBeNull();
      expect(result?.failed).toBe(3);
      expect(result?.passed).toBe(42);
      expect(result?.skipped).toBe(2);
    });

    it("parses Vitest compact format", () => {
      const output = "Tests  5 failed | 67 passed (72)";

      const result = parseTestOutput(output);

      expect(result).not.toBeNull();
      expect(result?.failed).toBe(5);
      expect(result?.passed).toBe(67);
    });

    it("parses pytest output format", () => {
      const output = "15 passed, 3 failed, 2 skipped";

      const result = parseTestOutput(output);

      expect(result).not.toBeNull();
      expect(result?.passed).toBe(15);
      expect(result?.failed).toBe(3);
      expect(result?.skipped).toBe(2);
    });

    it("handles zero values correctly", () => {
      const output = "Tests: 0 failed, 10 passed, 0 skipped, 10 total";

      const result = parseTestOutput(output);

      expect(result?.failed).toBe(0);
      expect(result?.passed).toBe(10);
      expect(result?.skipped).toBe(0);
    });

    it("returns null for unrecognized output", () => {
      const output = "Some random build output without test counts";

      const result = parseTestOutput(output);

      expect(result).toBeNull();
    });

    it("handles partial pytest output (no failed/skipped)", () => {
      const output = "25 passed";

      const result = parseTestOutput(output);

      expect(result).not.toBeNull();
      expect(result?.passed).toBe(25);
      expect(result?.failed).toBe(0);
      expect(result?.skipped).toBe(0);
    });

    it("extracts failed test names from FAIL lines", () => {
      const output = `
Tests: 2 failed, 5 passed, 7 total
FAIL src/__tests__/foo.test.ts
  ✕ should work correctly
FAIL src/__tests__/bar.test.ts
  ✕ another failing test
      `;

      const result = parseTestOutput(output);

      expect(result?.failedNames.length).toBeGreaterThan(0);
    });

    it("handles pytest output with only passed count", () => {
      const output = "100 passed";

      const result = parseTestOutput(output);

      expect(result?.passed).toBe(100);
      expect(result?.failed).toBe(0);
      expect(result?.skipped).toBe(0);
    });
  });

  describe("BuildStateTracker", () => {
    it("starts with unknown status", () => {
      const tracker = new BuildStateTracker();

      expect(tracker.getStatus()).toBe("unknown");
    });

    it("detects npm build commands", () => {
      const tracker = new BuildStateTracker();

      tracker.recordShellResult("npm run build", 1, "Build failed");

      expect(tracker.getStatus()).toBe("failing");
      expect(tracker.getLastBuild()).not.toBeNull();
    });

    it("detects turbo build commands", () => {
      const tracker = new BuildStateTracker();

      tracker.recordShellResult("turbo run build", 0, "");

      expect(tracker.getStatus()).toBe("passing");
    });

    it("detects vitest test commands", () => {
      const tracker = new BuildStateTracker();

      tracker.recordShellResult("npx vitest run", 1, "Tests failed");

      expect(tracker.getStatus()).toBe("failing");
      expect(tracker.getLastTest()).not.toBeNull();
    });

    it("detects jest test commands", () => {
      const tracker = new BuildStateTracker();

      tracker.recordShellResult("jest --coverage", 0, "");

      expect(tracker.getStatus()).toBe("passing");
    });

    it("returns passing when both build and test succeed", () => {
      const tracker = new BuildStateTracker();

      tracker.recordShellResult("npm run build", 0, "");
      tracker.recordShellResult("npm test", 0, "");

      expect(tracker.getStatus()).toBe("passing");
    });

    it("returns failing when build fails", () => {
      const tracker = new BuildStateTracker();

      tracker.recordShellResult("npm run build", 1, "Syntax error");

      expect(tracker.getStatus()).toBe("failing");
    });

    it("returns failing when tests fail", () => {
      const tracker = new BuildStateTracker();

      tracker.recordShellResult("npm test", 1, "Test suite failed");

      expect(tracker.getStatus()).toBe("failing");
    });

    it("formats build warning when build fails", () => {
      const tracker = new BuildStateTracker();

      tracker.recordShellResult("npm run build", 1, "Syntax error in file.ts");
      const warning = tracker.formatBuildWarning();

      expect(warning).toContain("BUILD BROKEN");
      expect(warning).toContain("Syntax error");
    });

    it("formats test warning when tests fail", () => {
      const tracker = new BuildStateTracker();

      tracker.recordShellResult("npm test", 1, "Tests failed");
      const warning = tracker.formatBuildWarning();

      expect(warning).toContain("TESTS FAILING");
    });

    it("returns empty string when passing", () => {
      const tracker = new BuildStateTracker();

      tracker.recordShellResult("npm run build", 0, "");
      const warning = tracker.formatBuildWarning();

      expect(warning).toBe("");
    });

    it("clears state correctly", () => {
      const tracker = new BuildStateTracker();

      tracker.recordShellResult("npm run build", 1, "Error");
      tracker.clear();

      expect(tracker.getStatus()).toBe("unknown");
      expect(tracker.getLastBuild()).toBeNull();
      expect(tracker.getLastTest()).toBeNull();
    });

    it("uses custom build command pattern", () => {
      const tracker = new BuildStateTracker("custom-build-script", undefined);

      tracker.recordShellResult("custom-build-script", 1, "Failed");

      expect(tracker.getLastBuild()).not.toBeNull();
    });

    it("uses custom test command pattern", () => {
      const tracker = new BuildStateTracker(undefined, "custom-test-script");

      tracker.recordShellResult("custom-test-script", 1, "Failed");

      expect(tracker.getLastTest()).not.toBeNull();
    });

    it("captures error summary from stderr", () => {
      const tracker = new BuildStateTracker();
      const stderr = "Error at line 5\nAnother error\nFinal error";

      tracker.recordShellResult("npm run build", 1, stderr);
      const lastBuild = tracker.getLastBuild();

      expect(lastBuild?.errorSummary).toContain("Final error");
    });

    it("captures timestamp for build results", () => {
      const tracker = new BuildStateTracker();
      const before = Date.now();

      tracker.recordShellResult("npm run build", 0, "");

      const after = Date.now();
      const lastBuild = tracker.getLastBuild();

      expect(lastBuild?.timestamp).toBeGreaterThanOrEqual(before);
      expect(lastBuild?.timestamp).toBeLessThanOrEqual(after);
    });
  });
});

describe("repo-map", () => {
  describe("repoMapToContext", () => {
    it("formats empty map as empty string", () => {
      const map: RepoMap = {
        entries: [],
        edges: [],
        topFiles: [],
        totalFiles: 0,
        generated: Date.now(),
      };

      const context = repoMapToContext(map);

      expect(context).toBe("");
    });

    it("formats single file with exports", () => {
      const map: RepoMap = {
        entries: [
          {
            file: "src/utils.ts",
            exports: ["helper", "formatDate"],
            imports: [],
            symbols: [],
            signatures: [],
            lineCount: 42,
          },
        ],
        edges: [],
        topFiles: ["src/utils.ts"],
        totalFiles: 1,
        generated: Date.now(),
      };

      const context = repoMapToContext(map);

      expect(context).toContain("src/utils.ts");
      expect(context).toContain("helper, formatDate");
      expect(context).toContain("42 lines");
    });

    it("truncates exports when more than 5", () => {
      const map: RepoMap = {
        entries: [
          {
            file: "src/api.ts",
            exports: ["a", "b", "c", "d", "e", "f", "g"],
            imports: [],
            symbols: [],
            signatures: [],
            lineCount: 100,
          },
        ],
        edges: [],
        topFiles: ["src/api.ts"],
        totalFiles: 1,
        generated: Date.now(),
      };

      const context = repoMapToContext(map);

      expect(context).toContain("a, b, c, d, e");
      expect(context).toContain("(+2 more)");
    });

    it("handles files with no exports", () => {
      const map: RepoMap = {
        entries: [
          {
            file: "src/main.ts",
            exports: [],
            imports: ["express"],
            symbols: [],
            signatures: [],
            lineCount: 25,
          },
        ],
        edges: [],
        topFiles: ["src/main.ts"],
        totalFiles: 1,
        generated: Date.now(),
      };

      const context = repoMapToContext(map);

      expect(context).toContain("src/main.ts");
      expect(context).toContain("25 lines");
      expect(context).not.toContain("exports");
    });

    it("shows correct total file count", () => {
      const map: RepoMap = {
        entries: [
          {
            file: "src/a.ts",
            exports: [],
            imports: [],
            symbols: [],
            signatures: [],
            lineCount: 10,
          },
          {
            file: "src/b.ts",
            exports: [],
            imports: [],
            symbols: [],
            signatures: [],
            lineCount: 20,
          },
        ],
        edges: [],
        topFiles: ["src/a.ts"],
        totalFiles: 50,
        generated: Date.now(),
      };

      const context = repoMapToContext(map);

      expect(context).toContain("1 key files of 50");
    });

    it("handles multiple top files in order", () => {
      const map: RepoMap = {
        entries: [
          {
            file: "src/first.ts",
            exports: ["first"],
            imports: [],
            symbols: [],
            signatures: [],
            lineCount: 10,
          },
          {
            file: "src/second.ts",
            exports: ["second"],
            imports: [],
            symbols: [],
            signatures: [],
            lineCount: 20,
          },
        ],
        edges: [],
        topFiles: ["src/first.ts", "src/second.ts"],
        totalFiles: 10,
        generated: Date.now(),
      };

      const context = repoMapToContext(map);

      const firstIndex = context.indexOf("first.ts");
      const secondIndex = context.indexOf("second.ts");
      expect(firstIndex).toBeLessThan(secondIndex);
    });

    it("ignores entries not in topFiles", () => {
      const map: RepoMap = {
        entries: [
          {
            file: "src/visible.ts",
            exports: ["visible"],
            imports: [],
            symbols: [],
            signatures: [],
            lineCount: 10,
          },
          {
            file: "src/hidden.ts",
            exports: ["hidden"],
            imports: [],
            symbols: [],
            signatures: [],
            lineCount: 20,
          },
        ],
        edges: [],
        topFiles: ["src/visible.ts"],
        totalFiles: 2,
        generated: Date.now(),
      };

      const context = repoMapToContext(map);

      expect(context).toContain("visible.ts");
      expect(context).not.toContain("hidden.ts");
    });
  });
});
