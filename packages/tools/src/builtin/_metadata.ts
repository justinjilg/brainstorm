/**
 * Built-in tool metadata — the canonical source of truth for category,
 * headless-safety, and protocol notes for every tool registered by
 * `createDefaultToolRegistry()`.
 *
 * Why this file exists:
 *   Before Stage-1 of the tool compiler, these three tables lived inside
 *   `export-catalog.ts` and existed only for the catalog generator. Any
 *   surface that wanted the same metadata (MCP exposers, headless-runner
 *   gates, docs generators) had to re-derive it. That's the exact
 *   "N hand-maintained surfaces of one contract" drift BrainstormRouter
 *   collapsed with `defineCapability()`. We do the same thing here, just
 *   smaller: collocate the metadata with the registry it describes, and
 *   gate-test that every registered tool has an entry.
 *
 * Adding a new built-in tool? Two-step:
 *   1. `defineTool({ ... })` somewhere under `builtin/`.
 *   2. Add a `BUILTIN_TOOL_METADATA[name] = { ... }` entry below.
 *
 * The gate test in `__tests__/metadata-coverage.test.ts` will fail CI if
 * step 2 is skipped.
 */

import type { ToolMetadata } from "../base.js";

/** Every built-in tool name must appear here. Gate-test enforced. */
export const BUILTIN_TOOL_METADATA: Record<string, ToolMetadata> = {
  // ── Filesystem ────────────────────────────────────────────────
  file_read: { category: "filesystem", headlessSafe: true },
  file_write: { category: "filesystem", headlessSafe: true },
  file_edit: { category: "filesystem", headlessSafe: true },
  multi_edit: { category: "filesystem", headlessSafe: true },
  batch_edit: {
    category: "filesystem",
    headlessSafe: true,
    protocol:
      "Cross-file find-and-replace in one atomic operation. Validates all edits before applying any.",
  },
  list_dir: { category: "filesystem", headlessSafe: true },
  glob: { category: "filesystem", headlessSafe: true },
  grep: { category: "filesystem", headlessSafe: true },

  // ── Shell ─────────────────────────────────────────────────────
  shell: {
    category: "shell",
    headlessSafe: true,
    protocol:
      "Supports foreground (default 120s timeout) and background mode (returns task ID). Use --lfg to auto-approve in non-interactive mode.",
  },
  process_spawn: { category: "shell", headlessSafe: true },
  process_kill: { category: "shell", headlessSafe: true },
  build_verify: { category: "shell", headlessSafe: true },

  // ── Git ───────────────────────────────────────────────────────
  git_status: { category: "git", headlessSafe: true },
  git_diff: { category: "git", headlessSafe: true },
  git_log: { category: "git", headlessSafe: true },
  git_commit: {
    category: "git",
    headlessSafe: true,
    protocol:
      "Requires --lfg or --unattended in non-interactive mode to bypass confirmation prompt.",
  },
  git_branch: { category: "git", headlessSafe: true },
  git_stash: { category: "git", headlessSafe: true },

  // ── GitHub ────────────────────────────────────────────────────
  gh_pr: { category: "github", headlessSafe: true },
  gh_issue: { category: "github", headlessSafe: true },
  gh_review: { category: "github", headlessSafe: true },
  gh_actions: { category: "github", headlessSafe: true },
  gh_release: { category: "github", headlessSafe: true },
  gh_search: { category: "github", headlessSafe: true },
  gh_security: { category: "github", headlessSafe: true },
  gh_repo: { category: "github", headlessSafe: true },

  // ── Web ───────────────────────────────────────────────────────
  web_fetch: { category: "web", headlessSafe: true },
  web_search: { category: "web", headlessSafe: true },

  // ── Tasks ─────────────────────────────────────────────────────
  task_create: { category: "tasks", headlessSafe: true },
  task_update: { category: "tasks", headlessSafe: true },
  task_list: { category: "tasks", headlessSafe: true },

  // ── Agent self-management ─────────────────────────────────────
  undo_last_write: { category: "agent", headlessSafe: true },
  scratchpad_write: { category: "agent", headlessSafe: true },
  scratchpad_read: { category: "agent", headlessSafe: true },
  ask_user: {
    category: "agent",
    headlessSafe: false,
    protocol:
      "Blocks waiting for UI event. Only works in interactive chat mode (brainstorm chat). Deadlocks in brainstorm run.",
  },
  set_routing_hint: { category: "agent", headlessSafe: true },
  cost_estimate: { category: "agent", headlessSafe: true },

  // ── Planning ──────────────────────────────────────────────────
  plan_preview: { category: "planning", headlessSafe: true },

  // ── Transactions ──────────────────────────────────────────────
  begin_transaction: {
    category: "transactions",
    headlessSafe: true,
    protocol:
      "Opens an atomic transaction. All file writes are staged. Must be followed by commit_transaction or rollback_transaction.",
  },
  commit_transaction: {
    category: "transactions",
    headlessSafe: true,
    protocol: "Applies all staged writes from begin_transaction atomically.",
  },
  rollback_transaction: {
    category: "transactions",
    headlessSafe: true,
    protocol:
      "Discards all staged writes from begin_transaction. No files are changed.",
  },

  // ── BrainstormRouter intelligence ─────────────────────────────
  br_status: { category: "brainstorm_router", headlessSafe: true },
  br_budget: { category: "brainstorm_router", headlessSafe: true },
  br_models: { category: "brainstorm_router", headlessSafe: true },
  br_memory_search: {
    category: "brainstorm_router",
    headlessSafe: true,
    protocol:
      "Searches BrainstormRouter's memory by semantic query. Requires active BR API key.",
  },
  br_memory_store: {
    category: "brainstorm_router",
    headlessSafe: true,
    protocol:
      "Stores a key-value pair in BrainstormRouter's memory. Requires active BR API key.",
  },
  br_leaderboard: { category: "brainstorm_router", headlessSafe: true },
  br_insights: { category: "brainstorm_router", headlessSafe: true },
  br_health: { category: "brainstorm_router", headlessSafe: true },

  // ── Memory (persistent) ───────────────────────────────────────
  memory: { category: "agent", headlessSafe: true },

  // ── Code graph ────────────────────────────────────────────────
  code_callers: { category: "code_graph", headlessSafe: true },
  code_callees: { category: "code_graph", headlessSafe: true },
  code_definition: { category: "code_graph", headlessSafe: true },
  code_impact: { category: "code_graph", headlessSafe: true },
  code_stats: { category: "code_graph", headlessSafe: true },

  // ── Tool discovery ────────────────────────────────────────────
  tool_search: {
    category: "discovery",
    headlessSafe: true,
    protocol:
      "Discovers and loads deferred MCP/God Mode tools by keyword. Call this to find runtime-discovered tools not in the static catalog.",
  },

  // ── Daemon-only ───────────────────────────────────────────────
  daemon_sleep: {
    category: "daemon",
    headlessSafe: true,
    protocol:
      "Only available in daemon mode. Model calls this to control its own wake cycle.",
  },
  pipeline_dispatch: {
    category: "daemon",
    headlessSafe: true,
    protocol:
      "Pipeline dispatcher tool — daemon-only orchestration entrypoint.",
  },
};

/**
 * Resolve a tool's effective metadata by merging the canonical table
 * with anything declared inline on the tool def. Inline fields win — so
 * a plugin or test can override central defaults without rewriting this
 * file.
 *
 * Returns `undefined` if the tool has no inline declaration AND no
 * entry in the canonical table. The gate test fails CI in that case
 * for built-in tools.
 */
export function resolveToolMetadata(
  toolName: string,
  inline?: Partial<ToolMetadata>,
): ToolMetadata | undefined {
  const canonical = BUILTIN_TOOL_METADATA[toolName];
  if (!canonical && (!inline || inline.category === undefined))
    return undefined;
  return {
    category: inline?.category ?? canonical?.category ?? "other",
    headlessSafe: inline?.headlessSafe ?? canonical?.headlessSafe ?? true,
    tags: inline?.tags ?? canonical?.tags,
    protocol: inline?.protocol ?? canonical?.protocol,
  };
}
