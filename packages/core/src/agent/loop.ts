import { streamText, stepCountIs } from "ai";
import type { ConversationMessage } from "../session/manager.js";
import type { BrainstormConfig } from "@brainst0rm/config";
import type { ProviderRegistry } from "@brainst0rm/providers";
import type { RoutingDecision } from "@brainst0rm/shared";
import {
  BrainstormRouter,
  CostTracker,
  recordOutcome,
  adaptToolsForModel,
} from "@brainst0rm/router";
import type { RoutingOutcomeRepository } from "@brainst0rm/db";
import type { ToolRegistry, PermissionCheckFn } from "@brainst0rm/tools";
import {
  setTaskEventHandler,
  clearTasks,
  setBackgroundEventHandler,
  getToolHealthTracker,
  setToolOutputHandler,
  getTierForComplexity,
  getToolsForTier,
  enterWorkspace,
} from "@brainst0rm/tools";
import {
  createLogger,
  type AgentEvent,
  type GatewayFeedbackData,
  type ModelEntry,
  type TurnContext,
} from "@brainst0rm/shared";
import type { BuildStateTracker } from "./build-state.js";
import { LoopDetector } from "./loop-detector.js";
import { serializeRoutingMetadata } from "@brainst0rm/shared";
import { createStreamFilter } from "./response-filter.js";
import { normalizeInsightMarkers } from "./insights.js";
import { parseGatewayHeaders } from "@brainst0rm/gateway";
import type { MiddlewarePipeline } from "../middleware/pipeline.js";
import {
  syncTrustWindow,
  flushTrustWindow,
} from "../middleware/builtin/trust-propagation.js";
import {
  buildScrubMap,
  injectSecrets,
  scrubSecrets,
  setScrubMap,
} from "../middleware/builtin/secret-substitution.js";
import { TrajectoryRecorder } from "../session/trajectory.js";
import { CircuitBreakerRegistry } from "../security/circuit-breaker.js";

// Module-level registry of circuit breakers, one per model ID.
// Protects the LLM call path against cascade failures: after 3 consecutive
// failures from a specific model, the circuit opens for 60s and routes
// the call to fallback models immediately. After cooldown, allows one
// probe call; success closes the circuit, failure re-opens it.
const llmCircuitRegistry = new CircuitBreakerRegistry();
function getLLMCircuit(modelId: string) {
  return llmCircuitRegistry.getBreaker({
    name: `llm:${modelId}`,
    failureThreshold: 3,
    cooldownMs: 60_000,
  });
}
import {
  enterToolExecution,
  exitToolExecution,
} from "../session/compaction.js";
import type { SystemPromptSegment } from "./context.js";
import { segmentsToSystemArray } from "./context.js";
import { predictTaskCost } from "./cost-predictor.js";
import { detectTone, toneGuidance } from "./sentiment.js";
import { shouldUseEnsemble } from "./ensemble.js";

const log = createLogger("agent-loop");

/** Classify whether an error is from the model API (rate limit, auth, network). */
function isModelApiError(err: any): boolean {
  const status = err.statusCode ?? err.status;
  if (status && status >= 400) return true;
  const msg = (err.message ?? "").toLowerCase();
  return (
    msg.includes("fetch failed") ||
    msg.includes("rate limit") ||
    msg.includes("429") ||
    msg.includes("503") ||
    msg.includes("unauthorized") ||
    msg.includes("api key") ||
    msg.includes("timeout") ||
    msg.includes("econnrefused") ||
    msg.includes("ai_") // AI SDK error codes
  );
}

/** Classify whether an error is from SQLite/database operations. */
function isDbError(err: any): boolean {
  const msg = (err.message ?? "").toLowerCase();
  return (
    err.code === "SQLITE_FULL" ||
    err.code === "SQLITE_BUSY" ||
    err.code === "SQLITE_LOCKED" ||
    msg.includes("sqlite") ||
    msg.includes("database is locked") ||
    msg.includes("disk i/o error") ||
    msg.includes("no space left") ||
    msg.includes("enospc")
  );
}

/**
 * Enrich raw API errors with actionable user-facing messages.
 * The original error is preserved; the message is replaced with a helpful one.
 */
/**
 * Enrich raw API errors with actionable user-facing messages.
 * First tries to parse BR's built-in recovery hints from the response body.
 * Falls back to heuristic matching for non-BR errors.
 */
function enrichError(error: any, modelId: string): Error {
  const msg = error.message ?? "";
  const status = error.statusCode ?? error.status;

  // Try to parse BR's structured recovery hint from the response body
  // BR sends: { error: {...}, recovery: { action, message, endpoint, wait_ms } }
  const recovery = extractBRRecovery(error);
  if (recovery) {
    const parts = [recovery.message];
    if (recovery.endpoint)
      parts.push(`Action: ${recovery.method ?? "GET"} ${recovery.endpoint}`);
    if (recovery.wait_ms)
      parts.push(`Retry after: ${Math.ceil(recovery.wait_ms / 1000)}s`);
    if (recovery.docs_url) parts.push(`Docs: ${recovery.docs_url}`);
    error.message = parts.join(" | ");
    return error;
  }

  // Fallback: heuristic matching for non-BR errors
  if (
    msg.includes("fetch failed") ||
    msg.includes("ECONNREFUSED") ||
    msg.includes("ETIMEDOUT")
  ) {
    error.message = `Cannot reach BrainstormRouter. Check your internet connection.`;
    return error;
  }
  if (status === 401 || msg.includes("Unauthorized")) {
    error.message = `Authentication failed. Run: storm vault status\nThen: storm vault set BRAINSTORM_API_KEY <your-key>`;
    return error;
  }
  if (msg.includes("No models available")) {
    error.message = `No models available. Try:\n  1. storm models — check discovered models\n  2. Ensure Ollama/LM Studio is running for local models\n  3. Set BRAINSTORM_API_KEY for cloud models via BrainstormRouter`;
    return error;
  }
  if (msg.includes("Budget exceeded") || error.name === "BudgetExceededError") {
    error.message = `${msg}\n\nTo continue:\n  1. storm budget — view current usage\n  2. Increase limit in ~/.brainstorm/config.toml [budget] section\n  3. Or start a new session: storm chat --new`;
    return error;
  }
  if (msg.includes("blocked") || msg.includes("Sandbox blocked")) {
    error.message = `${msg}\n\nIf this command is safe, adjust sandbox level in config.toml:\n  [shell]\n  sandbox = "none"`;
    return error;
  }
  if (msg.includes("No active session")) {
    error.message = `No active session. Start one with: storm chat\nOr resume the last session: storm chat --resume`;
    return error;
  }

  // Last resort: add model context
  if (!msg.includes(modelId)) {
    error.message = `[${modelId}] ${msg}`;
  }
  return error;
}

/** Extract BR's recovery hint from the error's response body. */
function extractBRRecovery(error: any): any {
  // AI SDK stores the parsed response body in error.data
  if (error.data?.recovery) return error.data.recovery;
  // Also try responseBody (raw string)
  if (error.responseBody) {
    try {
      const parsed = JSON.parse(error.responseBody);
      if (parsed.recovery) return parsed.recovery;
    } catch {
      /* not JSON */
    }
  }
  return null;
}

// Suppress AI SDK warnings in non-debug mode
if (!process.env.BRAINSTORM_LOG_LEVEL) {
  (globalThis as any).AI_SDK_LOG_WARNINGS = false;
}

/** Extract text content from a stream part (AI SDK v6: .text or legacy .delta). */
function getPartText(part: Record<string, unknown>): string {
  return (part.text as string) ?? (part.delta as string) ?? "";
}

/** Extract tool call input from a stream part (AI SDK v6: .input or legacy .args). */
function getPartInput(
  part: Record<string, unknown>,
): Record<string, unknown> | undefined {
  return (
    (part.input as Record<string, unknown>) ??
    (part.args as Record<string, unknown>)
  );
}

/** Extract tool result output from a stream part (AI SDK v6: .output or legacy .result). */
function getPartOutput(part: Record<string, unknown>): unknown {
  return part.output ?? part.result;
}

/**
 * Provider-safety normalization for system-role messages.
 *
 * The conversation history can contain system-role messages — compaction
 * injects 4-5 of them per cycle (preserved-context block, summary, scratchpad,
 * compaction summary). The AI SDK passes these straight through to the
 * provider. Anthropic and OpenAI tolerate mid-stream system messages, but
 * Google's Gemini provider throws AI_UnsupportedFunctionalityError because
 * Google's API only accepts system messages at the start of the conversation.
 *
 * This helper extracts every system-role message from the history and folds
 * its content into the system field as additional segments. The model still
 * sees the content; it just arrives via the system channel that every
 * provider supports. The returned messages array contains only user/assistant
 * turns.
 */
export function normalizeSystemMessagesForProvider(
  systemForAPI:
    | string
    | Array<{
        role: "system";
        content: string;
        providerOptions?: Record<string, any>;
      }>,
  messages: Array<{ role: string; content: string | unknown }>,
): {
  systemForApiNormalized:
    | string
    | Array<{
        role: "system";
        content: string;
        providerOptions?: Record<string, any>;
      }>;
  messagesForApi: Array<{ role: string; content: string | unknown }>;
} {
  // Fast path: no system-role messages in history → no work needed.
  const hasSystemInHistory = messages.some((m) => m.role === "system");
  if (!hasSystemInHistory) {
    return { systemForApiNormalized: systemForAPI, messagesForApi: messages };
  }

  // Slow path: extract system messages from the history and fold them in.
  const extractedSystem: string[] = [];
  const filtered: Array<{ role: string; content: string | unknown }> = [];
  for (const msg of messages) {
    if (msg.role === "system") {
      const content =
        typeof msg.content === "string" ? msg.content : String(msg.content);
      extractedSystem.push(content);
    } else {
      filtered.push(msg);
    }
  }

  // Append extracted system content as additional non-cacheable segments.
  // We don't merge them into the existing cached prefix because that would
  // bust the prompt cache; non-cacheable segments don't.
  const additionalSegments = extractedSystem.map((content) => ({
    role: "system" as const,
    content,
  }));

  let systemForApiNormalized:
    | string
    | Array<{
        role: "system";
        content: string;
        providerOptions?: Record<string, any>;
      }>;

  if (typeof systemForAPI === "string") {
    systemForApiNormalized = [
      { role: "system" as const, content: systemForAPI },
      ...additionalSegments,
    ];
  } else if (Array.isArray(systemForAPI)) {
    systemForApiNormalized = [...systemForAPI, ...additionalSegments];
  } else {
    systemForApiNormalized = additionalSegments;
  }

  return { systemForApiNormalized, messagesForApi: filtered };
}

export interface CompactionCallbacks {
  /** Current estimated token count of conversation history. */
  getTokenEstimate: () => number;
  /** Run compaction on the conversation. Returns compaction result. */
  compact: (options: {
    contextWindow: number;
    keepRecent?: number;
    summarizeModel?: any;
  }) => Promise<{
    compacted: boolean;
    removed: number;
    tokensBefore: number;
    tokensAfter: number;
    summaryCost: number;
  }>;
}

export interface AgentLoopOptions {
  config: BrainstormConfig;
  registry: ProviderRegistry;
  router: BrainstormRouter;
  costTracker: CostTracker;
  tools: ToolRegistry;
  sessionId: string;
  projectPath: string;
  systemPrompt: string;
  /** Segmented system prompt for prompt caching. When provided, used instead of flat systemPrompt. */
  systemSegments?: SystemPromptSegment[];
  disableTools?: boolean;
  /** Override model selection — bypass the router. Used by cross-model workflows. */
  preferredModelId?: string;
  /** Override max agentic steps (default: config.general.maxSteps). */
  maxSteps?: number;
  /** Context compaction support. If provided, compaction is checked before each LLM call. */
  compaction?: CompactionCallbacks;
  /** AbortSignal to cancel in-flight LLM calls and tool executions. */
  signal?: AbortSignal;
  /** Permission check function. When provided, tools are gated by this check. */
  permissionCheck?: PermissionCheckFn;
  /** Callback to inject turn context after each completion. */
  onTurnComplete?: (ctx: TurnContext) => void;
  /** Build state tracker — records build/test results for persistent warnings. */
  buildState?: BuildStateTracker;
  /** Internal: tracks fallback depth to cap retries (max 2). */
  _retryDepth?: number;
  /** Internal: tracks models already tried for error reporting. */
  _modelsTried?: string[];
  /** Optional middleware pipeline for composable agent interceptors. */
  middleware?: MiddlewarePipeline;
  /** Repository for persisting routing outcomes (Thompson sampling). */
  routingOutcomeRepo?: RoutingOutcomeRepository;
  /** Enable trajectory recording to JSONL. Default: true (enables learning loop). */
  trajectoryEnabled?: boolean;
  /** Session checkpointer for crash recovery. */
  checkpointer?: { saveIfNeeded: (data: any) => boolean };
  /** Role-based tool filter. When set, restricts which tools the agent can use. */
  roleToolFilter?: { allowedTools?: string[]; blockedTools?: string[] };
  /** Secret resolver for $VAULT_* pattern substitution. When provided, tool args
   *  containing $VAULT_NAME are resolved before execution and scrubbed from output. */
  secretResolver?: (name: string) => Promise<string | null>;
}

// All task types get tools — the model decides whether to use them.
// Previously conversation/explanation/analysis were excluded, but this
// caused the model to print shell commands as text instead of calling tools
// when the classifier miscategorized a request (e.g., "look at files on my desktop"
// classified as "conversation"). A coding assistant should always have tools available.

export async function* runAgentLoop(
  messages: ConversationMessage[],
  options: AgentLoopOptions,
): AsyncGenerator<AgentEvent> {
  const { router, costTracker, tools, config, sessionId } = options;
  let { systemPrompt } = options;

  // Establish the workspace context for this agent session. Tools like
  // file_write, file_edit, file_read, glob, grep, shell, and git now resolve
  // paths relative to options.projectPath instead of process.cwd().
  //
  // Uses enterWith() rather than withWorkspace() because this is a generator:
  // we can't wrap yield statements in a callback, and enterWith() persists for
  // the rest of the current async execution. Nested spawnSubagent calls can
  // override this scope with their own withWorkspace.
  enterWorkspace(options.projectPath);

  // Initialize trajectory recorder — enabled by default for learning loop.
  // Explicitly opt out with trajectoryEnabled: false.
  const sessionStartTime = Date.now();
  const trajectoryEnabled = options.trajectoryEnabled !== false;
  const trajectory = trajectoryEnabled
    ? new TrajectoryRecorder(sessionId)
    : null;
  trajectory?.recordSessionStart({
    projectPath: options.projectPath,
    systemPrompt: systemPrompt.slice(0, 200),
  });

  // Reset task state and wire event handlers for this invocation
  clearTasks();
  const taskEventQueue: AgentEvent[] = [];
  const TASK_QUEUE_CAP = 1000; // Prevent OOM from unbounded push — Forge R06
  setTaskEventHandler((type, task) => {
    if (taskEventQueue.length < TASK_QUEUE_CAP) {
      taskEventQueue.push({ type, task } as AgentEvent);
    }
  });

  // Wire background task completion events into the same queue
  setBackgroundEventHandler((event) => {
    if (taskEventQueue.length >= TASK_QUEUE_CAP) return;
    taskEventQueue.push({
      type: "background-complete",
      taskId: event.taskId,
      command: event.command,
      exitCode: event.exitCode,
      stdout: event.stdout,
      stderr: event.stderr,
    } as AgentEvent);
  });

  // Wire tool output streaming into the same queue
  setToolOutputHandler((event) => {
    if (taskEventQueue.length >= TASK_QUEUE_CAP) return;
    taskEventQueue.push({
      type: "tool-output-partial",
      toolName: event.toolName,
      chunk: event.chunk,
    } as AgentEvent);
  });

  // Middleware metadata — hoisted so the tool wrapper closure can access it
  // for trust propagation (syncTrustWindow/flushTrustWindow).
  const mwMetadata: Record<string, unknown> = {};

  // Run middleware beforeAgent hook (if pipeline provided)
  if (options.middleware) {
    const mwState = {
      turn: 0,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      systemPrompt,
      toolNames: [],
      metadata: mwMetadata,
    };
    const mwResult = options.middleware.runBeforeAgent(mwState);
    if (mwResult.systemPrompt !== systemPrompt) {
      systemPrompt = mwResult.systemPrompt;
    }
  }

  // Phase: classifying
  yield { type: "thinking" as const, phase: "classifying" as const };
  const lastUserMsg = [...messages].reverse().find((m) => m.role === "user");
  const userText = lastUserMsg?.content ?? "";
  const task = router.classify(userText);

  // Detect user tone and inject guidance into system prompt
  const userMessages = messages
    .filter((m) => m.role === "user")
    .map((m) => m.content);
  const tone = detectTone(userMessages);
  const toneHint = toneGuidance(tone.tone);
  if (toneHint && tone.confidence > 0.3) {
    systemPrompt += "\n" + toneHint;
  }

  // Phase: routing
  yield { type: "thinking" as const, phase: "routing" as const };
  const conversationTokens = options.compaction?.getTokenEstimate() ?? 0;
  let decision: RoutingDecision;
  if (options.preferredModelId) {
    const pinnedModel = options.registry.getModel(options.preferredModelId);
    if (pinnedModel) {
      // Explicit model pin overrides routing strategy unconditionally
      decision = {
        ...router.route(task, conversationTokens),
        model: pinnedModel,
        reason: `Model pin: ${options.preferredModelId}`,
      };
    } else {
      // Model not in registry — warn and fall back to routing (don't fail silently)
      const routed = router.route(task, conversationTokens);
      yield {
        type: "loop-warning" as const,
        message: `Model '${options.preferredModelId}' not available — falling back to ${routed.model.id}`,
      };
      decision = routed;
    }
  } else {
    decision = router.route(task, conversationTokens);
  }

  // Circuit breaker check: if the chosen model has an open circuit, swap to
  // the first available fallback with a closed circuit. This prevents
  // cascade failures when a provider is degraded — instead of hitting the
  // failed model 3 times per session, we skip it immediately after 3 total
  // failures within the cooldown window.
  const primaryCircuit = getLLMCircuit(decision.model.id);
  if (!primaryCircuit.canExecute()) {
    const openModelId = decision.model.id;
    const fallbackWithClosedCircuit = decision.fallbacks?.find((f) =>
      getLLMCircuit(f.id).canExecute(),
    );
    if (fallbackWithClosedCircuit) {
      yield {
        type: "loop-warning" as const,
        message: `Circuit open for ${openModelId} — routing to ${fallbackWithClosedCircuit.id}`,
      };
      decision = {
        ...decision,
        model: fallbackWithClosedCircuit,
        reason: `Circuit breaker: primary ${openModelId} is open, using fallback`,
      };
    }
    // If no fallback has a closed circuit either, proceed anyway — we'll
    // let streamText try and the failure will be recorded normally.
  }

  yield { type: "routing", decision };

  // Record routing decision in trajectory
  trajectory?.recordRoutingDecision({
    candidates: [],
    winner: decision.model.id,
    strategy: decision.strategy ?? "unknown",
    reasoning: decision.reason ?? "",
    taskType: task.type,
    complexity: task.complexity,
  });

  // Check if ensemble generation should be used for this task
  const ensembleEnabled = (config as any).ensemble?.enabled ?? false;
  if (shouldUseEnsemble(task.complexity, ensembleEnabled)) {
    yield {
      type: "ensemble-info",
      message: `Ensemble mode: task complexity "${task.complexity}" qualifies for multi-model verification`,
    } as any;
    // Ensemble execution uses selectWinner() + pruneResults() from ensemble.ts.
    // Currently single-model with ensemble flag — parallel streamText with voting
    // is activated when budget allows and 2+ models are available via BrainstormRouter.
  }

  // Cost prediction — yield estimate so CLI can display it
  const costPrediction = predictTaskCost(task, [decision.model]);
  if (costPrediction.estimated > 0.01) {
    yield { type: "cost-prediction", prediction: costPrediction } as any;
  }

  // Phase: connecting
  yield { type: "thinking" as const, phase: "connecting" as const };

  // Check if context compaction is needed before the LLM call
  if (options.compaction && config.compaction?.enabled !== false) {
    const contextWindow = decision.model.limits.contextWindow || 128_000;
    const threshold = config.compaction?.threshold ?? 0.8;
    const tokenEstimate = options.compaction.getTokenEstimate();

    if (tokenEstimate > contextWindow * threshold) {
      try {
        const COMPACTION_TIMEOUT_MS = 30_000;
        const compactionResult = await Promise.race([
          options.compaction.compact({
            contextWindow,
            keepRecent: config.compaction?.keepRecent ?? 5,
          }),
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error("Compaction timeout")),
              COMPACTION_TIMEOUT_MS,
            ),
          ),
        ]);
        if (compactionResult.compacted) {
          yield {
            type: "compaction",
            removed: compactionResult.removed,
            tokensBefore: compactionResult.tokensBefore,
            tokensAfter: compactionResult.tokensAfter,
          };
        }
      } catch (compactionErr) {
        // Compaction failed — continue without it rather than crashing the session
        log.warn(
          { err: compactionErr },
          "Compaction failed, continuing without compaction",
        );
      }
    }
  }

  // Always resolve through the provider registry — it handles local, cloud, and SaaS models
  const modelId = options.registry.getProvider(decision.model.id);

  // Provide tools unless explicitly disabled by the caller (e.g., brainstorm run without --tools)
  const shouldUseTools = !options.disableTools;

  // Progressive tool loading: select tool tier based on task complexity.
  // Only restrict tools for trivial tasks (Q&A, simple reads). All other tasks
  // get the full tool set until mid-session escalation is implemented.
  const toolTier = getTierForComplexity(task.complexity);
  const useFullTools = toolTier !== "minimal";
  const allToolNames = tools.listTools().map((t) => t.name);
  let effectiveToolNames = useFullTools
    ? undefined
    : getToolsForTier(toolTier, allToolNames);

  // Role-based tool scoping: apply allowedTools/blockedTools from the active role.
  // allowedTools is a whitelist (only these tools). blockedTools is a blacklist (all except these).
  // Role filter merges with tier filter — the intersection is used.
  if (options.roleToolFilter) {
    const { allowedTools: roleAllowed, blockedTools: roleBlocked } =
      options.roleToolFilter;
    const allToolNames = tools.listTools().map((t) => t.name);

    if (roleAllowed && roleAllowed.length > 0) {
      // Whitelist: only these tools are available
      const roleSet = new Set(roleAllowed);
      if (effectiveToolNames) {
        // Intersect with tier filter
        effectiveToolNames = effectiveToolNames.filter((n) => roleSet.has(n));
      } else {
        effectiveToolNames = roleAllowed;
      }
    } else if (roleBlocked && roleBlocked.length > 0) {
      // Blacklist: all tools except these
      const blockedSet = new Set(roleBlocked);
      const base = effectiveToolNames ?? allToolNames;
      effectiveToolNames = base.filter((n) => !blockedSet.has(n));
    }
  }

  // Build tools with permission gating if a check function is provided
  const aiTools = shouldUseTools
    ? options.permissionCheck
      ? tools.toAISDKToolsWithPermissions(
          options.permissionCheck,
          effectiveToolNames,
        )
      : effectiveToolNames
        ? tools.toAISDKToolsFiltered(effectiveToolNames)
        : tools.toAISDKTools()
    : undefined;

  // Wire middleware into tool execution — wrap each tool's execute with
  // runWrapToolCall (pre-execution gate) and runAfterToolResult (post-processing).
  // This is the critical integration point: without this, security middleware
  // only runs in tests, not in production.
  if (aiTools && options.middleware) {
    const pipeline = options.middleware;
    for (const [toolName, toolObj] of Object.entries(aiTools)) {
      if (toolObj && typeof toolObj === "object" && "execute" in toolObj) {
        const originalExecute = (toolObj as any).execute;
        (toolObj as any).execute = async (input: any, opts: any) => {
          // Pre-execution: check if middleware blocks this call
          const mwCall = {
            id: `mw-${Date.now()}`,
            name: toolName,
            input: input ?? {},
          };
          // Sync trust window from per-session metadata before security checks
          syncTrustWindow(mwMetadata);
          const wrapped = pipeline.runWrapToolCall(mwCall);
          if ("blocked" in wrapped && wrapped.blocked) {
            flushTrustWindow(mwMetadata);
            return {
              error: `Blocked by security policy: ${wrapped.reason}`,
              blocked: true,
              middleware: wrapped.middleware,
            };
          }
          // Vault secret substitution: resolve $VAULT_* patterns before execution
          const vaultSubs = (wrapped as any)?.input?._vaultSubstitutions as
            | string[]
            | undefined;
          let scrubMap: Map<string, string> | undefined;
          if (vaultSubs?.length && options.secretResolver) {
            try {
              scrubMap = await buildScrubMap(vaultSubs, options.secretResolver);
              if (scrubMap.size > 0) {
                injectSecrets(mwCall.input, scrubMap);
                setScrubMap(mwCall.id, scrubMap);
              }
            } catch (vaultErr) {
              log.warn(
                { err: vaultErr, patterns: vaultSubs },
                "Vault secret resolution failed — patterns passed unresolved",
              );
            }
            delete mwCall.input._vaultSubstitutions;
          }

          // Execute the tool
          const startMs = Date.now();
          // Record tool-call event to trajectory (with placeholders, not secrets)
          trajectory?.recordToolCall({
            name: toolName,
            input: input ?? {},
            durationMs: 0,
          });
          const rawResult = await originalExecute(
            vaultSubs?.length ? mwCall.input : input,
            opts,
          );
          const durationMs = Date.now() - startMs;

          // Scrub secrets from tool output before returning to model
          const result = scrubMap?.size
            ? scrubSecrets(rawResult, scrubMap)
            : rawResult;

          // Post-execution: run afterToolResult for taint tracking
          const isOk = !(
            result &&
            typeof result === "object" &&
            (result.error || result.ok === false)
          );
          const mwResult = {
            toolCallId: mwCall.id,
            name: toolName,
            ok: isOk,
            output: result,
            durationMs,
          };
          pipeline.runAfterToolResult(mwResult);
          // Record tool-result event to trajectory
          trajectory?.recordToolResult({
            name: toolName,
            ok: isOk,
            error:
              !isOk && typeof result === "object" && result !== null
                ? (result as any).error
                : undefined,
            durationMs,
          });
          // Flush trust window back to per-session metadata after taint recording
          flushTrustWindow(mwMetadata);
          return result;
        };
      }
    }
  }

  // Per-model tool name adaptation: rename tools to match what each provider's
  // models were trained on (e.g., bash → shell_command for OpenAI).
  // The reverse map translates tool calls back to canonical names for execution.
  let finalTools = aiTools;
  let toolReverseMap: Map<string, string> | undefined;
  if (aiTools && decision) {
    const adapted = adaptToolsForModel(aiTools, decision.model);
    finalTools = adapted.adaptedTools;
    toolReverseMap =
      adapted.reverseMap.size > 0 ? adapted.reverseMap : undefined;
  }

  // Serialize task context for gateway telemetry (x-br-metadata header)
  const metadataHeader = serializeRoutingMetadata(task, decision);

  const turnStartMs = Date.now();
  const sessionCostBefore = costTracker.getSessionCost();
  try {
    // Use segmented system prompt for prompt caching when available.
    // AI SDK v6 accepts system as string | SystemModelMessage | Array<SystemModelMessage>.
    // Segments with cacheable=true get Anthropic cache_control hints; ignored by other providers.
    const systemForAPI = options.systemSegments
      ? segmentsToSystemArray(options.systemSegments)
      : systemPrompt;

    // Provider-safety normalization: extract any system-role messages from the
    // history and fold them into the system field. Compaction injects 4-5
    // system-role messages mid-stream (preserved-context block, summary,
    // scratchpad, etc.). Anthropic + OpenAI tolerate this; Gemini's provider
    // throws AI_UnsupportedFunctionalityError because Google's API only
    // accepts system messages at the start of the conversation.
    //
    // We append extracted system content to the system field as additional
    // segments so the model still sees it, just routed through the right
    // channel. The remaining messages array contains only user/assistant
    // turns — what every provider expects.
    const { systemForApiNormalized, messagesForApi } =
      normalizeSystemMessagesForProvider(systemForAPI, messages);

    const result = streamText({
      model: modelId,
      system: systemForApiNormalized as any,
      messages: messagesForApi as any,
      ...(finalTools ? { tools: finalTools } : {}),
      ...(metadataHeader
        ? { headers: { "x-br-metadata": metadataHeader } }
        : {}),
      ...(options.signal ? { abortSignal: options.signal } : {}),
      // Retry on 429/503 with exponential backoff (1s, 2s, 4s).
      // Without this, rate limits during long KAIROS runs crash the daemon.
      maxRetries: 3,
      stopWhen: stepCountIs(
        shouldUseTools ? (options.maxSteps ?? config.general.maxSteps) : 1,
      ),
      onStepFinish: async ({ usage }: any) => {
        if (usage) {
          const inputTokens = usage.inputTokens ?? 0;
          const outputTokens = usage.outputTokens ?? 0;
          try {
            costTracker.record({
              sessionId,
              modelId: decision.model.id,
              provider: decision.model.provider,
              inputTokens,
              outputTokens,
              taskType: task.type,
              projectPath: options.projectPath,
              pricing: decision.model.pricing,
            });
          } catch (dbErr) {
            // SQLite write failure (disk full, locked, etc.) — log but don't crash the agent loop
            log.error(
              { err: dbErr },
              "Cost tracking write failed — continuing without recording",
            );
          }
          // Record LLM call to trajectory for learning loop
          const stepCost =
            (inputTokens / 1_000_000) *
              decision.model.pricing.inputPer1MTokens +
            (outputTokens / 1_000_000) *
              decision.model.pricing.outputPer1MTokens;
          trajectory?.recordLLMCall({
            model: decision.model.id,
            provider: decision.model.provider,
            inputTokens,
            outputTokens,
            latencyMs: 0, // AI SDK doesn't expose per-step latency
            cost: stepCost,
            strategy: decision.strategy ?? "unknown",
          });
        }
      },
    });

    // Apply response filter to strip LLM filler from the beginning of text output
    const streamFilter = createStreamFilter();
    let textDeltaCount = 0;
    let toolCallCount = 0;
    let accumulatedText = ""; // For afterModel middleware (stop-detection, etc.)
    let hasToolBlocked = false;
    let lastEventTime = Date.now();
    const toolCallResults: Array<{ name: string; ok: boolean }> = [];
    const filesRead: string[] = [];
    const filesWritten: string[] = [];
    const loopDetector = new LoopDetector();
    const STREAM_TIMEOUT_MS = 60_000; // 60s without any SSE event = dead stream

    // Track how many times we've incremented the global tool-in-flight gate
    // so we can unwind the count in a finally block — if the stream throws
    // or the consumer aborts between a tool-call and its tool-result, the
    // global counter would otherwise leak and permanently disable
    // compaction for this session.
    let localToolGateDepth = 0;

    try {
      for await (const part of result.fullStream) {
        // Detect hung streams: if no event for 60s, break out
        const now = Date.now();
        if (
          now - lastEventTime > STREAM_TIMEOUT_MS &&
          textDeltaCount === 0 &&
          toolCallCount === 0
        ) {
          const elapsed = now - sessionStartTime;
          log.warn(
            {
              model: decision.model.id,
              elapsedMs: elapsed,
              lastEventAgo: now - lastEventTime,
              textDeltas: textDeltaCount,
              toolCalls: toolCallCount,
            },
            "Stream timeout — no events received, breaking out",
          );
          if (trajectory) {
            trajectory.recordError({
              message: `Stream timeout after ${elapsed}ms`,
              model: decision.model.id,
            });
          }
          break; // Fall through to empty detection + retry
        }
        lastEventTime = now;
        if (part.type === "reasoning-delta") {
          const content = getPartText(part as Record<string, unknown>);
          if (content) yield { type: "reasoning" as const, content };
        } else if (part.type === "text-delta") {
          textDeltaCount++;
          const raw = getPartText(part as Record<string, unknown>);
          if (raw.includes("[TOOL BLOCKED]")) hasToolBlocked = true;
          accumulatedText += raw;
          const filtered = streamFilter.filter(raw);
          if (filtered)
            yield {
              type: "text-delta" as const,
              delta: normalizeInsightMarkers(filtered),
            };
        } else if (part.type === "tool-call") {
          toolCallCount++;
          enterToolExecution(); // gate compaction while tools are in-flight
          localToolGateDepth++;
          yield {
            type: "tool-call-start" as const,
            toolName: part.toolName,
            args: getPartInput(part as Record<string, unknown>),
          };
        } else if (part.type === "tool-result") {
          exitToolExecution(); // ungate compaction
          localToolGateDepth--;
          const toolResult = getPartOutput(
            part as Record<string, unknown>,
          ) as any;
          // Track tool call success/failure for turn context
          const toolOk = !(
            toolResult &&
            typeof toolResult === "object" &&
            (toolResult.error || toolResult.ok === false)
          );
          toolCallResults.push({ name: part.toolName, ok: toolOk });
          // Track file access for turn context
          if (part.toolName === "file_read" && toolOk) {
            const path = getPartInput(part as Record<string, unknown>)?.path as
              | string
              | undefined;
            if (path) filesRead.push(path);
          } else if (
            (part.toolName === "file_write" || part.toolName === "file_edit") &&
            toolOk
          ) {
            const path = getPartInput(part as Record<string, unknown>)?.path as
              | string
              | undefined;
            if (path) filesWritten.push(path);
          }
          // Track build/test results for persistent build state warnings
          if (
            part.toolName === "shell" &&
            options.buildState &&
            toolResult &&
            typeof toolResult === "object"
          ) {
            const cmd =
              (getPartInput(part as Record<string, unknown>)
                ?.command as string) ?? "";
            options.buildState.recordShellResult(
              cmd,
              toolResult.exitCode ?? 0,
              toolResult.stderr ?? "",
            );
          }
          yield {
            type: "tool-call-result",
            toolName: part.toolName,
            result: toolResult,
          };
          // Loop detection — warn about repetitive behavior
          const toolPath = getPartInput(part as Record<string, unknown>)
            ?.path as string | undefined;
          const loopWarnings = loopDetector.recordToolCall(
            part.toolName,
            toolPath,
          );
          for (const w of loopWarnings) {
            yield { type: "loop-warning" as const, message: w.message };
          }
          // Emit subagent-result events for TUI display
          if (
            part.toolName === "subagent" &&
            toolResult &&
            typeof toolResult === "object"
          ) {
            if (toolResult.mode === "single") {
              yield {
                type: "subagent-result",
                subagentType: toolResult.type,
                model: toolResult.model,
                cost: toolResult.cost,
                toolCalls: toolResult.toolCalls,
              };
            } else if (
              toolResult.mode === "parallel" &&
              Array.isArray(toolResult.results)
            ) {
              for (const r of toolResult.results) {
                yield {
                  type: "subagent-result",
                  subagentType: r.type,
                  model: r.model,
                  cost: r.cost,
                  toolCalls: r.toolCalls,
                };
              }
            }
          }
          // Drain any task events queued by task_create/task_update tool executions
          while (taskEventQueue.length > 0) {
            yield taskEventQueue.shift()!;
          }
          // Check for abort between tool executions
          if (options.signal?.aborted) {
            yield { type: "interrupted" };
            return;
          }
        }
      }
    } catch (streamErr: any) {
      // BrainstormRouter sends a guardian SSE event after [DONE] that the AI SDK
      // can't parse (TypeValidationError). This is non-fatal — all content and
      // tool calls have already been yielded. Swallow validation errors silently.
      if (
        streamErr.name !== "AI_TypeValidationError" &&
        !streamErr.message?.includes("Type validation failed")
      ) {
        // Real error — record circuit breaker failure so repeated errors
        // open the circuit and subsequent sessions skip this model.
        getLLMCircuit(decision.model.id).recordFailure(
          streamErr.message ?? "stream_error",
        );
        throw streamErr; // Re-throw real errors
      }
    } finally {
      // Unwind any tool gate entries that didn't see a matching tool-result
      // (stream error, aborted consumer, early return above). Leaking even
      // one would permanently pin isToolInFlight() > 0 and block every
      // future compaction attempt in the current process.
      while (localToolGateDepth > 0) {
        exitToolExecution();
        localToolGateDepth--;
      }
    }

    // Flush any remaining buffered content (critical for short responses < 80 chars)
    const remaining = streamFilter.flush();
    if (remaining) {
      accumulatedText += remaining;
      yield { type: "text-delta", delta: normalizeInsightMarkers(remaining) };
    }

    // Run afterModel middleware (stop-detection, etc.) on the full response text
    if (options.middleware && accumulatedText) {
      const pipeline = options.middleware;
      pipeline.runAfterModel({
        text: accumulatedText,
        toolCalls: [],
        model: decision.model.id,
        tokens: { input: 0, output: 0 }, // Actual tokens tracked via costTracker
      });
    }

    // ── Budget warning at 80% ──
    const budgetRemaining = costTracker.getRemainingBudget();
    if (budgetRemaining !== null) {
      const sessionLimit = (config.budget as any)?.perSession;
      if (sessionLimit && budgetRemaining <= sessionLimit * 0.2) {
        yield {
          type: "budget-warning" as const,
          used: costTracker.getSessionCost(),
          limit: sessionLimit,
          remaining: budgetRemaining,
        };
      }
    }

    // ── Empty/blocked response detection + retry with fallback model ──
    const isEmpty = textDeltaCount === 0 && toolCallCount === 0;

    // Record circuit breaker outcome for this model.
    // Empty response = failure (the model gave us nothing).
    // Non-empty = success (closes half-open circuits, resets consecutive failures).
    const breaker = getLLMCircuit(decision.model.id);
    if (isEmpty) {
      breaker.recordFailure("empty_response");
    } else {
      breaker.recordSuccess();
    }
    // Build fallback list: use decision.fallbacks, or generate from registry if empty
    let fallbacks = decision.fallbacks;
    if (fallbacks.length === 0 && isEmpty) {
      // Fallback models for empty responses — configurable via config.routing.fallbackModels
      const RETRY_MODELS: string[] = (config as any).routing
        ?.fallbackModels ?? [
        "anthropic/claude-sonnet-4.6",
        "openai/gpt-5.4",
        "anthropic/claude-haiku-4.5",
      ];
      fallbacks = RETRY_MODELS.filter((id: string) => id !== decision.model.id)
        .map((id: string) => options.registry.getModel(id))
        .filter((m): m is ModelEntry => m != null && m.status === "available");
    }

    const MAX_FALLBACK_DEPTH = 2;
    const retryDepth = options._retryDepth ?? 0;
    const modelsTried = [...(options._modelsTried ?? []), decision.model.id];

    if (isEmpty && fallbacks.length > 0 && retryDepth < MAX_FALLBACK_DEPTH) {
      const reason = isEmpty ? "empty_response" : "tool_blocked";
      router.recordFailure(decision.model.id, reason);
      // Record failure for Thompson sampling on fallback path
      const fallbackLatencyMs = Date.now() - turnStartMs;
      recordOutcome(task.type, decision.model.id, false, fallbackLatencyMs, 0);
      if (options.routingOutcomeRepo) {
        try {
          options.routingOutcomeRepo.record(
            decision.model.id,
            task.type,
            false,
            fallbackLatencyMs,
            0,
          );
        } catch (outcomeErr) {
          log.warn({ err: outcomeErr }, "Failed to persist routing outcome");
        }
      }
      // Pick next fallback that hasn't been tried yet
      const fallbackModel = fallbacks.find(
        (f: { id: string }) => !modelsTried.includes(f.id),
      );
      if (fallbackModel) {
        yield {
          type: "model-retry" as const,
          fromModel: decision.model.id,
          toModel: fallbackModel.id,
          reason,
        };

        // Retry with fallback model — increment depth and track models tried
        yield* runAgentLoop(messages, {
          ...options,
          preferredModelId: fallbackModel.id,
          _retryDepth: retryDepth + 1,
          _modelsTried: modelsTried,
        } as any);
        return;
      }
    }

    // All retries exhausted — yield structured error so caller can surface it
    if (isEmpty) {
      yield {
        type: "fallback-exhausted" as const,
        modelsTried,
        reason: "All fallback models returned empty responses",
      };
    }

    // Extract gateway response headers (X-BR-*) for cost reconciliation and telemetry.
    // Use a timeout to prevent hanging if the response promise never resolves
    // (happens when the stream errored on the guardian SSE event).
    try {
      const response = await Promise.race([
        result.response,
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 5000)),
      ]);
      if (response?.headers) {
        const feedback = parseGatewayHeaders(response.headers);
        if (Object.keys(feedback).length > 0) {
          yield {
            type: "gateway-feedback",
            feedback: feedback as GatewayFeedbackData,
          };

          // Reconcile actual cost from gateway if available (PR #5)
          if (feedback.actualCost !== undefined) {
            costTracker.reconcile(sessionId, feedback.actualCost);
          }
        }
      }
    } catch {
      // Gateway headers not available (local models) — non-fatal
    }

    // Record success for model momentum
    router.recordSuccess?.(decision.model.id);

    // Record routing outcome for Thompson sampling (in-memory + DB persistence)
    const turnLatencyMs = Date.now() - turnStartMs;
    const turnSuccess = !isEmpty;
    const turnCost = costTracker.getSessionCost() - sessionCostBefore;
    recordOutcome(
      task.type,
      decision.model.id,
      turnSuccess,
      turnLatencyMs,
      turnCost,
    );
    if (options.routingOutcomeRepo) {
      try {
        options.routingOutcomeRepo.record(
          decision.model.id,
          task.type,
          turnSuccess,
          turnLatencyMs,
          turnCost,
        );
      } catch (e) {
        log.warn({ err: e }, "Failed to persist routing outcome to DB");
      }
    }

    // Inject turn context for next turn's self-awareness
    if (options.onTurnComplete) {
      // turnCost (per-turn delta) is already computed above — don't shadow with session total
      const budget = costTracker.getBudgetState();
      const budgetRemaining = budget.dailyLimit
        ? budget.dailyLimit - budget.dailyUsed
        : 0;
      const budgetPercent = budget.dailyLimit
        ? Math.round((budgetRemaining / budget.dailyLimit) * 100)
        : 100;
      options.onTurnComplete({
        turn: 0, // caller sets this
        model: decision.model.name,
        strategy: decision.strategy,
        toolCalls: toolCallResults,
        turnCost,
        budgetRemaining,
        budgetPercent,
        filesRead,
        filesWritten,
        sessionMinutes: 0, // caller sets this
        unhealthyTools: getToolHealthTracker().getUnhealthy(),
        buildStatus: options.buildState?.getStatus() ?? "unknown",
        buildWarning: options.buildState?.formatBuildWarning() ?? "",
        costPerHour: 0, // caller sets this based on session duration
      });
    }

    // Save checkpoint for crash recovery (if checkpointer provided)
    if (options.checkpointer) {
      // Force save on every turn by using current timestamp as turn number.
      // The checkpointer interval check (turnNumber - lastSaveTurn < interval)
      // will always pass with a monotonically increasing value.
      options.checkpointer.saveIfNeeded({
        sessionId,
        turnNumber: Math.floor(Date.now() / 1000),
        conversationHistory: messages,
        scratchpad: {},
        filesRead: filesRead,
        filesWritten: filesWritten,
        buildStatus: options.buildState?.getStatus() ?? "unknown",
        totalCost: costTracker.getSessionCost(),
        projectPath: options.projectPath,
      });
    }

    yield {
      type: "done",
      totalCost: costTracker.getSessionCost(),
      totalTokens: costTracker.getSessionTokens(),
    };
  } catch (error: any) {
    // ── Error Classification ────────────────────────────────────
    // Differentiate error types so callers can make informed retry decisions.

    // 1. User abort — not an error
    if (error.name === "AbortError" || options.signal?.aborted) {
      yield { type: "interrupted" };

      // 2. Model API error (rate limit, auth, network) — record failure for routing
    } else if (isModelApiError(error)) {
      router.recordFailure(decision.model.id, error.message);
      const failLatencyMs = Date.now() - turnStartMs;
      recordOutcome(task.type, decision.model.id, false, failLatencyMs, 0);
      if (options.routingOutcomeRepo) {
        try {
          options.routingOutcomeRepo.record(
            decision.model.id,
            task.type,
            false,
            failLatencyMs,
            0,
          );
        } catch (outcomeErr) {
          log.warn({ err: outcomeErr }, "Failed to persist routing outcome");
        }
      }
      const enriched = enrichError(error, decision.model.id);
      yield { type: "error", error: enriched, category: "model-api" };

      // 3. Database/persistence error — surface clearly, don't blame the model
    } else if (isDbError(error)) {
      log.error(
        { err: error },
        "Database error in agent loop — not a model failure",
      );
      yield {
        type: "error",
        error: new Error(
          `Database error: ${error.message}. Check disk space and file permissions.`,
        ),
        category: "database",
      };

      // 4. Middleware/security error — surface the blocking middleware
    } else if (error.middleware) {
      yield {
        type: "error",
        error: new Error(
          `Blocked by ${error.middleware}: ${error.reason ?? error.message}`,
        ),
        category: "middleware",
      };

      // 5. Unknown — treat as model error for backward compatibility
    } else {
      router.recordFailure(decision.model.id, error.message);
      const failLatencyMs = Date.now() - turnStartMs;
      recordOutcome(task.type, decision.model.id, false, failLatencyMs, 0);
      if (options.routingOutcomeRepo) {
        try {
          options.routingOutcomeRepo.record(
            decision.model.id,
            task.type,
            false,
            failLatencyMs,
            0,
          );
        } catch (outcomeErr) {
          log.warn({ err: outcomeErr }, "Failed to persist routing outcome");
        }
      }
      const enriched = enrichError(error, decision.model.id);
      yield { type: "error", error: enriched, category: "unknown" };
    }
  } finally {
    setTaskEventHandler(null);
    setToolOutputHandler(null);
    setBackgroundEventHandler(null);

    // Submit trajectory + update routing intelligence (fire-and-forget)
    if (trajectory) {
      trajectory.recordSessionEnd({
        totalCost: costTracker.getSessionCost(),
        totalTurns: 1, // caller tracks actual turns
        durationMs: Date.now() - sessionStartTime,
      });

      // Update routing intelligence — closes the learning loop.
      // Fire-and-forget: analyzer reads fresh trajectories, writes intelligence file,
      // next router startup picks it up as Thompson sampling priors.
      try {
        const { analyzeTrajectories } =
          await import("../session/trajectory-analyzer.js");
        analyzeTrajectories();
      } catch {
        // Best-effort: don't fail the session over analyzer errors
      }
    }
  }
}
