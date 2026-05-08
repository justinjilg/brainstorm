export {
  brainstormConfigSchema,
  type BrainstormConfig,
  type BudgetConfig,
  type ProviderConfig,
  type RoutingRule,
  type GeneralConfig,
  type AgentConfig,
  type WorkflowConfig,
  type WorkflowStepConfig,
  type DaemonConfig,
} from "./schema.js";
export {
  loadConfig,
  watchConfig,
  GLOBAL_CONFIG_DIR,
  GLOBAL_CONFIG_FILE,
} from "./loader.js";
export { DEFAULT_CONFIG } from "./defaults.js";
export {
  stormFrontmatterSchema,
  type StormFrontmatter,
} from "./storm-schema.js";
export {
  loadStormFile,
  parseStormFile,
  loadHierarchicalStormFiles,
  type StormFile,
  type HierarchicalStormResult,
} from "./storm-loader.js";
export {
  businessTomlSchema,
  archetypeSchema,
  BUSINESS_SCHEMA_VERSION,
  type BusinessToml,
  type BusinessIdentity,
  type Archetype,
  type ProductPointer,
  type ValidationPolicy,
  type AccessPolicy,
  type AiLoopsBudget,
} from "./business-schema.js";
export {
  findBusinessHarnessRoot,
  loadBusinessHarness,
  detectBusinessHarness,
  BUSINESS_MANIFEST_FILE,
  type LoadBusinessHarnessResult,
} from "./business-loader.js";

/**
 * Starter-template types shared between `@brainst0rm/cli` (the consumer)
 * and `@brainst0rm/archetype-*` packages (the producers).
 */
export interface TemplateFile {
  /** Relative path inside the harness root. */
  path: string;
  /** File content (UTF-8). */
  content: string;
}

export interface StarterTemplate {
  /** Slug used in `--template <slug>`. */
  slug: string;
  /** Human-readable description for `--help`. */
  description: string;
  /** Archetype this template targets - written into business.toml. */
  archetype: string;
  /** Files to materialize relative to harness root. */
  files: TemplateFile[];
}
