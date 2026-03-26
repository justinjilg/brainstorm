import { z } from 'zod';
import { defineTool } from '../base.js';

/**
 * Routing Hint — agent self-selects routing preference for the next turn.
 * The hint is consumed once by the agent loop, then reset.
 */

export type RoutingPreference = 'cheap' | 'quality' | 'fast' | 'auto';

let currentHint: RoutingPreference = 'auto';

export function getRoutingHint(): RoutingPreference {
  return currentHint;
}

/** Consume the hint (read once, then reset to auto). */
export function consumeRoutingHint(): RoutingPreference {
  const hint = currentHint;
  currentHint = 'auto';
  return hint;
}

export function resetRoutingHint(): void {
  currentHint = 'auto';
}

export const routingHintTool = defineTool({
  name: 'set_routing_hint',
  description: 'Set your preference for the NEXT model selection. Use "cheap" for simple reads, "quality" for complex refactors, "fast" for latency-sensitive work, "auto" to let the router decide. Hint is consumed once.',
  permission: 'auto',
  inputSchema: z.object({
    preference: z.enum(['cheap', 'quality', 'fast', 'auto']).describe('Routing preference for the next turn'),
    reason: z.string().optional().describe('Brief reason for the choice'),
  }),
  async execute({ preference, reason }) {
    currentHint = preference;
    return { success: true, preference, message: `Next turn will prefer "${preference}" routing.${reason ? ` Reason: ${reason}` : ''}` };
  },
});
