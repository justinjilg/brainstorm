import { streamText, stepCountIs } from "ai";
import type { BrainstormConfig } from "@brainst0rm/config";
import type { ProviderRegistry } from "@brainst0rm/providers";
import { BrainstormRouter, CostTracker } from "@brainst0rm/router";
import {
  type ToolRegistry,
  setDockerSandbox,
  DockerSandbox,
  withWorkspace,
} from "@brainst0rm/tools";
import {
  serializeRoutingMetadata,
  createLogger,
  linkSignals,
} from "@brainst0rm/shared";
import type { SystemPromptSegment } from "./context.js";
import { segmentsToSystemArray } from "./context.js";

const log = createLogger("subagent");

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
}

export interface SubagentResult {
  text: string;
  cost: number;
  modelUsed: string;
  toolCalls: string[];
  type: SubagentType;
  budgetExceeded: boolean;
  partialOutput?: string;
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
export async function spawnSubagent(
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
  const systemPrompt = options.systemPrompt ?? typeConfig.systemPrompt;
  const maxSteps = options.maxSteps ?? typeConfig.defaultMaxSteps;

  // ── Privilege Reduction: subagent tools are the INTERSECTION of ──
  // ── its type's allowed tools and the parent's available tools.  ──
  // ── A subagent can NEVER have more tools than its parent.       ──

  // Step 1: Determine the subagent type's allowed tool set
  let typeAllowed: string[] | undefined =
    typeConfig.allowedTools === "all"
      ? undefined
      : [...typeConfig.allowedTools];

  // Step 2: Intersect with parent's available tools (privilege ceiling)
  if (options.parentToolNames && options.parentToolNames.length > 0) {
    const parentSet = new Set(options.parentToolNames);
    if (typeAllowed) {
      // Type has explicit list — intersect with parent
      typeAllowed = typeAllowed.filter((t) => parentSet.has(t));
    } else {
      // Type gets "all" — restrict to parent's set
      typeAllowed = options.parentToolNames;
    }
  }

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
    typeAllowed = READ_ONLY_TOOLS;
  }

  // Step 4: Build the filtered tool set
  const baseTools = options.permissionCheck
    ? tools.toAISDKToolsWithPermissions(options.permissionCheck, typeAllowed)
    : typeAllowed
      ? tools.toAISDKToolsFiltered(typeAllowed)
      : tools.toAISDKTools();
  const filteredTools = baseTools;

  // Log the effective capability manifest (frozen at spawn time)
  log.info(
    {
      type,
      effectiveTools: typeAllowed ?? "all",
      parentToolCount: options.parentToolNames?.length ?? "unrestricted",
      hasPermissionCheck: !!options.permissionCheck,
    },
    "Subagent capability manifest frozen",
  );

  const subagentSessionId = `subagent-${type}-${Date.now()}`;
  const budgetLimit = options.budgetLimit ?? costTracker.getSubagentBudget();
  const costBefore = costTracker.getSessionCost();

  // Docker isolation: code subagents get their own container
  let ownSandbox: DockerSandbox | null = null;
  let prevSandbox: DockerSandbox | null = null;
  if (
    options.containerIsolation &&
    type === "code" &&
    DockerSandbox.isAvailable()
  ) {
    ownSandbox = new DockerSandbox({
      hostWorkspace: projectPath,
    });
    ownSandbox.start();
    prevSandbox = setDockerSandbox(ownSandbox);
  }

  // Fire SubagentStart hook
  if (options.onHook) {
    await options.onHook("SubagentStart", {
      subagentType: type,
      prompt: task,
      budget: budgetLimit,
    });
  }
  const toolCallNames: string[] = [];
  let fullText = "";
  let budgetExceeded = false;
  let subagentCostAccum = 0; // Track cost internally to avoid parallel race

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
    await withWorkspace(projectPath, async () => {
      const result = streamText({
        model: modelId,
        system: systemForAPI as any,
        messages: [
          {
            role: "user" as const,
            content: `[Project: ${projectPath}]\n\n${task}`,
          },
        ],
        tools: filteredTools,
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
          fullText += (part as any).delta ?? (part as any).text ?? "";
        } else if (part.type === "tool-call") {
          toolCallNames.push(part.toolName);
        }
      }
    });
  } catch (err: any) {
    // AbortError from budget enforcement is expected — not an error
    if (err.name !== "AbortError") throw err;
  } finally {
    // Clean up subagent's Docker sandbox and restore parent's
    if (ownSandbox) {
      ownSandbox.stop();
      setDockerSandbox(prevSandbox);
    }
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
  };
}

/**
 * Spawn multiple subagents in parallel.
 * Uses Promise.allSettled so one failure doesn't kill all results.
 */
export async function spawnParallel(
  specs: Array<{ task: string; type?: SubagentType }>,
  options: SubagentOptions,
): Promise<SubagentResult[]> {
  const settled = await Promise.allSettled(
    specs.map((spec) =>
      spawnSubagent(spec.task, { ...options, type: spec.type }),
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
