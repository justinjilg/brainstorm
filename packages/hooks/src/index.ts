export { HookManager } from "./manager.js";
export type {
  HookDefinition,
  HookEvent,
  HookResult,
  HookType,
  PermissionDecision,
} from "./types.js";
export {
  detectLinter,
  runLint,
  createAutoLintHooks,
} from "./builtin/auto-lint.js";
export {
  detectTestRunner,
  detectBuildCommand,
  runVerify,
  createAutoVerifyHooks,
  type VerifyResult,
} from "./builtin/auto-verify.js";
export { createGraphEnrichHooks } from "./builtin/graph-enrich.js";
export { createAutoReindexHooks } from "./builtin/auto-reindex.js";
