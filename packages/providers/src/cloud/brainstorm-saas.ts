import { createOpenAICompatible } from '@ai-sdk/openai-compatible';

/**
 * BrainstormRouter SaaS provider.
 * Uses OpenAI-compatible API at api.brainstormrouter.com.
 * Supports model="auto" for intelligent routing by the SaaS.
 */
export function createBrainstormSaaSProvider(apiKey: string) {
  return createOpenAICompatible({
    name: 'brainstormrouter',
    baseURL: 'https://api.brainstormrouter.com/v1',
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  });
}

/**
 * Community tier API key — ships with the CLI for zero-setup onboarding.
 * Rate-limited server-side by BrainstormRouter: 5 RPM, 100 req/day, $2/day,
 * cheap models only (DeepSeek V3, Haiku, GPT-4.1-mini, Gemini Flash).
 * Users override with BRAINSTORM_API_KEY for full access to 357 models.
 */
const COMMUNITY_KEY = 'br_live_b028d73791f9a2d614acafe80b89d36f66e69d3091d9b70b24658ccc03a5a48a';

/**
 * Get the BrainstormRouter API key.
 * Priority: BRAINSTORM_API_KEY env var → community key (free tier).
 */
export function getBrainstormApiKey(): string {
  return process.env.BRAINSTORM_API_KEY ?? COMMUNITY_KEY;
}

/**
 * Check if the current key is the community tier (for UI messaging).
 */
export function isCommunityKey(key: string): boolean {
  return key === COMMUNITY_KEY;
}
