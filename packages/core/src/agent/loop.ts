import { streamText, stepCountIs } from 'ai';
import type { ConversationMessage } from '../session/manager.js';
import type { BrainstormConfig } from '@brainstorm/config';
import type { ProviderRegistry } from '@brainstorm/providers';
import { BrainstormRouter, CostTracker } from '@brainstorm/router';
import type { ToolRegistry } from '@brainstorm/tools';
import { setTaskEventHandler, clearTasks } from '@brainstorm/tools';
import type { AgentEvent, GatewayFeedbackData } from '@brainstorm/shared';
import { serializeRoutingMetadata } from '@brainstorm/shared';
import { createStreamFilter } from './response-filter.js';
import { normalizeInsightMarkers } from './insights.js';
import { parseGatewayHeaders } from '@brainstorm/gateway';

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
}

// Task types that should NOT get tools (pure text generation)
const NO_TOOL_TASKS = new Set(['explanation', 'conversation', 'analysis']);

export async function* runAgentLoop(
  messages: ConversationMessage[],
  options: AgentLoopOptions,
): AsyncGenerator<AgentEvent> {
  const { router, costTracker, tools, config, sessionId, systemPrompt } = options;

  // Reset task state and wire event handler for this invocation
  clearTasks();
  const taskEventQueue: AgentEvent[] = [];
  setTaskEventHandler((type, task) => {
    taskEventQueue.push({ type, task } as AgentEvent);
  });

  // Classify from the last user message
  const lastUserMsg = [...messages].reverse().find((m) => m.role === 'user');
  const userText = lastUserMsg?.content ?? '';

  const task = router.classify(userText);
  const conversationTokens = options.compaction?.getTokenEstimate() ?? 0;
  const decision = options.preferredModelId
    ? { ...router.route(task, conversationTokens), model: options.registry.getModel(options.preferredModelId) ?? router.route(task, conversationTokens).model, reason: `Cross-model workflow override: ${options.preferredModelId}` }
    : router.route(task, conversationTokens);

  yield { type: 'routing', decision };

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

  // Only provide tools when the task needs them and they're not disabled
  const shouldUseTools = !options.disableTools && task.requiresToolUse && !NO_TOOL_TASKS.has(task.type);

  // Serialize task context for gateway telemetry (x-br-metadata header)
  const metadataHeader = serializeRoutingMetadata(task, decision);

  try {
    const result = streamText({
      model: modelId,
      system: systemPrompt,
      messages: messages as any,
      ...(shouldUseTools ? { tools: tools.toAISDKTools() } : {}),
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

    for await (const part of result.fullStream) {
      if (part.type === 'reasoning-delta') {
        const content = (part as any).text ?? (part as any).delta ?? '';
        if (content) yield { type: 'reasoning', content };
      } else if (part.type === 'text-delta') {
        const raw = (part as any).text ?? (part as any).delta ?? '';
        const filtered = streamFilter.filter(raw);
        if (filtered) yield { type: 'text-delta', delta: normalizeInsightMarkers(filtered) };
      } else if (part.type === 'tool-call') {
        yield { type: 'tool-call-start', toolName: part.toolName, args: (part as any).input ?? (part as any).args };
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

    // Flush any remaining buffered content (critical for short responses < 80 chars)
    const remaining = streamFilter.flush();
    if (remaining) yield { type: 'text-delta', delta: normalizeInsightMarkers(remaining) };

    // Extract gateway response headers (X-BR-*) for cost reconciliation and telemetry
    try {
      const response = await result.response;
      if (response.headers) {
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

    yield { type: 'done', totalCost: costTracker.getSessionCost(), totalTokens: costTracker.getSessionTokens() };
  } catch (error: any) {
    // AbortError means the user cancelled — yield interrupted, not error
    if (error.name === 'AbortError' || options.signal?.aborted) {
      yield { type: 'interrupted' };
    } else {
      router.recordFailure(decision.model.id, error.message);
      yield { type: 'error', error };
    }
  } finally {
    setTaskEventHandler(null);
  }
}
