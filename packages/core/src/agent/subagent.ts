import { streamText, stepCountIs } from "ai";
import type { BrainstormConfig } from "@brainst0rm/config";
import type { ProviderRegistry } from "@brainst0rm/providers";
import {
  BrainstormRouter,
  CostTracker,
  adaptToolsForModel,
  reverseToolName,
} from "@brainst0rm/router";
import {
  type ToolRegistry,
  setDockerSandbox,
  DockerSandbox,
  withWorkspace,
  getSandboxPool,
} from "@brainst0rm/tools";
import {
  serializeRoutingMetadata,
  createLogger,
  linkSignals,
} from "@brainst0rm/shared";
import type { AgentContract } from "@brainst0rm/shared";
import {
  renderContractPrompt,
  validateContractOutput,
} from "@brainst0rm/contracts";
import { getOutputSchema } from "@brainst0rm/agents";
import type { SystemPromptSegment } from "./context.js";
import { segmentsToSystemArray } from "./context.js";
import {
  detectNarratedToolIntent,
  buildToolUseCorrection,
} from "./tool-use-enforcement.js";

const log = createLogger("subagent");

// ── Container sandbox serialization ─────────────────────────────────
//
// The module-level Docker sandbox singleton (setDockerSandbox/shell.ts)
// can only safely hold one subagent's container at a time — every shell
// tool call reads that single reference. Two containerIsolation code
// subagents running in parallel (spawn_agents parallel mode) would
// otherwise interleave their swap/restore: subagent B could capture
// subagent A's container as "previous", A's finally could release A's
// container back to the pool as idle while B still holds it live, and
// B's finally could then re-install a pool-idle container as the
// singleton out from under the parent. Serialize just this
// acquire→run→release window for container-isolated subagents so only
// one holds the singleton at a time.
let containerLockTail: Promise<void> = Promise.resolve();
function acquireContainerLock(): Promise<() => void> {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const acquired = containerLockTail.then(() => release);
  containerLockTail = containerLockTail.then(() => held);
  return acquired;
}

// ── Subagent Types ──────────────────────────────────────────────────

export type SubagentType =
  | "explore"
  | "plan"
  | "code"
  | "review"
  | "general"
  | "decompose"
  | "external"
  | "research"
  | "memory-curator";

interface SubagentTypeConfig {
  /** Tools this subagent type is allowed to use */
  allowedTools: string[] | "all";
  /** System prompt prefix for behavioral instructions */
  systemPrompt: string;
  /** Default max steps (keep focused subagents short) */
  defaultMaxSteps: number;
  /** Model complexity hint: 'cheap' routes to cost-first, 'capable' to quality-first */
  modelHint: "cheap" | "capable";
}

const SUBAGENT_TYPES: Record<SubagentType, SubagentTypeConfig> = {
  explore: {
    allowedTools: [
      "file_read",
      "glob",
      "grep",
      "list_dir",
      "git_status",
      "git_diff",
      "git_log",
      "web_fetch",
      "web_search",
    ],
    systemPrompt:
      "You are an exploration subagent. Your job is to find information in the codebase or online docs quickly and return what you found. You have read-only tools — you cannot modify files. Return results as a structured list of findings with file paths and line numbers where applicable.",
    defaultMaxSteps: 5,
    modelHint: "cheap",
  },
  plan: {
    allowedTools: [
      "file_read",
      "glob",
      "grep",
      "list_dir",
      "git_status",
      "git_diff",
      "git_log",
      "task_create",
      "task_update",
      "task_list",
      "memory",
    ],
    systemPrompt:
      "You are a planning subagent. Analyze the codebase and design an implementation approach. Create tasks to track the plan. You have read-only file tools plus task management. Return a structured plan.",
    defaultMaxSteps: 8,
    modelHint: "capable",
  },
  code: {
    allowedTools: "all",
    systemPrompt:
      "You are a coding subagent. Implement the requested changes, verify they compile, and return a summary of what you changed. Follow existing patterns in the codebase.",
    defaultMaxSteps: 10,
    modelHint: "capable",
  },
  review: {
    allowedTools: [
      "file_read",
      "glob",
      "grep",
      "list_dir",
      "git_status",
      "git_diff",
      "git_log",
    ],
    systemPrompt:
      "You are a code review subagent. Review the changes for bugs, style issues, and correctness. Be specific — cite file paths and line numbers. Focus on real issues, not nitpicks. You have read-only access — you cannot modify files or commit.",
    defaultMaxSteps: 5,
    modelHint: "capable",
  },
  general: {
    allowedTools: [
      "file_read",
      "glob",
      "grep",
      "list_dir",
      "git_status",
      "git_diff",
      "git_log",
      "web_fetch",
      "web_search",
      "shell",
      "task_create",
      "task_update",
      "task_list",
      "memory",
    ],
    systemPrompt:
      "You are a focused subagent. Complete the given task concisely and return the result. Do not ask questions — make your best judgment. You cannot create or edit files directly — use shell commands if you need to modify files.",
    defaultMaxSteps: 5,
    modelHint: "cheap",
  },
  decompose: {
    allowedTools: [
      "file_read",
      "glob",
      "grep",
      "list_dir",
      "git_status",
      "git_diff",
      "git_log",
    ],
    systemPrompt:
      "You are a task decomposition agent. Break down the given task into discrete implementation steps. " +
      "For each step, specify: title, subagent type (explore/plan/code/review), dependencies on other steps, " +
      "and estimated relative cost (low/medium/high). Return a structured JSON array of steps. " +
      "Read the codebase to understand the architecture before decomposing.",
    defaultMaxSteps: 5,
    modelHint: "capable",
  },
  research: {
    allowedTools: [
      "file_read",
      "glob",
      "grep",
      "list_dir",
      "web_fetch",
      "web_search",
      "gh_issue",
      "gh_pr",
    ],
    systemPrompt:
      "You are a research subagent. Search external documentation, GitHub repos, Stack Overflow, and API references to find answers. " +
      "Combine findings from multiple sources. Cite URLs for every claim. " +
      "Return a structured research report with: summary, key findings (with sources), and recommended next steps.",
    defaultMaxSteps: 8,
    modelHint: "capable",
  },
  external: {
    allowedTools: [],
    systemPrompt:
      "External agent — execution is delegated to an external CLI tool.",
    defaultMaxSteps: 1,
    modelHint: "cheap",
  },
  "memory-curator": {
    allowedTools: ["file_read", "file_write", "glob"],
    systemPrompt:
      "You are a memory curator agent. Tidy recently-modified memory files: dedup near-identical entries, resolve contradictions, promote/demote tiers. Be conservative — only change what clearly needs changing.",
    defaultMaxSteps: 5,
    modelHint: "cheap",
  },
};

/**
 * Get the configuration for a subagent type.
 */
export function getSubagentTypeConfig(type: SubagentType): SubagentTypeConfig {
  return SUBAGENT_TYPES[type];
}

/**
 * All valid subagent type names.
 */
export const SUBAGENT_TYPE_NAMES: SubagentType[] = [
  "explore",
  "plan",
  "code",
  "review",
  "general",
  "decompose",
  "external",
  "research",
  "memory-curator",
];

// ── Subagent Execution ──────────────────────────────────────────────

/** Callback for subagent lifecycle hooks (injected to avoid circular deps with @brainst0rm/hooks). */
export type SubagentHookFn = (
  event: "SubagentStart" | "SubagentStop",
  context: {
    subagentType: string;
    prompt?: string;
    budget?: number;
    result?: string;
    cost?: number;
    toolCalls?: number;
    model?: string;
    /** Effective per-spawn tool allowlist (narrowing only), if one was resolved. */
    toolAllowlist?: string[];
    /** Extra system-prompt instructions appended for this spawn, if any. */
    promptAppend?: string;
    /** Effective max agentic steps for this spawn. */
    maxSteps?: number;
    /** Effective budget limit (dollars) for this spawn. */
    budgetLimit?: number;
  },
) => Promise<void>;

export interface SubagentOptions {
  config: BrainstormConfig;
  registry: ProviderRegistry;
  router: BrainstormRouter;
  costTracker: CostTracker;
  tools: ToolRegistry;
  projectPath: string;
  /** Subagent type — determines tool access, system prompt, and model hint. */
  type?: SubagentType;
  /** System prompt override (overrides type's default). */
  systemPrompt?: string;
  /** Max steps override (overrides type's default). */
  maxSteps?: number;
  /** Budget limit in dollars. If exceeded, subagent is terminated (parent continues). */
  budgetLimit?: number;
  /** Optional hook callback for SubagentStart/SubagentStop events. */
  onHook?: SubagentHookFn;
  /**
   * Permission check — gating function for subagent tools.
   * MANDATORY: if not provided, subagent tools are restricted to read-only.
   * This prevents privilege escalation via subagent spawning.
   */
  permissionCheck?: (
    toolName: string,
    toolPermission: any,
  ) => "allow" | "confirm" | "deny";
  /** When true and container mode is active, code subagents get their own DockerSandbox. */
  containerIsolation?: boolean;
  /** Parent's system prompt segments — enables prompt cache sharing (fork model). */
  parentSegments?: SystemPromptSegment[];
  /**
   * Parent's available tool names — subagent tools are intersected with this set.
   * Prevents privilege escalation: a subagent can never have more tools than its parent.
   * If not provided, the subagent type's allowedTools are used as-is (legacy behavior).
   */
  parentToolNames?: string[];
  /**
   * Per-spawn tool allowlist — a narrowing subset applied on top of the type's
   * allowedTools ceiling. This can only NARROW, never widen: it is intersected
   * with the type's allowed set (or, when the type grants "all", becomes the
   * effective set), and is then further intersected with parentToolNames. A
   * caller cannot use this to grant a tool the type does not already permit.
   */
  toolAllowlist?: string[];
  /**
   * Force zero tools for this spawn, regardless of the type's tool set. Use
   * for pure text-in/text-out subagents (e.g. the planner's decomposition
   * pass) where tool access only tempts a model to explore instead of
   * answering. Stronger than a prompt directive: the tools physically aren't
   * present, so a disobedient model cannot call them. Overrides toolAllowlist.
   */
  noTools?: boolean;
  /**
   * Extra instructions appended to the system prompt with a blank-line
   * separator. This NEVER replaces the template prompt — it composes with
   * (options.systemPrompt ?? typeConfig.systemPrompt), so a caller can add
   * task-specific guidance without stripping the type's behavioral guardrails.
   */
  promptAppend?: string;
  /**
   * Explicit model pin — when provided, bypasses the subagent's internal
   * routing and uses this model directly. Parent loops can propagate their
   * own preferredModelId through to subagents so --model flags honor
   * transitively through spawnSubagent.
   */
  preferredModelId?: string;
  /**
   * Parent abort signal. When the parent agent loop is cancelled (Ctrl+C,
   * request disconnect), the subagent must also stop — otherwise spawned
   * subagents keep burning tokens and running tools on a dead session.
   * This is linked alongside the subagent's internal budget abort so
   * either source triggers termination.
   */
  parentSignal?: AbortSignal;
  /**
   * Force the read-only tool downgrade for this spawn, regardless of type.
   * Routes through applyReadOnlyDowngrade (narrowing-only, never widening) —
   * used to map an AgentContract's `authority.readOnly` onto the existing
   * narrowing chain. Absent → unchanged behavior.
   */
  readOnly?: boolean;
  /**
   * Optional AgentContract this spawn executes against. When present, the
   * task prompt is the deterministic contract render (renderContractPrompt),
   * the contract's authority.* maps onto the narrowing chain
   * (toolAllowlist/maxSteps/budgetLimit/readOnly), and the output is validated
   * against the declared schema with one repair round-trip. Absent → exact
   * freeform behavior. Purely additive/opt-in.
   */
  contract?: AgentContract;
}

export interface SubagentResult {
  text: string;
  cost: number;
  modelUsed: string;
  toolCalls: string[];
  type: SubagentType;
  budgetExceeded: boolean;
  partialOutput?: string;
  /**
   * The provider `finishReason` of the subagent's final model turn (AI SDK v6):
   * `"stop"` (normal), `"tool-calls"`, `"length"`, `"content-filter"` (provider
   * moderation refused the prompt), `"error"`, etc. Surfaced so callers can tell
   * a genuine empty result from a provider-terminated one instead of reporting a
   * silent "no changes". Undefined if the run never produced a finish event.
   */
  finishReason?: string;
  /**
   * Contract validation outcome — present only when the spawn ran against an
   * AgentContract (options.contract). `valid` reflects the final validation
   * (after one repair round-trip, if attempted). Absent on the freeform path.
   */
  contractOutcome?: {
    valid: boolean;
    parsed?: unknown;
    errors?: string[];
    repairAttempted?: boolean;
  };
}

/**
 * Human-readable explanation for a non-`stop` provider finishReason, or null
 * when the reason is a normal completion (`stop`/`tool-calls`/undefined) that
 * needs no callout. Lets callers surface WHY a run produced no useful output —
 * e.g. a moderation block — instead of a silent empty result.
 */
export function describeFinishReason(
  reason: string | undefined,
): string | null {
  switch (reason) {
    case "content-filter":
      return "provider content filter blocked the response (the model/provider refused the prompt)";
    case "length":
      return "hit the output token limit before finishing";
    case "error":
      return "the provider returned an error mid-generation";
    case "other":
      return "the provider stopped generation for an unspecified reason";
    default:
      // "stop", "tool-calls", undefined, or any unknown reason → no callout.
      return null;
  }
}

/**
 * Resolve a subagent's effective tool set via the narrowing intersection
 * chain: type ceiling → per-spawn allowlist → parent ceiling.
 *
 * Every stage can only remove tools, never add them. Returns the concrete
 * allowed list, or `undefined` meaning "all tools" (only possible when the
 * type grants "all" and neither an allowlist nor a parent ceiling narrows it).
 *
 * Extracted as a pure function so the security-critical intersection
 * semantics can be unit-tested without spawning real models.
 */
export function resolveToolScope(
  typeAllowed: string[] | "all",
  toolAllowlist?: string[],
  parentToolNames?: string[],
): string[] | undefined {
  // Step 1: Determine the subagent type's allowed tool set
  let allowed: string[] | undefined =
    typeAllowed === "all" ? undefined : [...typeAllowed];

  // Step 1b: Apply the per-spawn allowlist (narrowing subset).
  if (toolAllowlist && toolAllowlist.length > 0) {
    const allowSet = new Set(toolAllowlist);
    if (allowed) {
      // Type has explicit list — keep only names also in the allowlist.
      allowed = allowed.filter((t) => allowSet.has(t));
    } else {
      // Type grants "all" — the allowlist becomes the effective ceiling.
      allowed = [...toolAllowlist];
    }
  }

  // Step 2: Intersect with parent's available tools (privilege ceiling)
  if (parentToolNames && parentToolNames.length > 0) {
    const parentSet = new Set(parentToolNames);
    if (allowed) {
      // Explicit list — intersect with parent
      allowed = allowed.filter((t) => parentSet.has(t));
    } else {
      // Still "all" — restrict to parent's set
      allowed = [...parentToolNames];
    }
  }

  return allowed;
}

/**
 * Narrow an already-resolved tool scope down to read-only tools.
 *
 * Applied to mutating subagent types (code, general) spawned WITHOUT a
 * permissionCheck. This is a downgrade — it can only remove tools, never
 * add them, so it INTERSECTS with the incoming scope rather than replacing
 * it. Replacing would re-widen past an already-narrower per-spawn
 * toolAllowlist or parent ceiling, re-granting tools the caller excluded.
 *
 * Extracted as a pure function so the security-critical composition with
 * resolveToolScope can be unit-tested without spawning real models.
 */
export function applyReadOnlyDowngrade(
  resolved: string[] | undefined,
  readOnlyTools: string[],
): string[] {
  return resolved
    ? resolved.filter((t) => readOnlyTools.includes(t))
    : [...readOnlyTools];
}

/**
 * Compose a subagent's system prompt. `promptAppend`, when present, is
 * appended to the base prompt with a blank-line separator — it never
 * replaces the base template prompt.
 */
export function composeSystemPrompt(
  base: string,
  promptAppend?: string,
): string {
  return promptAppend ? `${base}\n\n${promptAppend}` : base;
}

/**
 * Spawn an isolated subagent for a focused task.
 *
 * Subagents get their own context — they don't see the parent conversation.
 * This prevents context bloat while enabling parallel work.
 *
 * The subagent type determines:
 * - Which tools are available (explore = read-only, code = all)
 * - System prompt behavior (review = bug-focused, plan = structured output)
 * - Model selection hint (explore → cheap, code → capable)
 */
/**
 * Spawn a subagent. Thin dispatcher: the freeform path (no contract) runs the
 * core loop unchanged — byte-for-byte today's behavior; the contract path
 * renders the contract, maps its authority onto the narrowing chain, runs the
 * core loop, and validates the output with one repair round-trip.
 */
export async function spawnSubagent(
  task: string,
  options: SubagentOptions,
): Promise<SubagentResult> {
  if (!options.contract) {
    return runSubagentCore(task, options);
  }
  return runContractSubagent(options.contract, options);
}

/**
 * Map an AgentContract's `authority.*` onto the SubagentOptions narrowing
 * fields. Every field is a FLOOR: an explicit option wins, else the contract's
 * authority applies, else (undefined) the type default resolved downstream.
 * These feed the EXISTING resolveToolScope / applyReadOnlyDowngrade chain — the
 * contract never bypasses the security-critical narrowing. Pure, so the mapping
 * is unit-testable without spawning a model.
 */
export function contractAuthorityOptions(
  contract: AgentContract,
  options: Pick<
    SubagentOptions,
    "toolAllowlist" | "maxSteps" | "budgetLimit" | "readOnly"
  >,
): {
  toolAllowlist?: string[];
  maxSteps?: number;
  budgetLimit?: number;
  readOnly?: boolean;
} {
  const auth = contract.authority;
  return {
    toolAllowlist: options.toolAllowlist ?? auth.toolAllowlist,
    maxSteps: options.maxSteps ?? auth.maxSteps,
    budgetLimit: options.budgetLimit ?? auth.budgetLimitUsd,
    readOnly: options.readOnly ?? auth.readOnly,
  };
}

/**
 * Contract-carried handoff. The rendered contract IS the task prompt; the
 * contract's authority maps onto the EXISTING SubagentOptions narrowing fields
 * (never bypassing resolveToolScope); the output is validated against the
 * declared schema, with exactly one bounded repair round-trip on failure.
 */
async function runContractSubagent(
  contract: AgentContract,
  options: SubagentOptions,
): Promise<SubagentResult> {
  const coreOptions: SubagentOptions = {
    ...options,
    contract: undefined, // prevent re-entry
    ...contractAuthorityOptions(contract, options),
  };

  const renderedTask = renderContractPrompt(contract);
  const first = await runSubagentCore(renderedTask, coreOptions);

  // No declared schema → nothing to validate; the handoff is structurally
  // complete once the run returns.
  if (!contract.output.schemaRef) {
    return { ...first, contractOutcome: { valid: true } };
  }

  let validation = validateContractOutput(
    contract,
    first.text,
    getOutputSchema,
  );
  if (validation.ok) {
    return {
      ...first,
      contractOutcome: { valid: true, parsed: validation.parsed },
    };
  }

  // One bounded repair round-trip: re-prompt with the exact validation error.
  const repairAppend =
    `## Output validation failed\n\nYour previous response did not match the ` +
    `required '${contract.output.schemaRef}' schema:\n` +
    validation.errors.map((e) => `- ${e}`).join("\n") +
    `\n\nRespond again with ONLY a single JSON object matching the schema, ` +
    `fenced in a \`\`\`json block.`;
  // The repair is a TEXT-ONLY re-prompt: the worker's WORK is already done (a
  // code subagent has already edited the worktree). Re-running the full agentic
  // loop with tools here could double-apply or conflict those edits — the
  // round-trip only needs the model to reformat its output to match the schema,
  // not to touch the workspace again. noTools makes that structural: the model
  // physically cannot edit, so it must answer with the JSON.
  const repaired = await runSubagentCore(renderedTask, {
    ...coreOptions,
    noTools: true,
    maxSteps: 1,
    promptAppend: [options.promptAppend, repairAppend]
      .filter(Boolean)
      .join("\n\n"),
  });
  validation = validateContractOutput(contract, repaired.text, getOutputSchema);

  return {
    ...repaired,
    // Fold both attempts' cost so the handoff reports its true price.
    cost: first.cost + repaired.cost,
    contractOutcome: {
      valid: validation.ok,
      parsed: validation.parsed,
      errors: validation.ok ? undefined : validation.errors,
      repairAttempted: true,
    },
  };
}

async function runSubagentCore(
  task: string,
  options: SubagentOptions,
): Promise<SubagentResult> {
  const { router, costTracker, tools, config, registry, projectPath } = options;
  const type = options.type ?? "general";
  const typeConfig = SUBAGENT_TYPES[type];

  // Budget guard: reserve 20% of remaining budget for parent.
  // Fail early rather than spawning a subagent that will immediately be killed.
  const PARENT_RESERVE_RATIO = 0.2;
  const remainingBudget = costTracker.getRemainingBudget();
  const subagentBudget = options.budgetLimit ?? costTracker.getSubagentBudget();
  if (remainingBudget !== null && remainingBudget > 0) {
    const reserved = remainingBudget * PARENT_RESERVE_RATIO;
    const available = remainingBudget - reserved;
    if (available <= 0) {
      return {
        text: `[Subagent not spawned: insufficient budget. $${remainingBudget.toFixed(4)} remaining, $${reserved.toFixed(4)} reserved for parent.]`,
        cost: 0,
        modelUsed: "none",
        toolCalls: [],
        type,
        budgetExceeded: true,
      };
    }
  }

  const taskProfile = router.classify(task);

  // Cost-aware routing: budget pressure overrides static model hint
  const remaining = costTracker.getRemainingBudget();
  const budgetPressure =
    remaining !== null && remaining > 0
      ? 1 - remaining / (costTracker.getSubagentBudget() * 4 || 1)
      : 0;
  // >60% budget used → prefer cheap, regardless of type hint
  const preferCheap = typeConfig.modelHint === "cheap" || budgetPressure > 0.6;

  // If parent explicitly pinned a model, honor it and skip the subagent's
  // internal routing. Without this, --model flags passed to commands like
  // eval-swe-bench get ignored at the subagent level because the subagent
  // re-routes from scratch via capability strategy.
  let decision;
  if (options.preferredModelId) {
    const pinnedModel = registry.getModel(options.preferredModelId);
    if (pinnedModel) {
      decision = {
        ...router.route(taskProfile, { preferCheap }),
        model: pinnedModel,
        reason: `Model pin (from parent): ${options.preferredModelId}`,
      };
    } else {
      log.warn(
        { requested: options.preferredModelId },
        "Parent pinned model not found in registry — falling back to router",
      );
      decision = router.route(taskProfile, { preferCheap });
    }
  } else {
    decision = router.route(taskProfile, { preferCheap });
  }

  const modelId = registry.getProvider(decision.model.id);
  const systemPrompt = composeSystemPrompt(
    options.systemPrompt ?? typeConfig.systemPrompt,
    options.promptAppend,
  );
  const maxSteps = options.maxSteps ?? typeConfig.defaultMaxSteps;

  // ── Privilege Reduction: subagent tools are the INTERSECTION of the ──
  // ── type ceiling, the per-spawn allowlist, and the parent's tools.  ──
  // ── Each stage can only NARROW — a subagent can NEVER have more     ──
  // ── tools than its parent, nor more than its type permits.          ──

  // Steps 1–2: type ceiling → per-spawn allowlist → parent ceiling.
  // (See resolveToolScope for the narrowing intersection chain.)
  let typeAllowed = resolveToolScope(
    typeConfig.allowedTools,
    options.toolAllowlist,
    options.parentToolNames,
  );

  // Step 3: Mutating subagent types (code, general) REQUIRE permissionCheck.
  // Without it, they're downgraded to read-only to prevent privilege escalation.
  const MUTATING_TYPES = new Set<SubagentType>(["code", "general"]);
  const READ_ONLY_TOOLS = [
    "file_read",
    "glob",
    "grep",
    "list_dir",
    "git_status",
    "git_diff",
    "git_log",
  ];

  if (MUTATING_TYPES.has(type) && !options.permissionCheck) {
    log.warn(
      { type },
      "Mutating subagent spawned without permissionCheck — restricting to read-only",
    );
    // Intersect (never replace): the downgrade can only NARROW. Overwriting
    // would widen past an already-narrower per-spawn toolAllowlist / parent
    // ceiling, re-granting tools the caller deliberately excluded.
    typeAllowed = applyReadOnlyDowngrade(typeAllowed, READ_ONLY_TOOLS);
  }

  // Step 3a2: an explicit read-only request (e.g. mapped from a contract's
  // authority.readOnly) narrows to the read-only tool set. Narrowing-only —
  // intersects with whatever the chain above already produced.
  if (options.readOnly) {
    typeAllowed = applyReadOnlyDowngrade(typeAllowed, READ_ONLY_TOOLS);
  }

  // Step 3b: noTools forces an empty set — the most restrictive scope,
  // overriding everything above. An empty allowlist flows through the build
  // below as zero tools on both the permissioned and filtered paths.
  if (options.noTools) {
    typeAllowed = [];
  }

  // Step 4: Build the filtered tool set
  const baseTools = options.permissionCheck
    ? tools.toAISDKToolsWithPermissions(options.permissionCheck, typeAllowed)
    : typeAllowed
      ? tools.toAISDKToolsFiltered(typeAllowed)
      : tools.toAISDKTools();
  // Per-model tool name adaptation (mirrors the parent loop): rename tools to
  // the provider-native names each model was trained on so non-Anthropic
  // subagent models see e.g. apply_patch/read_file/replace rather than the
  // canonical Anthropic names only. Without this, a non-Anthropic subagent
  // model calling its native tool name would miss the executor entirely. The
  // INBOUND reverseToolName (below, in the stream loop) maps observed calls
  // back to canonical for toolCallNames tracking.
  const { adaptedTools: filteredTools } = adaptToolsForModel(
    baseTools,
    decision.model,
  );

  // Log the effective capability manifest (frozen at spawn time)
  log.info(
    {
      type,
      effectiveTools: typeAllowed ?? "all",
      parentToolCount: options.parentToolNames?.length ?? "unrestricted",
      hasAllowlist: !!(
        options.toolAllowlist && options.toolAllowlist.length > 0
      ),
      hasPermissionCheck: !!options.permissionCheck,
    },
    "Subagent capability manifest frozen",
  );

  const subagentSessionId = `subagent-${type}-${Date.now()}`;
  const budgetLimit = options.budgetLimit ?? costTracker.getSubagentBudget();
  const costBefore = costTracker.getSessionCost();

  // Docker isolation: code subagents get their own container. Set up
  // inside the try below (not here) so a throwing onHook or any error
  // between acquire and the streamText call is still caught by the
  // finally that releases/restores — see acquireContainerLock() doc for
  // why this whole window is also serialized across parallel subagents.
  let ownSandbox: DockerSandbox | null = null;
  let prevSandbox: DockerSandbox | null = null;
  let releaseContainerLock: (() => void) | null = null;
  const needsContainer =
    !!options.containerIsolation &&
    type === "code" &&
    DockerSandbox.isAvailable();

  const toolCallNames: string[] = [];
  let fullText = "";
  let budgetExceeded = false;
  let subagentCostAccum = 0; // Track cost internally to avoid parallel race
  // Last streamText finishReason across nudge retries — surfaced on the result
  // so callers (e.g. the SWE-bench eval) can distinguish a genuine empty answer
  // from a provider-terminated one (content-filter / length / error) instead of
  // reporting a silent "no changes".
  let lastFinishReason: string | undefined;

  // ── Phase 7: tool-use enforcement (narration → forced tool call) ────
  // Mirror runAgentLoop's Phase 7 gate for subagents (and thus the
  // SWE-bench eval, which runs through spawnSubagent). A weak subagent
  // model may NARRATE a tool action ("Let me read config.ts") and then
  // stop WITHOUT emitting the call. When enabled, and only when the run
  // (a) stopped on its own (finishReason !== "tool-calls"), (b) made zero
  // tool calls, (c) has tools available, and (d) its text reads as an
  // un-acted tool intent, we push a corrective user-role nudge and RE-RUN
  // with toolChoice="required" so a real call is forced. Because
  // spawnSubagent is a SINGLE streamText (not a re-invokable generator),
  // the loop's recursion is expressed as a bounded re-invocation loop
  // INSIDE the withWorkspace callback below. Subagents carry no
  // options._nudgeDepth field, so enablement is resolved straight from
  // config (the loop's options.toolEnforcement layer does not exist here).
  const teEnabled = config.general?.toolEnforcement?.enabled ?? true;
  const teMaxNudges = config.general?.toolEnforcement?.maxNudges ?? 2;
  // "tools available to call" gate: filteredTools must be non-empty. An
  // empty set (noTools / read-only downgrade / empty scope) means a nudge
  // could never be satisfied by a real call, so treat it as the gate
  // failing — mirroring the loop's `!!finalTools`.
  const hasTools = Object.keys(filteredTools ?? {}).length > 0;

  // AbortController for budget enforcement — terminates the subagent stream.
  // The stream's effective abort signal is linked to both the internal
  // budget controller and the optional parent signal, so parent Ctrl+C or
  // request disconnect tears the subagent down too.
  const budgetAbort = new AbortController();
  const effectiveAbort = linkSignals(budgetAbort.signal, options.parentSignal);

  const metadataHeader = serializeRoutingMetadata(taskProfile, decision);

  // Fork model: if parent segments are available, share the cacheable prefix.
  // The subagent gets cache hits on the stable portion (identity, tools, project context),
  // making parallel subagents nearly free in terms of input token costs.
  //
  // SECURITY: external subagents do NOT inherit parent context segments.
  // They receive only the type's system prompt + the task. This prevents
  // exfiltration of project memory, credentials, or system prompt content
  // via the LLM response text (external subagents have no tools but can
  // still leak context through their output).
  const systemForAPI =
    type === "external"
      ? systemPrompt
      : options.parentSegments
        ? segmentsToSystemArray([
            // Reuse parent's cacheable prefix (gets Anthropic cache hits)
            ...options.parentSegments.filter((s) => s.cacheable),
            // Subagent's own behavioral instructions (dynamic, not cached)
            {
              text: `\n## Subagent Instructions\n\n${systemPrompt}`,
              cacheable: false,
            },
          ])
        : systemPrompt;

  // Wrap BOTH the streamText call AND stream consumption in withWorkspace.
  //
  // Subtle: AsyncLocalStorage context propagates to async work STARTED inside
  // the run() callback. If we call streamText() outside the callback, the
  // internal async chains the AI SDK sets up (tool execution, provider calls,
  // etc.) are created before the context is active, so they don't inherit it.
  // Tool calls then resolve paths via process.cwd() → wrong directory.
  //
  // Discovered the hard way: the previous version wrapped only the for-await
  // loop, which seemed sufficient but wasn't — sphinx/ and sympy/ directories
  // ended up written into the brainstorm repo root instead of the cloned
  // target repos during parallel SWE-bench runs.
  try {
    if (needsContainer) {
      releaseContainerLock = await acquireContainerLock();
      ownSandbox = getSandboxPool().acquire({
        hostWorkspace: projectPath,
      }) as DockerSandbox;
      prevSandbox = setDockerSandbox(ownSandbox);
    }

    // Fire SubagentStart hook
    if (options.onHook) {
      await options.onHook("SubagentStart", {
        subagentType: type,
        prompt: task,
        budget: budgetLimit,
        toolAllowlist: typeAllowed,
        promptAppend: options.promptAppend,
        maxSteps,
        budgetLimit,
      });
    }

    // Conversation for the run. Mutable so the enforcement loop can append
    // the model's narration + a corrective user turn between re-invocations.
    const messages: any[] = [
      {
        role: "user" as const,
        content: `[Project: ${projectPath}]\n\n${task}`,
      },
    ];

    await withWorkspace(projectPath, async () => {
      // Bounded re-invocation loop = the single-streamText analogue of the
      // loop's Phase 7 self-recursion. `nudge` is the nudgeDepth: iteration 0
      // is the original run; each subsequent iteration is one corrective
      // re-run. It ALL lives inside this one withWorkspace callback so every
      // streamText + its internal async tool chain inherits the AsyncLocalStorage
      // workspace context (see the block comment above — hoisting streamText
      // out breaks path resolution for tool calls).
      let forceToolChoice = false;
      for (let nudge = 0; ; nudge++) {
        // Per-iteration accumulators (mirror the loop's per-turn state). The
        // module-scope fullText/toolCallNames accumulate ACROSS retries for the
        // returned result; these locals hold only THIS run's output so the gate
        // judges the just-finished turn (like the loop's fresh recursion).
        let iterText = "";
        let iterToolCalls = 0;
        let finishReason: string | undefined;

        const result = streamText({
          model: modelId,
          system: systemForAPI as any,
          messages,
          tools: filteredTools,
          // Phase 7: force a real tool call ONLY on a corrective retry, and
          // never on the terminal retry (see forceToolChoice below), so the
          // model can still finish with a clean text answer. Only meaningful
          // when tools are present.
          ...(hasTools && forceToolChoice
            ? { toolChoice: "required" as const }
            : {}),
          ...(metadataHeader
            ? { headers: { "x-br-metadata": metadataHeader } }
            : {}),
          abortSignal: effectiveAbort,
          stopWhen: stepCountIs(maxSteps),
          onStepFinish: async ({ usage }: any) => {
            if (usage) {
              const inputTokens = usage.inputTokens ?? 0;
              const outputTokens = usage.outputTokens ?? 0;
              const stepCost =
                (inputTokens / 1_000_000) *
                  decision.model.pricing.inputPer1MTokens +
                (outputTokens / 1_000_000) *
                  decision.model.pricing.outputPer1MTokens;
              subagentCostAccum += stepCost;
              costTracker.record({
                sessionId: subagentSessionId,
                modelId: decision.model.id,
                provider: decision.model.provider,
                inputTokens,
                outputTokens,
                taskType: taskProfile.type,
                projectPath,
                pricing: decision.model.pricing,
              });
            }
            if (subagentCostAccum >= budgetLimit) {
              budgetExceeded = true;
              budgetAbort.abort();
            }
          },
        });

        for await (const part of result.fullStream) {
          if (part.type === "text-delta") {
            const delta = (part as any).delta ?? (part as any).text ?? "";
            iterText += delta;
            fullText += delta;
          } else if (part.type === "tool-call") {
            // INBOUND rename: record the canonical tool name so the subagent's
            // reported toolCalls match the parent's canonical vocabulary
            // regardless of which provider renamed them outbound.
            iterToolCalls++;
            toolCallNames.push(reverseToolName(part.toolName, decision.model));
          } else if (part.type === "finish" || part.type === "finish-step") {
            // Capture finishReason so the gate can require a self-stop
            // (finishReason !== "tool-calls") — absent from the original
            // subagent drain, this is the loop's missing precondition.
            finishReason = (part as any).finishReason ?? finishReason;
          }
        }
        // Remember the terminal reason of the final run for the result.
        lastFinishReason = finishReason;

        // ── Enforcement gate (mirrors loop.ts Phase 7 preconditions) ──
        // Break (accept the run as-is) unless ALL hold: enforcement enabled,
        // the run wasn't budget-killed / aborted, it made zero tool calls,
        // stopped on its own, tools are available, we have nudges left, and
        // the text reads as an un-acted tool intent.
        const shouldNudge =
          teEnabled &&
          !budgetExceeded &&
          !effectiveAbort.aborted &&
          iterToolCalls === 0 &&
          finishReason !== "tool-calls" &&
          hasTools &&
          nudge < teMaxNudges &&
          detectNarratedToolIntent(iterText);

        if (!shouldNudge) break;

        // Budget guard — a nudge is a full extra model run (with its own fresh
        // stepCountIs budget). Reuse the loop's 20%-remaining threshold and
        // also honor the subagent's own budgetLimit; skip rather than risk
        // blowing the session budget.
        const nudgeBudgetRemaining = costTracker.getRemainingBudget();
        const nudgeSessionLimit = (config.budget as any)?.perSession;
        const nudgeBudgetTooLow =
          nudgeBudgetRemaining !== null &&
          nudgeSessionLimit &&
          nudgeBudgetRemaining <= nudgeSessionLimit * 0.2;
        if (nudgeBudgetTooLow || subagentCostAccum >= budgetLimit) {
          log.warn(
            {
              remaining: nudgeBudgetRemaining,
              sessionLimit: nudgeSessionLimit,
              subagentCost: subagentCostAccum,
              budgetLimit,
            },
            "Subagent tool-use nudge skipped — budget too low",
          );
          break;
        }

        const nextNudge = nudge + 1;
        log.info(
          {
            type,
            model: decision.model.id,
            iteration: nextNudge,
            maxNudges: teMaxNudges,
          },
          "Subagent narrated a tool action without calling it — nudging with forced tool call",
        );
        // Feed the model's narration back as an assistant turn plus the
        // corrective user turn, so the retry has context for what it claimed
        // to do. Do NOT force tools on the TERMINAL retry (nextNudge ===
        // teMaxNudges): that re-entry can no longer nudge again, so its output
        // is ACCEPTED — forcing would rob the model of a clean text answer.
        messages.push({ role: "assistant", content: iterText });
        messages.push({ role: "user", content: buildToolUseCorrection() });
        forceToolChoice = nextNudge < teMaxNudges;
      }
    });
  } catch (err: any) {
    // AbortError from budget enforcement is expected — not an error
    if (err.name !== "AbortError") throw err;
  } finally {
    // Clean up subagent's Docker sandbox and restore parent's. Safe to
    // do unconditionally here: acquireContainerLock() guarantees no
    // other container-isolated subagent touches the module-level
    // singleton between our acquire and this release, so prevSandbox is
    // still exactly what we displaced.
    if (ownSandbox) {
      getSandboxPool().release(ownSandbox);
      setDockerSandbox(prevSandbox);
    }
    releaseContainerLock?.();
  }

  if (budgetExceeded) {
    fullText += `\n\n[Subagent terminated: budget limit of $${budgetLimit.toFixed(4)} exceeded ($${subagentCostAccum.toFixed(4)} used)]`;
  }

  // Fire SubagentStop hook
  if (options.onHook) {
    await options.onHook("SubagentStop", {
      subagentType: type,
      result: fullText.slice(0, 500),
      cost: subagentCostAccum,
      toolCalls: toolCallNames.length,
      model: decision.model.name,
    });
  }

  return {
    text: fullText,
    cost: subagentCostAccum,
    modelUsed: decision.model.name,
    toolCalls: toolCallNames,
    type,
    budgetExceeded,
    partialOutput: budgetExceeded ? fullText : undefined,
    finishReason: lastFinishReason,
  };
}

/**
 * Spawn multiple subagents in parallel.
 * Uses Promise.allSettled so one failure doesn't kill all results.
 */
export async function spawnParallel(
  specs: Array<{
    task: string;
    type?: SubagentType;
    toolAllowlist?: string[];
    promptAppend?: string;
    maxSteps?: number;
    budgetLimit?: number;
  }>,
  options: SubagentOptions,
): Promise<SubagentResult[]> {
  const settled = await Promise.allSettled(
    specs.map((spec) =>
      spawnSubagent(spec.task, {
        ...options,
        type: spec.type,
        // Per-spec overrides take precedence over the shared options.
        toolAllowlist: spec.toolAllowlist ?? options.toolAllowlist,
        promptAppend: spec.promptAppend ?? options.promptAppend,
        maxSteps: spec.maxSteps ?? options.maxSteps,
        budgetLimit: spec.budgetLimit ?? options.budgetLimit,
      }),
    ),
  );
  return settled.map((result, i) => {
    if (result.status === "fulfilled") return result.value;
    // Return error result for failed subagents instead of throwing
    return {
      text: `[Subagent failed: ${result.reason?.message ?? "unknown error"}]`,
      cost: 0,
      modelUsed: "unknown",
      toolCalls: [],
      type: specs[i].type ?? "general",
      budgetExceeded: false,
    };
  });
}
