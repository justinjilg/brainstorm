/**
 * @brainst0rm/code-graph — multi-language knowledge graph for codebases.
 *
 * Builds a SQLite graph of functions, classes, methods, and call edges
 * using tree-sitter AST parsing. Supports TypeScript (bundled), Python,
 * Go, Rust, Java (optional peer dependencies).
 *
 * Answers structural queries like:
 *   - Who calls this function?
 *   - What does this function call?
 *   - What breaks if I change this?
 *   - Go to definition
 *
 * Inspired by Codebase-Memory (arxiv 2603.27277) — the state of the art.
 */

export { parseFile } from "./parser.js";
export type {
  ParsedFile,
  FunctionDef,
  ClassDef,
  MethodDef,
  CallSite,
  ImportDecl,
} from "./parser.js";

export { CodeGraph } from "./graph.js";
export type { GraphOptions } from "./graph.js";

export { indexProject, indexProjectSync } from "./indexer.js";
export type { IndexProgress } from "./indexer.js";

// Language adapter system
export type { LanguageAdapter } from "./languages/types.js";
export {
  registerAdapter,
  getAdapterForExtension,
  supportedExtensions,
  registeredLanguages,
  initializeAdapters,
} from "./languages/registry.js";
export { createTypeScriptAdapter } from "./languages/typescript.js";

// Work Plan Generator
export {
  generateWorkPlan,
  type WorkPlan,
  type WorkItem,
  type SectorBrief,
  type ProjectOverview,
  type RiskAssessment,
  type OrchestrationStrategy,
} from "./planner/index.js";

// Dashboard
export { startDashboard, type DashboardOptions } from "./dashboard/index.js";

// Obsidian Vault
export { generateObsidianVault, type VaultResult } from "./vault/index.js";

// Community Detection
export {
  detectCommunities,
  nameCommunity,
  classifySectorTier,
  type SectorProfile,
  type SectorTier,
  type DetectionResult,
  TIER_TO_COMPLEXITY,
  TIER_TO_QUALITY,
} from "./community/index.js";

// Sector Agents
export {
  assignAgentsToSectors,
  getAgentForFile,
  getAgentsByPriority,
  profileForTier,
  buildSectorPrompt,
  generateSectorAgentMd,
  loadSectorPlan,
  saveSectorPlan,
  loadAllSectorPlans,
  createInitialPlan,
  getNextObjective,
  completeObjective,
  selectNextSector,
  recordSectorTick,
  getSectorPlanSummary,
  type SectorAgent,
  type SectorTaskProfile,
  type SectorPlan,
  type PlanObjective,
  type SectorTickContext,
} from "./sectors/index.js";

// Cross-Project Intelligence
export {
  CrossProjectGraph,
  type CrossProjectEdge,
  type CrossProjectAnalysis,
  type ApiContract,
  type SharedType,
} from "./cross-project/index.js";

// Hybrid Search
export {
  initFTS5,
  buildFTS5Index,
  searchBM25,
  hybridSearch,
  type BM25Result,
  type HybridSearchResult,
} from "./search/index.js";

// MCP Server
export {
  registerCodeIntelMCP,
  type CodeIntelServerOptions,
} from "./mcp/index.js";
export { registerCodeIntelTools } from "./mcp/index.js";

// Pipeline DAG
export {
  executePipeline,
  topologicalLevels,
  createDefaultPipeline,
} from "./pipeline/index.js";
export type {
  PipelineStage,
  PipelineContext,
  PipelineResult,
  ScanResult,
  ParseResult,
  GraphBuildResult,
  CrossFileResult,
  PipelineSummary,
} from "./pipeline/index.js";
