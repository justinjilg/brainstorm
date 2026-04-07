/**
 * Trust-Label Propagation — taint tracking through the agent pipeline.
 *
 * Every piece of content in the agent's context carries an implicit trust level.
 * When untrusted content (from web_fetch, unknown files, external APIs) enters
 * the pipeline, it "taints" everything derived from it.
 *
 * The key invariant:
 *   No high-impact action may be taken from untrusted context without an
 *   explicit, surfaced, human-reviewed trust transition.
 *
 * Trust levels:
 *   1.0  — User-provided (typed by human, read from CLAUDE.md)
 *   0.7  — Local trusted (project files the user committed)
 *   0.5  — Agent-derived (model synthesis, learned patterns)
 *   0.2  — External untrusted (web_fetch, web_search, unknown URLs)
 *   0.0  — Known adversarial (detected injection patterns)
 *
 * Implementation: middleware tracks a sliding window of trust levels from
 * recent tool results. When a high-risk tool call is about to execute and
 * the minimum trust in the window is below the threshold, the call is blocked.
 */

import { createLogger } from "@brainst0rm/shared";

const log = createLogger("trust-labels");

/** Minimum trust score required for each tool risk tier. */
const TRUST_THRESHOLDS: Record<string, number> = {
  // High-risk tools: require trusted context (0.5+)
  shell: 0.5,
  process_spawn: 0.5,
  file_write: 0.5,
  file_edit: 0.5,
  multi_edit: 0.5,
  batch_edit: 0.5,
  git_commit: 0.5,
  git_push: 0.7,

  // God Mode tools: require high trust
  agent_run_tool: 0.7,
  agent_kill_switch: 0.9,
  agent_workflow_approve: 0.7,

  // Memory tools: moderate trust
  memory: 0.4,

  // GitHub tools: moderate-high trust for mutating actions
  gh_pr: 0.5,
  gh_review: 0.5,
  gh_release: 0.6,
  gh_actions: 0.5,
};

/** Tools whose outputs are inherently untrusted (external data). */
const UNTRUSTED_OUTPUT_TOOLS = new Set(["web_fetch", "web_search"]);

/** Tools whose outputs have moderate trust (local but unverified). */
const MODERATE_TRUST_TOOLS = new Set([
  "file_read",
  "glob",
  "grep",
  "list_dir",
  "git_log",
  "git_diff",
  "git_status",
]);

/** Default trust for tools not in any category. */
const DEFAULT_TOOL_OUTPUT_TRUST = 0.5;

export interface TrustWindow {
  /** Recent tool result trust scores (sliding window of last N). */
  scores: Array<{ tool: string; trust: number; timestamp: number }>;
  /** The minimum trust in the current window. */
  minTrust: number;
  /** Whether the current context is considered tainted. */
  tainted: boolean;
}

const WINDOW_SIZE = 5;

/** Get the trust level for a tool's output. */
export function getToolOutputTrust(toolName: string): number {
  if (UNTRUSTED_OUTPUT_TOOLS.has(toolName)) return 0.2;
  if (MODERATE_TRUST_TOOLS.has(toolName)) return 0.7;
  return DEFAULT_TOOL_OUTPUT_TRUST;
}

/** Get the minimum trust required to execute a tool. */
export function getToolTrustThreshold(toolName: string): number | null {
  return TRUST_THRESHOLDS[toolName] ?? null;
}

/** Create a fresh trust window. */
export function createTrustWindow(): TrustWindow {
  return { scores: [], minTrust: 1.0, tainted: false };
}

/** Record a tool result's trust level in the window. */
export function recordToolTrust(
  window: TrustWindow,
  toolName: string,
  trust?: number,
): TrustWindow {
  const score = trust ?? getToolOutputTrust(toolName);
  const entry = { tool: toolName, trust: score, timestamp: Date.now() };

  const scores = [...window.scores, entry].slice(-WINDOW_SIZE);
  const minTrust = Math.min(...scores.map((s) => s.trust));
  const tainted = minTrust < 0.4;

  if (tainted && !window.tainted) {
    log.info(
      { tool: toolName, trust: score, minTrust },
      "Context tainted by low-trust tool output",
    );
  }

  return { scores, minTrust, tainted };
}

/** Check if a tool call should be allowed given the current trust window. */
export function checkToolTrust(
  window: TrustWindow,
  toolName: string,
):
  | { allowed: true }
  | {
      allowed: false;
      reason: string;
      requiredTrust: number;
      currentTrust: number;
    } {
  const threshold = getToolTrustThreshold(toolName);
  if (threshold === null) return { allowed: true };

  if (window.minTrust >= threshold) return { allowed: true };

  const taintSource = window.scores
    .filter((s) => s.trust < threshold)
    .map((s) => s.tool)
    .join(", ");

  return {
    allowed: false,
    reason: `Context tainted by ${taintSource} (trust: ${window.minTrust.toFixed(1)}) — ${toolName} requires trust >= ${threshold}`,
    requiredTrust: threshold,
    currentTrust: window.minTrust,
  };
}

/** Reset trust window (e.g., after explicit human approval clears taint). */
export function clearTaint(window: TrustWindow): TrustWindow {
  return { scores: [], minTrust: 1.0, tainted: false };
}
