import { describe, expect, it } from "vitest";
import type { ProjectAnalysis } from "@brainst0rm/ingest";
import { generateArchitectureDoc } from "../architecture.js";

function createAnalysis(
  overrides: Partial<ProjectAnalysis> = {},
): ProjectAnalysis {
  return {
    projectPath: "/tmp/sample-app",
    analyzedAt: "2026-04-10T00:00:00.000Z",
    languages: {
      primary: "TypeScript",
      languages: [
        {
          language: "TypeScript",
          files: 12,
          lines: 1234,
          percentage: 88.5,
        },
        {
          language: "Markdown",
          files: 2,
          lines: 160,
          percentage: 11.5,
        },
      ],
      totalLines: 1394,
      totalFiles: 14,
    },
    frameworks: {
      frameworks: ["React", "Express"],
      buildTools: ["Turborepo", "Vite"],
      packageManagers: ["npm"],
      databases: ["PostgreSQL"],
      deployment: ["Docker"],
      testing: ["Vitest"],
      ci: ["GitHub Actions"],
    },
    dependencies: {
      nodes: [],
      edges: [
        {
          from: "src/index.ts",
          to: "src/server/app.ts",
          importType: "static",
        },
        {
          from: "src/server/app.ts",
          to: "src/ui/App.tsx",
          importType: "dynamic",
        },
      ],
      clusters: [
        {
          directory: "src/server",
          files: [
            "src/server/app.ts",
            "src/server/router.ts",
            "src/server/db.ts",
          ],
          internalEdges: 3,
          externalEdges: 1,
          cohesion: 0.75,
        },
        {
          directory: "src/ui",
          files: ["src/ui/App.tsx", "src/ui/routes.tsx"],
          internalEdges: 1,
          externalEdges: 1,
          cohesion: 0.5,
        },
      ],
      entryPoints: ["src/index.ts"],
      leafNodes: ["src/ui/routes.tsx"],
    },
    complexity: {
      files: [
        {
          path: "src/server/router.ts",
          lines: 320,
          branchCount: 42,
          maxNesting: 6,
          functionCount: 11,
          score: 81,
        },
        {
          path: "src/ui/App.tsx",
          lines: 180,
          branchCount: 12,
          maxNesting: 3,
          functionCount: 6,
          score: 48,
        },
      ],
      summary: {
        totalFiles: 14,
        totalLines: 1394,
        avgComplexity: 64,
        hotspots: ["src/server/router.ts"],
        avgFileSize: 100,
        largestFile: {
          path: "src/server/router.ts",
          lines: 320,
        },
      },
    },
    endpoints: {
      endpoints: [],
      frameworks: ["Express/Hono/Fastify"],
      totalRoutes: 3,
    },
    summary: {
      primaryLanguage: "TypeScript",
      totalFiles: 14,
      totalLines: 1394,
      frameworkList: ["React", "Express", "Turborepo", "Vite"],
      moduleCount: 2,
      avgComplexity: 64,
      hotspotCount: 1,
      entryPointCount: 1,
      apiRouteCount: 3,
    },
    ...overrides,
  };
}

describe("generateArchitectureDoc", () => {
  it("returns non-empty markdown with document headers", () => {
    const doc = generateArchitectureDoc(createAnalysis());

    expect(doc.markdown).toContain("# sample-app — Architecture Document");
    expect(doc.markdown).toContain("## Overview");
    expect(doc.markdown).toContain("## Technology Stack");
    expect(doc.markdown).toContain("## Component Diagram");
    expect(doc.markdown.trim().length).toBeGreaterThan(0);
  });

  it("includes the primary language and total line count in the overview", () => {
    const doc = generateArchitectureDoc(createAnalysis());

    expect(doc.markdown).toContain("| Primary Language | TypeScript |");
    expect(doc.markdown).toContain("| Total Lines | 1,394 |");
  });

  it("includes detected framework categories in the technology stack", () => {
    const doc = generateArchitectureDoc(createAnalysis());

    expect(doc.markdown).toContain("- **Frameworks:** React, Express");
    expect(doc.markdown).toContain("- **Build Tools:** Turborepo, Vite");
    expect(doc.markdown).toContain("- **Testing:** Vitest");
    expect(doc.markdown).toContain("- **CI/CD:** GitHub Actions");
  });

  it("includes hotspot files with complexity score details when available", () => {
    const doc = generateArchitectureDoc(createAnalysis());

    expect(doc.markdown).toContain("## Complexity Hotspots");
    expect(doc.markdown).toContain(
      "- `src/server/router.ts` — complexity: 81, 320 lines",
    );
  });

  it("renders fallback sections for minimal analysis without crashing", () => {
    const minimalAnalysis = createAnalysis({
      projectPath: "/tmp/minimal",
      languages: {
        primary: "Unknown",
        languages: [],
        totalLines: 0,
        totalFiles: 0,
      },
      frameworks: {
        frameworks: [],
        buildTools: [],
        packageManagers: [],
        databases: [],
        deployment: [],
        testing: [],
        ci: [],
      },
      dependencies: {
        nodes: [],
        edges: [],
        clusters: [],
        entryPoints: [],
        leafNodes: [],
      },
      complexity: {
        files: [],
        summary: {
          totalFiles: 0,
          totalLines: 0,
          avgComplexity: 0,
          hotspots: [],
          avgFileSize: 0,
          largestFile: null,
        },
      },
      endpoints: {
        endpoints: [],
        frameworks: [],
        totalRoutes: 0,
      },
      summary: {
        primaryLanguage: "Unknown",
        totalFiles: 0,
        totalLines: 0,
        frameworkList: [],
        moduleCount: 0,
        avgComplexity: 0,
        hotspotCount: 0,
        entryPointCount: 0,
        apiRouteCount: 0,
      },
    });

    const doc = generateArchitectureDoc(minimalAnalysis);

    expect(doc.markdown).toContain("# minimal — Architecture Document");
    expect(doc.markdown).toContain("| Frameworks | None detected |");
    expect(doc.markdown).toContain("```mermaid");
    expect(doc.mermaidDiagram).toContain("No module clusters detected");
    expect(doc.sections).toEqual([
      "Overview",
      "Technology Stack",
      "Language Breakdown",
      "Component Diagram",
    ]);
  });

  it("includes module clusters and entry points when dependency data exists", () => {
    const doc = generateArchitectureDoc(createAnalysis());

    expect(doc.markdown).toContain("## Module Clusters");
    expect(doc.markdown).toContain("### src/server");
    expect(doc.markdown).toContain("- `src/server/app.ts`");
    expect(doc.markdown).toContain("## Entry Points");
    expect(doc.markdown).toContain("- `src/index.ts`");
  });
});
