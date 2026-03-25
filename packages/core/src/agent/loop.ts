import { streamText, stepCountIs } from 'ai';
import type { ConversationMessage } from '../session/manager.js';
import type { BrainstormConfig } from '@brainstorm/config';
import type { ProviderRegistry } from '@brainstorm/providers';
import { BrainstormRouter, CostTracker } from '@brainstorm/router';
import type { ToolRegistry, PermissionCheckFn } from '@brainstorm/tools';
import { setTaskEventHandler, clearTasks, setBackgroundEventHandler } from '@brainstorm/tools';
import type { AgentEvent, GatewayFeedbackData, ModelEntry } from '@brainstorm/shared';
import { serializeRoutingMetadata } from '@brainstorm/shared';
import { createStreamFilter } from './response-filter.js';
import { normalizeInsightMarkers } from './insights.js';
import { parseGatewayHeaders } from '@brainstorm/gateway';

/**
 * Enrich raw API errors with actionable user-facing messages.
 * The original error is preserved; the message is replaced with a helpful one.
 */
function enrichError(error: any, modelId: string): Error {
  const msg = error.message ?? '';
  const status = error.statusCode ?? error.status;

  // Budget exceeded
  if (msg.includes('Budget exceeded') || msg.includes('budget_exceeded')) {
    const match = msg.match(/Limit: \$([\d.]+)/);
    const limit = match?.[1] ?? '?';
    error.message = `Daily budget exceeded ($${limit}). Increase with: curl -X PUT api.brainstormrouter.com/v1/budget/limits -d '{"daily_limit_usd": 50}'`;
    return error;
  }

  // Rate limited
  if (status === 429 || msg.includes('rate limit') || msg.includes('community_limit')) {
    error.message = `Rate limited. ${msg.includes('community') ? 'Community plan: 5 req/min. Set BRAINSTORM_API_KEY for full access.' : 'Wait a moment and retry.'}`;
    return error;
  }

  // Model not available
  if (msg.includes('model_not_allowed') || msg.includes('not available on the community plan')) {
    error.message = `Model not available on your plan. Try: storm run --model deepseek/deepseek-chat, or set a paid API key with: storm vault add BRAINSTORM_API_KEY`;
    return error;
  }

  // Auth failure
  if (status === 401 || msg.includes('Unauthorized') || msg.includes('invalid_api_key')) {
    error.message = `Authentication failed. Check your API key: storm vault status. Or get a key at brainstormrouter.com`;
    return error;
  }

  // Network/connectivity
  if (msg.includes('fetch failed') || msg.includes('ECONNREFUSED') || msg.includes('ETIMEDOUT')) {
    error.message = `Cannot reach BrainstormRouter. Check your internet connection. Gateway: api.brainstormrouter.com`;
    return error;
  }

  // Fallback: keep original but add model context
  if (!msg.includes(modelId)) {
    error.message = `[${modelId}] ${msg}`;
  }
  return error;
}

// Suppress AI SDK warnings in non-debug mode
if (!process.env.BRAINSTORM_LOG_LEVEL) {
  (globalThis as any).AI_SDK_LOG_WARNINGS = false;
}

export interface CompactionCallbacks {
  /** Current estimated token count of conversation history. */
  getTokenEstimate: () => number;
  /** Run compaction on the conversation. Returns compaction result. */
  compact: (options: { contextWindow: number; keepRecent?: number; summarizeModel?: any }) => Promise<{
    compacted: boolean; removed: number; tokensBefore: number; tokensAfter: number; summaryCost: number;
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
  /** Internal: marks this as a retry attempt to prevent infinite recursion. */
  _retryAttempt?: boolean;
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
  const { router, costTracker, tools, config, sessionId, systemPrompt } = options;

  // Reset task state and wire event handlers for this invocation
  clearTasks();
  const taskEventQueue: AgentEvent[] = [];
  setTaskEventHandler((type, task) => {
    taskEventQueue.push({ type, task } as AgentEvent);
  });

  // Wire background task completion events into the same queue
  setBackgroundEventHandler((event) => {
    taskEventQueue.push({
      type: 'background-complete',
      taskId: event.taskId,
      command: event.command,
      exitCode: event.exitCode,
      stdout: event.stdout,
      stderr: event.stderr,
    } as AgentEvent);
  });

  // Phase: classifying
  yield { type: 'thinking' as const, phase: 'classifying' as const };
  const lastUserMsg = [...messages].reverse().find((m) => m.role === 'user');
  const userText = lastUserMsg?.content ?? '';
  const task = router.classify(userText);

  // Phase: routing
  yield { type: 'thinking' as const, phase: 'routing' as const };
  const conversationTokens = options.compaction?.getTokenEstimate() ?? 0;
  const decision = options.preferredModelId
    ? { ...router.route(task, conversationTokens), model: options.registry.getModel(options.preferredModelId) ?? router.route(task, conversationTokens).model, reason: `Cross-model workflow override: ${options.preferredModelId}` }
    : router.route(task, conversationTokens);

  yield { type: 'routing', decision };

  // Phase: connecting
  yield { type: 'thinking' as const, phase: 'connecting' as const };

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
          type: 'compaction',
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

  // Build tools with permission gating if a check function is provided
  const aiTools = shouldUseTools
    ? (options.permissionCheck
      ? tools.toAISDKToolsWithPermissions(options.permissionCheck)
      : tools.toAISDKTools())
    : undefined;

  // Serialize task context for gateway telemetry (x-br-metadata header)
  const metadataHeader = serializeRoutingMetadata(task, decision);

  try {
    const result = streamText({
      model: modelId,
      system: systemPrompt,
      messages: messages as any,
      ...(aiTools ? { tools: aiTools } : {}),
      ...(metadataHeader ? { headers: { 'x-br-metadata': metadataHeader } } : {}),
      ...(options.signal ? { abortSignal: options.signal } : {}),
      stopWhen: stepCountIs(shouldUseTools ? (options.maxSteps ?? config.general.maxSteps) : 1),
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
    const STREAM_TIMEOUT_MS = 60_000; // 60s without any SSE event = dead stream

    try {
      for await (const part of result.fullStream) {
        // Detect hung streams: if no event for 60s, break out
        const now = Date.now();
        if (now - lastEventTime > STREAM_TIMEOUT_MS && textDeltaCount === 0 && toolCallCount === 0) {
          break; // Fall through to empty detection + retry
        }
        lastEventTime = now;
        if (part.type === 'reasoning-delta') {
          const content = (part as any).text ?? (part as any).delta ?? '';
          if (content) yield { type: 'reasoning' as const, content };
        } else if (part.type === 'text-delta') {
          textDeltaCount++;
          const raw = (part as any).text ?? (part as any).delta ?? '';
          if (raw.includes('[TOOL BLOCKED]')) hasToolBlocked = true;
          const filtered = streamFilter.filter(raw);
          if (filtered) yield { type: 'text-delta' as const, delta: normalizeInsightMarkers(filtered) };
        } else if (part.type === 'tool-call') {
          toolCallCount++;
          yield { type: 'tool-call-start' as const, toolName: part.toolName, args: (part as any).input ?? (part as any).args };
        } else if (part.type === 'tool-result') {
          const toolResult = (part as any).output ?? (part as any).result;
          yield { type: 'tool-call-result', toolName: part.toolName, result: toolResult };
          // Emit subagent-result events for TUI display
          if (part.toolName === 'subagent' && toolResult && typeof toolResult === 'object') {
            if (toolResult.mode === 'single') {
              yield { type: 'subagent-result', subagentType: toolResult.type, model: toolResult.model, cost: toolResult.cost, toolCalls: toolResult.toolCalls };
            } else if (toolResult.mode === 'parallel' && Array.isArray(toolResult.results)) {
              for (const r of toolResult.results) {
                yield { type: 'subagent-result', subagentType: r.type, model: r.model, cost: r.cost, toolCalls: r.toolCalls };
              }
            }
          }
          // Drain any task events queued by task_create/task_update tool executions
          while (taskEventQueue.length > 0) {
            yield taskEventQueue.shift()!;
          }
          // Check for abort between tool executions
          if (options.signal?.aborted) {
            yield { type: 'interrupted' };
            return;
          }
        }
      }
    } catch (streamErr: any) {
      // BrainstormRouter sends a guardian SSE event after [DONE] that the AI SDK
      // can't parse (TypeValidationError). This is non-fatal — all content and
      // tool calls have already been yielded. Swallow validation errors silently.
      if (streamErr.name !== 'AI_TypeValidationError' && !streamErr.message?.includes('Type validation failed')) {
        throw streamErr; // Re-throw real errors
      }
    }

    // Flush any remaining buffered content (critical for short responses < 80 chars)
    const remaining = streamFilter.flush();
    if (remaining) yield { type: 'text-delta', delta: normalizeInsightMarkers(remaining) };

    // ── Empty/blocked response detection + retry with fallback model ──
    const isEmpty = textDeltaCount === 0 && toolCallCount === 0;
    // Build fallback list: use decision.fallbacks, or generate from registry if empty
    let fallbacks = decision.fallbacks;
    if (fallbacks.length === 0 && (isEmpty)) {
      // When BR Auto returns empty, construct fallbacks from explicit models in the registry
      const RETRY_MODELS = ['anthropic/claude-sonnet-4-5-20250929', 'openai/gpt-4.1', 'anthropic/claude-haiku-4-5-20251001'];
      fallbacks = RETRY_MODELS
        .filter((id) => id !== decision.model.id)
        .map((id) => options.registry.getModel(id))
        .filter((m): m is ModelEntry => m != null && m.status === 'available');
    }

    if ((isEmpty) && fallbacks.length > 0 && !options._retryAttempt) {
      const reason = isEmpty ? 'empty_response' : 'tool_blocked';
      router.recordFailure(decision.model.id, reason);
      const fallbackModel = fallbacks[0];
      yield { type: 'model-retry' as const, fromModel: decision.model.id, toModel: fallbackModel.id, reason };

      // Retry with fallback model — recurse with _retryAttempt flag to prevent infinite loop
      yield* runAgentLoop(messages, {
        ...options,
        preferredModelId: fallbackModel.id,
        _retryAttempt: true,
      } as any);
      return;
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
          yield { type: 'gateway-feedback', feedback: feedback as GatewayFeedbackData };

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

    yield { type: 'done', totalCost: costTracker.getSessionCost(), totalTokens: costTracker.getSessionTokens() };
  } catch (error: any) {
    // AbortError means the user cancelled — yield interrupted, not error
    if (error.name === 'AbortError' || options.signal?.aborted) {
      yield { type: 'interrupted' };
    } else {
      router.recordFailure(decision.model.id, error.message);
      // Wrap raw API errors with actionable messages
      const enriched = enrichError(error, decision.model.id);
      yield { type: 'error', error: enriched };
    }
  } finally {
    setTaskEventHandler(null);
    // Keep background handler alive — background tasks outlive individual agent loop runs
  }
}
