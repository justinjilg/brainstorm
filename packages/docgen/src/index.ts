/**
 * @brainst0rm/docgen — Documentation generator for analyzed codebases.
 *
 * Consumes ProjectAnalysis from @brainst0rm/ingest and produces:
 * - Architecture document (overview, stack, component diagram, hotspots)
 * - Module documents (per-cluster: files, exports, dependencies, complexity)
 * - API reference (endpoints grouped by prefix, sequence diagrams)
 *
 * All generators are deterministic — no LLM calls. For LLM-enhanced prose,
 * pass the generated markdown as context to an agent.
 */

export {
  generateArchitectureDoc,
  type ArchitectureDoc,
} from "./architecture.js";
export { generateModuleDocs, type ModuleDoc } from "./modules.js";
export { generateAPIDoc, type APIDoc } from "./api-reference.js";
export { generateGraphDoc, type GraphDoc } from "./graph-docs.js";

import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { ProjectAnalysis } from "@brainst0rm/ingest";
import { generateArchitectureDoc } from "./architecture.js";
import { generateModuleDocs } from "./modules.js";
import { generateAPIDoc } from "./api-reference.js";
import { generateGraphDoc } from "./graph-docs.js";

export interface DocgenResult {
  outputDir: string;
  filesWritten: string[];
  architectureDoc: string;
  moduleDocs: number;
  apiDoc: string | null;
  graphDoc: string | null;
}

/**
 * Generate all documentation and write to disk.
 *
 * @param analysis - ProjectAnalysis from @brainst0rm/ingest
 * @param outputDir - Directory to write docs to (default: docs/generated)
 */
/**
 * Generate all documentation and write to disk.
 *
 * @param analysis - ProjectAnalysis from @brainst0rm/ingest
 * @param outputDir - Directory to write docs to (default: docs/generated)
 * @param graph - Optional CodeGraph for structural documentation (call graphs, community maps)
 */
export function generateAllDocs(
  analysis: ProjectAnalysis,
  outputDir?: string,
  graph?: any,
): DocgenResult {
  const dir = outputDir ?? join(analysis.projectPath, "docs", "generated");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const filesWritten: string[] = [];

  // Architecture doc
  const archDoc = generateArchitectureDoc(analysis);
  const archPath = join(dir, "ARCHITECTURE.md");
  writeFileSync(archPath, archDoc.markdown, "utf-8");
  filesWritten.push(archPath);

  // Module docs
  const moduleDocs = generateModuleDocs(analysis);
  if (moduleDocs.length > 0) {
    const modulesDir = join(dir, "modules");
    if (!existsSync(modulesDir)) mkdirSync(modulesDir, { recursive: true });

    for (const mod of moduleDocs) {
      const safeName = mod.name.replace(/[/\\]/g, "_").replace(/^_/, "");
      const modPath = join(modulesDir, `${safeName}.md`);
      writeFileSync(modPath, mod.markdown, "utf-8");
      filesWritten.push(modPath);
    }
  }

  // API reference
  const apiDoc = generateAPIDoc(analysis);
  let apiDocPath: string | null = null;
  if (apiDoc.endpointCount > 0) {
    apiDocPath = join(dir, "API-REFERENCE.md");
    writeFileSync(apiDocPath, apiDoc.markdown, "utf-8");
    filesWritten.push(apiDocPath);
  }

  // Graph-aware documentation (call graphs, community maps, hotspots)
  let graphDocPath: string | null = null;
  if (graph && typeof graph.extendedStats === "function") {
    const graphDoc = generateGraphDoc(graph);
    graphDocPath = join(dir, "CODE-INTELLIGENCE.md");
    writeFileSync(graphDocPath, graphDoc.markdown, "utf-8");
    filesWritten.push(graphDocPath);
  }

  return {
    outputDir: dir,
    filesWritten,
    architectureDoc: archPath,
    moduleDocs: moduleDocs.length,
    apiDoc: apiDocPath,
    graphDoc: graphDocPath,
  };
}
