export { analyzeProject, type ProjectAnalysis } from "./analyzer.js";
export { detectLanguages, type LanguageBreakdown } from "./languages.js";
export { detectFrameworks, type FrameworkDetection } from "./frameworks.js";
export { buildDependencyGraph, type DependencyGraph } from "./dependencies.js";
export { computeComplexity, type ComplexityReport } from "./complexity.js";
export {
  mapEndpoints,
  type EndpointMap,
  type APIEndpoint,
} from "./endpoints.js";
