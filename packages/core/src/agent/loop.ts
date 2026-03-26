import { streamText, stepCountIs } from "ai";
import type { ConversationMessage } from "../session/manager.js";
import type { BrainstormConfig } from "@brainstorm/config";
import type { ProviderRegistry } from "@brainstorm/providers";
import { BrainstormRouter, CostTracker } from "@brainstorm/router";
import type { ToolRegistry, PermissionCheckFn } from "@brainstorm/tools";
import {
  setTaskEventHandler,
  clearTasks,
  setBackgroundEventHandler,
  getToolHealthTracker,
  setToolOutputHandler,
  getTierForComplexity,
  getToolsForTier,
} from "@brainstorm/tools";
import {
  createLogger,
  type AgentEvent,
  type GatewayFeedbackData,
  type ModelEntry,
  type TurnContext,
} from "@brainstorm/shared";
import type { BuildStateTracker } from "./build-state.js";
import { LoopDetector } from "./loop-detector.js";
import { serializeRoutingMetadata } from "@brainstorm/shared";
import { createStreamFilter } from "./response-filter.js";
import { normalizeInsightMarkers } from "./insights.js";
import { parseGatewayHeaders } from "@brainstorm/gateway";
import type { MiddlewarePipeline } from "../middleware/pipeline.js";
import { TrajectoryRecorder } from "../session/trajectory.js";
import { predictTaskCost } from "./cost-predictor.js";
import { detectTone, toneGuidance } from "./sentiment.js";
import { shouldUseEnsemble } from "./ensemble.js";

const log = createLogger("agent-loop");

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
  /** Enable trajectory recording to JSONL. */
  trajectoryEnabled?: boolean;
  /** Session checkpointer for crash recovery. */
  checkpointer?: { saveIfNeeded: (data: any) => boolean };
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

  // Initialize trajectory recorder if enabled
  const sessionStartTime = Date.now();
  const trajectory = options.trajectoryEnabled
    ? new TrajectoryRecorder(sessionId)
    : null;
  trajectory?.recordSessionStart({
    projectPath: options.projectPath,
    systemPrompt: systemPrompt.slice(0, 200),
  });

  // Reset task state and wire event handlers for this invocation
  clearTasks();
  const taskEventQueue: AgentEvent[] = [];
  setTaskEventHandler((type, task) => {
    taskEventQueue.push({ type, task } as AgentEvent);
  });

  // Wire background task completion events into the same queue
  setBackgroundEventHandler((event) => {
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
    taskEventQueue.push({
      type: "tool-output-partial",
      toolName: event.toolName,
      chunk: event.chunk,
    } as AgentEvent);
  });

  // Run middleware beforeAgent hook (if pipeline provided)
  if (options.middleware) {
    const mwState = {
      turn: 0,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      systemPrompt,
      toolNames: [],
      metadata: {},
    };
    options.middleware.runBeforeAgent(mwState);
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
  const decision = options.preferredModelId
    ? {
        ...router.route(task, conversationTokens),
        model:
          options.registry.getModel(options.preferredModelId) ??
          router.route(task, conversationTokens).model,
        reason: `Cross-model workflow override: ${options.preferredModelId}`,
      }
    : router.route(task, conversationTokens);

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
      const compactionResult = await options.compaction.compact({
        contextWindow,
        keepRecent: config.compaction?.keepRecent ?? 5,
      });
      if (compactionResult.compacted) {
        yield {
          type: "compaction",
          removed: compactionResult.removed,
          tokensBefore: compactionResult.tokensBefore,
          tokensAfter: compactionResult.tokensAfter,
        };
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
  const tierToolNames = useFullTools ? undefined : getToolsForTier(toolTier);

  // Build tools with permission gating if a check function is provided
  const aiTools = shouldUseTools
    ? options.permissionCheck
      ? tools.toAISDKToolsWithPermissions(
          options.permissionCheck,
          tierToolNames,
        )
      : tierToolNames
        ? tools.toAISDKToolsFiltered(tierToolNames)
        : tools.toAISDKTools()
    : undefined;

  // Serialize task context for gateway telemetry (x-br-metadata header)
  const metadataHeader = serializeRoutingMetadata(task, decision);

  try {
    const result = streamText({
      model: modelId,
      system: systemPrompt,
      messages: messages as any,
      ...(aiTools ? { tools: aiTools } : {}),
      ...(metadataHeader
        ? { headers: { "x-br-metadata": metadataHeader } }
        : {}),
      ...(options.signal ? { abortSignal: options.signal } : {}),
      stopWhen: stepCountIs(
        shouldUseTools ? (options.maxSteps ?? config.general.maxSteps) : 1,
      ),
      onStepFinish: async ({ usage }: any) => {
        if (usage) {
          costTracker.record({
            sessionId,
            modelId: decision.model.id,
            provider: decision.model.provider,
            inputTokens: usage.inputTokens ?? 0,
            outputTokens: usage.outputTokens ?? 0,
            taskType: task.type,
            projectPath: options.projectPath,
            pricing: decision.model.pricing,
          });
        }
      },
    });

    // Apply response filter to strip LLM filler from the beginning of text output
    const streamFilter = createStreamFilter();
    let textDeltaCount = 0;
    let toolCallCount = 0;
    let hasToolBlocked = false;
    let lastEventTime = Date.now();
    const toolCallResults: Array<{ name: string; ok: boolean }> = [];
    const filesRead: string[] = [];
    const filesWritten: string[] = [];
    const loopDetector = new LoopDetector();
    const STREAM_TIMEOUT_MS = 60_000; // 60s without any SSE event = dead stream

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
          const content = (part as any).text ?? (part as any).delta ?? "";
          if (content) yield { type: "reasoning" as const, content };
        } else if (part.type === "text-delta") {
          textDeltaCount++;
          const raw = (part as any).text ?? (part as any).delta ?? "";
          if (raw.includes("[TOOL BLOCKED]")) hasToolBlocked = true;
          const filtered = streamFilter.filter(raw);
          if (filtered)
            yield {
              type: "text-delta" as const,
              delta: normalizeInsightMarkers(filtered),
            };
        } else if (part.type === "tool-call") {
          toolCallCount++;
          yield {
            type: "tool-call-start" as const,
            toolName: part.toolName,
            args: (part as any).input ?? (part as any).args,
          };
        } else if (part.type === "tool-result") {
          const toolResult = (part as any).output ?? (part as any).result;
          // Track tool call success/failure for turn context
          const toolOk = !(
            toolResult &&
            typeof toolResult === "object" &&
            (toolResult.error || toolResult.ok === false)
          );
          toolCallResults.push({ name: part.toolName, ok: toolOk });
          // Track file access for turn context
          if (part.toolName === "file_read" && toolOk) {
            const path = (part as any).input?.path ?? (part as any).args?.path;
            if (path) filesRead.push(path);
          } else if (
            (part.toolName === "file_write" || part.toolName === "file_edit") &&
            toolOk
          ) {
            const path = (part as any).input?.path ?? (part as any).args?.path;
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
              (part as any).input?.command ?? (part as any).args?.command ?? "";
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
          const toolPath =
            (part as any).input?.path ?? (part as any).args?.path;
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
        throw streamErr; // Re-throw real errors
      }
    }

    // Flush any remaining buffered content (critical for short responses < 80 chars)
    const remaining = streamFilter.flush();
    if (remaining)
      yield { type: "text-delta", delta: normalizeInsightMarkers(remaining) };

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
    // Build fallback list: use decision.fallbacks, or generate from registry if empty
    let fallbacks = decision.fallbacks;
    if (fallbacks.length === 0 && isEmpty) {
      // When BR Auto returns empty, construct fallbacks from explicit models in the registry
      const RETRY_MODELS = [
        "anthropic/claude-sonnet-4.5-20250929",
        "openai/gpt-4.1",
        "anthropic/claude-haiku-4.5-20251001",
      ];
      fallbacks = RETRY_MODELS.filter((id) => id !== decision.model.id)
        .map((id) => options.registry.getModel(id))
        .filter((m): m is ModelEntry => m != null && m.status === "available");
    }

    const MAX_FALLBACK_DEPTH = 2;
    const retryDepth = options._retryDepth ?? 0;
    const modelsTried = [...(options._modelsTried ?? []), decision.model.id];

    if (isEmpty && fallbacks.length > 0 && retryDepth < MAX_FALLBACK_DEPTH) {
      const reason = isEmpty ? "empty_response" : "tool_blocked";
      router.recordFailure(decision.model.id, reason);
      // Pick next fallback that hasn't been tried yet
      const fallbackModel = fallbacks.find((f) => !modelsTried.includes(f.id));
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

    // Inject turn context for next turn's self-awareness
    if (options.onTurnComplete) {
      const turnCost = costTracker.getSessionCost(); // approximate per-turn
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
      options.checkpointer.saveIfNeeded({
        sessionId,
        turnNumber: 0, // caller sets actual turn
        conversationHistory: messages,
        scratchpad: {},
        filesRead: [],
        filesWritten: [],
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
    // AbortError means the user cancelled — yield interrupted, not error
    if (error.name === "AbortError" || options.signal?.aborted) {
      yield { type: "interrupted" };
    } else {
      router.recordFailure(decision.model.id, error.message);
      // Wrap raw API errors with actionable messages
      const enriched = enrichError(error, decision.model.id);
      yield { type: "error", error: enriched };
    }
  } finally {
    setTaskEventHandler(null);
    setToolOutputHandler(null);
    // Keep background handler alive — background tasks outlive individual agent loop runs

    // Submit trajectory to BR Intelligence API (fire-and-forget)
    if (trajectory) {
      trajectory.recordSessionEnd({
        totalCost: costTracker.getSessionCost(),
        totalTurns: 1, // caller tracks actual turns
        durationMs: Date.now() - sessionStartTime,
      });

      // Async submission — don't block session exit
      import("../session/trajectory.js").catch((e) => {
        log.warn(
          { err: e },
          "Failed to load trajectory module for intelligence submission",
        );
      });
    }
  }
}
