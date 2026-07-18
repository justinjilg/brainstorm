import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { ModelEntry } from "@brainst0rm/shared";
import { createLogger } from "@brainst0rm/shared";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";

const log = createLogger("openai-compat");

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

interface InferredModelLimits {
  contextWindow: number;
  maxOutputTokens: number;
  reasoning: boolean;
  toolCalling: boolean;
}

// Family heuristics for endpoints whose /v1/models response carries no limit
// metadata. Ordered — first match wins. These are conservative floors for the
// family, not per-checkpoint truth; `[[models]]` config overrides remain the
// authoritative correction when a deployment differs.
const MODEL_FAMILY_LIMITS: Array<{
  match: RegExp;
  limits: InferredModelLimits;
}> = [
  {
    // Embedding models: not chat-capable at all.
    match: /embed/i,
    limits: {
      contextWindow: 8192,
      maxOutputTokens: 1,
      reasoning: false,
      toolCalling: false,
    },
  },
  {
    match: /gpt-oss/i,
    limits: {
      contextWindow: 131072,
      maxOutputTokens: 32768,
      reasoning: true,
      toolCalling: true,
    },
  },
  {
    match: /qwen3[-.]?(coder|next)/i,
    limits: {
      contextWindow: 262144,
      maxOutputTokens: 32768,
      reasoning: false,
      toolCalling: true,
    },
  },
  {
    // Generation-scoped on purpose: a bare /qwen/ or /gemma/ would claim a
    // 128k window for older checkpoints (qwen1.5, gemma-2) whose real
    // windows are far smaller, suppressing required compaction and sending
    // over-context requests. Unknown generations fall to the conservative
    // default + warn instead.
    match: /qwen(2\.5|[3-9])/i,
    limits: {
      contextWindow: 131072,
      maxOutputTokens: 32768,
      reasoning: false,
      toolCalling: true,
    },
  },
  {
    match: /gemma[-_.]?[3-9]/i,
    limits: {
      contextWindow: 131072,
      maxOutputTokens: 8192,
      reasoning: false,
      toolCalling: true,
    },
  },
];

const DEFAULT_INFERRED_LIMITS: InferredModelLimits = {
  contextWindow: 8192,
  maxOutputTokens: 4096,
  reasoning: false,
  toolCalling: true,
};

/** Raw /v1/models entry — servers vary in what limit metadata they expose. */
interface RawModelEntry {
  id: string;
  /** LM Studio / OpenRouter convention. */
  context_length?: number;
  /** vLLM convention. */
  max_model_len?: number;
}

// Family windows describe current full-size checkpoints. Small checkpoints
// (< 7B params by id suffix, e.g. "qwen2.5-coder-0.5b", "gemma-3-1b") ship
// with much smaller windows — cap them rather than overclaim 128k.
const SMALL_CHECKPOINT_CONTEXT_CAP = 32768;
const SMALL_CHECKPOINT_PARAMS_B = 7;

function smallCheckpointCap(id: string): number | null {
  const match = id.match(/(\d+(?:\.\d+)?)b\b/i);
  if (!match) return null;
  return parseFloat(match[1]) < SMALL_CHECKPOINT_PARAMS_B
    ? SMALL_CHECKPOINT_CONTEXT_CAP
    : null;
}

export function inferModelLimits(raw: RawModelEntry): {
  limits: InferredModelLimits;
  source: "server" | "heuristic" | "default";
} {
  let family =
    MODEL_FAMILY_LIMITS.find((f) => f.match.test(raw.id))?.limits ?? null;
  const sizeCap = family ? smallCheckpointCap(raw.id) : null;
  if (family && sizeCap && family.contextWindow > sizeCap) {
    family = {
      ...family,
      contextWindow: sizeCap,
      maxOutputTokens: Math.min(family.maxOutputTokens, sizeCap),
    };
  }
  const serverContext =
    typeof raw.context_length === "number"
      ? raw.context_length
      : typeof raw.max_model_len === "number"
        ? raw.max_model_len
        : null;

  // Server-reported context wins; family heuristic fills the rest.
  const base = family ?? DEFAULT_INFERRED_LIMITS;
  if (serverContext && serverContext > 0) {
    return {
      limits: {
        ...base,
        contextWindow: serverContext,
        maxOutputTokens: Math.min(base.maxOutputTokens, serverContext),
      },
      source: "server",
    };
  }
  return { limits: base, source: family ? "heuristic" : "default" };
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
    const data = (await response.json()) as { data?: RawModelEntry[] };
    if (!data.data) return [];

    const entries: ModelEntry[] = [];
    for (const m of data.data) {
      const { limits, source } = inferModelLimits(m);
      // Embedding-only models are not chat models: registering them would
      // let the router select one for conversation tasks and hand streamText
      // a 1-token output budget.
      if (!limits.toolCalling && limits.maxOutputTokens <= 1) {
        log.debug(
          { provider: name, model: m.id },
          "Skipping non-chat (embedding) model",
        );
        continue;
      }
      if (source === "default") {
        log.warn(
          { provider: name, model: m.id },
          "No limit metadata from server and no family heuristic matched — assuming 8192-token context. Correct via [[models]] overrides if wrong.",
        );
      }
      entries.push({
        id: `${name}:${m.id}`,
        provider: name,
        name: m.id,
        capabilities: {
          toolCalling: limits.toolCalling,
          streaming: true,
          vision: false,
          reasoning: limits.reasoning,
          contextWindow: limits.contextWindow,
          qualityTier: 3 as const,
          speedTier: 2 as const,
          bestFor: ["conversation" as const, "simple-edit" as const],
        },
        pricing: { inputPer1MTokens: 0, outputPer1MTokens: 0 },
        limits: {
          contextWindow: limits.contextWindow,
          maxOutputTokens: limits.maxOutputTokens,
        },
        status: "available" as const,
        isLocal: true,
        lastHealthCheck: Date.now(),
      });
    }
    return entries;
  } catch {
    return [];
  }
}
