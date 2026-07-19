import { streamText, stepCountIs } from "ai";
import { randomUUID } from "node:crypto";
import type { ConversationMessage } from "../session/manager.js";
import type { BrainstormConfig } from "@brainst0rm/config";
import type { ProviderRegistry } from "@brainst0rm/providers";
import type { RoutingDecision } from "@brainst0rm/shared";
import {
  BrainstormRouter,
  CostTracker,
  recordOutcome,
  adaptToolsForModel,
  reverseToolName,
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
  enterSession,
} from "@brainst0rm/tools";
import {
  createLogger,
  type AgentEvent,
  type GatewayFeedbackData,
  type ModelEntry,
  type TurnContext,
  type StopCause,
  type RunOutcome,
  type ModelAttemptOutcome,
} from "@brainst0rm/shared";
import type { BuildStateTracker } from "./build-state.js";
import { LoopDetector } from "./loop-detector.js";
import { serializeRoutingMetadata, linkSignals } from "@brainst0rm/shared";
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

/**
 * Classify how a single model attempt terminated into a canonical StopCause.
 * Ordering matters: truncation and emptiness are model-side failures a
 * fallback may recover; step-cap is only asserted when the run actually
 * exhausted its budget AND the last step still wanted to continue (a bare
 * terminal `finishReason:"tool-calls"` is not itself proof of a cap).
 */
export function classifyStopCause(input: {
  isEmpty: boolean;
  toolCallTruncated: boolean;
  stepsCompleted: number;
  maxSteps: number;
  lastStepFinishReason?: string;
  providerFinishReason?: string;
}): StopCause {
  const {
    isEmpty,
    toolCallTruncated,
    stepsCompleted,
    maxSteps,
    lastStepFinishReason,
    providerFinishReason,
  } = input;
  if (toolCallTruncated) return "truncated_tool_call";
  const providerLength =
    providerFinishReason === "length" || lastStepFinishReason === "length";
  const contentFiltered =
    providerFinishReason === "content-filter" ||
    providerFinishReason === "content_filter" ||
    lastStepFinishReason === "content-filter";
  // Hit the step budget while the last step still wanted to act.
  if (
    stepsCompleted >= maxSteps &&
    (lastStepFinishReason === "tool-calls" || lastStepFinishReason === "length")
  ) {
    return "step_cap_reached";
  }
  if (contentFiltered) return "content_filtered";
  if (providerLength) return "output_limit";
  if (isEmpty) return "empty_output";
  return "natural_stop";
}

/**
 * Request-level output budget: the model's advertised maxOutputTokens,
 * clamped to what its context window can still hold after the prompt.
 * System prompt and tool schemas aren't in the message estimate, so a
 * fixed overhead is reserved; a small floor keeps the request valid even
 * when the estimate is pessimistic (the server clamps further if needed).
 * Returns a spreadable object so callers can omit the option entirely for
 * models that advertise no output limit.
 */
/**
 * Robust char estimate for message content that may be a string OR the AI
 * SDK's array-of-parts shape (text/tool-call/tool-result parts). Avoids the
 * string-only assumption in estimateTokenCount, which would mis-measure
 * array content and silently under-reserve prompt space.
 */
function contentCharLength(content: unknown): number {
  if (typeof content === "string") return content.length;
  if (Array.isArray(content)) {
    let n = 0;
    for (const part of content) {
      if (typeof part === "string") n += part.length;
      else if (part && typeof (part as { text?: unknown }).text === "string")
        n += (part as { text: string }).text.length;
      else n += JSON.stringify(part ?? "").length;
    }
    return n;
  }
  return content == null ? 0 : JSON.stringify(content).length;
}

export function computeOutputBudget(
  model: {
    limits?: { contextWindow?: number; maxOutputTokens?: number };
  },
  messages: Array<{ role: string; content: unknown }>,
  systemPrompt?: unknown,
): { maxOutputTokens: number } | Record<string, never> {
  const advertised = model.limits?.maxOutputTokens;
  if (!advertised) return {};
  const window = model.limits?.contextWindow;
  if (!window) return { maxOutputTokens: advertised };
  // Tool schemas aren't measured (they're functions + zod shapes); reserve a
  // fixed allowance. The system prompt IS measured — brainstorm's runs multi-k
  // tokens, far beyond any fixed guess.
  const TOOL_SCHEMA_OVERHEAD_TOKENS = 1024;
  const MIN_OUTPUT_TOKENS = 256;
  const systemText =
    typeof systemPrompt === "string"
      ? systemPrompt
      : Array.isArray(systemPrompt)
        ? systemPrompt
            .map((s) =>
              s && typeof (s as { content?: unknown }).content === "string"
                ? (s as { content: string }).content
                : "",
            )
            .join("")
        : "";
  // 20 chars/message overhead mirrors estimateTokenCount's role+formatting fudge.
  let messageChars = 0;
  for (const m of messages) messageChars += contentCharLength(m.content) + 20;
  const promptEstimate =
    Math.ceil(messageChars / 4) +
    Math.ceil(systemText.length / 4) +
    TOOL_SCHEMA_OVERHEAD_TOKENS;
  const remaining = window - promptEstimate;
  if (remaining >= MIN_OUTPUT_TOKENS) {
    return { maxOutputTokens: Math.min(advertised, remaining) };
  }
  // Near-exhausted window: requesting the floor would overflow — request
  // exactly what's left. Fully exhausted (remaining <= 0): the prompt alone
  // exceeds the window and no max_tokens value can save the request; keep it
  // well-formed with the floor and let compaction/fallback handle the error.
  return {
    maxOutputTokens: remaining > 0 ? remaining : MIN_OUTPUT_TOKENS,
  };
}

/**
 * Smallest shared model-call seam (first TurnController strangler seam; the
 * full extraction is iteration 006). Assembles the streamText config that is
 * common to every attempt — model, system, messages, output budget, abort,
 * retries, headers — in ONE place, so the normal attempt and the forced-
 * synthesis attempt can't drift. Callers pass only what differs: the normal
 * attempt supplies tools + onStepFinish + a multi-step budget; synthesis
 * supplies neither and a single step.
 */
type StreamTextArgs = Parameters<typeof streamText>[0];

function invokeModelAttempt(params: {
  /** Provider-resolved model (registry.getProvider(...)). */
  providerModel: unknown;
  /** Catalog entry — for output budgeting. */
  modelEntry: { limits?: { contextWindow?: number; maxOutputTokens?: number } };
  system: unknown;
  messages: Array<{ role: string; content: unknown }>;
  abortSignal: AbortSignal;
  maxSteps: number;
  metadataHeader?: string;
  tools?: StreamTextArgs["tools"];
  forceToolChoice?: boolean;
  onStepFinish?: StreamTextArgs["onStepFinish"];
}) {
  return streamText({
    model: params.providerModel as StreamTextArgs["model"],
    system: params.system as any,
    messages: params.messages as any,
    ...(params.tools ? { tools: params.tools } : {}),
    ...(params.tools && params.forceToolChoice
      ? { toolChoice: "required" as const }
      : {}),
    ...(params.metadataHeader
      ? { headers: { "x-br-metadata": params.metadataHeader } }
      : {}),
    ...computeOutputBudget(params.modelEntry, params.messages, params.system),
    abortSignal: params.abortSignal,
    maxRetries: 3,
    stopWhen: stepCountIs(params.maxSteps),
    ...(params.onStepFinish ? { onStepFinish: params.onStepFinish } : {}),
  });
}

import { segmentsToSystemArray } from "./context.js";
import { predictTaskCost } from "./cost-predictor.js";
import { detectTone, toneGuidance } from "./sentiment.js";
import { shouldUseEnsemble } from "./ensemble.js";
import {
  runVerifyPass,
  formatVerifyDiagnostic,
  type VerifyMode,
  type VerifyRunner,
} from "./verify-loop.js";
import {
  detectNarratedToolIntent,
  buildToolUseCorrection,
} from "./tool-use-enforcement.js";

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
  /**
   * Per-invocation override for in-loop verify / self-correction (Phase 3).
   * When omitted, falls back to config.general.verify.
   */
  verify?: { mode: VerifyMode; maxIterations: number };
  /** Internal: tracks verify self-correction depth to cap re-entry. */
  _verifyDepth?: number;
  /** Internal: injectable verifier (tests supply a mock). */
  _verifyRunner?: VerifyRunner;
  /**
   * Per-invocation override for tool-use enforcement (Phase 7). Weak models
   * that narrate a tool action but never emit the call get a corrective nudge
   * + a forced tool-call retry. When omitted, falls back to
   * config.general.toolEnforcement.
   */
  toolEnforcement?: { enabled: boolean; maxNudges: number };
  /** Internal: tracks tool-enforcement nudge depth to cap re-entry. */
  _nudgeDepth?: number;
  /**
   * Internal: force `toolChoice: "required"` for THIS single turn only. Set on
   * the corrective retry after a narration nudge so the model is compelled to
   * emit a real tool call instead of narrating again. Never persisted — every
   * other recursion site resets it so the model can still finish normally.
   */
  _forceToolChoice?: boolean;
  /**
   * Internal: set on a fallback re-entry to signal that a forced-synthesis
   * turn already ran upstream, so a re-entered loop doesn't synthesize again.
   * (Forced synthesis itself is a direct call, not a recursion, but fallback
   * retries DO recurse — this keeps synthesis strictly once per logical run.)
   */
  _synthesized?: boolean;
  /**
   * Internal: failed model-attempt outcomes accumulated by upstream fallback
   * levels, so the terminal (successful) level can emit ONE aggregate
   * RunOutcome carrying every attempt. Each fallback re-entry appends the
   * attempt it just gave up on.
   */
  _attemptsSoFar?: ModelAttemptOutcome[];
  /**
   * Internal: session cost at the START of this logical run, captured once at
   * the root and propagated through recursion so RunOutcome.costUsd is the run
   * delta — not the CostTracker's cumulative session/process total (which a
   * long-lived caller reuses across many runs).
   */
  _runCostBaseline?: number;
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
  // Same rationale for the session scope: session-scoped tool stores (tasks,
  // …) key off getSessionId(), so concurrent runs must each enter their own
  // session before any tool executes.
  enterSession(sessionId);

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

  // Run middleware beforeAgent hook (if pipeline provided).
  //
  // This runs BEFORE the classified try/catch at line ~785, so a
  // throwing middleware would historically escape the entire error
  // classifier and surface as an unhandled exception in the generator.
  // Codex flagged this as MAJOR on the v15 P9d-2 chaos suite. Wrap
  // the call in its own typed-error scope so a "blocked by X"
  // middleware still emits a category=middleware event consumers can
  // route on.
  if (options.middleware) {
    const mwState = {
      turn: 0,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      systemPrompt,
      toolNames: [],
      metadata: mwMetadata,
    };
    try {
      const mwResult = options.middleware.runBeforeAgent(mwState);
      if (mwResult.systemPrompt !== systemPrompt) {
        systemPrompt = mwResult.systemPrompt;
      }
    } catch (mwErr: any) {
      // Surface tagged-middleware throws as the same typed event as
      // mid-stream middleware failures. Use the tagged `.middleware`
      // field if present; otherwise label as the generic
      // "beforeAgent" middleware so the operator knows where to look.
      const tag = mwErr?.middleware ?? "beforeAgent";
      const reason = mwErr?.reason ?? mwErr?.message ?? "unknown reason";
      yield {
        type: "error",
        error: new Error(`Blocked by ${tag}: ${reason}`),
        category: "middleware",
      };
      return;
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
        // Caller-owned timer + AbortController so the listener is cleaned
        // up when compact() wins the race (the normal path). Previously an
        // AbortSignal.timeout() handle retained the abort listener and
        // fired reject() on an already-resolved promise 30s later, leaking
        // the closure once per compaction.
        const COMPACTION_TIMEOUT_MS = 30_000;
        const compactionTimeoutController = new AbortController();
        const compactionTimeoutTimer = setTimeout(
          () => compactionTimeoutController.abort(),
          COMPACTION_TIMEOUT_MS,
        );
        let compactionResult;
        try {
          compactionResult = await Promise.race([
            options.compaction.compact({
              contextWindow,
              keepRecent: config.compaction?.keepRecent ?? 5,
            }),
            new Promise<never>((_, reject) => {
              compactionTimeoutController.signal.addEventListener(
                "abort",
                () => reject(new Error("Compaction timeout")),
                { once: true },
              );
            }),
          ]);
        } finally {
          clearTimeout(compactionTimeoutTimer);
        }
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
          // Pre-execution: check if middleware blocks this call.
          // The mwCall.id must be unique across parallel tool calls —
          // Date.now() has 1ms resolution and AI SDK v6 can invoke
          // multiple execute()s in the same millisecond (and does,
          // when parallelToolCalls is enabled). randomUUID is
          // guaranteed-unique per call.
          const mwCall = {
            id: `mw-${randomUUID()}`,
            name: toolName,
            input: input ?? {},
          };
          // Sync trust window — scoped to this tool's call.id so
          // parallel tool executions don't corrupt each other's state.
          syncTrustWindow(mwMetadata, mwCall.id);
          const wrapped = pipeline.runWrapToolCall(mwCall);
          if ("blocked" in wrapped && wrapped.blocked) {
            flushTrustWindow(mwMetadata, mwCall.id);
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
          // The pipeline's return value IS the tool result the model must
          // see: quality-signal hints ride on it, and the secret-substitution
          // fail-closed path REPLACES the output with a redaction notice.
          // Discarding it (the previous behavior) silently disabled every
          // result-modifying middleware in production — including the
          // redaction guarantee.
          const mwProcessed = pipeline.runAfterToolResult(mwResult);
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
          flushTrustWindow(mwMetadata, mwCall.id);
          return mwProcessed.output;
        };
      }
    }
  }

  // Per-model tool name adaptation: rename tools to match what each provider's
  // models were trained on (e.g., bash → shell_command for OpenAI). We adapt
  // the OUTBOUND tool list so the model sees provider-native names. The
  // AI SDK then dispatches a tool call to the executor keyed under that same
  // adapted name — but every downstream consumer in the stream loop compares
  // against CANONICAL names (file_read/file_write/file_edit/shell/subagent)
  // for turn-context tracking, build-state capture, loop detection, and TUI
  // events. The INBOUND rename (reverseToolName below) maps each observed
  // tool-call name back to canonical at the point the loop resolves it, so a
  // model that emits a renamed name (apply_patch, replace, read_file, …) is
  // tracked and surfaced under its canonical identity rather than silently
  // missing every comparison.
  let finalTools = aiTools;
  if (aiTools && decision) {
    const adapted = adaptToolsForModel(aiTools, decision.model);
    finalTools = adapted.adaptedTools;
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

    // Stream-stall watchdog: a provider may open the SSE connection but
    // never send any event (silent proxy drop, network stall, provider
    // hang). The for-await-of below only checks the staleness timer when
    // a part arrives, so without this watchdog a truly-hung stream would
    // block the loop forever. Link the watchdog's signal with any parent
    // signal so both sources terminate the stream.
    const streamAbort = new AbortController();
    const effectiveStreamSignal = linkSignals(
      streamAbort.signal,
      options.signal,
    );
    // Step-cap detection: count completed steps and remember the last step's
    // finish reason. A bare terminal `finishReason:"tool-calls"` is NOT proof
    // the run hit its budget — only `stepsCompleted >= maxStepsForRun` with the
    // last step still wanting to continue is. Hoisted maxStepsForRun so both
    // stopWhen and the post-loop classifier read the same number.
    const maxStepsForRun = shouldUseTools
      ? (options.maxSteps ?? config.general.maxSteps)
      : 1;
    let stepsCompleted = 0;
    let lastStepFinishReason: string | undefined;
    // Phase 7: on a narration-nudge corrective retry ONLY, force a real tool
    // call so the model cannot narrate-and-stop again. Scoped to this single
    // re-entry via options._forceToolChoice; never permanent. The seam applies
    // the output budget (full advertised max, clamped to remaining context —
    // reasoning models otherwise burn their whole budget on reasoning tokens
    // and finish empty) shared with the forced-synthesis attempt below.
    const result = invokeModelAttempt({
      providerModel: modelId,
      modelEntry: decision.model,
      system: systemForApiNormalized,
      messages: messagesForApi,
      abortSignal: effectiveStreamSignal,
      maxSteps: maxStepsForRun,
      metadataHeader,
      tools: finalTools ?? undefined,
      forceToolChoice: options._forceToolChoice,
      onStepFinish: async ({ usage, finishReason: stepFinish }: any) => {
        stepsCompleted++;
        if (typeof stepFinish === "string") lastStepFinishReason = stepFinish;
        if (usage) {
          const inputTokens = usage.inputTokens ?? 0;
          const outputTokens = usage.outputTokens ?? 0;
          // AI SDK v6 exposes cache-read tokens on the usage object. These
          // are a subset of inputTokens and are billed at a reduced rate.
          const cachedTokens = usage.cachedInputTokens ?? 0;
          try {
            costTracker.record({
              sessionId,
              modelId: decision.model.id,
              provider: decision.model.provider,
              inputTokens,
              outputTokens,
              cachedTokens,
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
          // Record LLM call to trajectory for learning loop. Apply the same
          // cache-read discount as CostTracker so trajectory cost matches the
          // billed cost: cached tokens bill at the cached rate (default 0.1×
          // input), the remainder at the full input rate.
          const cachedRate =
            decision.model.pricing.cachedInputPer1MTokens ??
            decision.model.pricing.inputPer1MTokens * 0.1;
          const billableCached = Math.min(cachedTokens, inputTokens);
          const stepCost =
            ((inputTokens - billableCached) / 1_000_000) *
              decision.model.pricing.inputPer1MTokens +
            (billableCached / 1_000_000) * cachedRate +
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
    // ── Streamed tool-call assembly integrity tracking ──
    // pendingToolInputs: incremented when the provider signals the start of a
    // tool-call (tool-input-start) and decremented when that call materializes
    // as a dispatchable tool-call part. A residual > 0 after the stream ends
    // means a tool call began assembling but never completed — the classic
    // symptom of a truncated/duplicate terminal finish (seen from BR) cutting
    // the AI-SDK parser off mid-tool-call.
    let pendingToolInputs = 0;
    // finishReason from the terminal finish / finish-step parts. "tool-calls"
    // means the model intended to act; if we then saw zero dispatchable
    // tool-calls the assembly was truncated (not a genuine empty turn).
    let finishReason: string | undefined;
    let finishPartCount = 0;
    let lastEventTime = Date.now();
    const toolCallResults: Array<{ name: string; ok: boolean }> = [];
    const filesRead: string[] = [];
    const filesWritten: string[] = [];
    const loopDetector = new LoopDetector();
    // Stream-stall watchdog threshold. Configurable via
    // config.agent.streamTimeoutMs; defaults to 60s. Extended-thinking
    // models that emit long stretches of silent reasoning may need a
    // higher value — raising this is cheap, lowering it is what
    // catches genuine hangs faster.
    const STREAM_TIMEOUT_MS = options.config.agent?.streamTimeoutMs ?? 60_000;

    // Track how many times we've incremented the global tool-in-flight gate
    // so we can unwind the count in a finally block — if the stream throws
    // or the consumer aborts between a tool-call and its tool-result, the
    // global counter would otherwise leak and permanently disable
    // compaction for this session.
    let localToolGateDepth = 0;

    // Watchdog: if no event arrives for STREAM_TIMEOUT_MS the stream is
    // dead. Aborting streamAbort terminates fullStream and the for-await
    // exits cleanly. We unref() so the timer itself doesn't keep the
    // process alive.
    //
    // `watchdogFired` distinguishes watchdog-origin aborts from user-origin
    // aborts (options.signal). Watchdog-origin should fall through to the
    // empty-response retry path with RETRY_MODELS, matching the old
    // in-loop `break`-on-stall behaviour. User-origin stays "interrupted".
    let watchdogFired = false;
    const watchdog = setInterval(() => {
      if (Date.now() - lastEventTime > STREAM_TIMEOUT_MS) {
        const elapsed = Date.now() - sessionStartTime;
        log.warn(
          {
            model: decision.model.id,
            elapsedMs: elapsed,
            lastEventAgo: Date.now() - lastEventTime,
            textDeltas: textDeltaCount,
            toolCalls: toolCallCount,
          },
          "Stream stall detected — aborting stream",
        );
        trajectory?.recordError({
          message: `Stream timeout after ${elapsed}ms`,
          model: decision.model.id,
        });
        watchdogFired = true;
        streamAbort.abort();
      }
    }, 5_000);
    watchdog.unref?.();

    try {
      for await (const part of result.fullStream) {
        const now = Date.now();
        lastEventTime = now;
        if (part.type === "reasoning-delta") {
          const content = getPartText(part as Record<string, unknown>);
          if (content) yield { type: "reasoning" as const, content };
        } else if (part.type === "text-delta") {
          textDeltaCount++;
          const raw = getPartText(part as Record<string, unknown>);
          accumulatedText += raw;
          const filtered = streamFilter.filter(raw);
          if (filtered)
            yield {
              type: "text-delta" as const,
              delta: normalizeInsightMarkers(filtered),
            };
        } else if (part.type === "tool-input-start") {
          // A tool call began streaming. Track it so we can detect a stream
          // that finishes before the call materializes into a tool-call part.
          pendingToolInputs++;
        } else if (part.type === "tool-call") {
          toolCallCount++;
          // Balance the tool-input-start we counted above (if the provider
          // emitted one). Floor at 0 so providers that emit tool-call without
          // a preceding tool-input-start don't drive the counter negative.
          pendingToolInputs = Math.max(0, pendingToolInputs - 1);
          // INBOUND rename: map the provider-native tool name back to canonical
          // so downstream comparisons and TUI events see the canonical identity.
          const canonicalName = reverseToolName(part.toolName, decision.model);
          enterToolExecution(); // gate compaction while tools are in-flight
          localToolGateDepth++;
          yield {
            type: "tool-call-start" as const,
            toolName: canonicalName,
            args: getPartInput(part as Record<string, unknown>),
          };
        } else if (part.type === "finish" || part.type === "finish-step") {
          // Capture the terminal finish reason. A duplicate/malformed finish
          // (BR sometimes sends more than one) is itself a truncation signal —
          // count them so the diagnostic can report it.
          finishPartCount++;
          finishReason =
            ((part as Record<string, unknown>).finishReason as string) ??
            finishReason;
        } else if (part.type === "tool-result") {
          exitToolExecution(); // ungate compaction
          localToolGateDepth--;
          // INBOUND rename: canonical name for all comparisons/tracking below.
          const canonicalName = reverseToolName(part.toolName, decision.model);
          const toolResult = getPartOutput(
            part as Record<string, unknown>,
          ) as any;
          // Track tool call success/failure for turn context
          const toolOk = !(
            toolResult &&
            typeof toolResult === "object" &&
            (toolResult.error || toolResult.ok === false)
          );
          toolCallResults.push({ name: canonicalName, ok: toolOk });
          // Track file access for turn context
          if (canonicalName === "file_read" && toolOk) {
            const path = getPartInput(part as Record<string, unknown>)?.path as
              | string
              | undefined;
            if (path) filesRead.push(path);
          } else if (
            (canonicalName === "file_write" || canonicalName === "file_edit") &&
            toolOk
          ) {
            const path = getPartInput(part as Record<string, unknown>)?.path as
              | string
              | undefined;
            if (path) filesWritten.push(path);
          }
          // Track build/test results for persistent build state warnings
          if (
            canonicalName === "shell" &&
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
            toolName: canonicalName,
            result: toolResult,
          };
          // Loop detection — warn about repetitive behavior
          const toolPath = getPartInput(part as Record<string, unknown>)
            ?.path as string | undefined;
          const loopWarnings = loopDetector.recordToolCall(
            canonicalName,
            toolPath,
          );
          for (const w of loopWarnings) {
            yield { type: "loop-warning" as const, message: w.message };
          }
          // Emit subagent-result events for TUI display
          if (
            canonicalName === "subagent" &&
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
      const isTypeValidation =
        streamErr.name === "AI_TypeValidationError" ||
        streamErr.message?.includes("Type validation failed");
      // Watchdog-origin abort: the stream stalled out. Swallow the AbortError
      // here so control falls through to the empty-response retry below,
      // which tries each model in RETRY_MODELS. Without this swallow, the
      // outer catch's "error.name === AbortError" branch would classify a
      // stalled stream as a user interrupt and end the turn with no retry.
      const isWatchdogAbort = watchdogFired && streamErr.name === "AbortError";
      if (!isTypeValidation && !isWatchdogAbort) {
        // Real error — record circuit breaker failure so repeated errors
        // open the circuit and subsequent sessions skip this model.
        getLLMCircuit(decision.model.id).recordFailure(
          streamErr.message ?? "stream_error",
        );
        throw streamErr; // Re-throw real errors
      }
      if (isWatchdogAbort) {
        // Record the stall so circuit-breaker + routing see it as a failure
        // against this model, just like the old in-loop break did.
        getLLMCircuit(decision.model.id).recordFailure("stream_stall");
      }
    } finally {
      clearInterval(watchdog);
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
    // Whitespace-only text counts as empty: models occasionally stream a
    // bare newline (or reasoning-only turns leak a blank content delta),
    // which previously classified the turn as successful — routing recorded
    // a success and downstream consumers (workflow artifact validation)
    // failed on an "empty" artifact the loop had called good.
    const isEmpty =
      (textDeltaCount === 0 || accumulatedText.trim().length === 0) &&
      toolCallCount === 0;

    // ── Truncated tool-call detection ──
    // Distinct from an empty turn: here the model INTENDED to call a tool but
    // the stream ended before a dispatchable tool-call materialized. Two
    // signals, either of which is sufficient:
    //   1. pendingToolInputs > 0 — a tool-input-start never resolved into a
    //      tool-call (parser cut off mid-assembly).
    //   2. finishReason === "tool-calls" but toolCallCount === 0 — the provider
    //      reported it stopped to make tool calls, yet emitted none.
    // A duplicate terminal finish (finishPartCount > 1), which BR has been seen
    // to send, is the usual trigger for (1)/(2) — surfaced in the diagnostic.
    // We must NOT let this record as a silent empty-success: it retries.
    const toolCallTruncated =
      pendingToolInputs > 0 ||
      (finishReason === "tool-calls" && toolCallCount === 0);

    if (toolCallTruncated) {
      log.warn(
        {
          model: decision.model.id,
          pendingToolInputs,
          finishReason,
          finishPartCount,
          textDeltas: textDeltaCount,
          toolCalls: toolCallCount,
        },
        "Stream truncated mid-tool-call — tool-call assembly incomplete",
      );
      trajectory?.recordError({
        message: `Truncated tool-call assembly (pending=${pendingToolInputs}, finishReason=${finishReason ?? "none"}, finishParts=${finishPartCount})`,
        model: decision.model.id,
      });
      yield {
        type: "loop-warning" as const,
        message: `Stream from ${decision.model.id} truncated mid-tool-call (finishReason=${finishReason ?? "none"}, ${pendingToolInputs} pending). Retrying.`,
      };
    }

    // ── Forced synthesis: tool work done, but no final answer written ──
    // A model (often a coder, or a reasoning model whose answer leaked into
    // reasoning_content) can make tool calls and then STOP — whether by
    // exhausting its step budget or by finishing early — WITHOUT ever writing
    // a final answer. Such a turn is not `isEmpty` (it made tool calls) yet has
    // no usable response; it would otherwise record as a silent success with
    // empty text, which is exactly what dead-ended the reviewer seats + gpt-oss
    // eval step-cap failures + empty workflow artifacts this iteration targets.
    //
    // Live dogfooding (gpt-oss, iter-004) showed the hard-cap case is only HALF
    // of it — the model frequently stops EARLY after tool calls with no
    // summary. So trigger on the general condition: made tool calls, has no
    // final response, wasn't truncated. NOT producedArtifacts (edits ARE an
    // artifact). Run exactly ONE tools-disabled synthesis turn through the
    // shared seam; `initialStopCause` preserves how it actually stopped.
    // hasFinalResponse: the turn produced usable text. (A stricter "text AFTER
    // the last tool call" signal — Codex's finding #1 — would also flag
    // narrate-then-act turns that legitimately conclude on the next turn as
    // needing synthesis, over-firing; the sharper distinction is deferred to
    // the iter-006 TurnController, which models a turn's phases explicitly.)
    let hasFinalResponse = accumulatedText.trim().length > 0;
    let recovery: RunOutcome["recovery"] | undefined;
    let synthesisAttempted = options._synthesized ?? false;
    const initialStopCause = classifyStopCause({
      isEmpty,
      toolCallTruncated,
      stepsCompleted,
      maxSteps: maxStepsForRun,
      lastStepFinishReason,
      providerFinishReason: finishReason,
    });
    // Budget guard: synthesis is a direct extra model call that bypasses the
    // router — don't start it once the hard session budget is spent.
    const synthesisBudgetOk = (() => {
      const remaining = costTracker.getRemainingBudget();
      return remaining === null || remaining > 0;
    })();
    const needsSynthesis =
      shouldUseTools && // only a genuine tool-using session can lack a summary
      !hasFinalResponse &&
      toolCallCount > 0 &&
      !toolCallTruncated &&
      !synthesisAttempted &&
      synthesisBudgetOk;
    if (needsSynthesis) {
      synthesisAttempted = true; // once per logical run, even on failure
      // Own AbortController linked to the caller signal so a hung synthesis
      // stream can't hang the run; distinct timeout vs caller-cancellation.
      const SYNTH_TIMEOUT_MS = 60_000;
      const synthTimeoutController = new AbortController();
      const synthTimer = setTimeout(
        () => synthTimeoutController.abort(),
        SYNTH_TIMEOUT_MS,
      );
      const synthSignal = linkSignals(
        synthTimeoutController.signal,
        options.signal,
      );
      try {
        yield {
          type: "loop-warning" as const,
          message: `${decision.model.id} made ${toolCallCount} tool call(s) but wrote no final answer (stop: ${initialStopCause}) — running one tools-disabled synthesis turn.`,
        };
        // Give synthesis the model's OWN work to summarize: the assistant
        // tool-call + tool-result messages from the completed invocation, not
        // just the input history it can't see its work in.
        let synthContext = messagesForApi as Array<{
          role: string;
          content: unknown;
        }>;
        try {
          // Bound the response-metadata await against the synthesis watchdog +
          // caller signal — result.response can itself hang (a stalled/errored
          // stream), and an unbounded await here would defeat the watchdog.
          const resp = await Promise.race([
            result.response,
            new Promise<null>((resolve) => {
              synthSignal.addEventListener("abort", () => resolve(null), {
                once: true,
              });
            }),
          ]);
          const respMessages = (resp as { messages?: unknown[] } | null)
            ?.messages;
          if (Array.isArray(respMessages) && respMessages.length > 0) {
            synthContext = [
              ...synthContext,
              ...(respMessages as Array<{ role: string; content: unknown }>),
            ];
          }
        } catch {
          /* response unavailable — fall back to input history */
        }
        // If the caller cancelled while we were fetching response metadata,
        // stop before spending another model call.
        if (options.signal?.aborted) {
          clearTimeout(synthTimer);
          yield { type: "interrupted" };
          return;
        }
        const synthResult = invokeModelAttempt({
          providerModel: modelId,
          modelEntry: decision.model,
          system: systemForApiNormalized,
          messages: [
            ...synthContext,
            {
              role: "user",
              content:
                "You have reached your tool-use budget. Do NOT call any more tools. " +
                "Using only the work you have already done, write your final answer/result now.",
            },
          ],
          abortSignal: synthSignal,
          maxSteps: 1,
          metadataHeader,
        });
        const synthText = (await synthResult.text)?.trim() ?? "";
        // Record synthesis cost regardless of whether it produced text — an
        // empty synthesis is still billable.
        try {
          const u = await synthResult.usage;
          costTracker.record({
            sessionId,
            modelId: decision.model.id,
            provider: decision.model.provider,
            inputTokens: u?.inputTokens ?? 0,
            outputTokens: u?.outputTokens ?? 0,
            cachedTokens: 0,
            taskType: task.type,
            projectPath: options.projectPath,
            pricing: decision.model.pricing,
          });
        } catch {
          /* usage/cost best-effort */
        }
        if (synthText) {
          accumulatedText += (accumulatedText ? "\n\n" : "") + synthText;
          hasFinalResponse = true;
          recovery = "forced_synthesis";
          yield {
            type: "text-delta",
            delta: normalizeInsightMarkers(synthText),
          };
        }
      } catch (synthErr: any) {
        // A caller cancellation must propagate as interrupted, not be
        // swallowed into a recovered "done".
        if (synthErr?.name === "AbortError" || options.signal?.aborted) {
          clearTimeout(synthTimer);
          if (options.signal?.aborted) {
            yield { type: "interrupted" };
            return;
          }
          // else: our own synthesis timeout fired — fall through as a failed
          // synthesis (hasFinalResponse stays false → handled below).
        }
        log.warn(
          { err: synthErr, model: decision.model.id },
          "Forced synthesis turn failed — treating as no final response",
        );
      } finally {
        clearTimeout(synthTimer);
      }
    }

    // A turn needs a retry when a tool-call was truncated, OR a genuine
    // tool-using turn made tool calls but produced no final response (whether
    // synthesis ran-and-failed this turn OR was already spent upstream by a
    // _synthesized descendant — either way a tool-only turn with no answer is
    // not a success). Non-tool turns fall back to the classic empty signal.
    const toolTurnWithoutAnswer =
      shouldUseTools && toolCallCount > 0 && !hasFinalResponse;
    const shouldRetry =
      toolCallTruncated || toolTurnWithoutAnswer || isEmpty;

    // Record circuit breaker outcome for this model.
    // Empty response / truncated tool-call = failure (nothing usable).
    // Non-empty & complete = success (closes half-open circuits, resets
    // consecutive failures).
    const breaker = getLLMCircuit(decision.model.id);
    if (shouldRetry) {
      breaker.recordFailure(
        toolCallTruncated ? "truncated_tool_call" : "empty_response",
      );
    } else {
      breaker.recordSuccess();
    }
    // Build fallback list: use decision.fallbacks, or generate from registry if empty
    let fallbacks = decision.fallbacks;
    if (fallbacks.length === 0 && shouldRetry) {
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

    if (
      shouldRetry &&
      fallbacks.length > 0 &&
      retryDepth < MAX_FALLBACK_DEPTH
    ) {
      const reason = toolCallTruncated
        ? "truncated_tool_call"
        : "empty_response";
      router.recordFailure(decision.model.id, reason);
      // Record failure for Thompson sampling on fallback path
      const fallbackLatencyMs = Date.now() - turnStartMs;
      recordOutcome(task.type, decision.model.id, false, fallbackLatencyMs, 0);
      // This failed attempt's per-model outcome — carried into the fallback
      // so the eventual successful level emits it in the aggregate.
      const failedAttempt: ModelAttemptOutcome = {
        modelId: decision.model.id,
        taskType: task.type,
        status: "failed",
        stopCause: initialStopCause,
        providerFinishReason: finishReason,
        latencyMs: fallbackLatencyMs,
        costUsd: costTracker.getSessionCost() - sessionCostBefore,
      };
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
          // A forced tool-call is scoped to a single nudge retry; never carry
          // it into an unrelated fallback turn.
          _forceToolChoice: false,
          // Carry this failed attempt forward so the successful fallback level
          // emits the full attempt chain in its aggregate RunOutcome; mark
          // recovery=fallback there.
          _attemptsSoFar: [...(options._attemptsSoFar ?? []), failedAttempt],
          // Synthesis is once per logical run — a fallback model must not
          // synthesize again if this attempt already did.
          _synthesized: synthesisAttempted,
          // Preserve the run-cost baseline across the whole fallback chain.
          _runCostBaseline: options._runCostBaseline ?? sessionCostBefore,
        } as any);
        return;
      }
    }

    // All retries exhausted — yield structured error so caller can surface it.
    // Distinguish a genuinely empty turn from a truncated tool-call so the
    // operator knows whether the model said nothing or was cut off mid-action.
    if (shouldRetry) {
      yield {
        type: "fallback-exhausted" as const,
        modelsTried,
        reason: toolCallTruncated
          ? "All fallback models truncated their tool-call streams"
          : "All fallback models returned empty responses",
      };
    }

    // Extract gateway response headers (X-BR-*) for cost reconciliation and telemetry.
    // Use a timeout to prevent hanging if the response promise never resolves
    // (happens when the stream errored on the guardian SSE event).
    // Caller-owned timer so the abort listener is released once the race is
    // decided — otherwise it fires 5s later (on every turn where headers
    // resolved under 5s — i.e. almost every turn) and retains the closure.
    const HEADERS_TIMEOUT_MS = 5000;
    let headersTimedOut = false;
    const headersTimeoutController = new AbortController();
    const headersTimeoutTimer = setTimeout(
      () => headersTimeoutController.abort(),
      HEADERS_TIMEOUT_MS,
    );
    try {
      let response: Awaited<typeof result.response> | null;
      try {
        response = await Promise.race([
          result.response,
          new Promise<null>((resolve) => {
            headersTimeoutController.signal.addEventListener(
              "abort",
              () => {
                headersTimedOut = true;
                resolve(null);
              },
              { once: true },
            );
          }),
        ]);
      } finally {
        clearTimeout(headersTimeoutTimer);
      }
      if (headersTimedOut) {
        // Cost reconciliation is skipped for this turn — surface it instead of
        // silently dropping the gateway feedback.
        log.warn(
          { model: decision.model.id, timeoutMs: HEADERS_TIMEOUT_MS },
          "Gateway response headers timed out; cost reconciliation skipped",
        );
      } else if (response?.headers) {
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
    } catch (err) {
      // Gateway headers not available (local models) — non-fatal, but log for triage.
      log.debug(
        { err, model: decision.model.id },
        "Gateway headers unavailable",
      );
    }

    // Record routing outcome for Thompson sampling (in-memory + DB persistence)
    const turnLatencyMs = Date.now() - turnStartMs;
    const turnSuccess = !shouldRetry;
    const turnCost = costTracker.getSessionCost() - sessionCostBefore;

    // This attempt's per-model outcome (feeds routing learning). The aggregate
    // RunOutcome below stitches it onto any upstream failed attempts.
    const thisAttempt: ModelAttemptOutcome = {
      modelId: decision.model.id,
      taskType: task.type,
      status: turnSuccess ? "succeeded" : "failed",
      // Always the classified cause — a failed attempt that truncated /
      // hit output_limit / was capped keeps that evidence, not a blanket
      // empty_output.
      stopCause: initialStopCause,
      providerFinishReason: finishReason,
      latencyMs: turnLatencyMs,
      costUsd: turnCost,
    };

    // NOTE: momentum (router.recordSuccess) is deliberately NOT recorded here.
    // This point is BEFORE the Phase-7 tool-nudge and Phase-3 verify blocks,
    // which may `return` after recursing into a corrective re-run. Recording
    // momentum here would credit a turn that then gets nudged or fails
    // verification — and double-count with the recursive child's own momentum.
    // It is recorded once, at the true terminal (just before `done`), only when
    // no nudge/verify recursion took over. recordOutcome (Thompson, per-attempt)
    // DOES belong here — each model attempt is its own routing datapoint.
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

    // ── Phase 7: tool-use enforcement (narration → forced tool call) ────
    // A weak model may NARRATE a tool action ("Let me read config.ts") and
    // then stop WITHOUT emitting the call. Such a turn is not empty and not a
    // truncated tool-call, so it records as turnSuccess and would silently
    // complete. When enabled, and only when the turn (a) stopped on its own
    // (finishReason !== "tool-calls"), (b) made zero tool calls, (c) has tools
    // available to call, and (d) its text reads as an un-acted tool intent, we
    // push a corrective user-role nudge and RE-RUN with toolChoice="required"
    // so a real call is forced. Guards (mirroring the verify block below):
    //   - opt-in-safe: fires only on this failure state, DEFAULT enabled=true,
    //     so well-behaved models never trigger it (set enabled:false for exact
    //     legacy behavior),
    //   - bounded by maxNudges to prevent infinite re-prompting,
    //   - gated on remaining budget (same 20% threshold as verify/budget-warn),
    //   - placed BEFORE verify: a narrated turn wrote no files, so verify would
    //     skip it anyway — and only ONE recursion+return runs per turn, so the
    //     two corrective mechanisms cannot compound into an unbounded loop.
    const teEnabled =
      options.toolEnforcement?.enabled ??
      config.general?.toolEnforcement?.enabled ??
      true;
    const teMaxNudges =
      options.toolEnforcement?.maxNudges ??
      config.general?.toolEnforcement?.maxNudges ??
      2;
    const nudgeDepth = options._nudgeDepth ?? 0;

    if (
      teEnabled &&
      turnSuccess &&
      toolCallCount === 0 &&
      finishReason !== "tool-calls" &&
      !!finalTools &&
      nudgeDepth < teMaxNudges &&
      !options.signal?.aborted &&
      detectNarratedToolIntent(accumulatedText)
    ) {
      // Budget guard — a nudge is a full extra model turn. Reuse the same
      // 20%-remaining threshold verify/budget-warning use; skip rather than
      // risk blowing config.budget.perSession.
      const nudgeBudgetRemaining = costTracker.getRemainingBudget();
      const nudgeSessionLimit = (config.budget as any)?.perSession;
      const nudgeBudgetTooLow =
        nudgeBudgetRemaining !== null &&
        nudgeSessionLimit &&
        nudgeBudgetRemaining <= nudgeSessionLimit * 0.2;

      if (nudgeBudgetTooLow) {
        log.warn(
          {
            remaining: nudgeBudgetRemaining,
            sessionLimit: nudgeSessionLimit,
          },
          "tool-use nudge skipped — remaining budget below 20% threshold",
        );
      } else {
        const nextNudge = nudgeDepth + 1;
        log.info(
          {
            model: decision.model.id,
            iteration: nextNudge,
            maxNudges: teMaxNudges,
          },
          "Model narrated a tool action without calling it — nudging with forced tool call",
        );
        yield {
          type: "tool-nudge" as const,
          iteration: nextNudge,
          maxNudges: teMaxNudges,
        };
        // Feed the correction back as a user-role turn and re-run, mirroring
        // the verify self-recursion below. _forceToolChoice compels a real
        // call on the retry; it is scoped to that single re-entry (the verify
        // and fallback recursions explicitly clear it, so the model can still
        // finish normally afterwards).
        //
        // Do NOT force on the TERMINAL retry: when `nextNudge === teMaxNudges`
        // the re-entry can no longer nudge again (`nudgeDepth < teMaxNudges`
        // fails there), so whatever it emits is ACCEPTED as the turn's finish.
        // Forcing tools on that accepted turn would compel it into a tool call
        // and rob the model of a clean text answer. Only force while a further
        // corrective opportunity still remains.
        const forceOnRetry = nextNudge < teMaxNudges;
        messages.push({ role: "user", content: buildToolUseCorrection() });
        yield* runAgentLoop(messages, {
          ...options,
          _nudgeDepth: nextNudge,
          _forceToolChoice: forceOnRetry,
          _synthesized: synthesisAttempted,
          _runCostBaseline: options._runCostBaseline ?? sessionCostBefore,
          // Carry this invocation into the aggregate so the terminal run
          // outcome includes the nudge-superseded attempt, not just the final.
          _attemptsSoFar: [...(options._attemptsSoFar ?? []), thisAttempt],
        });
        return;
      }
    }

    // ── Phase 3: in-loop verify / self-correction ──────────────────────
    // After an edit-producing turn, verify the files the model just changed
    // (typecheck always; affected tests in "full" mode). On failure, feed the
    // diagnostics back as another turn so the model self-corrects WITHIN this
    // agentic run (Cline/OpenHands pattern; the single-agent analogue of the
    // Judge's verifyWorktree gate). Guards:
    //   - only when the turn actually changed files (a no-op turn skips it),
    //   - only when the model turn itself succeeded (never verify a failed turn),
    //   - bounded by verify.maxIterations to prevent infinite oscillation,
    //   - gated on remaining budget so self-correction can't blow perSession,
    //   - a verify pass that errors degrades to a skip (never crashes the turn).
    const verifyMode: VerifyMode =
      options.verify?.mode ?? config.general?.verify?.mode ?? "off";
    const verifyMaxIterations =
      options.verify?.maxIterations ??
      config.general?.verify?.maxIterations ??
      2;
    const verifyDepth = options._verifyDepth ?? 0;
    const changedThisTurn = Array.from(new Set(filesWritten));

    if (
      verifyMode !== "off" &&
      turnSuccess &&
      changedThisTurn.length > 0 &&
      verifyDepth < verifyMaxIterations &&
      !options.signal?.aborted
    ) {
      // Budget guard — each verify-fix is a full extra model turn. Reuse the
      // same 20%-remaining threshold the budget-warning uses above; if we're
      // under it, skip verify rather than risk blowing config.budget.perSession.
      const verifyBudgetRemaining = costTracker.getRemainingBudget();
      const verifySessionLimit = (config.budget as any)?.perSession;
      const budgetTooLow =
        verifyBudgetRemaining !== null &&
        verifySessionLimit &&
        verifyBudgetRemaining <= verifySessionLimit * 0.2;

      if (budgetTooLow) {
        log.warn(
          {
            remaining: verifyBudgetRemaining,
            sessionLimit: verifySessionLimit,
          },
          "verify skipped — remaining budget below 20% threshold",
        );
      } else {
        const outcome = runVerifyPass(
          changedThisTurn,
          verifyMode,
          { projectPath: options.projectPath, signal: options.signal },
          options._verifyRunner,
        );

        if (outcome.ran && !outcome.ok) {
          const nextIteration = verifyDepth + 1;
          const isFinalAttempt = nextIteration >= verifyMaxIterations;
          yield {
            type: "verify-failed" as const,
            iteration: nextIteration,
            maxIterations: verifyMaxIterations,
            diagnostics: outcome.diagnostics,
          };
          // Feed diagnostics back as a user-role correction turn and recurse,
          // mirroring the fallback self-recursion at the top of this function.
          messages.push({
            role: "user",
            content: formatVerifyDiagnostic(
              outcome,
              verifyMode,
              isFinalAttempt,
            ),
          });
          // Checkpoint THIS turn's edits before recursing. The outer invocation
          // returns right after the recursive yield*, so without this the
          // original turn's filesWritten are never persisted and crash-recovery/
          // undo would under-report the edits (only the final correction's files
          // would survive). Mirrors the checkpointer.saveIfNeeded below.
          if (options.checkpointer) {
            options.checkpointer.saveIfNeeded({
              sessionId,
              turnNumber: Math.floor(Date.now() / 1000),
              conversationHistory: messages,
              scratchpad: {},
              filesRead,
              filesWritten,
              buildStatus: options.buildState?.getStatus() ?? "unknown",
              totalCost: costTracker.getSessionCost(),
              projectPath: options.projectPath,
            });
          }
          yield* runAgentLoop(messages, {
            ...options,
            _verifyDepth: nextIteration,
            // Forced tool-call is scoped to the nudge retry only — don't leak
            // it into a verify self-correction turn.
            _forceToolChoice: false,
            _synthesized: synthesisAttempted,
            _runCostBaseline: options._runCostBaseline ?? sessionCostBefore,
            // Include this verify-superseded attempt in the aggregate chain.
            _attemptsSoFar: [...(options._attemptsSoFar ?? []), thisAttempt],
          });
          return;
        }

        if (outcome.ran && outcome.ok) {
          yield {
            type: "verify-passed" as const,
            iteration: verifyDepth,
            mode: verifyMode === "full" ? "full" : "typecheck",
          };
        }
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

    // Aggregate outcome: this attempt stitched onto any upstream failed
    // fallback attempts. initialStopCause is the FIRST attempt's cause (the
    // upstream one if this is a fallback re-entry), so a recovered run doesn't
    // masquerade as a clean first stop. verification/security/judge are left
    // not_run here; wiring their live results into the outcome is a follow-on
    // (the contract + termination/recovery/cost are established this iteration).
    const allAttempts = [...(options._attemptsSoFar ?? []), thisAttempt];
    // If earlier attempts failed and this one succeeded, the run recovered via
    // fallback (unless it already recovered via forced synthesis this turn).
    const aggregateRecovery: RunOutcome["recovery"] =
      recovery ??
      (turnSuccess && (options._attemptsSoFar?.length ?? 0) > 0
        ? "fallback"
        : undefined);
    const runOutcome: RunOutcome = {
      status: turnSuccess ? "succeeded" : "failed",
      attempts: allAttempts,
      finalModelId: turnSuccess ? decision.model.id : undefined,
      initialStopCause: allAttempts[0]?.stopCause ?? initialStopCause,
      recovery: aggregateRecovery,
      hasFinalResponse,
      madeChanges: filesWritten.length > 0,
      verification: "not_run",
      security: "not_run",
      judge: "not_run",
      // Run delta, not the cumulative session total (a long-lived caller
      // reuses the tracker across runs). Baseline captured at the root.
      costUsd:
        costTracker.getSessionCost() -
        (options._runCostBaseline ?? sessionCostBefore),
    };

    // Momentum: record ONLY here, at the true terminal. Reaching this point
    // means no Phase-7 nudge / Phase-3 verify recursion took over (those
    // `return` after recursing), so this attempt is the final accepted one —
    // and only credit it if the run actually produced a usable result.
    if (runOutcome.status === "succeeded") {
      router.recordSuccess?.(decision.model.id, task.type);
    }

    yield {
      type: "done",
      totalCost: costTracker.getSessionCost(),
      totalTokens: costTracker.getSessionTokens(),
      outcome: runOutcome,
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
