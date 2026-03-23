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
 * Check if BR SaaS is configured and available.
 */
export function getBrainstormApiKey(): string | null {
  return process.env.BRAINSTORM_API_KEY ?? null;
}
