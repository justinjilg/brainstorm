/**
 * Onboard package tests — budget inference, budget tracking, memory bridge.
 */

import { describe, it, expect, afterEach } from "vitest";
import { inferBudget, createBudgetTracker } from "../budget.js";
import { persistOnboardToMemory } from "../memory-bridge.js";
import { MemoryManager } from "@brainst0rm/core";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import type { OnboardResult } from "../types.js";

function getMemoryDir(projectPath: string): string {
  const hash = createHash("sha256")
    .update(projectPath)
    .digest("hex")
    .slice(0, 16);
  return join(homedir(), ".brainstorm", "projects", hash, "memory");
}

function createProjectPath(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `${prefix}-`));
}

describe("Budget", () => {
  describe("inferBudget", () => {
    it("returns $2 for small projects (<50 files)", () => {
      const budget = inferBudget({
        summary: { totalFiles: 30, avgComplexity: 10 },
      } as any);
      expect(budget).toBe(2.0);
    });

    it("returns $5 for medium projects (<500 files)", () => {
      const budget = inferBudget({
        summary: { totalFiles: 200, avgComplexity: 10 },
      } as any);
      expect(budget).toBe(5.0);
    });

    it("returns $10 for large projects (500+ files)", () => {
      const budget = inferBudget({
        summary: { totalFiles: 1000, avgComplexity: 10 },
      } as any);
      expect(budget).toBe(10.0);
    });

    it("applies 1.5x multiplier for high complexity (>15)", () => {
      const budget = inferBudget({
        summary: { totalFiles: 200, avgComplexity: 20 },
      } as any);
      expect(budget).toBe(7.5); // $5 * 1.5
    });

    it("no multiplier for normal complexity", () => {
      const low = inferBudget({
        summary: { totalFiles: 200, avgComplexity: 10 },
      } as any);
      const high = inferBudget({
        summary: { totalFiles: 200, avgComplexity: 20 },
      } as any);
      expect(high).toBeGreaterThan(low);
    });
  });

  describe("createBudgetTracker", () => {
    it("tracks spending", () => {
      const tracker = createBudgetTracker(10.0);
      expect(tracker.total).toBe(10.0);
      expect(tracker.remaining).toBe(10.0);

      tracker.record(3.5);
      expect(tracker.spent).toBe(3.5);
      expect(tracker.remaining).toBe(6.5);
    });

    it("canAfford returns false when over budget", () => {
      const tracker = createBudgetTracker(5.0);
      tracker.record(4.0);
      expect(tracker.canAfford(2.0)).toBe(false);
      expect(tracker.canAfford(1.0)).toBe(true);
    });

    it("record returns false when budget exceeded", () => {
      const tracker = createBudgetTracker(5.0);
      expect(tracker.record(3.0)).toBe(true);
      expect(tracker.record(3.0)).toBe(false); // 6.0 > 5.0
    });
  });
});

describe("Memory Bridge", () => {
  const cleanupPaths: string[] = [];

  function trackProjectPath(projectPath: string): string {
    cleanupPaths.push(projectPath);
    return projectPath;
  }

  function createResult(
    overrides?: Partial<NonNullable<OnboardResult["context"]["exploration"]>>,
  ): OnboardResult {
    return {
      context: {
        analysis: {} as any,
        exploration: {
          conventions: {
            naming: {
              variables: "camelCase",
              files: "kebab-case",
              exports: "PascalCase",
            },
            errorHandling: "try/catch with typed errors",
            testingPatterns: "vitest with colocated __tests__",
            importStyle: "named imports, barrel exports",
            customRules: ["No default exports"],
          },
          domainConcepts: [
            {
              name: "MemoryManager",
              definition: "Persistent memory for agents",
              relatedFiles: ["manager.ts"],
            },
          ],
          gitWorkflow: {
            commitStyle: "conventional commits",
            branchStrategy: "trunk-based",
            prPatterns: "squash merge",
            typicalPRSize: "50-200 lines",
            activeContributors: 1,
          },
          cicdSetup: {
            provider: "GitHub Actions",
            stages: ["lint", "test", "build"],
            deployTarget: "npm",
            hasPreCommitHooks: true,
          },
          keyFiles: [
            {
              path: "packages/core/src/agent/loop.ts",
              purpose: "Agent execution loop",
              summary: "Main entry point",
            },
          ],
          projectPurpose:
            "AI-governed control plane for multi-product infrastructure",
          ...overrides,
        },
      },
      filesWritten: [],
      totalCost: 0.5,
      totalDurationMs: 5000,
      phasesRun: ["static-analysis", "deep-exploration"],
      phasesSkipped: [],
    };
  }

  afterEach(() => {
    for (const p of cleanupPaths) {
      try {
        rmSync(p, { recursive: true, force: true });
      } catch {}
      try {
        rmSync(getMemoryDir(p), { recursive: true, force: true });
      } catch {}
    }
    cleanupPaths.length = 0;
  });

  it("persists exploration results to memory", () => {
    const projectPath = trackProjectPath(
      createProjectPath("brainstorm-onboard-test"),
    );
    const result = createResult();

    const saved = persistOnboardToMemory(result, projectPath);
    const manager = new MemoryManager(projectPath);

    expect(saved).toBe(6);
    expect(manager.list().map((entry) => entry.name)).toEqual(
      expect.arrayContaining([
        "conventions",
        "domain-concepts",
        "project-purpose",
        "git-workflow",
        "ci-cd-profile",
        "key-files-digest",
      ]),
    );
  });

  it("persists partial exploration data with only conventions and project purpose", () => {
    const projectPath = trackProjectPath(
      createProjectPath("brainstorm-onboard-partial"),
    );
    const result = createResult({
      domainConcepts: [],
      gitWorkflow: undefined as any,
      cicdSetup: undefined as any,
      keyFiles: [],
    });

    const saved = persistOnboardToMemory(result, projectPath);
    const manager = new MemoryManager(projectPath);
    const entryNames = manager.list().map((entry) => entry.name);

    expect(saved).toBe(2);
    expect(entryNames).toEqual(
      expect.arrayContaining(["conventions", "project-purpose"]),
    );
    expect(entryNames).not.toContain("domain-concepts");
    expect(entryNames).not.toContain("git-workflow");
    expect(entryNames).not.toContain("ci-cd-profile");
    expect(entryNames).not.toContain("key-files-digest");
  });

  it("handles a non-directory project path gracefully by still hashing the path for storage", () => {
    const parentPath = trackProjectPath(
      createProjectPath("brainstorm-onboard-non-directory-parent"),
    );
    const fileProjectPath = join(parentPath, "project-file.txt");
    const result = createResult({
      domainConcepts: [],
      gitWorkflow: undefined as any,
      cicdSetup: undefined as any,
      keyFiles: [],
      projectPurpose: undefined as any,
    });

    const saved = persistOnboardToMemory(result, fileProjectPath);
    const manager = new MemoryManager(fileProjectPath);
    const entries = manager.list();

    expect(saved).toBe(1);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.name).toBe("conventions");
  });

  it("persists very long content without truncation", () => {
    const projectPath = trackProjectPath(
      createProjectPath("brainstorm-onboard-long-content"),
    );
    const longPurpose = "A".repeat(5500);
    const result = createResult({
      projectPurpose: longPurpose,
      domainConcepts: [],
      gitWorkflow: undefined as any,
      cicdSetup: undefined as any,
      keyFiles: [],
      conventions: undefined as any,
    });

    const saved = persistOnboardToMemory(result, projectPath);
    const manager = new MemoryManager(projectPath);
    const purposeEntry = manager.get("project-purpose");

    expect(saved).toBe(1);
    expect(purposeEntry?.content).toBe(longPurpose);
    expect(purposeEntry?.content.length).toBeGreaterThan(5000);
  });

  it("skips empty keyFiles and domainConcepts arrays", () => {
    const projectPath = trackProjectPath(
      createProjectPath("brainstorm-onboard-empty-arrays"),
    );
    const result = createResult({
      domainConcepts: [],
      keyFiles: [],
      gitWorkflow: undefined as any,
      cicdSetup: undefined as any,
      projectPurpose: undefined as any,
    });

    const saved = persistOnboardToMemory(result, projectPath);
    const manager = new MemoryManager(projectPath);
    const entryNames = manager.list().map((entry) => entry.name);

    expect(saved).toBe(1);
    expect(entryNames).toEqual(["conventions"]);
  });

  it("returns 0 when no exploration results", () => {
    const projectPath = trackProjectPath(
      createProjectPath("brainstorm-onboard-test-empty"),
    );

    const result: OnboardResult = {
      context: { analysis: {} as any },
      filesWritten: [],
      totalCost: 0,
      totalDurationMs: 100,
      phasesRun: [],
      phasesSkipped: [],
    };

    const saved = persistOnboardToMemory(result, projectPath);
    expect(saved).toBe(0);
  });
});
