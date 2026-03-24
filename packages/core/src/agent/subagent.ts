import { streamText, stepCountIs } from 'ai';
import type { BrainstormConfig } from '@brainstorm/config';
import type { ProviderRegistry } from '@brainstorm/providers';
import { BrainstormRouter, CostTracker } from '@brainstorm/router';
import type { ToolRegistry } from '@brainstorm/tools';
import { serializeRoutingMetadata } from '@brainstorm/shared';

export interface SubagentOptions {
  config: BrainstormConfig;
  registry: ProviderRegistry;
  router: BrainstormRouter;
  costTracker: CostTracker;
  tools: ToolRegistry;
  projectPath: string;
  /** System prompt override for the subagent. */
  systemPrompt?: string;
  /** Max steps for the subagent (default: 5, keeps it focused). */
  maxSteps?: number;
}

export interface SubagentResult {
  text: string;
  cost: number;
  modelUsed: string;
  toolCalls: string[];
}

/**
 * Spawn an isolated subagent for a focused task.
 *
 * Subagents get their own context — they don't see the parent conversation.
 * This prevents context bloat while enabling parallel work.
 * BrainstormRouter routes subagents to cheaper models (they're simpler tasks).
 */
export async function spawnSubagent(
  task: string,
  options: SubagentOptions,
): Promise<SubagentResult> {
  const { router, costTracker, tools, config, registry, projectPath } = options;

  const taskProfile = router.classify(task);
  const decision = router.route(taskProfile);

  const modelId = registry.getProvider(decision.model.id);
  const systemPrompt = options.systemPrompt ??
    'You are a focused subagent. Complete the given task concisely and return the result. Do not ask questions — make your best judgment.';

  const costBefore = costTracker.getSessionCost();
  const toolCallNames: string[] = [];
  let fullText = '';

  // Serialize task context for gateway telemetry (x-br-metadata header)
  const metadataHeader = serializeRoutingMetadata(taskProfile, decision);

  const result = streamText({
    model: modelId,
    system: systemPrompt,
    messages: [{ role: 'user' as const, content: task }],
    tools: tools.toAISDKTools(),
    ...(metadataHeader ? { headers: { 'x-br-metadata': metadataHeader } } : {}),
    stopWhen: stepCountIs(options.maxSteps ?? 5),
    onStepFinish: async ({ usage }: any) => {
      if (usage) {
        costTracker.record({
          sessionId: 'subagent',
          modelId: decision.model.id,
          provider: decision.model.provider,
          inputTokens: usage.inputTokens ?? 0,
          outputTokens: usage.outputTokens ?? 0,
          taskType: taskProfile.type,
          projectPath,
          pricing: decision.model.pricing,
        });
      }
    },
  });

  for await (const part of result.fullStream) {
    if (part.type === 'text-delta') {
      fullText += (part as any).text ?? '';
    } else if (part.type === 'tool-call') {
      toolCallNames.push(part.toolName);
    }
  }

  return {
    text: fullText,
    cost: costTracker.getSessionCost() - costBefore,
    modelUsed: decision.model.name,
    toolCalls: toolCallNames,
  };
}
