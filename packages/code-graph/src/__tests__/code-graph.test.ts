import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CodeGraph,
  indexProjectSync,
  parseFile,
  registerAdapter,
  createTypeScriptAdapter,
} from "../index.js";

// Register TypeScript adapter before tests (required after multi-language refactor)
beforeAll(() => {
  registerAdapter(createTypeScriptAdapter());
});

/** parseFile with non-null assertion — safe because TS adapter is registered above. */
function parse(filePath: string) {
  const result = parseFile(filePath);
  if (!result) throw new Error(`parseFile returned null for ${filePath}`);
  return result;
}

const tempDirs: string[] = [];
const graphs: CodeGraph[] = [];

function makeTempDir(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `${name}-`));
  tempDirs.push(dir);
  return dir;
}

function writeProjectFile(
  projectDir: string,
  relativePath: string,
  content: string,
): string {
  const filePath = join(projectDir, relativePath);
  mkdirSync(join(filePath, ".."), { recursive: true });
  writeFileSync(filePath, content);
  return filePath;
}

function createGraph(projectDir: string): CodeGraph {
  const graph = new CodeGraph({ dbPath: join(projectDir, "graph.db") });
  graphs.push(graph);
  return graph;
}

afterEach(() => {
  while (graphs.length > 0) {
    graphs.pop()?.close();
  }
});

describe("@brainst0rm/code-graph", () => {
  it("parseFile extracts exported functions, classes, methods, calls, and imports", () => {
    const projectDir = makeTempDir("code-graph-parser");
    const filePath = writeProjectFile(
      projectDir,
      "sample.ts",
      [
        'import Foo, { helper as renamedHelper, named } from "./dep";',
        "",
        "export async function runTask(value: string) {",
        "    renamedHelper(value);",
        "    Foo();",
        "}",
        "",
        "export class Worker {",
        "    static async execute() {",
        "        named();",
        "    }",
        "}",
      ].join("\n"),
    );

    const parsed = parse(filePath);

    expect(parsed.functions).toEqual([
      expect.objectContaining({
        name: "runTask",
        file: filePath,
        isExported: true,
        isAsync: true,
      }),
    ]);
    expect(parsed.classes).toEqual([
      expect.objectContaining({
        name: "Worker",
        file: filePath,
        isExported: true,
      }),
    ]);
    expect(parsed.methods).toEqual([
      expect.objectContaining({
        name: "execute",
        className: "Worker",
        isStatic: true,
        isAsync: true,
      }),
    ]);
    expect(parsed.callSites).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          callerName: "runTask",
          calleeName: "renamedHelper",
        }),
        expect.objectContaining({
          callerName: "runTask",
          calleeName: "Foo",
        }),
        expect.objectContaining({
          callerName: "Worker.execute",
          calleeName: "named",
        }),
      ]),
    );
    expect(parsed.imports).toEqual([
      {
        file: filePath,
        source: "./dep",
        names: ["Foo", "helper", "named"],
        isDefault: true,
      },
    ]);
  });

  it("parseFile records assigned arrow functions as non-exported functions", () => {
    const projectDir = makeTempDir("code-graph-arrow");
    const filePath = writeProjectFile(
      projectDir,
      "arrow.ts",
      ["export const localTask = async () => {", "    helper();", "};"].join(
        "\n",
      ),
    );

    const parsed = parse(filePath);

    expect(parsed.functions).toEqual([
      expect.objectContaining({
        name: "localTask",
        isExported: false,
        isAsync: true,
      }),
    ]);
    expect(parsed.callSites).toEqual([
      expect.objectContaining({
        callerName: "localTask",
        calleeName: "helper",
      }),
    ]);
  });

  it("CodeGraph stores definitions, callers, callees, and stats for parsed files", () => {
    const projectDir = makeTempDir("code-graph-storage");
    const filePath = writeProjectFile(
      projectDir,
      "flow.ts",
      [
        "function alpha() {",
        "    beta();",
        "}",
        "",
        "function beta() {}",
        "",
        "class Worker {",
        "    run() {",
        "        alpha();",
        "    }",
        "}",
      ].join("\n"),
    );
    const parsed = parse(filePath);
    const graph = createGraph(projectDir);

    graph.upsertFile(parsed);

    expect(graph.findCallers("alpha")).toEqual([
      {
        caller: "Worker.run",
        file: filePath,
        line: 9,
      },
    ]);
    expect(graph.findCallees("alpha")).toEqual([
      {
        callee: "beta",
        file: filePath,
        line: 2,
      },
    ]);
    expect(graph.findDefinition("Worker")).toEqual([
      expect.objectContaining({
        kind: "class",
        name: "Worker",
        file: filePath,
      }),
    ]);
    expect(graph.stats()).toEqual({
      files: 1,
      functions: 2,
      classes: 1,
      methods: 1,
      callEdges: 2,
    });
  });

  it("CodeGraph impactAnalysis walks transitive callers with depth limits", () => {
    const projectDir = makeTempDir("code-graph-impact");
    const filePath = writeProjectFile(
      projectDir,
      "impact.ts",
      [
        "function leaf() {}",
        "function mid() {",
        "    leaf();",
        "}",
        "function top() {",
        "    mid();",
        "}",
      ].join("\n"),
    );
    const graph = createGraph(projectDir);

    graph.upsertFile(parse(filePath));

    expect(graph.impactAnalysis("leaf", 1)).toEqual([
      {
        name: "mid",
        depth: 1,
        file: filePath,
      },
    ]);
    expect(graph.impactAnalysis("leaf", 2)).toEqual([
      {
        name: "mid",
        depth: 1,
        file: filePath,
      },
      {
        name: "top",
        depth: 2,
        file: filePath,
      },
    ]);
  });

  it("parseFile recognizes generator and async generator function declarations as enclosing scopes", () => {
    const projectDir = makeTempDir("code-graph-generator");
    const filePath = writeProjectFile(
      projectDir,
      "gen.ts",
      [
        "export function* simpleGen() {",
        "    yield helper();",
        "}",
        "",
        "export async function* asyncGen() {",
        "    yield await fetcher();",
        "}",
      ].join("\n"),
    );

    const parsed = parse(filePath);

    // Both generator forms should be captured as functions, not skipped.
    expect(parsed.functions.map((f) => f.name).sort()).toEqual([
      "asyncGen",
      "simpleGen",
    ]);
    // Calls inside generator bodies should be attributed to the enclosing
    // generator function, not module level. This is the bug that made
    // runAgentLoop's 159 outbound call sites invisible.
    const helperCall = parsed.callSites.find((c) => c.calleeName === "helper");
    expect(helperCall).toBeDefined();
    expect(helperCall?.callerName).toBe("simpleGen");
    const fetcherCall = parsed.callSites.find(
      (c) => c.calleeName === "fetcher",
    );
    expect(fetcherCall?.callerName).toBe("asyncGen");
  });

  it("CodeGraph impactAnalysis surfaces module-level call sites instead of dropping them", () => {
    const projectDir = makeTempDir("code-graph-module-impact");
    const filePath = writeProjectFile(
      projectDir,
      "module-call.ts",
      [
        "// Top-level call to target with no enclosing function",
        "import { target } from './other';",
        "target();",
      ].join("\n"),
    );
    const graph = createGraph(projectDir);

    graph.upsertFile(parse(filePath));

    // The call site has caller=null. Old behavior: impactAnalysis returned
    // [] because the loop skipped null callers. New behavior: surface as
    // a module-level call site so the agent at least knows the function is
    // referenced from somewhere.
    const impact = graph.impactAnalysis("target", 2);
    expect(impact.length).toBeGreaterThan(0);
    expect(impact[0]).toMatchObject({
      name: "(module-level call site)",
      depth: 1,
      file: filePath,
    });
  });

  it("does not infinite-loop when a symlink forms a cycle with the project root", async () => {
    // Set up: project with a self-referential symlink. A stat-based walker
    // would follow the symlink on each iteration and scan the same files
    // forever (or until maxFiles). lstat treats the symlink as a leaf and
    // stops.
    const projectDir = makeTempDir("code-graph-symlink");
    writeProjectFile(projectDir, "src/a.ts", "export const a = 1;");
    const { symlinkSync } = await import("node:fs");
    try {
      symlinkSync(projectDir, join(projectDir, "src", "loop"));
    } catch {
      // Some CI envs disallow symlinks — skip this test quietly there.
      return;
    }

    const graph = createGraph(projectDir);
    const result = indexProjectSync(projectDir, {
      graph,
      maxFiles: 10,
    });
    // If the fix regressed, this call would either hang or error after
    // hitting maxFiles on repeated scans of src/a.ts.
    expect(result.progress.filesIndexed).toBeLessThanOrEqual(10);
    expect(result.progress.filesScanned).toBeLessThanOrEqual(10);
  });

  it("indexProject indexes supported files, skips ignored paths, and reports progress", () => {
    const projectDir = makeTempDir("code-graph-indexer");
    writeProjectFile(
      projectDir,
      "src/kept.ts",
      ["export function kept() {", "    helper();", "}"].join("\n"),
    );
    writeProjectFile(
      projectDir,
      "src/view.tsx",
      [
        "export function View() {",
        "    return <button onClick={() => kept()}>Go</button>;",
        "}",
      ].join("\n"),
    );
    writeProjectFile(
      projectDir,
      "src/types.d.ts",
      "export interface Ignored {}\n",
    );
    writeProjectFile(
      projectDir,
      "node_modules/skip.ts",
      "export function skipped() {}\n",
    );
    writeProjectFile(projectDir, ".hidden.ts", "export function hidden() {}\n");

    const progressEvents: Array<{
      filesScanned: number;
      filesIndexed: number;
    }> = [];
    const graph = createGraph(projectDir);

    const { progress } = indexProjectSync(projectDir, {
      graph,
      maxFiles: 2,
      onProgress(current) {
        progressEvents.push({
          filesScanned: current.filesScanned,
          filesIndexed: current.filesIndexed,
        });
      },
    });

    expect(progress).toMatchObject({
      filesScanned: 2,
      filesIndexed: 2,
      errors: 0,
    });
    expect(progress.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(progressEvents).toEqual([]);
    expect(graph.stats()).toEqual({
      files: 2,
      functions: 2,
      classes: 0,
      methods: 0,
      callEdges: 2,
    });
    expect(graph.findDefinition("skipped")).toEqual([]);
    expect(graph.findDefinition("hidden")).toEqual([]);
  });
});
