import type { AgentMiddleware, MiddlewareState } from '../types.js';

/** Adjusts response style based on detected user tone. */
export const sentimentMiddleware: AgentMiddleware = {
  name: 'sentiment',
  beforeAgent(state) {
    const tone = state.metadata.userTone as string | undefined;
    if (!tone || tone === 'calm') return;

    // Inject tone guidance into system prompt
    const guidance = getToneGuidance(tone);
    if (!guidance) return;

    return {
      ...state,
      systemPrompt: state.systemPrompt + '\n' + guidance,
    };
  },
};

function getToneGuidance(tone: string): string {
  switch (tone) {
    case 'frustrated':
      return '[Tone: frustrated. Be direct, lead with the fix, skip explanations unless asked.]';
    case 'urgent':
      return '[Tone: urgent. Minimize reads, act quickly, skip exploration.]';
    case 'exploring':
      return '[Tone: exploring. Offer alternatives, explain trade-offs, be collaborative.]';
    case 'appreciative':
      return '[Tone: satisfied. Continue current approach.]';
    default:
      return '';
  }
}
