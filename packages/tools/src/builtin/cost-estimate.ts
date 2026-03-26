import { z } from 'zod';
import { defineTool } from '../base.js';

/**
 * Cost Estimate Tool — show estimated costs for different model tiers.
 * Used by the agent before expensive operations to negotiate with the user.
 */

export const costEstimateTool = defineTool({
  name: 'cost_estimate',
  description: 'Show estimated cost for a task across model tiers (quality, balanced, cheap). Use before expensive operations (>$0.10 estimated) to let the user choose. Returns estimates per tier. Then use ask_user to present choices and set_routing_hint based on their answer.',
  permission: 'auto',
  inputSchema: z.object({
    estimatedInputTokens: z.number().describe('Estimated input tokens for the task'),
    estimatedOutputTokens: z.number().describe('Estimated output tokens for the task'),
    taskDescription: z.string().describe('Brief description of what the task involves'),
  }),
  async execute({ estimatedInputTokens, estimatedOutputTokens, taskDescription }) {
    // Tier pricing estimates (approximate, based on common model pricing)
    const tiers = [
      {
        tier: 'quality',
        models: 'Claude Sonnet 4, GPT-4.1',
        inputPer1M: 3.0,
        outputPer1M: 15.0,
      },
      {
        tier: 'balanced',
        models: 'Claude Haiku, GPT-4.1-mini',
        inputPer1M: 0.80,
        outputPer1M: 4.0,
      },
      {
        tier: 'cheap',
        models: 'GPT-4.1-nano, Gemini Flash',
        inputPer1M: 0.10,
        outputPer1M: 0.40,
      },
    ];

    const estimates = tiers.map((t) => {
      const cost = (estimatedInputTokens / 1_000_000) * t.inputPer1M +
                   (estimatedOutputTokens / 1_000_000) * t.outputPer1M;
      return {
        tier: t.tier,
        models: t.models,
        estimatedCost: `$${cost.toFixed(4)}`,
        costRaw: cost,
      };
    });

    return {
      task: taskDescription,
      estimates,
      recommendation: 'Use ask_user to present these options, then set_routing_hint based on their choice.',
    };
  },
});
