import { streamText, stepCountIs } from 'ai';
import type { ConversationMessage } from '../session/manager.js';
import type { BrainstormConfig } from '@brainstorm/config';
import type { ProviderRegistry } from '@brainstorm/providers';
import { BrainstormRouter, CostTracker } from '@brainstorm/router';
import type { ToolRegistry } from '@brainstorm/tools';
import { setTaskEventHandler } from '@brainstorm/tools';
import type { AgentEvent, AgentTask, GatewayFeedbackData } from '@brainstorm/shared';
import { serializeRoutingMetadata } from '@brainstorm/shared';
import { createStreamFilter } from './response-filter.js';
import { normalizeInsightMarkers } from './insights.js';
import { parseGatewayHeaders } from '@brainstorm/gateway';

// Suppress AI SDK warnings in non-debug mode
if (!process.env.BRAINSTORM_LOG_LEVEL) {
  (globalThis as any).AI_SDK_LOG_WARNINGS = false;
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
}

// Task types that should NOT get tools (pure text generation)
const NO_TOOL_TASKS = new Set(['explanation', 'conversation', 'analysis']);

export async function* runAgentLoop(
  messages: ConversationMessage[],
  options: AgentLoopOptions,
): AsyncGenerator<AgentEvent> {
  const { router, costTracker, tools, config, sessionId, systemPrompt } = options;

  // Wire task event handler so task_create/task_update yield events to the TUI
  const taskEventQueue: AgentEvent[] = [];
  setTaskEventHandler((type, task) => {
    taskEventQueue.push({ type, task } as AgentEvent);
  });

  // Classify from the last user message
  const lastUserMsg = [...messages].reverse().find((m) => m.role === 'user');
  const userText = lastUserMsg?.content ?? '';

  const task = router.classify(userText);
  const decision = options.preferredModelId
    ? { ...router.route(task), model: options.registry.getModel(options.preferredModelId) ?? router.route(task).model, reason: `Cross-model workflow override: ${options.preferredModelId}` }
    : router.route(task);

  yield { type: 'routing', decision };

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
      if (part.type === 'text-delta') {
        const raw = (part as any).text ?? (part as any).delta ?? '';
        const filtered = streamFilter.filter(raw);
        if (filtered) yield { type: 'text-delta', delta: normalizeInsightMarkers(filtered) };
      } else if (part.type === 'tool-call') {
        yield { type: 'tool-call-start', toolName: part.toolName, args: (part as any).input ?? (part as any).args };
      } else if (part.type === 'tool-result') {
        yield { type: 'tool-call-result', toolName: part.toolName, result: (part as any).output ?? (part as any).result };
        // Drain any task events queued by task_create/task_update tool executions
        while (taskEventQueue.length > 0) {
          yield taskEventQueue.shift()!;
        }
      }
    }

    // Flush any remaining buffered content (critical for short responses < 80 chars)
    const remaining = streamFilter.flush();
    if (remaining) yield { type: 'text-delta', delta: remaining };

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

    yield { type: 'done', totalCost: costTracker.getSessionCost() };
  } catch (error: any) {
    router.recordFailure(decision.model.id, error.message);
    yield { type: 'error', error };
  }
}
