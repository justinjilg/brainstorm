/**
 * Dependency graph tests using real fixture files on disk.
 */

import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDependencyGraph } from "../dependencies.js";

function createTempProject(): string {
  return mkdtempSync(join(tmpdir(), "brainstorm-ingest-deps-"));
}

function writeTsFile(
  projectDir: string,
  relativePath: string,
  content: string,
): void {
  const filePath = join(projectDir, relativePath);
  mkdirSync(join(filePath, ".."), { recursive: true });
  writeFileSync(filePath, content);
}

describe("buildDependencyGraph", () => {
  it("returns an empty graph for an empty directory", () => {
    const projectDir = createTempProject();

    const graph = buildDependencyGraph(projectDir);

    expect(graph).toEqual({
      nodes: [],
      edges: [],
      clusters: [],
      entryPoints: [],
      leafNodes: [],
    });
  });

  it("tracks a simple two-file import relationship", () => {
    const projectDir = createTempProject();
    writeTsFile(
      projectDir,
      "src/a.ts",
      'import { answer } from "./b";\nexport const value = answer;\n',
    );
    writeTsFile(projectDir, "src/b.ts", "export const answer = 42;\n");

    const graph = buildDependencyGraph(projectDir);

    expect(graph.nodes.map((node) => node.path).sort()).toEqual([
      "src/a.ts",
      "src/b.ts",
    ]);
    expect(graph.edges).toEqual([
      {
        from: "src/a.ts",
        to: "src/b.ts",
        importType: "static",
      },
    ]);
  });

  it("tracks exported functions, classes, types, interfaces, and enums", () => {
    const projectDir = createTempProject();
    writeTsFile(
      projectDir,
      "src/exports.ts",
      [
        "export function makeThing() { return 1; }",
        "export class Thing {}",
        "export type ThingId = string;",
        "export interface ThingShape { id: ThingId; }",
        'export enum Status { Ready = "ready" }',
      ].join("\n"),
    );

    const graph = buildDependencyGraph(projectDir);
    const node = graph.nodes.find((item) => item.path === "src/exports.ts");

    expect(node).toBeDefined();
    expect(node?.exports).toEqual([
      "makeThing",
      "Thing",
      "ThingId",
      "ThingShape",
      "Status",
    ]);
  });

  it("detects entry points as files never imported by other files", () => {
    const projectDir = createTempProject();
    writeTsFile(
      projectDir,
      "src/main.ts",
      'import { helper } from "./helper";\nexport const run = helper;\n',
    );
    writeTsFile(projectDir, "src/helper.ts", "export const helper = 1;\n");
    writeTsFile(
      projectDir,
      "src/isolated.ts",
      "export const isolated = true;\n",
    );

    const graph = buildDependencyGraph(projectDir);

    expect(graph.entryPoints.sort()).toEqual([
      "src/isolated.ts",
      "src/main.ts",
    ]);
  });

  it("detects leaf nodes as files that import nothing", () => {
    const projectDir = createTempProject();
    writeTsFile(
      projectDir,
      "src/main.ts",
      'import { helper } from "./helper";\nexport const run = helper;\n',
    );
    writeTsFile(projectDir, "src/helper.ts", "export const helper = 1;\n");
    writeTsFile(
      projectDir,
      "src/standalone.ts",
      "export const standalone = 2;\n",
    );

    const graph = buildDependencyGraph(projectDir);

    expect(graph.leafNodes.sort()).toEqual([
      "src/helper.ts",
      "src/standalone.ts",
    ]);
  });

  it("builds directory-based clusters with cohesion based on internal versus external edges", () => {
    const projectDir = createTempProject();
    writeTsFile(
      projectDir,
      "src/feature/a.ts",
      [
        'import { bValue } from "./b";',
        'import { sharedValue } from "../shared";',
        "export const aValue = bValue + sharedValue;",
      ].join("\n"),
    );
    writeTsFile(
      projectDir,
      "src/feature/b.ts",
      'import { aValue } from "./a";\nexport const bValue = aValue + 1;\n',
    );
    writeTsFile(projectDir, "src/shared.ts", "export const sharedValue = 1;\n");

    const graph = buildDependencyGraph(projectDir);
    const cluster = graph.clusters.find(
      (item) => item.directory === "src/feature",
    );

    expect(cluster).toBeDefined();
    expect(cluster).toEqual({
      directory: "src/feature",
      files: ["src/feature/a.ts", "src/feature/b.ts"],
      internalEdges: 2,
      externalEdges: 1,
      cohesion: 0.67,
    });
  });
});
