import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ProjectAnalysis } from "@brainst0rm/ingest";
import {
  generateAllDocs,
  generateAPIDoc,
  generateModuleDocs,
} from "../index.js";

function createAnalysis(
  overrides: Partial<ProjectAnalysis> = {},
): ProjectAnalysis {
  return {
    projectPath: "/tmp/docgen-fixture",
    analyzedAt: "2026-04-10T00:00:00.000Z",
    languages: {
      primary: "TypeScript",
      languages: [
        {
          language: "TypeScript",
          files: 4,
          lines: 640,
          percentage: 100,
        },
      ],
      totalLines: 640,
      totalFiles: 4,
    },
    frameworks: {
      frameworks: ["Express"],
      buildTools: ["tsup"],
      packageManagers: ["npm"],
      databases: ["PostgreSQL"],
      deployment: ["Docker"],
      testing: ["Vitest"],
      ci: ["GitHub Actions"],
    },
    dependencies: {
      nodes: [
        {
          path: "src/api/users.ts",
          language: "TypeScript",
          lines: 120,
          exports: ["getUsers", "createUser"],
        },
        {
          path: "src/api/admin.ts",
          language: "TypeScript",
          lines: 95,
          exports: ["listAdmins"],
        },
        {
          path: "src/lib/db.ts",
          language: "TypeScript",
          lines: 70,
          exports: ["connectDb"],
        },
        {
          path: "src/lib/logger.ts",
          language: "TypeScript",
          lines: 35,
          exports: ["logInfo"],
        },
      ],
      edges: [
        {
          from: "src/api/users.ts",
          to: "src/lib/db.ts",
          importType: "static",
        },
        {
          from: "src/api/users.ts",
          to: "src/lib/logger.ts",
          importType: "static",
        },
        {
          from: "src/api/admin.ts",
          to: "src/lib/db.ts",
          importType: "static",
        },
        {
          from: "src/lib/logger.ts",
          to: "src/api/users.ts",
          importType: "dynamic",
        },
      ],
      clusters: [
        {
          directory: "src/api",
          files: ["src/api/users.ts", "src/api/admin.ts"],
          internalEdges: 0,
          externalEdges: 3,
          cohesion: 0.2,
        },
        {
          directory: "src/lib",
          files: ["src/lib/db.ts", "src/lib/logger.ts"],
          internalEdges: 0,
          externalEdges: 1,
          cohesion: 0.1,
        },
      ],
      entryPoints: ["src/api/users.ts"],
      leafNodes: ["src/lib/db.ts"],
    },
    complexity: {
      files: [
        {
          path: "src/api/users.ts",
          lines: 120,
          branchCount: 14,
          maxNesting: 4,
          functionCount: 5,
          score: 84,
        },
        {
          path: "src/api/admin.ts",
          lines: 95,
          branchCount: 6,
          maxNesting: 2,
          functionCount: 2,
          score: 61,
        },
        {
          path: "src/lib/db.ts",
          lines: 70,
          branchCount: 3,
          maxNesting: 2,
          functionCount: 2,
          score: 44,
        },
      ],
      summary: {
        totalFiles: 4,
        totalLines: 640,
        avgComplexity: 63,
        hotspots: ["src/api/users.ts"],
        avgFileSize: 160,
        largestFile: { path: "src/api/users.ts", lines: 120 },
      },
    },
    endpoints: {
      endpoints: [
        {
          method: "GET",
          path: "/api/users",
          file: "src/api/users.ts",
          line: 8,
          handler: "getUsers",
        },
        {
          method: "POST",
          path: "/api/users",
          file: "src/api/users.ts",
          line: 22,
          handler: "createUser",
        },
        {
          method: "GET",
          path: "/api/admin/audit",
          file: "src/api/admin.ts",
          line: 5,
        },
        {
          method: "GET",
          path: "/status",
          file: "src/api/admin.ts",
          line: 30,
          handler: "statusHandler",
        },
      ],
      frameworks: ["Express/Hono/Fastify"],
      totalRoutes: 4,
    },
    summary: {
      primaryLanguage: "TypeScript",
      totalFiles: 4,
      totalLines: 640,
      frameworkList: ["Express", "tsup"],
      moduleCount: 2,
      avgComplexity: 63,
      hotspotCount: 1,
      entryPointCount: 1,
      apiRouteCount: 4,
    },
    ...overrides,
  };
}

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("docgen pipeline and output", () => {
  it("writes architecture, module, and API docs to disk", () => {
    const outputDir = mkdtempSync(join(tmpdir(), "docgen-"));
    tempDirs.push(outputDir);

    const result = generateAllDocs(createAnalysis(), outputDir);

    expect(result.outputDir).toBe(outputDir);
    expect(result.architectureDoc).toBe(join(outputDir, "ARCHITECTURE.md"));
    expect(result.moduleDocs).toBe(2);
    expect(result.apiDoc).toBe(join(outputDir, "API-REFERENCE.md"));
    expect(result.filesWritten).toEqual([
      join(outputDir, "ARCHITECTURE.md"),
      join(outputDir, "modules", "src_api.md"),
      join(outputDir, "modules", "src_lib.md"),
      join(outputDir, "API-REFERENCE.md"),
    ]);
    expect(readFileSync(result.architectureDoc, "utf-8")).toContain(
      "# docgen-fixture — Architecture Document",
    );
    expect(
      readFileSync(join(outputDir, "modules", "src_api.md"), "utf-8"),
    ).toContain("# Module: src/api");
    expect(readFileSync(result.apiDoc!, "utf-8")).toContain(
      "# docgen-fixture — API Reference",
    );
  });

  it("skips API file creation when no endpoints are present", () => {
    const outputDir = mkdtempSync(join(tmpdir(), "docgen-"));
    tempDirs.push(outputDir);

    const result = generateAllDocs(
      createAnalysis({
        endpoints: {
          endpoints: [],
          frameworks: [],
          totalRoutes: 0,
        },
        summary: {
          ...createAnalysis().summary,
          apiRouteCount: 0,
        },
      }),
      outputDir,
    );

    expect(result.apiDoc).toBeNull();
    expect(result.filesWritten).toEqual([
      join(outputDir, "ARCHITECTURE.md"),
      join(outputDir, "modules", "src_api.md"),
      join(outputDir, "modules", "src_lib.md"),
    ]);
  });

  it("renders module docs with dependencies, dependents, and export truncation", () => {
    const docs = generateModuleDocs(
      createAnalysis({
        dependencies: {
          ...createAnalysis().dependencies,
          nodes: [
            {
              path: "src/api/users.ts",
              language: "TypeScript",
              lines: 120,
              exports: ["alpha", "beta", "gamma", "delta", "epsilon", "zeta"],
            },
            {
              path: "src/api/admin.ts",
              language: "TypeScript",
              lines: 95,
              exports: ["omega"],
            },
            ...createAnalysis().dependencies.nodes.slice(2),
          ],
        },
      }),
    );
    const apiDoc = docs.find((doc) => doc.name === "src/api");

    expect(apiDoc?.markdown).toContain(
      "- `src/api/users.ts` (120 lines) — exports: alpha, beta, gamma, delta, epsilon (+1)",
    );
    expect(apiDoc?.markdown).toContain("## Public API");
    expect(apiDoc?.markdown).toContain("- `omega`");
    expect(apiDoc?.markdown).toContain("## Dependencies");
    expect(apiDoc?.markdown).toContain("- src/lib");
    expect(apiDoc?.markdown).toContain("## Dependents");
    expect(apiDoc?.markdown).toContain("- src/lib");
    expect(apiDoc?.markdown).toContain("Average score: **72.5/100**");
    expect(apiDoc?.markdown).toContain("Hotspots (complexity > 10):");
  });

  it("adds API summary, grouped sections, and a capped request flow diagram", () => {
    const doc = generateAPIDoc(
      createAnalysis({
        endpoints: {
          endpoints: [
            {
              method: "GET",
              path: "/api/users",
              file: "src/api/users.ts",
              line: 8,
              handler: "getUsers",
            },
            {
              method: "POST",
              path: "/api/users",
              file: "src/api/users.ts",
              line: 22,
              handler: "createUser",
            },
            {
              method: "DELETE",
              path: "/api/users/:id",
              file: "src/api/users.ts",
              line: 40,
              handler: "deleteUser",
            },
            {
              method: "GET",
              path: "/api/admin/audit",
              file: "src/api/admin.ts",
              line: 5,
              handler: "auditLog",
            },
            {
              method: "PATCH",
              path: "/api/admin/settings",
              file: "src/api/admin.ts",
              line: 14,
            },
            {
              method: "GET",
              path: "/health",
              file: "src/api/admin.ts",
              line: 30,
              handler: "healthCheck",
            },
            {
              method: "HEAD",
              path: "/status",
              file: "src/api/admin.ts",
              line: 31,
            },
          ],
          frameworks: ["Express/Hono/Fastify", "Next.js API Routes"],
          totalRoutes: 7,
        },
        summary: {
          ...createAnalysis().summary,
          apiRouteCount: 7,
        },
      }),
    );

    expect(doc.endpointCount).toBe(7);
    expect(doc.markdown).toContain("- **Total endpoints:** 7");
    expect(doc.markdown).toContain(
      "- **Frameworks:** Express/Hono/Fastify, Next.js API Routes",
    );
    expect(doc.markdown).toContain("| DELETE | 1 |");
    expect(doc.markdown).toContain("## /api/users");
    expect(doc.markdown).toContain("## /api/admin");
    expect(doc.markdown).toContain("## /health");
    expect(doc.markdown).toContain(
      "| `PATCH` | `/api/admin/settings` | — | `src/api/admin.ts:14` |",
    );
    expect(doc.mermaidDiagram).toContain("sequenceDiagram");
    expect(doc.mermaidDiagram.match(/C->>S:/g)?.length).toBe(6);
    expect(doc.mermaidDiagram).not.toContain("HEAD /status");
  });

  it("returns a concise empty-state API doc when no routes are detected", () => {
    const doc = generateAPIDoc(
      createAnalysis({
        endpoints: {
          endpoints: [],
          frameworks: [],
          totalRoutes: 0,
        },
        summary: {
          ...createAnalysis().summary,
          apiRouteCount: 0,
        },
      }),
    );

    expect(doc.endpointCount).toBe(0);
    expect(doc.mermaidDiagram).toBe("");
    expect(doc.markdown).toContain("No API endpoints detected.");
    expect(doc.markdown).not.toContain("## Summary");
  });
});
