import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { ModelEntry } from "@brainst0rm/shared";

// LM Studio and llama.cpp both expose OpenAI-compatible APIs

/** Resolved auth for a remote OpenAI-compatible endpoint. */
export interface LocalProviderAuth {
  /** Bearer token — sent as `Authorization: Bearer <apiKey>`. */
  apiKey?: string;
  /** Additional static headers (merged before the bearer token). */
  headers?: Record<string, string>;
}

/**
 * Build request headers from resolved auth. Returns undefined when there is
 * nothing to add, so localhost providers behave exactly as before (no headers).
 */
export function buildAuthHeaders(
  auth?: LocalProviderAuth,
): Record<string, string> | undefined {
  if (!auth) return undefined;
  // Header names are case-insensitive. If a resolved bearer token is present,
  // remove any statically configured Authorization variant before adding the
  // canonical field. Passing both `authorization` and `Authorization` through
  // fetch combines them into an invalid value such as
  // "Basic ..., Bearer ..." rather than reliably overriding the first.
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(auth.headers ?? {})) {
    if (auth.apiKey && name.toLowerCase() === "authorization") continue;
    headers[name] = value;
  }
  if (auth.apiKey) headers.Authorization = `Bearer ${auth.apiKey}`;
  return Object.keys(headers).length > 0 ? headers : undefined;
}

/**
 * Resolve a config provider entry's declared auth (`apiKeyEnv` + `headers`)
 * into a {@link LocalProviderAuth}, using `resolveKey` to look up the token
 * (vault-aware in the registry, `process.env` in discovery). Returns undefined
 * when the entry declares no auth at all.
 */
export function resolveLocalAuth(
  cfg: { apiKeyEnv?: string; headers?: Record<string, string> },
  resolveKey: (name: string) => string | null,
): LocalProviderAuth | undefined {
  const apiKey = cfg.apiKeyEnv
    ? (resolveKey(cfg.apiKeyEnv) ?? undefined)
    : undefined;
  if (!apiKey && !cfg.headers) return undefined;
  return { apiKey, headers: cfg.headers };
}

export function createLMStudioProvider(
  baseUrl = "http://localhost:1234",
  auth?: LocalProviderAuth,
) {
  return createOpenAICompatible({
    name: "lmstudio",
    baseURL: `${baseUrl}/v1`,
    headers: buildAuthHeaders(auth),
  });
}

export function createLlamaCppProvider(
  baseUrl = "http://localhost:8080",
  auth?: LocalProviderAuth,
) {
  return createOpenAICompatible({
    name: "llamacpp",
    baseURL: `${baseUrl}/v1`,
    headers: buildAuthHeaders(auth),
  });
}

export async function discoverOpenAICompatModels(
  name: "lmstudio" | "llamacpp",
  baseUrl: string,
  auth?: LocalProviderAuth,
): Promise<ModelEntry[]> {
  try {
    const response = await fetch(`${baseUrl}/v1/models`, {
      signal: AbortSignal.timeout(3000),
      headers: buildAuthHeaders(auth),
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
