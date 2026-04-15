import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CodeGraph } from "../graph.js";
import { registerAdapter } from "../languages/registry.js";
import { createTypeScriptAdapter } from "../languages/typescript.js";
import { createPythonAdapter } from "../languages/python.js";
import {
  executePipeline,
  topologicalLevels,
  createDefaultPipeline,
} from "../pipeline/index.js";
import type { PipelineContext, PipelineSummary } from "../pipeline/index.js";

beforeAll(() => {
  registerAdapter(createTypeScriptAdapter());
  registerAdapter(createPythonAdapter());
});

function createFixtureProject(): string {
  const dir = join(
    tmpdir(),
    `pipeline-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(join(dir, "src"), { recursive: true });
  mkdirSync(join(dir, "lib"), { recursive: true });

  // TypeScript files with cross-file calls
  writeFileSync(
    join(dir, "src", "auth.ts"),
    `
export function validateToken(token: string): boolean {
  return checkSignature(token);
}

function checkSignature(token: string): boolean {
  return token.startsWith("Bearer ");
}
`,
    "utf-8",
  );

  writeFileSync(
    join(dir, "src", "api.ts"),
    `
import { validateToken } from "./auth";

export function handleRequest(req: any) {
  const valid = validateToken(req.token);
  return sendResponse(valid);
}

function sendResponse(ok: boolean) {
  return { status: ok ? 200 : 401 };
}
`,
    "utf-8",
  );

  // Python file
  writeFileSync(
    join(dir, "lib", "utils.py"),
    `
import os

def process_data(data):
    return transform(data)

def transform(data):
    return data.upper()

class DataProcessor:
    def run(self, data):
        return process_data(data)
`,
    "utf-8",
  );

  // Files that should be skipped
  mkdirSync(join(dir, "node_modules"), { recursive: true });
  writeFileSync(
    join(dir, "node_modules", "skip.ts"),
    "export const x = 1;",
    "utf-8",
  );
  writeFileSync(
    join(dir, "src", "types.d.ts"),
    "export interface X {}",
    "utf-8",
  );

  return dir;
}

describe("Pipeline DAG", () => {
  describe("topologicalLevels", () => {
    it("groups independent stages into parallel levels", () => {
      const stages = createDefaultPipeline();
      const levels = topologicalLevels(stages);

      // Level 0: scan (no deps)
      expect(levels[0].map((s) => s.id)).toEqual(["scan"]);

      // Level 1: parse (depends on scan)
      expect(levels[1].map((s) => s.id)).toEqual(["parse"]);

      // Level 2: graph-build (depends on parse)
      expect(levels[2].map((s) => s.id)).toEqual(["graph-build"]);

      // Level 3: cross-file + search-index (both depend on graph-build — run in parallel)
      const level3Ids = levels[3].map((s) => s.id).sort();
      expect(level3Ids).toEqual(["cross-file", "search-index"]);

      // Level 4: communities (depends on cross-file)
      expect(levels[4].map((s) => s.id)).toEqual(["communities"]);

      // Level 5: summary (depends on graph-build, cross-file, communities)
      expect(levels[5].map((s) => s.id)).toEqual(["summary"]);
    });

    it("throws on circular dependencies", () => {
      expect(() =>
        topologicalLevels([
          { id: "a", name: "A", dependsOn: ["b"], run: async () => {} },
          { id: "b", name: "B", dependsOn: ["a"], run: async () => {} },
        ]),
      ).toThrow("circular");
    });
  });

  describe("executePipeline", () => {
    let graph: CodeGraph;

    afterEach(() => {
      graph?.close();
    });

    it("runs the full pipeline on a multi-language project", async () => {
      const projectDir = createFixtureProject();
      const dbDir = join(tmpdir(), `pipeline-db-${Date.now()}`);
      mkdirSync(dbDir, { recursive: true });
      graph = new CodeGraph({ dbPath: join(dbDir, "test.db") });

      const progressMessages: string[] = [];
      const ctx: PipelineContext = {
        projectPath: projectDir,
        graph,
        results: new Map(),
        onProgress: (_stage, msg) => progressMessages.push(msg),
      };

      const result = await executePipeline(createDefaultPipeline(), ctx);

      // All stages should succeed
      expect(result.stages.every((s) => s.success)).toBe(true);
      expect(result.stages).toHaveLength(7);

      // Check summary
      const summary = ctx.results.get("summary") as PipelineSummary;
      expect(summary).toBeDefined();

      // Should have parsed TS + Python files
      expect(summary.filesParsed).toBeGreaterThanOrEqual(3); // auth.ts, api.ts, utils.py
      expect(summary.languages).toContain("typescript");
      expect(summary.languages).toContain("python");

      // Should have nodes in the graph
      expect(summary.nodes).toBeGreaterThan(0);

      // node_modules and .d.ts should be skipped
      expect(summary.filesDiscovered).toBe(3); // auth.ts, api.ts, utils.py

      // Progress messages should have fired
      expect(progressMessages.length).toBeGreaterThan(0);
    });

    it("handles failed stages by skipping dependents", async () => {
      const projectDir = createFixtureProject();
      const dbDir = join(tmpdir(), `pipeline-fail-${Date.now()}`);
      mkdirSync(dbDir, { recursive: true });
      graph = new CodeGraph({ dbPath: join(dbDir, "test.db") });

      const failingStage = {
        id: "scan",
        name: "Failing Scan",
        dependsOn: [] as string[],
        run: async () => {
          throw new Error("simulated failure");
        },
      };

      const stages = createDefaultPipeline();
      stages[0] = failingStage; // replace scan with failing version

      const ctx: PipelineContext = {
        projectPath: projectDir,
        graph,
        results: new Map(),
      };

      const result = await executePipeline(stages, ctx);

      // scan failed
      expect(result.stages.find((s) => s.id === "scan")?.success).toBe(false);
      // all dependents should be skipped
      expect(result.stages.find((s) => s.id === "parse")?.success).toBe(false);
      expect(result.stages.find((s) => s.id === "parse")?.error).toContain(
        "dependency failed",
      );
    });
  });
});
