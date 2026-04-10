import type { BrainstormConfig } from "@brainst0rm/config";
import type { ModelEntry, CapabilityScores } from "@brainst0rm/shared";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createOllamaProvider } from "./local/ollama.js";
import {
  createLMStudioProvider,
  createLlamaCppProvider,
} from "./local/openai-compat.js";
import { discoverLocalModels } from "./local/discovery.js";
import { CLOUD_MODELS } from "./cloud/models.js";
import {
  createBrainstormSaaSProvider,
  getBrainstormApiKey,
} from "./cloud/brainstorm-saas.js";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

export interface ProviderRegistry {
  models: ModelEntry[];
  getModel(id: string): ModelEntry | undefined;
  getProvider(modelId: string): any;
  hasBrainstormSaaS: boolean;
  refresh(): Promise<void>;
}

/**
 * Optional pre-resolved API keys from the vault/1Password/env chain.
 * When provided, these take priority over process.env for provider setup.
 */
export interface ResolvedKeys {
  get(name: string): string | null;
}

export async function createProviderRegistry(
  config: BrainstormConfig,
  resolvedKeys?: ResolvedKeys,
): Promise<ProviderRegistry> {
  /** Resolve a key: check resolvedKeys first, then fall back to process.env. */
  const getKey = (name: string): string | null =>
    resolvedKeys?.get(name) ?? process.env[name] ?? null;

  const providers: Record<string, any> = {};

  // Local providers
  if (config.providers.ollama.enabled) {
    providers.ollama = createOllamaProvider(config.providers.ollama.baseUrl);
  }
  if (config.providers.lmstudio.enabled) {
    providers.lmstudio = createLMStudioProvider(
      config.providers.lmstudio.baseUrl,
    );
  }
  if (config.providers.llamacpp.enabled) {
    providers.llamacpp = createLlamaCppProvider(
      config.providers.llamacpp.baseUrl,
    );
  }

  // BrainstormRouter SaaS — only enabled with an explicit API key.
  // The embedded community key is NOT used implicitly to prevent sending
  // prompts/code to a remote service without explicit opt-in.
  const explicitBrKey = getKey("BRAINSTORM_API_KEY");
  const brApiKey =
    explicitBrKey ??
    (process.env.BRAINSTORM_API_KEY ? getBrainstormApiKey() : null);
  const hasBrainstormSaaS = !!brApiKey;
  if (brApiKey) {
    providers.brainstormrouter = createBrainstormSaaSProvider(brApiKey);
  }

  // Direct provider SDKs (fallback when no BR SaaS, or for direct API key usage)
  const anthropicKey = getKey("ANTHROPIC_API_KEY");
  if (anthropicKey) {
    providers.anthropic = createAnthropic({ apiKey: anthropicKey });
  }
  const openaiKey = getKey("OPENAI_API_KEY");
  if (openaiKey) {
    providers.openai = createOpenAI({ apiKey: openaiKey });
  }
  const googleKey = getKey("GOOGLE_GENERATIVE_AI_API_KEY");
  if (googleKey) {
    providers.google = createGoogleGenerativeAI({ apiKey: googleKey });
  }

  // Only include cloud models for providers we have credentials for
  const availableCloudProviders = new Set<string>();
  if (brApiKey) availableCloudProviders.add("brainstormrouter"); // SaaS can route to any model
  if (anthropicKey) availableCloudProviders.add("anthropic");
  if (openaiKey) availableCloudProviders.add("openai");
  if (googleKey) availableCloudProviders.add("google");
  const deepseekKey = getKey("DEEPSEEK_API_KEY");
  if (deepseekKey) {
    availableCloudProviders.add("deepseek");
    providers.deepseek = createOpenAICompatible({
      name: "deepseek",
      baseURL: "https://api.deepseek.com/v1",
      headers: { Authorization: `Bearer ${deepseekKey}` },
      includeUsage: true,
    });
  }
  const moonshotKey = getKey("MOONSHOT_API_KEY");
  if (moonshotKey) {
    availableCloudProviders.add("moonshot");
    providers.moonshot = createOpenAICompatible({
      name: "moonshot",
      baseURL: "https://api.moonshot.ai/v1",
      headers: { Authorization: `Bearer ${moonshotKey}` },
      includeUsage: true,
    });
  }

  // Include all cloud models reachable via SaaS or direct keys.
  // Models with direct provider keys are marked preferred for routing.
  const hasDirectKeys =
    availableCloudProviders.size > (hasBrainstormSaaS ? 1 : 0);
  const reachableCloudModels = hasBrainstormSaaS
    ? CLOUD_MODELS
    : CLOUD_MODELS.filter((m) => availableCloudProviders.has(m.provider));

  let allModels = [...reachableCloudModels];

  // If BR SaaS is available, add "auto" model (intelligent SaaS routing)
  if (hasBrainstormSaaS) {
    allModels.unshift({
      id: "brainstormrouter/auto",
      provider: "brainstormrouter",
      name: "BrainstormRouter Auto",
      capabilities: {
        toolCalling: true,
        streaming: true,
        vision: true,
        reasoning: true,
        contextWindow: 200000,
        qualityTier: 1,
        speedTier: 1,
        bestFor: [
          "code-generation",
          "debugging",
          "refactoring",
          "analysis",
          "multi-file-edit",
          "explanation",
          "conversation",
        ],
      },
      pricing: { inputPer1MTokens: 0, outputPer1MTokens: 0 }, // SaaS handles pricing
      limits: { contextWindow: 200000, maxOutputTokens: 16384 },
      status: "available",
      isLocal: false,
      lastHealthCheck: Date.now(),
    });
  }

  // Discover local models
  const { models: localModels } = await discoverLocalModels(config.providers);
  allModels.push(...localModels);

  // Apply model overrides from config
  for (const override of config.models) {
    const existing = allModels.find((m) => m.id === override.id);
    if (existing) {
      if (override.qualityTier)
        existing.capabilities.qualityTier = override.qualityTier as any;
      if (override.speedTier)
        existing.capabilities.speedTier = override.speedTier as any;
      if (override.bestFor)
        existing.capabilities.bestFor = override.bestFor as any;
    }
  }

  // Overlay eval-derived capability scores (from `brainstorm eval`)
  const evalScores = loadEvalCapabilityScores();
  for (const [modelId, entry] of Object.entries(evalScores)) {
    const model = allModels.find((m) => m.id === modelId);
    if (model) {
      model.capabilities.capabilityScores = entry.scores;
    }
  }

  // Persist model list to cache for faster subsequent startups
  saveProviderCache(allModels);

  const registry: ProviderRegistry = {
    models: allModels,
    hasBrainstormSaaS,

    getModel(id: string) {
      return allModels.find((m) => m.id === id);
    },

    getProvider(modelId: string) {
      // BrainstormRouter SaaS: route through SaaS provider
      if (
        modelId.startsWith("brainstormrouter/") &&
        providers.brainstormrouter
      ) {
        const model = modelId.split("/")[1]; // "auto" or specific model
        return providers.brainstormrouter(model);
      }

      // Local models (ollama:xxx, lmstudio:xxx, llamacpp:xxx)
      const [providerName] = modelId.split(":");
      if (providerName && providers[providerName]) {
        const modelName = modelId.slice(providerName.length + 1);
        return providers[providerName](modelName);
      }

      // Cloud models ("provider/model" format) — resolve through direct SDK providers
      const [cloudProvider, ...modelParts] = modelId.split("/");
      const cloudModelName = modelParts.join("/");
      if (cloudProvider && providers[cloudProvider]) {
        return providers[cloudProvider](cloudModelName);
      }

      // No direct provider SDK available — route through BrainstormRouter if available.
      // This handles the common case where the router picks "openai/gpt-4.1" but the
      // user only has a BR key (no OPENAI_API_KEY). BR can route to any model.
      if (providers.brainstormrouter) {
        return providers.brainstormrouter(modelId);
      }

      // Last resort: return the raw model ID string
      return modelId;
    },

    async refresh() {
      const { models: refreshedLocal } = await discoverLocalModels(
        config.providers,
      );
      const cloudAndSaas = allModels.filter((m) => !m.isLocal);
      allModels = [...cloudAndSaas, ...refreshedLocal];
      // Re-apply eval capability scores (may have been updated by brainstorm eval)
      const freshScores = loadEvalCapabilityScores();
      for (const [modelId, entry] of Object.entries(freshScores)) {
        const model = allModels.find((m) => m.id === modelId);
        if (model) {
          model.capabilities.capabilityScores = entry.scores;
        }
      }
      registry.models = allModels;
    },
  };

  return registry;
}

/**
 * Load eval-derived capability scores from ~/.brainstorm/eval/capability-scores.json.
 * These are written by `brainstorm eval` via @brainst0rm/eval's exportCapabilityScores().
 * Reading directly avoids a circular dependency (eval → providers → eval).
 */
const CACHE_PATH = join(homedir(), ".brainstorm", ".providers.cache.json");
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

interface ProviderCache {
  timestamp: number;
  modelIds: string[];
}

function loadProviderCache(): ProviderCache | null {
  try {
    if (!existsSync(CACHE_PATH)) return null;
    const raw = readFileSync(CACHE_PATH, "utf-8");
    // Guard against corrupt/oversized cache files (max 1MB)
    if (raw.length > 1_000_000) return null;
    const data = JSON.parse(raw);
    // Validate required fields exist
    if (typeof data?.timestamp !== "number" || !Array.isArray(data?.modelIds))
      return null;
    if (Date.now() - data.timestamp > CACHE_TTL_MS) return null;
    return data as ProviderCache;
  } catch {
    return null;
  }
}

function saveProviderCache(models: ModelEntry[]): void {
  try {
    const dir = join(homedir(), ".brainstorm");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const cache: ProviderCache = {
      timestamp: Date.now(),
      modelIds: models.map((m) => m.id),
    };
    writeFileSync(CACHE_PATH, JSON.stringify(cache), "utf-8");
  } catch {
    // Non-fatal — caching is best-effort
  }
}

function loadEvalCapabilityScores(): Record<
  string,
  { scores: CapabilityScores; evaluatedAt: number }
> {
  const scoresPath = join(
    homedir(),
    ".brainstorm",
    "eval",
    "capability-scores.json",
  );
  if (!existsSync(scoresPath)) return {};
  try {
    return JSON.parse(readFileSync(scoresPath, "utf-8"));
  } catch {
    return {};
  }
}
