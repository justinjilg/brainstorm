export {
  analyzeProject,
  runDeepAnalysis,
  type ProjectAnalysis,
  type DeepGraphAnalysis,
} from "./analyzer.js";
export { detectLanguages, type LanguageBreakdown } from "./languages.js";
export { detectFrameworks, type FrameworkDetection } from "./frameworks.js";
export {
  buildDependencyGraph,
  type DependencyGraph,
  type GraphNode,
  type GraphEdge,
  type ModuleCluster,
} from "./dependencies.js";
export { computeComplexity, type ComplexityReport } from "./complexity.js";
export {
  mapEndpoints,
  type EndpointMap,
  type APIEndpoint,
} from "./endpoints.js";
