import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { ModelEntry } from "@brainst0rm/shared";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";

// LM Studio and llama.cpp both expose OpenAI-compatible APIs

export function createLMStudioProvider(baseUrl = "http://localhost:1234") {
  return createOpenAICompatible({
    name: "lmstudio",
    baseURL: `${baseUrl}/v1`,
  });
}

export function createLlamaCppProvider(baseUrl = "http://localhost:8080") {
  return createOpenAICompatible({
    name: "llamacpp",
    baseURL: `${baseUrl}/v1`,
  });
}

// Custom OpenAI-compatible endpoints ([providers.custom.<name>] in config) —
// same protocol as LM Studio/llama.cpp but may sit behind a bearer token.

export function createCustomProvider(
  name: string,
  baseUrl: string,
  apiKey?: string,
) {
  return createOpenAICompatible({
    name,
    baseURL: `${baseUrl}/v1`,
    ...(apiKey ? { headers: { Authorization: `Bearer ${apiKey}` } } : {}),
    includeUsage: true,
  });
}

/**
 * Resolve a custom provider's bearer token: apiKeyEnv wins over apiKeyFile.
 * `lookupEnv` is injectable so the registry can route through its
 * vault-backed key chain; discovery falls back to process.env.
 */
export function resolveCustomProviderKey(
  cfg: { apiKeyEnv?: string; apiKeyFile?: string },
  lookupEnv: (name: string) => string | null = (name) =>
    process.env[name] ?? null,
): string | null {
  if (cfg.apiKeyEnv) {
    const fromEnv = lookupEnv(cfg.apiKeyEnv);
    if (fromEnv) return fromEnv;
  }
  if (cfg.apiKeyFile) {
    try {
      const path = cfg.apiKeyFile.replace(/^~(?=$|\/)/, homedir());
      const key = readFileSync(path, "utf-8").trim();
      if (key) return key;
    } catch {
      // unreadable key file → treat as no key; the endpoint may be open
    }
  }
  return null;
}

export async function discoverOpenAICompatModels(
  name: string,
  baseUrl: string,
  headers?: Record<string, string>,
): Promise<ModelEntry[]> {
  try {
    const response = await fetch(`${baseUrl}/v1/models`, {
      signal: AbortSignal.timeout(3000),
      ...(headers ? { headers } : {}),
    });
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
        bestFor: ["conversation" as const, "simple-edit" as const],
      },
      pricing: { inputPer1MTokens: 0, outputPer1MTokens: 0 },
      limits: { contextWindow: 8192, maxOutputTokens: 4096 },
      status: "available" as const,
      isLocal: true,
      lastHealthCheck: Date.now(),
    }));
  } catch {
    return [];
  }
}
