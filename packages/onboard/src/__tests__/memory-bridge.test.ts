import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { MemoryManager } from "@brainst0rm/core";
import type { OnboardResult } from "../types.js";
import { persistOnboardToMemory } from "../memory-bridge.js";

const cleanupPaths: string[] = [];

function trackProjectPath(projectPath: string): string {
  cleanupPaths.push(projectPath);
  return projectPath;
}

function createProjectPath(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `${prefix}-`));
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
            exports: "named",
            components: "PascalCase",
          },
          errorHandling: "try/catch with typed errors",
          testingPatterns: "vitest with colocated __tests__",
          importStyle: "named imports, barrel exports",
          stateManagement: "ipc-based state flow",
          apiPatterns: "REST endpoints with JSON envelopes",
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
  for (const projectPath of cleanupPaths) {
    rmSync(projectPath, { recursive: true, force: true });
  }
  cleanupPaths.length = 0;
});

describe("persistOnboardToMemory", () => {
  it("persists conventions with optional sections into system memory", () => {
    const projectPath = trackProjectPath(
      createProjectPath("onboard-memory-full"),
    );
    const saved = persistOnboardToMemory(createResult(), projectPath);
    const manager = new MemoryManager(projectPath);
    const conventions = manager.get("conventions");

    expect(saved).toBe(6);
    expect(conventions?.tier).toBe("system");
    expect(conventions?.content).toContain("Components: PascalCase");
    expect(conventions?.content).toContain(
      "## State Management: ipc-based state flow",
    );
    expect(conventions?.content).toContain(
      "## API Patterns: REST endpoints with JSON envelopes",
    );
    expect(conventions?.content).toContain("- No default exports");
  });

  it("skips empty optional exploration sections", () => {
    const projectPath = trackProjectPath(
      createProjectPath("onboard-memory-partial"),
    );
    const saved = persistOnboardToMemory(
      createResult({
        domainConcepts: [],
        gitWorkflow: undefined as any,
        cicdSetup: undefined as any,
        keyFiles: [],
        projectPurpose: undefined as any,
      }),
      projectPath,
    );
    const manager = new MemoryManager(projectPath);

    expect(saved).toBe(1);
    expect(manager.list().map((entry) => entry.name)).toEqual(["conventions"]);
  });

  it("returns zero when exploration is missing", () => {
    const projectPath = trackProjectPath(
      createProjectPath("onboard-memory-empty"),
    );
    const result: OnboardResult = {
      context: { analysis: {} as any },
      filesWritten: [],
      totalCost: 0,
      totalDurationMs: 100,
      phasesRun: [],
      phasesSkipped: [],
    };

    expect(persistOnboardToMemory(result, projectPath)).toBe(0);
  });
});
