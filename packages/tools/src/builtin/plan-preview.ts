import { z } from 'zod';
import { defineTool } from '../base.js';

/**
 * Plan Preview Tool — format a multi-step plan for display.
 * The agent calls this to structure its plan, then uses ask_user
 * to present it and get approval.
 */

export const planPreviewTool = defineTool({
  name: 'plan_preview',
  description: 'Format a multi-step plan for presentation to the user. Returns a formatted plan string. After calling this, use ask_user to present the plan and get approval before executing.',
  permission: 'auto',
  inputSchema: z.object({
    summary: z.string().describe('One-line summary of the overall task'),
    steps: z.array(z.object({
      description: z.string().describe('What this step does'),
      tools: z.array(z.string()).describe('Tools that will be used'),
    })).describe('Ordered list of planned steps'),
    estimatedCost: z.string().optional().describe('Estimated total cost (e.g., "$0.08")'),
  }),
  async execute({ summary, steps, estimatedCost }) {
    const lines = [`Plan: ${summary}`, ''];
    steps.forEach((s, i) => {
      lines.push(`  ${i + 1}. ${s.description}`);
      lines.push(`     Tools: ${s.tools.join(', ')}`);
    });
    if (estimatedCost) {
      lines.push('');
      lines.push(`Estimated cost: ${estimatedCost}`);
    }
    lines.push('');
    lines.push(`Total steps: ${steps.length}`);

    return {
      formattedPlan: lines.join('\n'),
      stepCount: steps.length,
      instruction: 'Present this plan to the user via ask_user with options ["Proceed", "Adjust", "Skip"]. If approved, execute the steps.',
    };
  },
});
