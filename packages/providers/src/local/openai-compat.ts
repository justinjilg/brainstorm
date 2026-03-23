import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { ModelEntry } from '@brainstorm/shared';

// LM Studio and llama.cpp both expose OpenAI-compatible APIs

export function createLMStudioProvider(baseUrl = 'http://localhost:1234') {
  return createOpenAICompatible({
    name: 'lmstudio',
    baseURL: `${baseUrl}/v1`,
  });
}

export function createLlamaCppProvider(baseUrl = 'http://localhost:8080') {
  return createOpenAICompatible({
    name: 'llamacpp',
    baseURL: `${baseUrl}/v1`,
  });
}

export async function discoverOpenAICompatModels(
  name: 'lmstudio' | 'llamacpp',
  baseUrl: string,
): Promise<ModelEntry[]> {
  try {
    const response = await fetch(`${baseUrl}/v1/models`, { signal: AbortSignal.timeout(3000) });
    if (!response.ok) return [];
    const data = (await response.json()) as { data?: Array<{ id: string }> };
    if (!data.data) return [];

    return data.data.map((m) => ({
      id: `${name}:${m.id}`,
      provider: name,
      name: m.id,
      capabilities: {
        toolCalling: true,
        streaming: true,
        vision: false,
        reasoning: false,
        contextWindow: 8192,
        qualityTier: 3 as const,
        speedTier: 2 as const,
        bestFor: ['conversation' as const, 'simple-edit' as const],
      },
      pricing: { inputPer1MTokens: 0, outputPer1MTokens: 0 },
      limits: { contextWindow: 8192, maxOutputTokens: 4096 },
      status: 'available' as const,
      isLocal: true,
      lastHealthCheck: Date.now(),
    }));
  } catch {
    return [];
  }
}
