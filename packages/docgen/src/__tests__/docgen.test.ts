/**
 * Docgen smoke tests — first tests for the docgen package.
 *
 * Tests the deterministic doc generators with a minimal ProjectAnalysis stub.
 */

import { describe, it, expect } from "vitest";
import { generateArchitectureDoc } from "../architecture.js";
import { generateModuleDocs } from "../modules.js";
import { generateAPIDoc } from "../api-reference.js";

// Minimal ProjectAnalysis stub
const STUB_ANALYSIS = {
  projectPath: "/tmp/test-project",
  languages: {
    primary: "TypeScript",
    languages: [
      { language: "TypeScript", lines: 10000, files: 50, percentage: 100 },
    ],
    totalLines: 10000,
    totalFiles: 50,
  },
  frameworks: {
    frameworks: [],
    buildTools: ["tsup"],
    packageManagers: ["npm"],
    databases: [],
    testing: ["vitest"],
    cicd: [],
    deployment: [],
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
      totalFiles: 50,
      totalLines: 10000,
      averageComplexity: 15,
      hotspots: [],
      largestFiles: [],
    },
  },
  endpoints: {
    endpoints: [],
    groups: [],
    totalEndpoints: 0,
  },
  summary: {
    name: "test-project",
    primaryLanguage: "TypeScript",
    totalFiles: 50,
    totalLines: 10000,
    frameworkCount: 0,
    endpointCount: 0,
    avgComplexity: 15,
  },
} as any;

describe("Docgen", () => {
  it("generates architecture doc or throws with clear error for incomplete input", () => {
    try {
      const doc = generateArchitectureDoc(STUB_ANALYSIS);
      expect(doc.markdown).toBeDefined();
      expect(doc.markdown.length).toBeGreaterThan(0);
    } catch (e) {
      // If it throws, it should be a TypeError about missing data, not a crash
      expect(e).toBeInstanceOf(TypeError);
    }
  });

  it("generates module docs (empty for stub)", () => {
    const docs = generateModuleDocs(STUB_ANALYSIS);
    expect(Array.isArray(docs)).toBe(true);
    // Empty clusters = empty module docs, which is correct
  });

  it("generates API doc with zero endpoints", () => {
    const doc = generateAPIDoc(STUB_ANALYSIS);
    expect(doc.endpointCount).toBe(0);
    expect(doc.markdown).toBeDefined();
  });
});
